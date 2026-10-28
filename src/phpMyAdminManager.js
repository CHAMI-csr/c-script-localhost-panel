'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const SUPPORTED_VERSIONS = Object.freeze(['5.2.3', '5.2.2']);
const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;

function phpString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function powerShellString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

class PhpMyAdminManager extends EventEmitter {
  constructor({ baseDir, phpManager, phpInstaller } = {}) {
    super();
    const profile = process.env.USERPROFILE || os.homedir();
    const appData = process.env.APPDATA || path.join(profile, 'AppData', 'Roaming');
    this.baseDir = baseDir || path.join(appData, 'c-script-localhost', 'phpmyadmin');
    this.phpManager = phpManager || null;
    this.phpInstaller = phpInstaller || null;
    this.downloadRequests = new Set();
    this.installations = new Map();
    this.server = null;
    this.serverStart = null;
  }

  _versionRoot(version) {
    if (!SUPPORTED_VERSIONS.includes(String(version))) throw new Error('Choose a supported stable phpMyAdmin version.');
    return path.join(this.baseDir, String(version));
  }

  _isInstalled(version) {
    const root = this._versionRoot(version);
    return fs.existsSync(path.join(root, 'index.php')) && fs.existsSync(path.join(root, 'libraries', 'classes', 'Version.php'));
  }

  status(version = SUPPORTED_VERSIONS[0]) {
    let safeVersion = String(version || SUPPORTED_VERSIONS[0]);
    if (!SUPPORTED_VERSIONS.includes(safeVersion)) safeVersion = SUPPORTED_VERSIONS[0];
    return {
      success: true,
      version: safeVersion,
      installed: this._isInstalled(safeVersion),
      installedVersions: SUPPORTED_VERSIONS.filter(item => this._isInstalled(item)),
      running: Boolean(this.server?.child && this.server.child.exitCode === null),
      runningVersion: this.server?.version || null,
      url: this.server?.url || null
    };
  }

  paths(version = SUPPORTED_VERSIONS[0]) {
    let root;
    try { root = this._versionRoot(version); }
    catch (error) { return { success: false, error: error.message }; }
    const configPath = path.join(root, 'config.inc.php');
    return {
      success: true,
      version: String(version),
      baseDir: this.baseDir,
      versionDir: root,
      configPath,
      installed: this._isInstalled(version),
      configExists: fs.existsSync(configPath)
    };
  }

  async install(version = SUPPORTED_VERSIONS[0]) {
    const selected = String(version);
    const target = this._versionRoot(selected);
    if (this._isInstalled(selected)) {
      this._ensureConfig(target);
      return { success: true, version: selected, alreadyInstalled: true, path: target };
    }
    if (this.installations.has(selected)) return this.installations.get(selected);

    const operation = this._installVersion(selected, target);
    this.installations.set(selected, operation);
    try { return await operation; }
    finally { this.installations.delete(selected); }
  }

