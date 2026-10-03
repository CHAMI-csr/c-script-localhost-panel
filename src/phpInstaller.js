/**
 * PhpInstaller - Standalone PHP Version Downloader & Environment Manager
 * Automatically downloads, extracts, and configures standalone PHP runtimes
 * directly into %APPDATA%\antigravity-localhost\php.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { repairPhpConfigForBinary } = require('./phpErrorRepair');

const KNOWN_RELEASES = {
  '8.5': {
    label: 'PHP 8.5 (Latest Stable)',
    url: 'https://downloads.php.net/~windows/releases/archives/php-8.5.11-nts-Win32-vs17-x64.zip',
    fallbackUrl: 'https://windows.php.net/downloads/releases/archives/php-8.5.11-nts-Win32-vs17-x64.zip',
    folder: 'php85',
    major: '8.5'
  },
  '8.4': {
    label: 'PHP 8.4 (Stable)',
    url: 'https://downloads.php.net/~windows/releases/archives/php-8.4.26-nts-Win32-vs17-x64.zip',
    fallbackUrl: 'https://windows.php.net/downloads/releases/archives/php-8.4.26-nts-Win32-vs17-x64.zip',
    folder: 'php84',
    major: '8.4'
  },
  '8.3': {
    label: 'PHP 8.3 (Stable)',
    url: 'https://downloads.php.net/~windows/releases/archives/php-8.3.35-nts-Win32-vs16-x64.zip',
    fallbackUrl: 'https://windows.php.net/downloads/releases/archives/php-8.3.35-nts-Win32-vs16-x64.zip',
    folder: 'php83',
    major: '8.3'
  },
  '8.2': {
    label: 'PHP 8.2 (Legacy Support)',
    url: 'https://downloads.php.net/~windows/releases/archives/php-8.2.34-nts-Win32-vs16-x64.zip',
    fallbackUrl: 'https://windows.php.net/downloads/releases/archives/php-8.2.34-nts-Win32-vs16-x64.zip',
    folder: 'php82',
    major: '8.2'
  },
  '8.1': {
    label: 'PHP 8.1 (Security Fixes)',
    url: 'https://downloads.php.net/~windows/releases/archives/php-8.1.34-nts-Win32-vs16-x64.zip',
    fallbackUrl: 'https://windows.php.net/downloads/releases/archives/php-8.1.34-nts-Win32-vs16-x64.zip',
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
            repairPhpConfigForBinary(exe);
            const ver = await this._getBinaryVersion(exe);
            // Do not tell the UI a broken PHP folder is installed and ready to use.
            if (!ver.version) continue;
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
      standaloneDir: this.baseDir
    };
  }

  /**
   * Helper to execute `php.exe -v` and get version info
   */
  _getBinaryVersion(exePath) {
    return new Promise((resolve) => {
      execFile(exePath, ['-v'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n').trim();
        const errorMessage = err?.code === 'ENOENT'
          ? 'PHP could not start. A required Windows runtime DLL may be missing.'
          : (err?.message || 'PHP did not return version information.');
        if (err || !output) {
          return resolve({ version: null, fullVersion: null, error: errorMessage });
        }
        const match = output.match(/PHP (\d+\.\d+[\.\d]*)/);
        resolve({
          version: match ? `PHP ${match[1]}` : null,
          fullVersion: output.split(/\r?\n/)[0],
          error: match ? null : errorMessage
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
            const nextUrl = new URL(res.headers.location, currentUrl).toString();
            res.resume();
            return makeRequest(nextUrl, redirectCount + 1);
          }

          if (res.statusCode !== 200) {
            res.resume();
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
            if (psCode === 0 && fs.existsSync(path.join(targetDir, 'php.exe'))) resolve();
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

    // A migrated php.ini may contain the same enabled module more than once.
    // Keep the first active declaration; PHP reports later ones as startup warnings.
    const seenExtensions = new Set();
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    content = content.split(/\r?\n/).map(line => {
      const match = line.match(/^(\s*)(;?)\s*(extension|zend_extension)\s*=\s*(.*?)\s*$/i);
      if (!match || match[2] === ';') return line;
      const value = match[4].replace(/^["']|["']$/g, '').trim();
      const name = path.basename(value).replace(/^php_/i, '').replace(/\.dll$/i, '').toLowerCase();
      const key = `${match[3].toLowerCase()}:${name}`;
      if (seenExtensions.has(key)) {
        return `; Disabled duplicate PHP extension by C-Script LocalHost Panel: ${line.trim()}`;
      }
      seenExtensions.add(key);
      return line;
    }).join(lineEnding);

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
      return { success: false, error: `Unsupported PHP version: ${majorVer}. Supported: ${Object.keys(KNOWN_RELEASES).join(', ')}` };
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
          try {
            await this._downloadFile(meta.fallbackUrl, tempZip);
          } catch (fallbackErr) {
            throw new Error(`${dlErr.message}; archive mirror failed: ${fallbackErr.message}`);
          }
        } else {
          throw dlErr;
        }
      }

      // 2. Extract ZIP
      this.emit('install-status', { stage: 'extracting', message: `Extracting ${meta.label}...` });
      await this._extractZip(tempZip, targetDir);

      // PHP's Windows binaries require the MSVC runtime. Bundle it locally so
      // PHP works on machines that don't have the VC++ Redistributable installed.
      const bundledDir = process.resourcesPath
        ? path.join(process.resourcesPath, 'bundled', 'vc-runtime')
        : path.join(__dirname, '..', 'resources', 'bundled', 'vc-runtime');
      const vcRuntimeFiles = [
        'vcruntime140.dll', 'vcruntime140_1.dll', 'vcruntime140_threads.dll',
        'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll',
        'msvcp140_atomic_wait.dll', 'msvcp140_codecvt_ids.dll'
      ];
      const missingRuntimeFiles = vcRuntimeFiles.filter(file => !fs.existsSync(path.join(bundledDir, file)));
      if (missingRuntimeFiles.length) {
        throw new Error(`PHP was downloaded, but its bundled Visual C++ runtime is missing: ${missingRuntimeFiles.join(', ')}`);
      }
      for (const file of vcRuntimeFiles) {
        fs.copyFileSync(path.join(bundledDir, file), path.join(targetDir, file));
      }

      // Clean up downloaded zip
      try { if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip); } catch (e) {}

      // 3. Configure php.ini
      this.emit('install-status', { stage: 'configuring', message: `Configuring php.ini and extensions...` });
      if (!this._configurePhpIni(targetDir)) {
        throw new Error('PHP was downloaded, but php.ini could not be created or configured. Check write permissions in the PHP folder.');
      }

      const phpExe = path.join(targetDir, 'php.exe');
      repairPhpConfigForBinary(phpExe);
      const verCheck = await this._getBinaryVersion(phpExe);
      if (!verCheck.version) {
        throw new Error(`PHP was extracted but could not be verified: ${verCheck.error || 'php.exe did not report a version.'}`);
      }

      this.emit('install-status', { stage: 'completed', message: `${meta.label} installed successfully!` });

      return {
        success: true,
        folder: meta.folder,
        targetDir,
        exePath: phpExe,
        version: verCheck.version
      };
    } catch (err) {
      try { if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip); } catch (e) {}
      return { success: false, error: err.message };
    }
  }

  /**
   * Ensure at least one standalone PHP is available in app storage.
   */
  async ensureStandalonePhp() {
    const installed = await this.listInstalled();
    if (installed.length > 0) {
      return { available: true, path: installed[0].exe, count: installed.length };
    }

    return { available: false, needDownload: true };
  }
}

module.exports = PhpInstaller;
