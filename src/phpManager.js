/**
 * PhpManager - Manages PHP built-in server processes
 * Starts/stops PHP servers for local sites
 */
const { EventEmitter } = require('events');
const { spawn, exec, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { repairPhpConfigForBinary } = require('./phpErrorRepair');

class PhpManager extends EventEmitter {
  constructor() {
    super();
    this.servers = {}; // siteId -> { process, port, site }
    this.fastCgiServers = {}; // siteId -> { process, port, site, binary }
    this.fastCgiPorts = new Set();
    this.phpBinary = 'php';
  }

  /** Set custom PHP binary path */
  setPHPBinary(binary) {
    const value = String(binary || 'php').trim().replace(/^(["'])(.*)\1$/, '$2');
    this.phpBinary = value || 'php';
  }

  _usedPorts(extraReserved = []) {
    const used = new Set(Object.values(this.servers).map(s => s.port));
    if (extraReserved) {
      for (const p of extraReserved) {
        if (p && Number(p) > 0) used.add(Number(p));
      }
    }
    return used;
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

  /** Find a free port starting from startPort that is neither active nor reserved */
  async findFreePort(startPort = 8000, extraReserved = []) {
    const used = this._usedPorts(extraReserved);
    for (let port = startPort; port <= 9999; port++) {
      if (used.has(port)) continue;
      if (await this._isPortFree(port)) return port;
    }
    throw new Error('No free ports available');
  }

  /**
   * Returns a physical Windows path to autoindexRouter.php.
   * If packaged in Electron (inside app.asar), extracts/syncs it to AppData
   * so that external native binaries like php.exe can access it without failing.
   */
  getAutoindexRouterPath() {
    try {
      const userProfile = process.env.USERPROFILE || require('os').homedir() || '';
      const appData = process.env.APPDATA || (userProfile ? path.join(userProfile, 'AppData', 'Roaming') : '');
      const scriptsDir = path.join(appData, 'c-script-localhost', 'scripts');
      if (!fs.existsSync(scriptsDir)) {
        fs.mkdirSync(scriptsDir, { recursive: true });
      }
      const targetPath = path.join(scriptsDir, 'autoindexRouter.php');

      // Check if unpacked by asarUnpack
      const unpackedCandidate = path.join(
        __dirname.replace(/app\.asar$/, 'app.asar.unpacked').replace(/app\.asar[\\/]/, 'app.asar.unpacked' + path.sep),
        'autoindexRouter.php'
      );
      if (fs.existsSync(unpackedCandidate) && !unpackedCandidate.includes('app.asar\\') && !unpackedCandidate.includes('app.asar/')) {
        return unpackedCandidate;
      }

      // Read bundled source (fs.readFileSync works from inside asar via Electron's patched fs)
      const bundledPath = path.join(__dirname, 'autoindexRouter.php');
      let needsWrite = !fs.existsSync(targetPath);
      if (!needsWrite && fs.existsSync(bundledPath)) {
        try {
          const bundledContent = fs.readFileSync(bundledPath, 'utf8');
          const targetContent = fs.readFileSync(targetPath, 'utf8');
          if (bundledContent !== targetContent) needsWrite = true;
        } catch (_) {
          needsWrite = true;
        }
      }

      if (needsWrite && fs.existsSync(bundledPath)) {
        const content = fs.readFileSync(bundledPath, 'utf8');
        fs.writeFileSync(targetPath, content, 'utf8');
      }

      if (fs.existsSync(targetPath)) {
        return targetPath;
      }
    } catch (err) {
      console.warn('Failed to ensure physical autoindexRouter.php in AppData:', err);
    }

    const local = path.join(__dirname, 'autoindexRouter.php');
    if (fs.existsSync(local) && !local.includes('.asar')) {
      return local;
    }
    return null;
  }

  getLaravelRouterPath(siteRoot) {
    const publicDir = path.join(siteRoot, 'public');
    const rootKey = crypto.createHash('sha256').update(path.resolve(siteRoot).toLowerCase()).digest('hex').slice(0, 24);
    const userProfile = process.env.USERPROFILE || require('os').homedir() || '';
    const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
    const scriptsDir = path.join(appData, 'c-script-localhost', 'scripts');
    const routerPath = path.join(scriptsDir, `laravel-router-${rootKey}.php`);
    const phpQuote = value => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    const source = `<?php
$publicRoot = ${phpQuote(publicDir)};
$requestPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$relativePath = ltrim(str_replace(['/', '\\\\'], DIRECTORY_SEPARATOR, rawurldecode($requestPath)), DIRECTORY_SEPARATOR);
$candidate = $publicRoot . DIRECTORY_SEPARATOR . $relativePath;
$realPublic = realpath($publicRoot);
$realCandidate = realpath($candidate);
if ($relativePath !== '' && $realPublic && $realCandidate && is_file($realCandidate)) {
    $publicPrefix = rtrim($realPublic, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
    if (stripos($realCandidate, $publicPrefix) === 0) return false;
}
require $publicRoot . DIRECTORY_SEPARATOR . 'index.php';
`;
    fs.mkdirSync(scriptsDir, { recursive: true });
    if (!fs.existsSync(routerPath) || fs.readFileSync(routerPath, 'utf8') !== source) {
      fs.writeFileSync(routerPath, source, 'utf8');
    }
    return routerPath;
  }

  _quoteCmdArg(value) {
    const str = String(value);
    if (!/[\s"]/.test(str)) return str;
    return `"${str.replace(/"/g, '\\"')}"`;
  }

  getEffectiveBinary() {
    const custom = String(this.phpBinary || '').trim();
    if (custom && custom !== 'php' && fs.existsSync(custom)) {
      repairPhpConfigForBinary(custom);
      return custom;
    }
    const userProfile = process.env.USERPROFILE || '';
    const appData = process.env.APPDATA || (userProfile ? path.join(userProfile, 'AppData', 'Roaming') : '');
    const versions = ['php84', 'php85', 'php83', 'php82', 'php81'];
    const roots = [
      path.join(appData, 'c-script-localhost', 'php'),
      path.join(appData, 'antigravity-localhost', 'php')
    ];
    for (const version of versions) {
      for (const root of roots) {
        const binary = path.join(root, version, 'php.exe');
        if (!fs.existsSync(binary)) continue;
        repairPhpConfigForBinary(binary);
        return binary;
      }
    }

    // A stale configured executable must not block the system PATH fallback.
    return 'php';
  }

  getBinaryForSite(site) {
    const requested = String(site?.phpBinary || site?.php || '').trim();
    if (requested && requested.toLowerCase() !== 'php' && fs.existsSync(requested)) {
      repairPhpConfigForBinary(requested);
      return requested;
    }
    return this.getEffectiveBinary();
  }

  _getSiteErrorLogPath(site) {
    const userProfile = process.env.USERPROFILE || require('os').homedir() || '';
    const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
    const directory = path.join(appData, 'c-script-localhost', 'logs', 'php');
    fs.mkdirSync(directory, { recursive: true });
    const safeId = String(site?.id || 'site').replace(/[^a-z0-9_-]/gi, '_');
    return path.join(directory, `${safeId}.log`);
  }

  _needsShell(binary) {
    if (process.platform !== 'win32') return false;
    const bin = binary || this.getEffectiveBinary();
    return !String(bin || '').toLowerCase().endsWith('.exe');
  }

  _spawnPhp(args, cwd, binary) {
    const bin = binary || this.getEffectiveBinary();
    repairPhpConfigForBinary(bin);
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

  _execPhp(args, callback, binaryOverride = null) {
    const bin = binaryOverride || this.getEffectiveBinary();
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
  getVersion(binaryOverride = null) {
    return new Promise((resolve) => {
      const binary = binaryOverride || this.getEffectiveBinary();
      this._execPhp(['--version'], (err, stdout, stderr) => {
        if (err) {
          let error = err.code === 'ENOENT'
            ? `PHP executable not found: ${binary}. Choose php.exe in Settings.`
            : (stderr || err.message || 'Unable to run PHP');
          if (/VCRUNTIME\d+|MSVCP\d+|side-by-side|0xc0000135/i.test(error)) {
            error = 'PHP needs the Microsoft Visual C++ 2015–2022 Redistributable (x64). Install it, then restart the app.';
          }
          resolve({ success: false, available: false, version: null, binary, error: error.trim() });
          return;
        }
        const out = stdout || stderr;
        const match = out.match(/PHP (\d+\.\d+\.\d+)/);
        resolve({
          success: true,
          available: true,
          version: match ? match[1] : 'Unknown',
          binary,
          fullOutput: out.trim()
        });
      }, binary);
    });
  }

  /** Get PHP extensions and config info */
  getInfo() {
    const run = args => new Promise(resolve => this._execPhp(args, (err, stdout, stderr) =>
      resolve({ error: err, output: stdout || '', stderr: stderr || '' })
    ));
    return Promise.all([
      run(['-m']),
      run(['-r', 'echo php_ini_loaded_file();']),
      run(['-r', 'echo PHP_VERSION;'])
    ]).then(([modules, ini, version]) => {
      if (modules.error && ini.error && version.error) {
        return { success: false, error: modules.error.message || 'Unable to run PHP' };
      }
      const outputLines = modules.output.split(/\r?\n/);
      let inModuleSection = false;
      const extensions = [];
      for (const line of outputLines) {
        const trimmed = line.trim();
        if (/^\[(PHP|Zend) Modules\]$/i.test(trimmed)) {
          inModuleSection = true;
          continue;
        }
        if (inModuleSection && /^[a-z][a-z0-9 _.-]*$/i.test(trimmed)) extensions.push(trimmed);
      }
      const warnings = [...new Set([modules.stderr, ini.stderr, version.stderr]
        .flatMap(output => output.split(/\r?\n/))
        .map(line => line.trim())
        .filter(line => /^(Warning|PHP Warning|PHP Startup Warning|Notice):/i.test(line)))];
      return {
        success: true,
        extensions: modules.error ? [] : [...new Set(extensions)],
        iniPath: ini.error ? 'Not found' : (ini.output.trim() || 'None'),
        version: version.error ? 'Unknown' : version.output.trim(),
        warnings
      };
    });
  }

  /** Start a PHP built-in server for a site */
  async start(site, extraReserved = []) {
    if (this.servers[site.id]) {
      return { success: true, port: this.servers[site.id].port, alreadyRunning: true };
    }

    if (!site.root || !fs.existsSync(site.root)) {
      return { success: false, error: `Directory not found: ${site.root}` };
    }

    const requested = site.port && site.port > 0 ? Number(site.port) : null;
    let port;
    try {
      if (requested) {
        if (this._usedPorts(extraReserved).has(requested)) {
          return { success: false, error: `Port ${requested} is reserved or already in use by another site.` };
        }
        if (!(await this._isPortFree(requested))) {
          return { success: false, error: `Port ${requested} is already in use by another application.` };
        }
        port = requested;
      } else {
        port = await this.findFreePort(8000, extraReserved);
      }
    } catch (err) {
      return { success: false, error: err.message };
    }

    let docRoot = site.root;
    let routerArg = null;

    const LaravelManager = require('./laravelManager');
    const isLaravel = LaravelManager.isLaravelProject(site.root);
    if (isLaravel && fs.existsSync(path.join(site.root, 'public', 'index.php'))) {
      docRoot = path.join(site.root, 'public');
      routerArg = this.getLaravelRouterPath(site.root);
    } else if (site.entryFile) {
      const resolvedEntry = path.isAbsolute(site.entryFile)
        ? site.entryFile
        : path.join(site.root, site.entryFile);

      if (fs.existsSync(resolvedEntry)) {
        const relDir = path.relative(site.root, path.dirname(resolvedEntry));
        if (relDir.toLowerCase() === 'public' || relDir.toLowerCase().startsWith('public' + path.sep)) {
          docRoot = path.dirname(resolvedEntry);
          const laravelServerPhp = path.join(site.root, 'server.php');
          if (fs.existsSync(laravelServerPhp)) {
            routerArg = laravelServerPhp;
          }
        } else {
          routerArg = resolvedEntry;
        }
      }
    } else if (fs.existsSync(path.join(site.root, 'public', 'index.php'))) {
      // Auto-detect Laravel / public docRoot even without explicit entryFile
      docRoot = path.join(site.root, 'public');
      const laravelServerPhp = path.join(site.root, 'server.php');
      if (fs.existsSync(laravelServerPhp)) {
        routerArg = laravelServerPhp;
      }
    } else if (site.autoindex !== false) {
      const router = this.getAutoindexRouterPath();
      if (router && fs.existsSync(router)) {
        routerArg = router;
      }
    }

    const errorLog = this._getSiteErrorLogPath(site);
    const args = ['-d', 'log_errors=On', '-d', `error_log=${errorLog}`, '-S', `127.0.0.1:${port}`, '-t', docRoot];
    if (routerArg) {
      args.push(routerArg);
    }
    const bin = this.getBinaryForSite(site);
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

  /** Start a per-site PHP-CGI FastCGI worker for NGINX. */
  async startFastCgi(site) {
    if (this.fastCgiServers[site.id]) return { success: true, port: this.fastCgiServers[site.id].port, alreadyRunning: true };
    const phpBinary = this.getBinaryForSite(site);
    const cgiBinary = path.join(path.dirname(phpBinary), 'php-cgi.exe');
    if (!path.isAbsolute(phpBinary) || !fs.existsSync(cgiBinary)) {
      return { success: false, error: `This PHP version does not include php-cgi.exe beside ${phpBinary}. Choose a Windows PHP NTS package with php-cgi.exe to use NGINX FastCGI.` };
    }
    let port = 9100;
    while (port < 10000) {
      if (this.fastCgiPorts.has(port)) { port++; continue; }
      this.fastCgiPorts.add(port);
      if (await this._isPortFree(port)) break;
      this.fastCgiPorts.delete(port);
      port++;
    }
    if (port >= 10000) return { success: false, error: 'No free per-site FastCGI ports are available (9100–9999).' };

    const errorLog = this._getSiteErrorLogPath(site);
    const proc = spawn(cgiBinary, ['-d', 'log_errors=On', '-d', `error_log=${errorLog}`, '-b', `127.0.0.1:${port}`], { cwd: path.dirname(cgiBinary), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.fastCgiServers[site.id] = { process: proc, port, site, binary: cgiBinary };
    proc.stderr?.on('data', data => this.emit('log', { siteId: site.id, siteName: site.name, message: data.toString().trim(), type: 'error', timestamp: new Date().toISOString() }));
    proc.once('exit', (code, signal) => {
      const wasRunning = !!this.fastCgiServers[site.id];
      delete this.fastCgiServers[site.id];
      this.fastCgiPorts.delete(port);
      if (wasRunning) this.emit('log', { siteId: site.id, siteName: site.name, message: `PHP-CGI FastCGI stopped (exit: ${code ?? signal})`, type: 'warning', timestamp: new Date().toISOString() });
    });
    proc.once('error', () => { if (this.fastCgiServers[site.id]?.process === proc) delete this.fastCgiServers[site.id]; this.fastCgiPorts.delete(port); });

    try {
      await this._waitForListen(port, 5000, proc);
      return { success: true, port, binary: cgiBinary };
    } catch (error) {
      this._killProcess(proc);
      delete this.fastCgiServers[site.id];
      this.fastCgiPorts.delete(port);
      return { success: false, error: `Could not start FastCGI for ${site.name}: ${error.message}` };
    }
  }

  getFastCgiPort(id) {
    return this.fastCgiServers[id]?.port || null;
  }

  stopFastCgi(id) {
    const worker = this.fastCgiServers[id];
    if (!worker) return false;
    delete this.fastCgiServers[id];
    this.fastCgiPorts.delete(worker.port);
    this._killProcess(worker.process);
    return true;
  }

  /** Stop a PHP server by site ID */
  stop(id) {
    this.stopFastCgi(id);
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
    Object.keys(this.fastCgiServers).forEach(id => this.stopFastCgi(id));
  }

  async stopAllAndWait(timeoutMs = 5000) {
    const entries = [...Object.entries(this.servers), ...Object.entries(this.fastCgiServers)];
    this.fastCgiServers = {};
    for (const [id] of entries) delete this.servers[id];
    await Promise.all(entries.map(([, server]) => new Promise(resolve => {
      const proc = server?.process;
      if (!proc || proc.exitCode !== null) return resolve();
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(finish, timeoutMs);
      proc.once('exit', finish);
      if (process.platform === 'win32' && proc.pid) {
        const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', finish);
        killer.once('close', () => { if (proc.exitCode !== null) finish(); });
      } else {
        try { proc.kill('SIGTERM'); } catch (error) { finish(); }
      }
    })));
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