  async _installVersion(version, target) {
    const archiveName = `phpMyAdmin-${version}-all-languages.zip`;
    const releaseRoot = `https://files.phpmyadmin.net/phpMyAdmin/${version}`;
    const archiveUrl = `${releaseRoot}/${archiveName}`;
    const checksumUrl = `${archiveUrl}.sha256`;
    const staging = path.join(this.baseDir, `.install-${version}-${process.pid}-${Date.now()}`);
    const archivePath = path.join(staging, archiveName);
    const extractPath = path.join(staging, 'extract');

    try {
      fs.mkdirSync(staging, { recursive: true });
      this.emit('progress', { version, stage: 'download', text: `Downloading phpMyAdmin ${version}…`, percent: 0 });
      const expectedHash = await this._downloadText(checksumUrl, 4096);
      const expected = expectedHash.match(/\b[a-f0-9]{64}\b/i)?.[0]?.toLowerCase();
      if (!expected) throw new Error('The official phpMyAdmin checksum could not be read.');
      await this._downloadFile(archiveUrl, archivePath, version);
      const actual = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
      if (actual !== expected) throw new Error('The phpMyAdmin archive failed its SHA-256 check and was discarded.');

      this.emit('progress', { version, stage: 'extract', text: 'Verifying and extracting the official archive…', percent: 100 });
      fs.mkdirSync(extractPath, { recursive: true });
      await this._extractZip(archivePath, extractPath);
      const extractedRoot = fs.readdirSync(extractPath, { withFileTypes: true })
        .filter(item => item.isDirectory())
        .map(item => path.join(extractPath, item.name))
        .find(folder => fs.existsSync(path.join(folder, 'index.php')) && fs.existsSync(path.join(folder, 'libraries', 'classes', 'Version.php')));
      if (!extractedRoot) throw new Error('The downloaded archive did not contain a complete phpMyAdmin installation.');

      this._ensureConfig(extractedRoot);
      if (fs.existsSync(target)) {
        if (this._isInstalled(version)) return { success: true, version, alreadyInstalled: true, path: target };
        throw new Error(`An incomplete phpMyAdmin ${version} folder already exists. Remove or rename it before reinstalling.`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(extractedRoot, target);
      if (!this._isInstalled(version)) throw new Error('phpMyAdmin installation verification failed.');
      this.emit('progress', { version, stage: 'complete', text: `phpMyAdmin ${version} is installed.`, percent: 100 });
      return { success: true, version, path: target };
    } catch (error) {
      this.emit('progress', { version, stage: 'error', text: error.message, percent: 0 });
      return { success: false, error: error.message };
    } finally {
      try { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
    }
  }

  _ensureConfig(root, mysql = {}) {
    const configPath = path.join(root, 'config.inc.php');
    const host = String(mysql.host || '127.0.0.1').trim() || '127.0.0.1';
    const port = Number.isInteger(Number(mysql.port)) && Number(mysql.port) > 0 && Number(mysql.port) <= 65535
      ? Number(mysql.port)
      : 3306;
    if (fs.existsSync(configPath)) {
      const existing = fs.readFileSync(configPath, 'utf8');
      // Only update a config generated by this app. Preserve user-edited configs.
      if (existing.includes('Generated by C-Script LocalHost Panel. Local phpMyAdmin configuration.')) {
        const updated = existing
          .replace(/\$cfg\[['"]Servers['"]\]\[\$i\]\[['"]host['"]\]\s*=\s*(['"]).*?\1\s*;/, `$cfg['Servers'][$i]['host'] = ${phpString(host)};`)
          .replace(/\$cfg\[['"]Servers['"]\]\[\$i\]\[['"]port['"]\]\s*=\s*(['"]).*?\1\s*;/, `$cfg['Servers'][$i]['port'] = '${port}';`);
        fs.writeFileSync(configPath, updated, 'utf8');
      }
      return configPath;
    }
    const secret = crypto.randomBytes(32).toString('hex');
    const content = `<?php
/* Generated by C-Script LocalHost Panel. Local phpMyAdmin configuration. */
$cfg['blowfish_secret'] = ${phpString(secret)};
$i = 0;
$i++;
$cfg['Servers'][$i]['auth_type'] = 'cookie';
$cfg['Servers'][$i]['host'] = ${phpString(host)};
$cfg['Servers'][$i]['port'] = '${port}';
$cfg['Servers'][$i]['connect_type'] = 'tcp';
$cfg['Servers'][$i]['AllowNoPassword'] = true;
$cfg['Servers'][$i]['compress'] = false;
$cfg['UploadDir'] = '';
$cfg['SaveDir'] = '';
`;
    fs.writeFileSync(configPath, content, { encoding: 'utf8', flag: 'wx' });
    return configPath;
  }

  _downloadText(urlString, maxBytes, redirects = 0) {
    return new Promise((resolve, reject) => {
      const requestUrl = new URL(urlString);
      if (requestUrl.protocol !== 'https:' || requestUrl.hostname !== 'files.phpmyadmin.net') {
        return reject(new Error('phpMyAdmin downloads are restricted to the official files.phpmyadmin.net host.'));
      }
      const request = https.get(requestUrl, response => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirects >= 4) return reject(new Error('The phpMyAdmin checksum download redirected too many times.'));
          const redirected = new URL(response.headers.location, requestUrl);
          if (redirected.hostname !== 'files.phpmyadmin.net' || redirected.protocol !== 'https:') return reject(new Error('The checksum download redirected to an untrusted host.'));
          return resolve(this._downloadText(redirected.toString(), maxBytes, redirects + 1));
        }
        if (response.statusCode !== 200) { response.resume(); return reject(new Error(`Checksum download returned HTTP ${response.statusCode}.`)); }
        let body = '';
        let size = 0;
        response.setEncoding('utf8');
        response.on('data', chunk => {
          size += Buffer.byteLength(chunk);
          if (size > maxBytes) { request.destroy(new Error('Checksum response exceeded the safety limit.')); return; }
          body += chunk;
        });
        response.once('end', () => resolve(body));
        response.once('error', reject);
      });
      this.downloadRequests.add(request);
      request.once('close', () => this.downloadRequests.delete(request));
      request.setTimeout(30000, () => request.destroy(new Error('Timed out downloading the phpMyAdmin checksum.')));
      request.once('error', reject);
    });
  }

  _downloadFile(urlString, destination, version, redirects = 0) {
    return new Promise((resolve, reject) => {
      let requestUrl;
      try { requestUrl = new URL(urlString); } catch (_) { return reject(new Error('Invalid phpMyAdmin download URL.')); }
      if (requestUrl.protocol !== 'https:' || requestUrl.hostname !== 'files.phpmyadmin.net') {
        return reject(new Error('phpMyAdmin downloads are restricted to the official files.phpmyadmin.net host.'));
      }
      if (redirects > 4) return reject(new Error('The phpMyAdmin download redirected too many times.'));
      const request = https.get(requestUrl, response => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          const redirected = new URL(response.headers.location, requestUrl);
          if (redirected.protocol !== 'https:' || redirected.hostname !== 'files.phpmyadmin.net') return reject(new Error('The phpMyAdmin archive redirected to an untrusted host.'));
          return resolve(this._downloadFile(redirected.toString(), destination, version, redirects + 1));
        }
        if (response.statusCode !== 200) { response.resume(); return reject(new Error(`phpMyAdmin download returned HTTP ${response.statusCode}.`)); }
        const total = Number(response.headers['content-length']) || 0;
        if (total > MAX_ARCHIVE_BYTES) { response.resume(); return reject(new Error('phpMyAdmin archive exceeded the 40 MiB safety limit.')); }
        const output = fs.createWriteStream(destination, { flags: 'wx' });
        let received = 0;
        response.on('data', chunk => {
          received += chunk.length;
          if (received > MAX_ARCHIVE_BYTES) request.destroy(new Error('phpMyAdmin archive exceeded the 40 MiB safety limit.'));
          this.emit('progress', { version, stage: 'download', text: `Downloading phpMyAdmin ${version}…`, received, total, percent: total ? Math.min(100, received / total * 100) : 0 });
        });
        response.pipe(output);
        output.once('finish', () => output.close(() => resolve({ received, total })));
        output.once('error', reject);
        response.once('error', reject);
      });
      this.downloadRequests.add(request);
      request.once('close', () => this.downloadRequests.delete(request));
      request.setTimeout(30000, () => request.destroy(new Error('Timed out downloading phpMyAdmin.')));
      request.once('error', reject);
    });
  }

  _extractZip(archivePath, destination) {
    if (process.platform !== 'win32') return Promise.reject(new Error('phpMyAdmin extraction is currently supported on Windows only.'));
    const psQuote = powerShellString;
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `$zipPath = ${psQuote(archivePath)}`,
      `$destination = [IO.Path]::GetFullPath(${psQuote(destination)}).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar`,
      '$archive = [IO.Compression.ZipFile]::OpenRead($zipPath)',
      'try {',
      '  foreach ($entry in $archive.Entries) {',
      '    $entryPath = [IO.Path]::GetFullPath([IO.Path]::Combine($destination, $entry.FullName))',
      '    if (-not $entryPath.StartsWith($destination, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe path in phpMyAdmin archive." }',
      '  }',
      '} finally { $archive.Dispose() }',
      '[IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $destination)',
      'exit 0'
    ].join('\r\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const command = fs.existsSync(powershell) ? powershell : 'powershell.exe';
    return new Promise((resolve, reject) => {
      const child = spawn(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      });
      const job = { child, targetDir: destination };
      this.extractJob = job;
      let stderr = '';
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-3000); });
      child.once('error', error => { this.extractJob = null; reject(new Error(`Could not start the Windows archive extractor: ${error.message}`)); });
      child.once('close', code => {
        this.extractJob = null;
        if (code === 0) resolve();
        else reject(new Error(`Could not extract phpMyAdmin archive. ${stderr.trim()}`.trim()));
      });
    });
  }

