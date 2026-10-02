/**
 * PhpManager - Manages PHP built-in server processes
 * Starts/stops PHP servers for local sites
 */
const { EventEmitter } = require('events');
const { spawn, exec, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');

class PhpManager extends EventEmitter {
  constructor() {
    super();
    this.servers = {}; // siteId -> { process, port, site }
    this.phpBinary = 'php';
  }

  /** Set custom PHP binary path */
  setPHPBinary(binary) {
    const value = String(binary || 'php').trim().replace(/^(["'])(.*)\1$/, '$2');
    this.phpBinary = value || 'php';
  }

  _usedPorts() {
    return new Set(Object.values(this.servers).map(s => s.port));
  }

  _isPortFree(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true));
      });
    });
  }

  /** Find a free port starting from startPort */
  async findFreePort(startPort = 8000) {
    const used = this._usedPorts();
    for (let port = startPort; port <= 9999; port++) {
      if (used.has(port)) continue;
      if (await this._isPortFree(port)) return port;
    }
    throw new Error('No free ports available');
  }

  _quoteCmdArg(value) {
    const str = String(value);
    if (!/[\s"]/.test(str)) return str;
    return `"${str.replace(/"/g, '\\"')}"`;
  }

  getEffectiveBinary() {
    const custom = String(this.phpBinary || '').trim();
    if (custom && custom !== 'php' && fs.existsSync(custom)) {
      return custom;
    }
    const userProfile = process.env.USERPROFILE || '';
    const appData = process.env.APPDATA || (userProfile ? path.join(userProfile, 'AppData', 'Roaming') : '');
    const standalone84 = path.join(appData, 'c-script-localhost', 'php', 'php84', 'php.exe');
    if (fs.existsSync(standalone84)) return standalone84;
    const legacy84 = path.join(appData, 'antigravity-localhost', 'php', 'php84', 'php.exe');
    if (fs.existsSync(legacy84)) return legacy84;

    const standalone85 = path.join(appData, 'c-script-localhost', 'php', 'php85', 'php.exe');
    if (fs.existsSync(standalone85)) return standalone85;
    const legacy85 = path.join(appData, 'antigravity-localhost', 'php', 'php85', 'php.exe');
    if (fs.existsSync(legacy85)) return legacy85;

    return this.phpBinary || 'php';
  }

  _needsShell(binary) {
    if (process.platform !== 'win32') return false;
    const bin = binary || this.getEffectiveBinary();
    return !String(bin || '').toLowerCase().endsWith('.exe');
  }

  _spawnPhp(args, cwd, binary) {
    const bin = binary || this.getEffectiveBinary();
    const options = {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    };

    if (this._needsShell(bin)) {
      const cmdline = [this._quoteCmdArg(bin), ...args.map(a => this._quoteCmdArg(a))].join(' ');
      return spawn(cmdline, { ...options, shell: true });
    }

    return spawn(bin, args, options);
  }

  _execPhp(args, callback) {
    const bin = this.getEffectiveBinary();
    const options = { windowsHide: true, timeout: 10000 };
    if (this._needsShell(bin)) {
      const command = [this._quoteCmdArg(bin), ...args.map(arg => this._quoteCmdArg(arg))].join(' ');
      exec(command, options, callback);
    } else {
      execFile(bin, args, options, callback);
    }
  }

  _killProcess(proc) {
    if (!proc || proc.killed) return;
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
      return;
    }
    try {
      proc.kill('SIGTERM');
    } catch (e) {
      /* already gone */
    }
  }

  _waitForListen(port, timeoutMs, proc) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        if (proc.exitCode != null) {
          reject(new Error('PHP process exited before the server was ready'));
          return;
        }
        const socket = net.connect({ host: '127.0.0.1', port }, () => {
          socket.end();
          resolve();
        });
        socket.on('error', () => {
          socket.destroy();
          if (Date.now() >= deadline) {
            reject(new Error(`PHP server did not start on port ${port}`));
            return;
          }
          setTimeout(attempt, 80);
        });
      };
      attempt();
    });
  }

  /** Get installed PHP version */
  getVersion() {
    return new Promise((resolve) => {
      this._execPhp(['--version'], (err, stdout, stderr) => {
        if (err) {
          const error = err.code === 'ENOENT'
            ? `PHP executable not found: ${this.phpBinary}. Choose php.exe in Settings.`
            : (stderr || err.message || 'Unable to run PHP');
          resolve({ success: false, available: false, version: null, binary: this.phpBinary, error: error.trim() });
          return;
        }
        const out = stdout || stderr;
        const match = out.match(/PHP (\d+\.\d+\.\d+)/);
        resolve({
          success: true,
          available: true,
          version: match ? match[1] : 'Unknown',
          binary: this.phpBinary,
          fullOutput: out.trim()
        });
      });
    });
  }

  /** Get PHP extensions and config info */
  getInfo() {
    const run = args => new Promise(resolve => this._execPhp(args, (err, stdout, stderr) =>
      resolve({ error: err, output: stdout || stderr || '' })
    ));
    return Promise.all([
      run(['-m']),
      run(['-r', 'echo php_ini_loaded_file();']),
      run(['-r', 'echo PHP_VERSION;'])
    ]).then(([modules, ini, version]) => {
      if (modules.error && ini.error && version.error) {
        return { success: false, error: modules.error.message || 'Unable to run PHP' };
      }
      return {
        success: true,
        extensions: modules.error ? [] : modules.output.trim().split(/\r?\n/).filter(line => line && !line.startsWith('[')),
        iniPath: ini.error ? 'Not found' : (ini.output.trim() || 'None'),
        version: version.error ? 'Unknown' : version.output.trim()
      };
    });
  }

  /** Start a PHP built-in server for a site */
  async start(site) {
    if (this.servers[site.id]) {
      return { success: true, port: this.servers[site.id].port, alreadyRunning: true };
    }

    if (!site.root || !fs.existsSync(site.root)) {
      return { success: false, error: `Directory not found: ${site.root}` };
    }

    const requested = site.port && site.port > 0 ? site.port : null;
    let port;
    try {
      if (requested) {
        if (this._usedPorts().has(requested) || !(await this._isPortFree(requested))) {
          return { success: false, error: `Port ${requested} is already in use` };
        }
        port = requested;
      } else {
        port = await this.findFreePort(8000);
      }
    } catch (err) {
      return { success: false, error: err.message };
    }

    const args = ['-S', `127.0.0.1:${port}`, '-t', site.root];
    // Optional router/entry file (passed as last arg to php -S)
    if (site.entryFile && fs.existsSync(site.entryFile)) {
      args.push(site.entryFile);
    }
    const bin = site.phpBinary || site.php || this.phpBinary || 'php';
    const phpProcess = this._spawnPhp(args, site.root, bin);

    let stderrBuf = '';
    let resolved = false;

    const result = await new Promise((resolve) => {
      const resolveOnce = (value) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };

      phpProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        stderrBuf += msg + '\n';
        this.emit('log', {
          siteId: site.id,
          siteName: site.name,
          message: msg,
          type: 'info',
          timestamp: new Date().toISOString()
        });
      });

      phpProcess.stdout.on('data', (data) => {
        this.emit('log', {
          siteId: site.id,
          siteName: site.name,
          message: data.toString().trim(),
          type: 'access',
          timestamp: new Date().toISOString()
        });
      });

      phpProcess.on('error', (err) => {
        const errMsg = err.code === 'ENOENT'
          ? `PHP not found. Make sure PHP is installed and in PATH (tried: "${bin}")`
          : err.message;
        resolveOnce({ success: false, error: errMsg });
      });

      phpProcess.on('exit', (code, signal) => {
        const wasRunning = !!this.servers[site.id];
        delete this.servers[site.id];
        this.emit('log', {
          siteId: site.id,
          siteName: site.name,
          message: `Server stopped (exit: ${code ?? signal})`,
          type: 'warning',
          timestamp: new Date().toISOString()
        });
        if (wasRunning) {
          this.emit('site-stopped', { siteId: site.id });
        }
        if (!resolved) {
          const hint = stderrBuf.trim() || `PHP exited with code ${code ?? signal}`;
          resolveOnce({ success: false, error: hint });
        }
      });

      this._waitForListen(port, 4000, phpProcess)
        .then(() => {
          this.servers[site.id] = { process: phpProcess, port, site, binary: bin };
          resolveOnce({ success: true, port });
        })
        .catch((err) => {
          if (phpProcess.exitCode == null) this._killProcess(phpProcess);
          resolveOnce({
            success: false,
            error: stderrBuf.trim() || err.message
          });
        });
    });

    return result;
  }

  /** Stop a PHP server by site ID */
  stop(id) {
    const server = this.servers[id];
    if (server) {
      this._killProcess(server.process);
      delete this.servers[id];
      return true;
    }
    return false;
  }

  /** Stop all running PHP servers */
  stopAll() {
    Object.keys(this.servers).forEach(id => this.stop(id));
  }

  /** Check if a site server is running */
  isRunning(id) {
    return !!this.servers[id];
  }

  /** Get the port a site is running on */
  getPort(id) {
    return this.servers[id] ? this.servers[id].port : null;
  }

  /** Get all running server info */
  getRunning() {
    return Object.entries(this.servers).map(([id, srv]) => ({
      siteId: id,
      port: srv.port,
      site: srv.site
    }));
  }
}

module.exports = PhpManager;
