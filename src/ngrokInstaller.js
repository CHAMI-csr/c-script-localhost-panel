'use strict';

/**
 * Installs the official ngrok v3 Windows client into the same app-owned bin
 * directory used by TunnelManager. The installer is shared by Settings and the
 * Share Site first-use prompt so both paths have identical behavior.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const NGROK_DOWNLOAD_URL = 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip';

class NgrokInstaller extends EventEmitter {
  constructor(options = {}) {
    super();
    const userProfile = process.env.USERPROFILE || os.homedir() || '';
    const appData = options.appData || process.env.APPDATA || (userProfile ? path.join(userProfile, 'AppData', 'Roaming') : '');
    this.binDir = path.join(appData, 'c-script-localhost', 'bin');
    this.exePath = path.join(this.binDir, 'ngrok.exe');
    this.https = options.https || https;
    this.execFile = options.execFile || execFile;
    this.installPromise = null;
  }

  isInstalled() {
    return fs.existsSync(this.exePath);
  }

  async getVersion(executable = this.exePath) {
    if (!fs.existsSync(executable)) return null;
    return new Promise(resolve => {
      this.execFile(executable, ['version'], { windowsHide: true, timeout: 10000 }, (error, stdout, stderr) => {
        if (error) return resolve(null);
        const output = String(stdout || stderr || '').trim();
        const match = output.match(/ngrok\s+version\s+([^\s]+)/i);
        resolve(match ? match[1] : (output || null));
      });
    });
  }

  _findSystemExecutable() {
    if (this.isInstalled()) return Promise.resolve(this.exePath);
    if (process.platform !== 'win32') return Promise.resolve(null);
    return new Promise(resolve => {
      this.execFile('where.exe', ['ngrok'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
        const candidate = String(stdout || '').split(/\r?\n/).map(item => item.trim()).find(Boolean);
        resolve(!error && candidate && fs.existsSync(candidate) ? candidate : null);
      });
    });
  }

  async getInfo() {
    const executable = await this._findSystemExecutable();
    return {
      installed: Boolean(executable),
      managed: executable === this.exePath,
      version: executable ? await this.getVersion(executable) : null,
      exePath: executable,
      binDir: this.binDir,
      downloadUrl: NGROK_DOWNLOAD_URL
    };
  }

  downloadAndInstall() {
    if (this.installPromise) return this.installPromise;
    this.installPromise = this._downloadAndInstall().finally(() => { this.installPromise = null; });
    return this.installPromise;
  }

  async _downloadAndInstall() {
    const suffix = `${process.pid}-${Date.now()}`;
    const zipPath = path.join(os.tmpdir(), `cscript-ngrok-${suffix}.zip`);
    const extractDir = path.join(os.tmpdir(), `cscript-ngrok-${suffix}`);
    const stagedExe = path.join(this.binDir, `ngrok-${suffix}.exe`);
    try {
      fs.mkdirSync(this.binDir, { recursive: true });
      this.emit('install-status', { stage: 'downloading', message: 'Downloading official ngrok v3 for Windows…' });
      await this._downloadFile(NGROK_DOWNLOAD_URL, zipPath);

      this.emit('install-status', { stage: 'extracting', message: 'Extracting ngrok…' });
      fs.mkdirSync(extractDir, { recursive: true });
      await this._extractZip(zipPath, extractDir);
      const extractedExe = this._findExecutable(extractDir);
      if (!extractedExe) throw new Error('The downloaded archive did not contain ngrok.exe.');
      fs.copyFileSync(extractedExe, stagedExe);

      const header = Buffer.alloc(2);
      const fd = fs.openSync(stagedExe, 'r');
      try { fs.readSync(fd, header, 0, 2, 0); } finally { fs.closeSync(fd); }
      if (header.toString('ascii') !== 'MZ') throw new Error('The downloaded ngrok executable is invalid.');

      const version = await this.getVersion(stagedExe);
      if (!version) throw new Error('The downloaded ngrok executable could not be verified.');
      if (fs.existsSync(this.exePath)) fs.unlinkSync(this.exePath);
      fs.renameSync(stagedExe, this.exePath);
      this.emit('install-status', { stage: 'completed', message: `ngrok ${version} installed successfully.` });
      return { success: true, version, exePath: this.exePath };
    } catch (error) {
      this.emit('install-status', { stage: 'error', message: error.message });
      return { success: false, error: error.message };
    } finally {
      try { fs.rmSync(zipPath, { force: true }); } catch (_) {}
      try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (_) {}
      try { fs.rmSync(stagedExe, { force: true }); } catch (_) {}
    }
  }

  _findExecutable(folder) {
    const queue = [folder];
    while (queue.length) {
      const current = queue.shift();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) queue.push(fullPath);
        else if (entry.isFile() && entry.name.toLowerCase() === 'ngrok.exe') return fullPath;
      }
    }
    return null;
  }

  _downloadFile(url, destination, redirects = 0) {
    if (redirects > 5) return Promise.reject(new Error('Too many redirects while downloading ngrok.'));
    return new Promise((resolve, reject) => {
      const request = this.https.get(url, response => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          const nextUrl = new URL(response.headers.location, url).toString();
          this._downloadFile(nextUrl, destination, redirects + 1).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Failed to download ngrok (HTTP ${response.statusCode}).`));
          return;
        }
        const totalBytes = Number(response.headers['content-length']) || 0;
        let receivedBytes = 0;
        const output = fs.createWriteStream(destination);
        response.on('data', chunk => {
          receivedBytes += chunk.length;
          if (totalBytes) this.emit('download-progress', {
            percent: Math.min(100, Math.round(receivedBytes * 100 / totalBytes)),
            receivedBytes,
            totalBytes
          });
        });
        response.pipe(output);
        output.once('finish', () => output.close(() => resolve(destination)));
        output.once('error', reject);
      });
      request.setTimeout?.(30000, () => request.destroy(new Error('ngrok download timed out.')));
      request.once('error', reject);
    });
  }

  _extractZip(zipPath, destination) {
    const run = (command, args) => new Promise((resolve, reject) => {
      this.execFile(command, args, { windowsHide: true, timeout: 60000 }, error => error ? reject(error) : resolve());
    });
    return run('tar.exe', ['-xf', zipPath, '-C', destination]).catch(() => run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`
    ]));
  }
}

NgrokInstaller.DOWNLOAD_URL = NGROK_DOWNLOAD_URL;
module.exports = NgrokInstaller;