  async _findCompatiblePhpBinary() {
    if (!this.phpManager) throw new Error('PHP manager is not ready.');
    const profile = process.env.USERPROFILE || os.homedir();
    const appData = process.env.APPDATA || path.join(profile, 'AppData', 'Roaming');
    const roots = [path.join(appData, 'c-script-localhost', 'php'), path.join(appData, 'antigravity-localhost', 'php')];
    const candidates = [];
    for (const version of ['php83', 'php82', 'php81', 'php80', 'php74']) {
      for (const root of roots) candidates.push(path.join(root, version, 'php.exe'));
    }
    if (this.phpManager.phpBinary) candidates.push(this.phpManager.phpBinary);
    candidates.push(this.phpManager.getEffectiveBinary(), 'php');
    for (const binary of [...new Set(candidates.filter(Boolean))]) {
      if (binary !== 'php' && !fs.existsSync(binary)) continue;
      const result = await this.phpManager.getVersion(binary);
      if (!result?.success || !result.version) continue;
      const match = String(result.version).match(/^(\d+)\.(\d+)/);
      if (!match) continue;
      const major = Number(match[1]);
      const minor = Number(match[2]);
      if ((major > 7 || (major === 7 && minor >= 2)) && (major < 8 || (major === 8 && minor < 4))) {
        const managedRoot = this.phpInstaller?.getPhpDirectory?.();
        if (managedRoot) {
          const relative = path.relative(path.resolve(managedRoot), path.resolve(binary));
          const isManaged = relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
          if (isManaged) {
            try { this.phpInstaller._configurePhpIni(path.dirname(binary)); } catch (_) {}
          }
        }
        if (await this._hasMysqli(binary)) return binary;
      }
    }
    if (this.phpInstaller && process.platform === 'win32') {
      this.emit('progress', { stage: 'php-install', text: 'Installing the compatible PHP 8.3 runtime required by phpMyAdmin…', percent: 0 });
      const forwardProgress = data => {
        const percent = Number(data?.percent);
        this.emit('progress', {
          stage: 'php-install',
          text: data?.message || (Number.isFinite(percent) ? `Installing PHP 8.3… ${Math.round(percent)}%` : 'Installing PHP 8.3…'),
          percent: Number.isFinite(percent) ? percent : 0
        });
      };
      this.phpInstaller.on('download-progress', forwardProgress);
      this.phpInstaller.on('install-status', forwardProgress);
      try {
        const install = await this.phpInstaller.downloadAndInstall('8.3');
        if (!install?.success) throw new Error(install?.error || 'The PHP 8.3 runtime could not be installed.');
        const binary = install.exePath || path.join(this.phpInstaller.getPhpDirectory(), 'php83', 'php.exe');
        if (await this._hasMysqli(binary)) return binary;
        throw new Error('PHP 8.3 was installed, but mysqli could not be enabled. Repair PHP 8.3 from Settings and try again.');
      } catch (error) {
        throw new Error(`Could not prepare phpMyAdmin’s PHP runtime. ${error.message}`);
      } finally {
        this.phpInstaller.removeListener('download-progress', forwardProgress);
        this.phpInstaller.removeListener('install-status', forwardProgress);
      }
    }
    throw new Error('phpMyAdmin 5.2.x requires PHP 7.2–8.3 with the mysqli extension enabled. Install PHP 8.3 or 8.2 from Settings, then try again.');
  }

