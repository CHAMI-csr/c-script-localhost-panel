/**
 * LaravelManager - Runs a small, explicit set of Artisan tasks for registered sites.
 * Commands are selected by ID and are never assembled from renderer-provided text.
 */
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const COMMANDS = Object.freeze({
  migrate: { args: ['migrate', '--force'], persistent: false },
  seed: { args: ['db:seed', '--force'], persistent: false },
  cacheClear: { args: ['cache:clear'], persistent: false },
  queueWork: { args: ['queue:work', '--verbose'], persistent: true }
});

class LaravelManager extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();
    this.nextJobId = 1;
  }

  static isLaravelProject(rootPath) {
    if (typeof rootPath !== 'string' || !rootPath.trim()) return false;
    try {
      const root = fs.realpathSync(rootPath);
      if (!fs.statSync(root).isDirectory()) return false;
      const artisanPath = path.join(root, 'artisan');
      if (!fs.existsSync(artisanPath) || !fs.statSync(artisanPath).isFile()) return false;

      // Laravel projects can be identified before Composer dependencies are installed.
      const bootstrapApp = path.join(root, 'bootstrap', 'app.php');
      if (fs.existsSync(bootstrapApp) && fs.statSync(bootstrapApp).isFile()) return true;
      const composerPath = path.join(root, 'composer.json');
      if (!fs.existsSync(composerPath) || !fs.statSync(composerPath).isFile()) return false;
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf8'));
      return ['require', 'require-dev'].some(section =>
        Object.keys(composer?.[section] || {}).some(name => name.toLowerCase() === 'laravel/framework')
      );
    } catch (_) {
      return false;
    }
  }

  run(site, action, phpManager) {
    const spec = COMMANDS[action];
    if (!spec) return Promise.resolve({ success: false, error: 'Unsupported Artisan action.' });
    if (!site || typeof site.root !== 'string') return Promise.resolve({ success: false, error: 'Site was not found.' });

    let root;
    try {
      root = fs.realpathSync(site.root);
      if (!fs.statSync(root).isDirectory()) throw new Error();
      if (!LaravelManager.isLaravelProject(root)) {
        return Promise.resolve({ success: false, error: 'This site is not a Laravel project.' });
      }
    } catch (_) {
      return Promise.resolve({ success: false, error: 'The site folder is unavailable.' });
    }

    if (spec.persistent && [...this.jobs.values()].some(job => job.siteId === site.id && job.action === action && !job.closed)) {
      return Promise.resolve({ success: false, error: 'A queue worker is already running for this site.' });
    }

    const binary = phpManager ? phpManager.getBinaryForSite(site) : 'php';
    const id = `artisan_${this.nextJobId++}`;
    const child = spawn(binary, [path.join(root, 'artisan'), ...spec.args], {
      cwd: root,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const job = { id, siteId: site.id, action, child, outputBytes: 0, closed: false };
    this.jobs.set(id, job);

    const emitOutput = (stream, chunk) => {
      const output = chunk.toString();
      job.outputBytes += Buffer.byteLength(output);
      if (job.outputBytes > 512 * 1024) {
        if (!job.outputLimitReached) {
          job.outputLimitReached = true;
          this.stop(id);
          this.emit('output', { jobId: id, siteId: site.id, action, stream: 'stderr', output: '\nOutput limit reached; process stopped.\n' });
        }
        return;
      }
      this.emit('output', { jobId: id, siteId: site.id, action, stream, output });
    };
    child.stdout.on('data', chunk => emitOutput('stdout', chunk));
    child.stderr.on('data', chunk => emitOutput('stderr', chunk));
    child.once('error', error => {
      this.emit('output', { jobId: id, siteId: site.id, action, stream: 'stderr', output: `${error.message}\n` });
    });

    return new Promise(resolve => {
      const timer = spec.persistent ? null : setTimeout(() => {
        if (!job.closed) {
          this.stop(id);
          this.emit('output', { jobId: id, siteId: site.id, action, stream: 'stderr', output: '\nCommand timed out after five minutes.\n' });
        }
      }, 5 * 60 * 1000);
      timer?.unref?.();
      child.once('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        job.closed = true;
        this.jobs.delete(id);
        this.emit('output', { jobId: id, siteId: site.id, action, stream: 'status', output: code === 0 ? '\nCommand completed successfully.\n' : `\nCommand exited (${signal || code}).\n`, done: true, code });
        resolve({ success: code === 0, jobId: id, code, error: code === 0 ? undefined : `Artisan exited with code ${code}.` });
      });
      if (spec.persistent) resolve({ success: true, jobId: id, running: true });
    });
  }

  stop(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || job.closed) return { success: false, error: 'Artisan job is not running.' };
    job.closed = true;
    try { job.child.kill('SIGTERM'); } catch (_) {}
    const forceTimer = setTimeout(() => {
      if (job.child.exitCode === null) {
        try { job.child.kill('SIGKILL'); } catch (_) {}
      }
    }, 3000);
    forceTimer.unref?.();
    return { success: true };
  }

  async stopAll() {
    const jobs = [...this.jobs.values()];
    for (const job of jobs) this.stop(job.id);
    await Promise.all(jobs.map(job => new Promise(resolve => {
      if (job.child.exitCode !== null || job.child.signalCode !== null) return resolve();
      const timer = setTimeout(resolve, 5000);
      timer.unref?.();
      job.child.once('close', () => { clearTimeout(timer); resolve(); });
    })));
  }
}

LaravelManager.COMMANDS = COMMANDS;
module.exports = LaravelManager;
