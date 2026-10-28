/**
 * FrameworkManager - 1-Click Starter Scaffolding for PHP Projects
 * Supports WordPress, Laravel, Vanilla PHP / Modern Dashboard, CodeIgniter
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { EventEmitter } = require('events');
const { spawn, exec } = require('child_process');

class FrameworkManager extends EventEmitter {
  constructor() {
    super();
    this.children = new Set();
    this.installingRoots = new Set();
    this.cancelledRoots = new Set();
    this.installations = new Set();
    this.downloadRequests = new Set();
  }

  inspectLaravelTarget(targetDir) {
    try {
      if (typeof targetDir !== 'string' || !targetDir.trim()) return { success: false, error: 'Choose an existing folder for the Laravel project.' };
      const root = fs.realpathSync(path.resolve(targetDir));
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        return { success: false, error: 'Choose an existing folder for the Laravel project.' };
      }
      const LaravelManager = require('./laravelManager');
      const isLaravel = LaravelManager.isLaravelProject(root);
      const entries = fs.readdirSync(root);
      const entryPath = path.join(root, 'public', 'index.php');
      const entryFile = isLaravel && fs.existsSync(entryPath) && fs.statSync(entryPath).isFile() ? entryPath : null;
      return {
        success: true,
        root,
        isLaravel,
        empty: entries.length === 0,
        dependenciesInstalled: fs.existsSync(path.join(root, 'vendor', 'autoload.php')),
        entryFile
      };
    } catch (error) {
      return { success: false, error: `Could not inspect the selected folder: ${error.message}` };
    }
  }

  inspectProjectTarget(targetDir) {
    const inspected = this.inspectLaravelTarget(targetDir);
    if (!inspected.success) return inspected;
    const root = inspected.root;
    let framework = 'none';
    let wordpressIndexContent = '';
    let wordpressConfigContent = '';
    try {
      const indexPath = path.join(root, 'index.php');
      const configPath = path.join(root, 'wp-config-sample.php');
      if (fs.existsSync(indexPath)) wordpressIndexContent = fs.readFileSync(indexPath, 'utf8');
      if (fs.existsSync(configPath)) wordpressConfigContent = fs.readFileSync(configPath, 'utf8');
    } catch (_) {}
    const wordpressSetupRecognized = wordpressIndexContent.includes('C-Script LocalHost Panel WordPress Setup') ||
      wordpressIndexContent.includes('WordPress Setup —') ||
      wordpressConfigContent.includes('C-Script LocalHost Panel WordPress Setup') ||
      wordpressConfigContent.includes('cscript_local_dev_key_1');
    const wordpressSetupMissing = [];
    const wordpressSetupCorrupt = [];
    if (!fs.existsSync(path.join(root, 'index.php'))) wordpressSetupMissing.push('index.php');
    if (!fs.existsSync(path.join(root, 'wp-config-sample.php'))) wordpressSetupMissing.push('wp-config-sample.php');
    const wordpressIndexHealthy = (wordpressIndexContent.includes('C-Script LocalHost Panel WordPress Setup') || wordpressIndexContent.includes('WordPress Setup —')) &&
      wordpressIndexContent.includes('WP_USE_THEMES') && wordpressIndexContent.includes('wp-blog-header.php');
    const wordpressConfigHealthy = (wordpressConfigContent.includes('C-Script LocalHost Panel WordPress Setup') || wordpressConfigContent.includes('cscript_local_dev_key_1')) &&
      wordpressConfigContent.includes('DB_NAME') && wordpressConfigContent.includes('DB_HOST') && wordpressConfigContent.includes('wp-settings.php');
    if (fs.existsSync(path.join(root, 'index.php')) && !wordpressIndexHealthy) wordpressSetupCorrupt.push('index.php');
    if (fs.existsSync(path.join(root, 'wp-config-sample.php')) && !wordpressConfigHealthy) wordpressSetupCorrupt.push('wp-config-sample.php');
    const wordpressSetupComplete = wordpressSetupRecognized && wordpressSetupMissing.length === 0 && wordpressSetupCorrupt.length === 0;
    const wordpressCoreComplete = fs.existsSync(path.join(root, 'wp-includes', 'version.php')) &&
      fs.existsSync(path.join(root, 'wp-admin')) && fs.existsSync(path.join(root, 'wp-load.php'));
    let hasCodeIgniterComposerPackage = false;
    try {
      const composer = JSON.parse(fs.readFileSync(path.join(root, 'composer.json'), 'utf8'));
      hasCodeIgniterComposerPackage = ['require', 'require-dev'].some(section =>
        Object.keys(composer?.[section] || {}).some(name => name.toLowerCase() === 'codeigniter4/framework')
      );
    } catch (_) {}
    const codeigniterRecognized = hasCodeIgniterComposerPackage ||
      (fs.existsSync(path.join(root, 'spark')) && fs.existsSync(path.join(root, 'app', 'Config', 'Paths.php')));
    const codeigniterCoreComplete = fs.existsSync(path.join(root, 'spark')) &&
      fs.existsSync(path.join(root, 'app', 'Config', 'Paths.php'));
    if (inspected.isLaravel) {
      framework = 'laravel';
    } else if (
      wordpressCoreComplete || wordpressSetupRecognized
    ) {
      framework = 'wordpress';
    } else if (codeigniterRecognized) {
      framework = 'codeigniter';
    }
    return {
      ...inspected,
      framework,
      existingProject: framework !== 'none',
      wordpressSetupRecognized,
      wordpressSetupComplete,
      wordpressSetupMissing,
      wordpressSetupCorrupt,
      wordpressCoreComplete,
      codeigniterCoreComplete
    };
  }

  hasActiveInstallations() {
    return this.installations.size > 0 || this.children.size > 0 || this.downloadRequests.size > 0;
  }

  async cancelInstallation(targetDir) {
    if (typeof targetDir !== 'string' || !targetDir.trim()) return { success: false, error: 'Choose the installation folder to stop.' };
    const key = path.resolve(targetDir).toLowerCase();
    const jobs = [...this.children].filter(job => path.resolve(job.targetDir).toLowerCase() === key);
    const requests = [...this.downloadRequests].filter(request => path.resolve(request.targetDir || '').toLowerCase() === key);
    const installations = [...this.installations].filter(installation => path.resolve(installation.targetDir || '').toLowerCase() === key);
    if (!jobs.length && !requests.length && !installations.length && !this.installingRoots.has(key)) {
      return { success: false, error: 'There is no active project setup operation for this folder.' };
    }
    this.cancelledRoots.add(key);
    for (const request of requests) {
      try { request.destroy(new Error('Laravel installation was cancelled by the user.')); } catch (_) {}
    }
    for (const job of jobs) {
      try { job.child?.kill('SIGTERM'); } catch (_) {}
    }
    await Promise.allSettled(installations);
    return { success: true, cancelled: true };
  }

  async installProjectDependencies(targetDir, phpBinary = 'php') {
    const inspected = this.inspectProjectTarget(targetDir);
    if (!inspected.success) return inspected;
    if (inspected.framework !== 'codeigniter') {
      return { success: false, error: 'Composer dependency repair is currently available for detected CodeIgniter 4 projects.' };
    }
    if (!inspected.codeigniterCoreComplete) {
      return { success: false, error: 'The CodeIgniter project files are incomplete. Restore the missing project files from a backup before installing dependencies.' };
    }
    if (inspected.dependenciesInstalled) return { success: true, alreadyInstalled: true, message: 'Composer dependencies are already installed.' };
    const root = inspected.root;
    const rootKey = path.resolve(root).toLowerCase();
    if (this.installingRoots.has(rootKey)) return { success: false, error: 'A project dependency installation is already running for this folder.' };
    this.installingRoots.add(rootKey);
    const installation = (async () => {
      try {
        this.emit('progress', { targetDir: root, stream: 'status', output: 'Preparing CodeIgniter Composer dependencies…\n' });
        const composer = await this._ensureComposer(String(phpBinary || 'php').trim(), root);
        const result = await this._runComposer(composer, String(phpBinary || 'php').trim(), ['install', '--no-interaction', '--prefer-dist'], root, root);
        if (!result.success) return { success: false, error: result.error || 'Composer dependency repair failed.' };
        const verified = this.inspectProjectTarget(root);
        if (!verified.success || !verified.dependenciesInstalled) return { success: false, error: 'Composer finished, but the CodeIgniter dependencies are still incomplete.' };
        return { success: true, framework: 'codeigniter', message: 'CodeIgniter Composer dependencies are ready.' };
      } catch (error) {
        return { success: false, error: `Could not repair project dependencies: ${error.message}` };
      } finally {
        this.installingRoots.delete(rootKey);
        this.cancelledRoots.delete(rootKey);
      }
    })();
    installation.targetDir = root;
    this.installations.add(installation);
    try { return await installation; }
    finally { this.installations.delete(installation); }
  }

  _findComposer() {
    const candidates = [];
    const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    if (process.platform === 'win32' && process.env.ProgramData) pathEntries.unshift(path.join(process.env.ProgramData, 'ComposerSetup', 'bin'));
    for (const directory of pathEntries) {
      candidates.push(path.join(directory, 'composer.phar'));
      candidates.push(path.join(directory, 'composer.exe'));
      candidates.push(path.join(directory, 'composer.bat'));
      candidates.push(path.join(directory, 'composer'));
    }
    for (const candidate of candidates) {
      try {
        if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
        const extension = path.extname(candidate).toLowerCase();
        if (extension === '.phar') return { type: 'phar', path: candidate };
        if (extension === '.exe' || !extension) return { type: 'binary', path: candidate };
        if (extension === '.bat') {
          const adjacentPhar = path.join(path.dirname(candidate), 'composer.phar');
          if (fs.existsSync(adjacentPhar)) return { type: 'phar', path: adjacentPhar };
        }
      } catch (_) {}
    }
    return null;
  }

  _downloadHttpsFile(urlString, destination, targetDir, redirects = 0) {
    return new Promise((resolve, reject) => {
      if (this.cancelledRoots.has(path.resolve(targetDir).toLowerCase())) return reject(new Error('Laravel installation was cancelled by the user.'));
      let url;
      try { url = new URL(urlString); } catch (_) { return reject(new Error('Invalid Composer download URL.')); }
      if (url.protocol !== 'https:' || url.hostname !== 'getcomposer.org') {
        return reject(new Error('Composer downloads are restricted to the official getcomposer.org host.'));
      }
      const request = https.get(url, response => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirects >= 3) return reject(new Error('Composer download redirected too many times.'));
          const redirected = new URL(response.headers.location, url).toString();
          return resolve(this._downloadHttpsFile(redirected, destination, targetDir, redirects + 1));
        }
        if (response.statusCode !== 200) {
          response.resume();
          return reject(new Error(`Composer download returned HTTP ${response.statusCode}.`));
        }
        const output = fs.createWriteStream(destination);
        let received = 0;
        const total = Number(response.headers['content-length']) || 0;
        response.on('data', chunk => {
          received += chunk.length;
          if (received > 20 * 1024 * 1024) request.destroy(new Error('Composer download exceeded the 20 MiB safety limit.'));
          if (total > 0) this.emit('progress', { targetDir, stream: 'download', received, total, percent: Math.min(100, received / total * 100) });
        });
        response.pipe(output);
        output.once('finish', () => output.close(() => resolve({ received, total })));
        output.once('error', error => reject(error));
        response.once('error', error => reject(error));
      });
      request.targetDir = targetDir;
      this.downloadRequests.add(request);
      request.once('close', () => this.downloadRequests.delete(request));
      request.setTimeout(30000, () => request.destroy(new Error('Timed out downloading Composer.')));
      request.once('error', reject);
    });
  }

  async _ensureComposer(phpBinary, targetDir) {
    const installed = this._findComposer();
    if (installed) return installed;

    const profile = process.env.USERPROFILE || os.homedir();
    const appData = process.env.APPDATA || path.join(profile, 'AppData', 'Roaming');
    const binDir = path.join(appData, 'c-script-localhost', 'bin');
    const composerPath = path.join(binDir, 'composer.phar');
    fs.mkdirSync(binDir, { recursive: true });

    if (fs.existsSync(composerPath)) {
      const cached = await this._runComposer({ type: 'phar', path: composerPath }, phpBinary, ['--version', '--no-interaction'], binDir, targetDir);
      if (cached.success) return { type: 'phar', path: composerPath };
      try { fs.unlinkSync(composerPath); } catch (_) {}
    }

    this.emit('progress', { targetDir, stream: 'status', output: 'Composer was not found. Downloading the official Composer release…\n' });
    const tempPhar = `${composerPath}.${process.pid}.download`;
    const tempChecksum = `${tempPhar}.sha256sum`;
    try {
      await this._downloadHttpsFile('https://getcomposer.org/download/latest-stable/composer.phar', tempPhar, targetDir);
      await this._downloadHttpsFile('https://getcomposer.org/download/latest-stable/composer.phar.sha256sum', tempChecksum, targetDir);
      const expected = fs.readFileSync(tempChecksum, 'utf8').match(/[a-f0-9]{64}/i)?.[0]?.toLowerCase();
      if (!expected) throw new Error('Composer did not provide a valid SHA-256 checksum.');
      const actual = crypto.createHash('sha256').update(fs.readFileSync(tempPhar)).digest('hex');
      if (actual !== expected) throw new Error('Composer SHA-256 verification failed; the download was discarded.');
      try { if (fs.existsSync(composerPath)) fs.unlinkSync(composerPath); } catch (_) {}
      fs.renameSync(tempPhar, composerPath);
      this.emit('progress', { targetDir, stream: 'status', output: 'Composer download verified.\n' });
      return { type: 'phar', path: composerPath };
    } catch (error) {
      try { if (fs.existsSync(tempPhar)) fs.unlinkSync(tempPhar); } catch (_) {}
      throw new Error(`Composer could not be downloaded or verified: ${error.message}`);
    } finally {
      try { if (fs.existsSync(tempChecksum)) fs.unlinkSync(tempChecksum); } catch (_) {}
    }
  }

  _runComposer(composer, phpBinary, args, cwd, targetDir) {
    if (this.cancelledRoots.has(path.resolve(targetDir).toLowerCase())) {
      return Promise.resolve({ success: false, error: 'Laravel installation was cancelled by the user.' });
    }
    const command = composer.type === 'phar' ? phpBinary : composer.path;
    const commandArgs = composer.type === 'phar' ? [composer.path, ...args] : args;
    const job = { child: null, targetDir };
    return new Promise(resolve => {
      const child = spawn(command, commandArgs, {
        cwd,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, COMPOSER_NO_INTERACTION: '1', CI: '1' }
      });
      job.child = child;
      this.children.add(job);
      let outputTail = '';
      let pendingOutput = '';
      let flushTimer = null;
      const flushOutput = () => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        if (!pendingOutput) return;
        const output = pendingOutput;
        pendingOutput = '';
        this.emit('progress', { targetDir, stream: 'output', output });
      };
      const forward = (stream, chunk) => {
        const text = chunk.toString();
        outputTail = (outputTail + text).slice(-12000);
        pendingOutput += text;
        if (!flushTimer) {
          flushTimer = setTimeout(flushOutput, 120);
          flushTimer.unref?.();
        }
      };
      child.stdout.on('data', chunk => forward('stdout', chunk));
      child.stderr.on('data', chunk => forward('stderr', chunk));
      child.once('error', error => {
        flushOutput();
        this.children.delete(job);
        this.emit('progress', { targetDir, stream: 'status', output: `Composer could not start: ${error.message}\n` });
        resolve({ success: false, error: `Composer could not start: ${error.message}`, output: outputTail });
      });
      child.once('close', (code, signal) => {
        flushOutput();
        this.children.delete(job);
        resolve({ success: code === 0, code, signal, output: outputTail,
          error: code === 0 ? undefined : `Composer exited (${signal || code}). ${outputTail.trim().slice(-1400)}` });
      });
    });
  }

  async stopAll() {
    const jobs = [...this.children];
    for (const request of this.downloadRequests) {
      try { request.destroy(new Error('Laravel installation cancelled because the app is closing.')); } catch (_) {}
    }
    for (const job of jobs) {
      try { job.child?.kill('SIGTERM'); } catch (_) {}
    }
    await Promise.all(jobs.map(job => new Promise(resolve => {
      const child = job.child;
      if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(resolve, 5000);
      timer.unref?.();
      child.once('close', () => { clearTimeout(timer); resolve(); });
    })));
    await Promise.allSettled([...this.installations]);
  }

  /**
   * Scaffold a project based on framework type
   * @param {string} framework 'wordpress' | 'laravel' | 'vanilla' | 'codeigniter'
   * @param {string} targetDir Destination folder
   * @param {object} options Additional options (name, dbName, onProgress)
   */
  async scaffold(framework, targetDir, options = {}) {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const type = (framework || 'vanilla').toLowerCase();

    if (type === 'vanilla') {
      return this._scaffoldVanilla(targetDir, options);
    } else if (type === 'wordpress') {
      return this._scaffoldWordPress(targetDir, options);
    } else if (type === 'laravel') {
      const installation = this._scaffoldLaravel(targetDir, options);
      installation.targetDir = path.resolve(targetDir);
      this.installations.add(installation);
      try { return await installation; }
      finally { this.installations.delete(installation); }
    } else if (type === 'codeigniter') {
      return this._scaffoldCodeIgniter(targetDir, options);
    } else {
      return this._scaffoldVanilla(targetDir, options);
    }
  }

  /**
   * Vanilla PHP Starter with modern responsive UI and DB status checker
   */
  async _scaffoldVanilla(targetDir, options) {
    const siteName = options.name || path.basename(targetDir);
    const dbName = options.dbName || '';

    const indexPhp = `<?php
/**
 * ${siteName} - Local Development Starter
 * Generated by C-Script LocalHost Panel
 */

$appName = '${siteName}';
$phpVersion = PHP_VERSION;
$serverSoftware = $_SERVER['SERVER_SOFTWARE'] ?? 'PHP Built-in Server';
$documentRoot = __DIR__;
$currentTime = date('Y-m-d H:i:s');

// Database Connection Test
$dbConnected = false;
$dbError = null;
$dbHost = '127.0.0.1';
$dbUser = 'root';
$dbPass = '';
$dbName = '${dbName}';

if (!empty($dbName)) {
    try {
        $pdo = new PDO("mysql:host=$dbHost;dbname=$dbName;charset=utf8mb4", $dbUser, $dbPass, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_TIMEOUT => 2
        ]);
        $dbConnected = true;
    } catch (Exception $e) {
        $dbError = $e->getMessage();
    }
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title><?= htmlspecialchars($appName) ?> — Localhost</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0b14;
      --card-bg: #141424;
      --border: #23233c;
      --accent: #6366f1;
      --accent-glow: rgba(99, 102, 241, 0.25);
      --green: #10b981;
      --red: #f43f5e;
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .container {
      max-width: 680px;
      width: 100%;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 40px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 40px var(--accent-glow);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      background: rgba(16, 185, 129, 0.15);
      color: var(--green);
      border: 1px solid rgba(16, 185, 129, 0.3);
      margin-bottom: 20px;
    }
    .badge-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); }
    h1 { font-size: 32px; font-weight: 800; letter-spacing: -0.5px; margin-bottom: 8px; }
    p.subtitle { color: var(--text-muted); font-size: 15px; margin-bottom: 32px; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 32px; }
    .stat-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
    }
    .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin-bottom: 4px; font-weight: 600; }
    .stat-val { font-size: 15px; font-weight: 700; font-family: 'JetBrains Mono', monospace; color: #fff; }
    .actions { display: flex; gap: 12px; flex-wrap: wrap; }
    .btn {
      padding: 10px 20px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: all 0.2s;
    }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { opacity: 0.9; transform: translateY(-1px); }
    .btn-secondary { background: rgba(255,255,255,0.06); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { background: rgba(255,255,255,0.1); }
    code { font-family: 'JetBrains Mono', monospace; font-size: 12px; background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="badge">
      <span class="badge-dot"></span> Site Running Live
    </div>
    <h1><?= htmlspecialchars($appName) ?></h1>
    <p class="subtitle">Your local PHP environment is active and serving traffic smoothly.</p>

    <div class="grid">
      <div class="stat-card">
        <div class="stat-label">PHP Version</div>
        <div class="stat-val"><?= htmlspecialchars($phpVersion) ?></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">MySQL Status</div>
        <div class="stat-val" style="color: <?= $dbConnected ? 'var(--green)' : 'var(--text-muted)' ?>">
          <?= $dbConnected ? 'Connected (' . htmlspecialchars($dbName) . ')' : (empty($dbName) ? 'Not configured' : 'Connection failed') ?>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Web Server</div>
        <div class="stat-val"><?= htmlspecialchars($serverSoftware) ?></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Document Root</div>
        <div class="stat-val" style="font-size: 11px; word-break: break-all;"><?= htmlspecialchars($documentRoot) ?></div>
      </div>
    </div>

    <div class="actions">
      <a href="?phpinfo=1" class="btn btn-secondary">PHP Info</a>
      <a href="/api.php" class="btn btn-secondary">JSON API Test</a>
    </div>
  </div>
</body>
</html>
<?php
if (isset($_GET['phpinfo'])) {
    phpinfo();
    exit;
}
?>
`;

    const apiPhp = `<?php
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

echo json_encode([
    'status' => 'success',
    'app' => '${siteName}',
    'php_version' => PHP_VERSION,
    'server_time' => date('c'),
    'message' => 'C-Script LocalHost API is functioning properly.'
], JSON_PRETTY_PRINT);
`;

    fs.writeFileSync(path.join(targetDir, 'index.php'), indexPhp, 'utf8');
    fs.writeFileSync(path.join(targetDir, 'api.php'), apiPhp, 'utf8');

    return {
      success: true,
      framework: 'vanilla',
      entryFile: 'index.php',
      message: 'Vanilla PHP starter created with index.php and api.php'
    };
  }

  /**
   * WordPress Starter Scaffolding
   */
  async _scaffoldWordPress(targetDir, options) {
    const current = this.inspectProjectTarget(targetDir);
    const canRepairPreviousSetup = current.success && current.framework === 'wordpress' && current.wordpressSetupRecognized;
    if (fs.readdirSync(targetDir).length !== 0 && !canRepairPreviousSetup) {
      return { success: false, error: 'This folder is not empty. Choose an empty folder for a new WordPress setup or select the existing WordPress project.' };
    }
    const siteName = options.name || path.basename(targetDir);
    const dbName = options.dbName || siteName.toLowerCase().replace(/[^a-z0-9_]/g, '_');

    // Create standard WordPress wp-config-sample and starter structure
    const indexPhp = `<?php
/**
 * C-Script LocalHost Panel WordPress Setup
 * Front to the WordPress application.
 */
define('WP_USE_THEMES', true);

// Check if WordPress core is installed
if (file_exists(__DIR__ . '/wp-blog-header.php')) {
    require __DIR__ . '/wp-blog-header.php';
} else {
?>
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>WordPress Setup — ${siteName}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif; background: #f0f0f1; color: #3c434a; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .wrap { background: #fff; padding: 40px; border-radius: 8px; max-width: 520px; box-shadow: 0 4px 15px rgba(0,0,0,0.08); text-align: center; }
    h1 { color: #1d2327; font-size: 24px; margin-bottom: 12px; }
    p { font-size: 14px; line-height: 1.6; color: #646970; }
    .btn { display: inline-block; background: #2271b1; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 4px; font-weight: 600; margin-top: 20px; font-size: 14px; }
    .btn:hover { background: #135e96; }
    .db-box { background: #f6f7f7; border: 1px solid #dcdcde; border-radius: 4px; padding: 12px; margin: 20px 0; font-family: monospace; font-size: 13px; text-align: left; }
  </style>
</head>
<body>
  <div class="wrap">
    <svg width="64" height="64" viewBox="0 0 100 100" style="margin-bottom:16px"><circle cx="50" cy="50" r="48" fill="#2271b1"/><path fill="#fff" d="M18.8 50c0 14.8 10.3 27.2 24.3 30.5L25.8 32.7C21.4 37.6 18.8 43.5 18.8 50zm49.9-1.9c0-5-1.8-8.5-3.3-11.2-2-3.4-3.9-6.3-3.9-9.7 0-3.8 2.9-7.3 6.9-7.3.2 0 .4 0 .6.1C62.6 15.6 53.6 13 43.7 13c-14.7 0-27.6 6.8-35.9 17.3l27.1 74.3 8.3-22.9-10.4-31.5c1.4-.1 2.7-.2 2.7-.2 1.3-.1 1.1-2-.2-2 0 0-3.9.3-6.4.3-2.4 0-6.3-.3-6.3-.3-1.3 0-1.4 1.9-.2 2 0 0 1.3.1 2.5.2l9.7 26.6-5.8 17.5C18.6 84.7 10 70.8 10 50c0-9.6 3.6-18.4 9.6-25.2L44.8 91c1.7.5 3.4.8 5.2.8 5.7 0 11.1-1.3 16-3.6L44.1 36.8l7.6-20.8c.8 0 1.6-.1 2.4-.1 8.8 0 16.9 3.5 22.9 9.3-.3.2-.5.5-.5.9 0 3.3 1.9 6.2 3.9 9.6 1.8 3.2 3.9 7.2 3.9 12.8 0 9.8-5.7 24.9-15.6 31.6z"/></svg>
    <h1>WordPress Ready for Setup</h1>
    <p>Database configured for this project:</p>
    <div class="db-box">
      Database: <strong>${dbName}</strong><br>
      Host: <strong>127.0.0.1:3306</strong><br>
      User: <strong>root</strong>
    </div>
    <p>You can run WordPress installer or download full WordPress core.</p>
    <a href="https://wordpress.org/download/" target="_blank" class="btn">Download WordPress Core</a>
  </div>
</body>
</html>
<?php
}
`;

    const wpConfig = `<?php
/**
 * C-Script LocalHost Panel WordPress Setup
 * WordPress local configuration
 */
define('DB_NAME', '${dbName}');
define('DB_USER', 'root');
define('DB_PASSWORD', '');
define('DB_HOST', '127.0.0.1:3306');
define('DB_CHARSET', 'utf8mb4');
define('DB_COLLATE', '');

define('AUTH_KEY',         'cscript_local_dev_key_1');
define('SECURE_AUTH_KEY',  'cscript_local_dev_key_2');
define('LOGGED_IN_KEY',    'cscript_local_dev_key_3');
define('NONCE_KEY',        'cscript_local_dev_key_4');

$table_prefix = 'wp_';
define('WP_DEBUG', true);
define('WP_DEBUG_LOG', true);
define('WP_DEBUG_DISPLAY', true);

if (!defined('ABSPATH')) {
    define('ABSPATH', __DIR__ . '/');
}
if (file_exists(ABSPATH . 'wp-settings.php')) {
    require_once ABSPATH . 'wp-settings.php';
}
`;

    const indexPath = path.join(targetDir, 'index.php');
    const configPath = path.join(targetDir, 'wp-config-sample.php');
    const writeOrRepair = (destination, contents, corrupt) => {
      if (!fs.existsSync(destination)) {
        fs.writeFileSync(destination, contents, { encoding: 'utf8', flag: 'wx' });
        return;
      }
      if (!corrupt) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = `${destination}.cscript-backup-${stamp}`;
      const temporary = `${destination}.cscript-repair-${process.pid}-${Date.now()}`;
      fs.writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx' });
      fs.copyFileSync(destination, backup);
      fs.renameSync(temporary, destination);
    };
    writeOrRepair(indexPath, indexPhp, current.wordpressSetupCorrupt?.includes('index.php'));
    writeOrRepair(configPath, wpConfig, current.wordpressSetupCorrupt?.includes('wp-config-sample.php'));
    const setupFilesReady = fs.existsSync(indexPath) && fs.existsSync(configPath);

    return {
      success: setupFilesReady,
      framework: 'wordpress',
      entryFile: 'index.php',
      setupFilesReady,
      dbName,
      message: setupFilesReady
        ? `WordPress starter template ready with database "${dbName}" preset.`
        : 'WordPress setup files could not be repaired.'
    };
  }

  /**
   * Laravel Project Scaffolding
   */
  async _scaffoldLaravel(targetDir, options) {
    const inspected = this.inspectLaravelTarget(targetDir);
    if (!inspected.success) return inspected;
    const root = inspected.root;
    const rootKey = path.resolve(root).toLowerCase();
    if (this.installingRoots.has(rootKey)) return { success: false, error: 'A Laravel installation is already running for this folder.' };
    if (inspected.isLaravel && inspected.dependenciesInstalled) {
      if (!inspected.entryFile) return { success: false, error: 'Laravel was found, but public/index.php is missing. No entry point was selected.' };
      return { success: true, framework: 'laravel', entryFile: inspected.entryFile, alreadyInstalled: true, message: 'Laravel project is ready.' };
    }
    if (!inspected.isLaravel && !inspected.empty) {
      return { success: false, error: 'This folder already contains files but is not a Laravel project. Choose an empty folder or an existing Laravel project.' };
    }

    const phpBinary = String(options.phpBinary || 'php').trim();
    this.installingRoots.add(rootKey);
    let temporaryTarget = null;
    try {
      const composer = await this._ensureComposer(phpBinary, root);
      if (inspected.isLaravel) {
        this.emit('progress', { targetDir: root, stream: 'status', output: 'Installing Laravel Composer dependencies…\n' });
        const result = await this._runComposer(composer, phpBinary, ['install', '--no-interaction', '--prefer-dist'], root, root);
        if (!result.success) return { success: false, error: result.error || 'Composer dependency installation failed.' };
      } else {
        const parent = path.dirname(root);
        const baseName = path.basename(root);
        temporaryTarget = path.join(parent, `.${baseName}.cscript-laravel-${process.pid}-${Date.now()}`);
        if (fs.existsSync(temporaryTarget)) return { success: false, error: 'A temporary Laravel installation folder already exists. Remove or rename it, then retry.' };
        this.emit('progress', { targetDir: root, stream: 'status', output: 'Downloading and installing Laravel into the selected empty folder…\n' });
        const result = await this._runComposer(composer, phpBinary, ['create-project', '--prefer-dist', '--no-interaction', 'laravel/laravel', temporaryTarget], parent, root);
        if (!result.success) return { success: false, error: result.error || 'Laravel installation failed.' };
        const LaravelManager = require('./laravelManager');
        if (!LaravelManager.isLaravelProject(temporaryTarget) ||
            !fs.existsSync(path.join(temporaryTarget, 'vendor', 'autoload.php')) ||
            !fs.existsSync(path.join(temporaryTarget, 'public', 'index.php'))) {
          return { success: false, error: 'Composer finished, but the Laravel project or its dependencies are incomplete.' };
        }
        if (fs.readdirSync(root).length !== 0) {
          return { success: false, error: 'The selected folder changed during installation. Its files were preserved; choose an empty folder and retry.' };
        }
        fs.rmdirSync(root);
        fs.renameSync(temporaryTarget, root);
        temporaryTarget = null;
      }

      const LaravelManager = require('./laravelManager');
      const installedEntry = path.join(root, 'public', 'index.php');
      if (!LaravelManager.isLaravelProject(root) || !fs.existsSync(path.join(root, 'vendor', 'autoload.php')) || !fs.existsSync(installedEntry)) {
        return { success: false, error: 'Laravel installation did not finish correctly. The site was not added.' };
      }
      this.emit('progress', { targetDir: root, stream: 'status', output: 'Laravel is installed and ready to add.\n' });
      return { success: true, framework: 'laravel', entryFile: installedEntry, message: 'Laravel and its Composer dependencies were installed successfully.' };
    } catch (error) {
      return { success: false, error: `Laravel installation failed: ${error.message}` };
    } finally {
      if (temporaryTarget && fs.existsSync(temporaryTarget)) {
        try {
          const parent = path.dirname(root);
          const resolvedTemp = path.resolve(temporaryTarget);
          if (path.dirname(resolvedTemp) === parent && path.basename(resolvedTemp).startsWith(`.${path.basename(root)}.cscript-laravel-`)) {
            fs.rmSync(resolvedTemp, { recursive: true, force: true });
          }
        } catch (cleanupError) {
          console.warn('[FrameworkManager] Could not clean temporary Laravel installation:', cleanupError.message);
        }
      }
      this.installingRoots.delete(rootKey);
      this.cancelledRoots.delete(rootKey);
    }
  }

  /**
   * CodeIgniter 4 Scaffolding
   */
  async _scaffoldCodeIgniter(targetDir, options) {
    const publicDir = path.join(targetDir, 'public');
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }

    const indexPhp = `<?php
// CodeIgniter 4 Entry Point
if (file_exists(__DIR__ . '/../app/Config/Paths.php')) {
    define('FCPATH', __DIR__ . DIRECTORY_SEPARATOR);
    require __DIR__ . '/../app/Config/Paths.php';
    $paths = new Config\\Paths();
    require $paths->systemDirectory . '/Boot.php';
    exit(CodeIgniter\\Boot::bootWeb($paths));
} else {
    echo "<h1>CodeIgniter 4 Ready</h1><p>Run <code>composer create-project codeigniter4/appstarter .</code> in this directory.</p>";
}
`;
    fs.writeFileSync(path.join(publicDir, 'index.php'), indexPhp, 'utf8');

    return {
      success: true,
      framework: 'codeigniter',
      entryFile: 'public/index.php',
      rootOverride: publicDir,
      message: 'CodeIgniter 4 starter skeleton created.'
    };
  }
}

module.exports = FrameworkManager;