  _hasMysqli(binary) {
    return new Promise(resolve => {
      let output = '';
      let settled = false;
      const child = spawn(binary, ['-m'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        finish(false);
      }, 8000);
      child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-20000); });
      child.once('error', () => finish(false));
      child.once('close', code => finish(code === 0 && /^mysqli$/im.test(output)));
    });
  }

  _waitForHttp(url, child, timeoutMs = 10000) {
    const end = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const check = () => {
        if (child.exitCode !== null) return reject(new Error('The phpMyAdmin PHP server stopped before it became ready.'));
        const request = http.get(url, response => {
          response.resume();
          if (response.statusCode < 500) resolve();
          else if (Date.now() >= end) reject(new Error(`phpMyAdmin returned HTTP ${response.statusCode}.`));
          else setTimeout(check, 200);
        });
        request.setTimeout(1500, () => request.destroy());
        request.once('error', () => {
          if (Date.now() >= end) reject(new Error('The phpMyAdmin local server did not become ready.'));
          else setTimeout(check, 200);
        });
      };
      check();
    });
  }

  async open(version = SUPPORTED_VERSIONS[0], mysql = {}) {
    if (this.serverStart) {
      await this.serverStart;
      if (this.server?.child && this.server.child.exitCode === null && this.server.version === version) {
        return { success: true, version, url: this.server.url, port: this.server.port, alreadyRunning: true };
      }
    }
    const installed = await this.install(version);
    if (!installed.success) return installed;
    const root = this._versionRoot(version);
    this._ensureConfig(root, mysql);
    if (this.server?.child && this.server.child.exitCode === null && this.server.version === version) {
      return { success: true, version, url: this.server.url, port: this.server.port, alreadyRunning: true };
    }
    if (this.server?.child && this.server.child.exitCode === null) await this.stop();
    const binary = await this._findCompatiblePhpBinary();
    const port = this.phpManager ? await this.phpManager.findFreePort(8765) : 8765;
    const url = `http://127.0.0.1:${port}/`;
    const child = spawn(binary, ['-S', `127.0.0.1:${port}`, '-t', root], {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    this.server = { child, version, port, url, binary };
    this.serverStart = new Promise((resolve, reject) => {
      let stderr = '';
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-3000); });
      child.once('error', error => reject(new Error(`Could not start PHP for phpMyAdmin: ${error.message}`)));
      this._waitForHttp(url, child).then(resolve, error => {
        if (stderr.trim()) error.message += ` ${stderr.trim()}`;
        reject(error);
      });
    });
    child.once('exit', () => { if (this.server?.child === child) this.server = null; });
    try {
      await this.serverStart;
      return { success: true, version, url, phpBinary: binary, port };
    } catch (error) {
      this._kill(child);
      this.server = null;
      return { success: false, error: error.message };
    } finally {
      this.serverStart = null;
    }
  }

  _kill(child) {
    if (!child || child.exitCode !== null) return;
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.unref();
    } else {
      try { child.kill('SIGTERM'); } catch (_) {}
    }
  }

  async stop() {
    const server = this.server;
    if (!server?.child) return { success: true, stopped: false };
    this.server = null;
    this._kill(server.child);
    await Promise.race([
      new Promise(resolve => server.child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
    return { success: true, stopped: true };
  }

  async stopAll() {
    const active = [...this.installations.values()];
    for (const request of this.downloadRequests) {
      try { request.destroy(new Error('phpMyAdmin installation stopped because the app is closing.')); } catch (_) {}
    }
    this._kill(this.extractJob?.child);
    await this.stop();
    await Promise.allSettled(active);
  }
}

module.exports = PhpMyAdminManager;
module.exports.SUPPORTED_VERSIONS = SUPPORTED_VERSIONS;
