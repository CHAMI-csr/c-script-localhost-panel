/**
 * NginxInstaller - Standalone NGINX Web Server Downloader & Manager
 * Installs and manages the application's own NGINX runtime.
 * Automatically downloads, extracts, and configures standalone NGINX
 * directly into the application's AppData runtime directory.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn, execFile, exec } = require('child_process');
const { EventEmitter } = require('events');

const NGINX_VERSION = '1.26.2';
const NGINX_DOWNLOAD_URL = `https://nginx.org/download/nginx-${NGINX_VERSION}.zip`;

class NginxInstaller extends EventEmitter {
  constructor() {
    super();
    this.userProfile = process.env.USERPROFILE || os.homedir() || '';
    const appData = process.env.APPDATA || (this.userProfile ? path.join(this.userProfile, 'AppData', 'Roaming') : '');
    this.baseDir = path.join(appData, 'c-script-localhost', 'nginx');
    this.exePath = path.join(this.baseDir, 'nginx.exe');
    this.confPath = path.join(this.baseDir, 'conf', 'nginx.conf');
    this.vhostsDir = path.join(this.baseDir, 'conf', 'vhosts');
    this.logsDir = path.join(this.baseDir, 'logs');
    this.tempDir = path.join(this.baseDir, 'temp');

    this._ensureDir(this.baseDir);
    this.removeLegacyBranding();
    this.repairMissingSslReferences();
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    }
  }

  /** Update the old generated fallback page label without replacing user config. */
  removeLegacyBranding() {
    try {
      if (!fs.existsSync(this.confPath)) return false;
      const original = fs.readFileSync(this.confPath, 'utf8');
      const updated = original
        .replace(/Antigravity LocalHost Panel/gi, 'C-Script LocalHost Panel')
        .replace(/Antigravity Dev Suite/gi, 'C-Script LocalHost Panel');
      if (updated === original) return false;
      fs.writeFileSync(this.confPath, updated, 'utf8');
      return true;
    } catch (error) {
      console.warn('[NginxInstaller] Could not update the old generated app label:', error.message);
      return false;
    }
  }

  /**
   * A virtual host with missing certificate files makes nginx -t fail and
   * prevents the whole web server from starting. Keep its HTTP config, but
   * remove the unusable HTTPS listener and certificate directives.
   */
  repairMissingSslReferences() {
    let repaired = 0;
    try {
      if (!fs.existsSync(this.vhostsDir)) return repaired;
      for (const entry of fs.readdirSync(this.vhostsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.conf')) continue;
        const confPath = path.join(this.vhostsDir, entry.name);
        let content;
        try { content = fs.readFileSync(confPath, 'utf8'); } catch (error) { continue; }
        const lines = content.split(/\r?\n/);
        const hasMissingCert = lines.some(line => {
          const match = line.match(/^\s*ssl_certificate(?:_key)?\s+["']?([^"';]+)["']?\s*;/i);
          if (!match || !path.isAbsolute(match[1].trim())) return false;
          return !fs.existsSync(match[1].trim());
        });
        if (!hasMissingCert) continue;

        const repairedContent = lines.filter(line =>
          !/^\s*ssl_certificate(?:_key)?\s+/i.test(line) &&
          !/^\s*listen\b.*\bssl\b/i.test(line)
        ).join('\n');
        fs.writeFileSync(confPath, repairedContent, 'utf8');
        repaired++;
        console.warn(`[NginxInstaller] Disabled SSL settings with missing certificate files in ${entry.name}; HTTP remains available.`);
      }
    } catch (error) {
      console.warn('[NginxInstaller] Could not repair missing SSL certificate settings:', error.message);
    }
    return repaired;
  }

  /**
   * Check if standalone NGINX is installed
   */
  isInstalled() {
    return fs.existsSync(this.exePath);
  }

  /**
   * Check if any nginx.exe is running on the system
   */
  async isRunning() {
    return new Promise((resolve) => {
      exec('tasklist /FI "IMAGENAME eq nginx.exe" /NH', (err, stdout) => {
        if (err || !stdout) return resolve(false);
        resolve(stdout.toLowerCase().includes('nginx.exe'));
      });
    });
  }

  /**
   * Get NGINX version string
   */
  async getVersion() {
    if (!this.isInstalled()) return null;
    return new Promise((resolve) => {
      execFile(this.exePath, ['-v'], { timeout: 4000, windowsHide: true }, (err, stdout, stderr) => {
        const out = stderr || stdout || '';
        const match = out.match(/nginx\/(\d+\.\d+[\.\d]*)/i);
        resolve(match ? `NGINX ${match[1]}` : 'NGINX');
      });
    });
  }

  /**
   * Get full info about NGINX installation and status
   */
  async getInfo() {
    const installed = this.isInstalled();
    const running = await this.isRunning();
    const version = installed ? await this.getVersion() : null;

    return {
      installed,
      running,
      version: version || `NGINX ${NGINX_VERSION}`,
      exePath: installed ? this.exePath : null,
      baseDir: this.baseDir,
      confPath: this.confPath,
      vhostsDir: this.vhostsDir,
      targetVersion: NGINX_VERSION,
      downloadUrl: NGINX_DOWNLOAD_URL
    };
  }

  /**
   * Download and install official NGINX from nginx.org
   */
  async downloadAndInstall() {
    const tempZip = path.join(os.tmpdir(), `nginx_${NGINX_VERSION}_${Date.now()}.zip`);
    const tempExtract = path.join(os.tmpdir(), `nginx_ext_${Date.now()}`);

    this.emit('install-status', { stage: 'downloading', message: `Downloading official NGINX ${NGINX_VERSION}...` });

    try {
      // 1. Download official ZIP
      await this._downloadFile(NGINX_DOWNLOAD_URL, tempZip);

      // 2. Extract ZIP
      this.emit('install-status', { stage: 'extracting', message: `Extracting NGINX ${NGINX_VERSION}...` });
      this._ensureDir(tempExtract);
      await this._extractZip(tempZip, tempExtract);

      // Clean up zip
      try { if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip); } catch (e) {}

      // Locate extracted nginx directory (e.g., tempExtract/nginx-1.26.2)
      let srcDir = tempExtract;
      const subEntries = fs.readdirSync(tempExtract, { withFileTypes: true });
      for (const sub of subEntries) {
        if (sub.isDirectory() && sub.name.toLowerCase().startsWith('nginx')) {
          srcDir = path.join(tempExtract, sub.name);
          break;
        }
      }

      // 3. Copy to destination
      this._ensureDir(this.baseDir);
      fs.cpSync(srcDir, this.baseDir, { recursive: true });

      // Clean up temp extracted
      try { fs.rmSync(tempExtract, { recursive: true, force: true }); } catch (e) {}

      // 4. Configure directories and nginx.conf
      this._ensureDir(this.vhostsDir);
      this._ensureDir(this.logsDir);
      this._ensureDir(this.tempDir);
      this.setupDefaultConf();

      const version = await this.getVersion();
      this.emit('install-status', { stage: 'completed', message: `NGINX ${NGINX_VERSION} installed successfully!` });

      return {
        success: true,
        version: version || `NGINX ${NGINX_VERSION}`,
        exePath: this.exePath,
        vhostsDir: this.vhostsDir
      };
    } catch (err) {
      try { if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip); } catch (e) {}
      try { if (fs.existsSync(tempExtract)) fs.rmSync(tempExtract, { recursive: true, force: true }); } catch (e) {}
      return { success: false, error: err.message };
    }
  }

  /**
   * Setup standard, high-performance development nginx.conf with vhosts support
   */
  setupDefaultConf() {
    this._ensureDir(path.join(this.baseDir, 'conf'));
    this._ensureDir(this.vhostsDir);
    this._ensureDir(this.logsDir);
    this._ensureDir(this.tempDir);

    const confContent = `# C-Script LocalHost Panel - Standalone NGINX Configuration
worker_processes 1;

events {
    worker_connections 1024;
}

http {
    include mime.types;
    default_type application/octet-stream;

    sendfile on;
    keepalive_timeout 65;
    client_max_body_size 128M;

    # Include all virtual hosts configured for running sites (.test domains)
    include vhosts/*.conf;

    # Default fallback server for unmatched requests
    server {
        listen 127.0.0.1:80 default_server;
        server_name _;

        location / {
            default_type text/html;
            return 200 '<!DOCTYPE html><html><head><title>C-Script LocalHost Panel</title><style>body{background:#0d0d14;color:#eee;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}</style></head><body><div style="text-align:center"><h2>C-Script LocalHost Panel</h2><p style="color:#888">Standalone NGINX is running on Port 80.</p></div></body></html>';
        }
    }
}
`;

    try {
      fs.writeFileSync(this.confPath, confContent, 'utf8');
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Start standalone NGINX
   */
  async start() {
    if (!this.isInstalled()) {
      return { success: false, error: 'NGINX is not installed.' };
    }

    const running = await this.isRunning();
    if (running) {
      return { success: true, alreadyRunning: true };
    }

    return new Promise((resolve) => {
      const proc = spawn(this.exePath, ['-p', this.baseDir, '-c', this.confPath], {
        cwd: this.baseDir,
        windowsHide: true,
        detached: true,
        stdio: 'ignore'
      });
      proc.unref();

      setTimeout(async () => {
        const isUp = await this.isRunning();
        resolve({ success: isUp, running: isUp });
      }, 1000);
    });
  }

  /**
   * Reload standalone NGINX configuration
   */
  async reload() {
    if (!this.isInstalled()) return { success: false };
    return new Promise((resolve) => {
      execFile(this.exePath, ['-p', this.baseDir, '-c', this.confPath, '-s', 'reload'], (err) => {
        resolve({ success: !err });
      });
    });
  }

  /**
   * Stop all NGINX processes
   */
  async stop() {
    return new Promise((resolve) => {
      exec('taskkill /F /IM nginx.exe', () => {
        resolve({ success: true });
      });
    });
  }

  /**
   * Download a file via HTTPS with progress events
   */
  _downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return this._downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`Failed to download NGINX (HTTP ${res.statusCode})`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let receivedBytes = 0;
        const fileStream = fs.createWriteStream(destPath);

        res.on('data', (chunk) => {
          receivedBytes += chunk.length;
          if (totalBytes > 0) {
            const percent = Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
            this.emit('download-progress', { percent, receivedBytes, totalBytes });
          }
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close(() => resolve(destPath));
        });

        fileStream.on('error', (err) => {
          try { fs.unlinkSync(destPath); } catch (e) {}
          reject(err);
        });
      });

      req.on('error', (err) => {
        try { fs.unlinkSync(destPath); } catch (e) {}
        reject(err);
      });
    });
  }

  /**
   * Extract zip archive natively using tar.exe
   */
  async _extractZip(zipPath, targetDir) {
    return new Promise((resolve, reject) => {
      const tarProc = spawn('tar.exe', ['-xf', zipPath, '-C', targetDir], { windowsHide: true });
      tarProc.on('exit', (code) => {
        if (code === 0) resolve();
        else {
          // Fallback: PowerShell Expand-Archive
          const psCmd = `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force`;
          const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { windowsHide: true });
          ps.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`Failed to extract with code ${c}`))));
          ps.on('error', reject);
        }
      });
      tarProc.on('error', () => {
        const psCmd = `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force`;
        const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { windowsHide: true });
        ps.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`PowerShell extract error`))));
        ps.on('error', reject);
      });
    });
  }
}

module.exports = NginxInstaller;
