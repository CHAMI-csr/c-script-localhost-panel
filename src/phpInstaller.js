/**
 * PhpInstaller - Standalone PHP Version Downloader & Environment Manager
 * Enables full independence from Herd / XAMPP / Laragon.
 * Automatically downloads, extracts, and configures standalone PHP runtimes
 * directly into %APPDATA%\antigravity-localhost\php.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const KNOWN_RELEASES = {
  '8.4': {
    label: 'PHP 8.4 (Latest Stable)',
    url: 'https://windows.php.net/downloads/releases/php-8.4.26-nts-Win32-vs17-x64.zip',
    fallbackUrl: 'https://windows.php.net/downloads/releases/archives/php-8.4.26-nts-Win32-vs17-x64.zip',
    folder: 'php84',
    major: '8.4'
  },
  '8.3': {
    label: 'PHP 8.3 (Stable)',
    url: 'https://windows.php.net/downloads/releases/php-8.3.17-nts-Win32-vs17-x64.zip',
    fallbackUrl: 'https://windows.php.net/downloads/releases/archives/php-8.3.17-nts-Win32-vs17-x64.zip',
    folder: 'php83',
    major: '8.3'
  },
  '8.2': {
    label: 'PHP 8.2 (Legacy Support)',
    url: 'https://windows.php.net/downloads/releases/php-8.2.28-nts-Win32-vs17-x64.zip',
    fallbackUrl: 'https://windows.php.net/downloads/releases/archives/php-8.2.28-nts-Win32-vs17-x64.zip',
    folder: 'php82',
    major: '8.2'
  },
  '8.1': {
    label: 'PHP 8.1 (Security Fixes)',
    url: 'https://windows.php.net/downloads/releases/archives/php-8.1.31-nts-Win32-vs16-x64.zip',
    fallbackUrl: 'https://windows.php.net/downloads/releases/archives/php-8.1.31-nts-Win32-vs16-x64.zip',
    folder: 'php81',
    major: '8.1'
  }
};

class PhpInstaller extends EventEmitter {
  constructor() {
    super();
    this.userProfile = process.env.USERPROFILE || os.homedir() || '';
    const appData = process.env.APPDATA || (this.userProfile ? path.join(this.userProfile, 'AppData', 'Roaming') : '');
    this.baseDir = path.join(appData, 'c-script-localhost', 'php');
    this._ensureDir(this.baseDir);
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    }
  }

  /**
   * Get the standalone directory where Antigravity stores PHP runtimes
   */
  getPhpDirectory() {
    return this.baseDir;
  }

  /**
   * Check if Herd currently has any PHP versions installed
   */
  getHerdPhps() {
    const herdBin = path.join(this.userProfile, '.config', 'herd', 'bin');
    const found = [];
    if (!fs.existsSync(herdBin)) return found;

    try {
      const entries = fs.readdirSync(herdBin, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.toLowerCase().startsWith('php')) {
          const exe = path.join(herdBin, entry.name, 'php.exe');
          if (fs.existsSync(exe)) {
            found.push({
              name: entry.name,
              dir: path.join(herdBin, entry.name),
              exe
            });
          }
        }
      }
    } catch (e) {}
    return found;
  }

  /**
   * 1-Click Migration / Protection:
   * Copies Herd's PHP installation into Antigravity's permanent standalone folder
   * so that uninstalling Herd does NOT delete PHP!
   */
  async migrateFromHerd() {
    const herdPhps = this.getHerdPhps();
    if (herdPhps.length === 0) {
      return { success: false, error: 'No Herd PHP installations found to migrate.' };
    }

    const migrated = [];
    for (const h of herdPhps) {
      const targetDir = path.join(this.baseDir, h.name);
      try {
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
          fs.cpSync(h.dir, targetDir, { recursive: true });
          this._configurePhpIni(targetDir);
          migrated.push({
            name: h.name,
            path: path.join(targetDir, 'php.exe')
          });
        } else {
          // Already migrated
          migrated.push({
            name: h.name,
            path: path.join(targetDir, 'php.exe'),
            alreadyExisted: true
          });
        }
      } catch (err) {
        console.warn(`[PhpInstaller] Failed to migrate ${h.name}:`, err.message);
      }
    }

    return {
      success: migrated.length > 0,
      migrated,
      baseDir: this.baseDir
    };
  }

  /**
   * List all standalone PHP versions currently installed in Antigravity storage
   */
  async listInstalled() {
    const list = [];
    if (!fs.existsSync(this.baseDir)) return list;

    try {
      const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const exe = path.join(this.baseDir, entry.name, 'php.exe');
          if (fs.existsSync(exe)) {
            const ver = await this._getBinaryVersion(exe);
            list.push({
              folder: entry.name,
              dir: path.join(this.baseDir, entry.name),
              exe,
              version: ver.version || entry.name,
              fullVersion: ver.fullVersion || '',
              iniPath: path.join(this.baseDir, entry.name, 'php.ini')
            });
          }
        }
      }
    } catch (e) {}
    return list;
  }

  /**
   * List available PHP versions (both installed and downloadable)
   */
  async getVersionCatalog() {
    const installed = await this.listInstalled();
    const installedFolders = new Set(installed.map(i => i.folder.toLowerCase()));

    const herdPhps = this.getHerdPhps();
    const herdAvailable = herdPhps.length > 0;

    const catalog = Object.entries(KNOWN_RELEASES).map(([major, meta]) => {
      const isInst = installedFolders.has(meta.folder.toLowerCase());
      const instData = isInst ? installed.find(i => i.folder.toLowerCase() === meta.folder.toLowerCase()) : null;
      return {
        major,
        label: meta.label,
        folder: meta.folder,
        installed: isInst,
        exePath: instData ? instData.exe : null,
        version: instData ? instData.version : null,
        downloadUrl: meta.url
      };
    });

    return {
      catalog,
      standaloneDir: this.baseDir,
      herdAvailable,
      herdPhps: herdPhps.map(h => ({ name: h.name, exe: h.exe }))
    };
  }

  /**
   * Helper to execute `php.exe -v` and get version info
   */
  _getBinaryVersion(exePath) {
    return new Promise((resolve) => {
      execFile(exePath, ['-v'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) {
          return resolve({ version: null, fullVersion: null });
        }
        const match = stdout.match(/PHP (\d+\.\d+[\.\d]*)/);
        resolve({
          version: match ? `PHP ${match[1]}` : null,
          fullVersion: stdout.split(/\r?\n/)[0]
        });
      });
    });
  }

  /**
   * Download a file via HTTPS with redirect handling and progress events
   */
  _downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
      const makeRequest = (currentUrl, redirectCount = 0) => {
        if (redirectCount > 5) {
          return reject(new Error('Too many redirects while downloading PHP.'));
        }

        const req = https.get(currentUrl, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            let nextUrl = res.headers.location;
            if (nextUrl.startsWith('/')) {
              const u = new URL(currentUrl);
              nextUrl = `${u.origin}${nextUrl}`;
            }
            return makeRequest(nextUrl, redirectCount + 1);
          }

          if (res.statusCode !== 200) {
            return reject(new Error(`Failed to download PHP (HTTP ${res.statusCode})`));
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
      };

      makeRequest(url);
    });
  }

  /**
   * Extract a zip archive natively using Windows built-in tar.exe or PowerShell
   */
  async _extractZip(zipPath, targetDir) {
    this._ensureDir(targetDir);

    return new Promise((resolve, reject) => {
      // First attempt: Windows native tar.exe (fastest, no extra processes)
      const tarProc = spawn('tar.exe', ['-xf', zipPath, '-C', targetDir], { windowsHide: true });
      tarProc.on('exit', (code) => {
        if (code === 0 && fs.existsSync(path.join(targetDir, 'php.exe'))) {
          return resolve();
        }

        // Fallback: PowerShell Expand-Archive
        const psCmd = `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force`;
        const psProc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { windowsHide: true });
        psProc.on('exit', (psCode) => {
          if (psCode === 0 && fs.existsSync(path.join(targetDir, 'php.exe'))) {
            resolve();
          } else {
            reject(new Error(`Failed to extract PHP zip (tar exited with ${code}, powershell with ${psCode})`));
          }
        });
        psProc.on('error', reject);
      });
      tarProc.on('error', () => {
        // If tar.exe is not found, fallback to PowerShell
        const psCmd = `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force`;
        const psProc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { windowsHide: true });
        psProc.on('exit', (psCode) => {
          if (psCode === 0) resolve();
          else reject(new Error(`PowerShell Expand-Archive failed with code ${psCode}`));
        });
        psProc.on('error', reject);
      });
    });
  }

  /**
   * Create or tune php.ini with standard development extensions enabled
   */
  _configurePhpIni(targetDir) {
    const iniPath = path.join(targetDir, 'php.ini');
    let content = '';

    if (fs.existsSync(iniPath)) {
      content = fs.readFileSync(iniPath, 'utf8');
    } else {
      const devIni = path.join(targetDir, 'php.ini-development');
      const prodIni = path.join(targetDir, 'php.ini-production');
      if (fs.existsSync(devIni)) {
        content = fs.readFileSync(devIni, 'utf8');
      } else if (fs.existsSync(prodIni)) {
        content = fs.readFileSync(prodIni, 'utf8');
      }
    }

    if (!content) return false;

    // 1. Ensure extension_dir = "ext"
    if (content.includes('extension_dir = "ext"')) {
      // already set
    } else if (/;?\s*extension_dir\s*=\s*"ext"/.test(content)) {
      content = content.replace(/;?\s*extension_dir\s*=\s*"ext"/g, 'extension_dir = "ext"');
    } else {
      content = `extension_dir = "ext"\r\n` + content;
    }

    // 2. Enable common essential extensions
    const requiredExts = [
      'curl',
      'fileinfo',
      'gd',
      'mbstring',
      'mysqli',
      'openssl',
      'pdo_mysql',
      'pdo_sqlite',
      'sqlite3',
      'zip',
      'exif'
    ];

    for (const ext of requiredExts) {
      const regex = new RegExp(`;\\s*extension\\s*=\\s*${ext}\\b`, 'gi');
      content = content.replace(regex, `extension=${ext}`);
    }

    // 3. Recommended PHP dev limits
    content = content.replace(/upload_max_filesize\s*=\s*[0-9]+[MG]/gi, 'upload_max_filesize = 128M');
    content = content.replace(/post_max_size\s*=\s*[0-9]+[MG]/gi, 'post_max_size = 128M');
    content = content.replace(/memory_limit\s*=\s*[0-9]+[MG]/gi, 'memory_limit = 512M');
    content = content.replace(/max_execution_time\s*=\s*[0-9]+/gi, 'max_execution_time = 300');

    try {
      fs.writeFileSync(iniPath, content, 'utf8');
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Download and install a specific PHP version (e.g. '8.4', '8.3', '8.2')
   */
  async downloadAndInstall(majorVer) {
    const meta = KNOWN_RELEASES[majorVer];
    if (!meta) {
      return { success: false, error: `Unsupported PHP version: ${majorVer}. Supported: 8.4, 8.3, 8.2, 8.1` };
    }

    const targetDir = path.join(this.baseDir, meta.folder);
    const tempZip = path.join(os.tmpdir(), `php_${meta.folder}_${Date.now()}.zip`);

    this.emit('install-status', { stage: 'downloading', message: `Downloading ${meta.label}...` });

    try {
      // 1. Download official ZIP
      try {
        await this._downloadFile(meta.url, tempZip);
      } catch (dlErr) {
        if (meta.fallbackUrl && meta.fallbackUrl !== meta.url) {
          this.emit('install-status', { stage: 'downloading', message: `Retrying from archives mirror...` });
          await this._downloadFile(meta.fallbackUrl, tempZip);
        } else {
          throw dlErr;
        }
      }

      // 2. Extract ZIP
      this.emit('install-status', { stage: 'extracting', message: `Extracting ${meta.label}...` });
      await this._extractZip(tempZip, targetDir);

      // Clean up downloaded zip
      try { if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip); } catch (e) {}

      // 3. Configure php.ini
      this.emit('install-status', { stage: 'configuring', message: `Configuring php.ini and extensions...` });
      this._configurePhpIni(targetDir);

      const phpExe = path.join(targetDir, 'php.exe');
      const verCheck = await this._getBinaryVersion(phpExe);

      this.emit('install-status', { stage: 'completed', message: `${meta.label} installed successfully!` });

      return {
        success: true,
        folder: meta.folder,
        targetDir,
        exePath: phpExe,
        version: verCheck.version || meta.label
      };
    } catch (err) {
      try { if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip); } catch (e) {}
      return { success: false, error: err.message };
    }
  }

  /**
   * Ensure at least one standalone PHP is available in Antigravity storage
   * If none exists, auto-migrates from Herd if available, or returns status
   */
  async ensureStandalonePhp() {
    const installed = await this.listInstalled();
    if (installed.length > 0) {
      return { available: true, path: installed[0].exe, count: installed.length };
    }

    // Check if Herd is available and migrate automatically
    const herdPhps = this.getHerdPhps();
    if (herdPhps.length > 0) {
      const mig = await this.migrateFromHerd();
      if (mig.success && mig.migrated.length > 0) {
        return { available: true, path: mig.migrated[0].path, migrated: true, count: mig.migrated.length };
      }
    }

    return { available: false, needDownload: true };
  }
}

module.exports = PhpInstaller;
