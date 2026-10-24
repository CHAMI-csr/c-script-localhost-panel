/**
 * PhpInstaller - Standalone PHP Version Downloader & Environment Manager
 * Automatically downloads, extracts, and configures standalone PHP runtimes
 * directly into the application's AppData PHP runtime directory.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { repairPhpConfigForBinary } = require('./phpErrorRepair');

const KNOWN_RELEASES = {
  '8.5': {
    label: 'PHP 8.5 (Latest Stable)',
    latestVersion: '8.5.11',
    activeSupportUntil: '2027-12-31',
    securitySupportUntil: '2029-12-31',
    url: 'https://downloads.php.net/~windows/releases/archives/php-8.5.11-nts-Win32-vs17-x64.zip',
    fallbackUrl: 'https://windows.php.net/downloads/releases/archives/php-8.5.11-nts-Win32-vs17-x64.zip',
    folder: 'php85',
    major: '8.5'
  },
  '8.4': {
    label: 'PHP 8.4 (Stable)',
    latestVersion: '8.4.26',
    activeSupportUntil: '2026-12-31',
    securitySupportUntil: '2028-12-31',
    url: 'https://downloads.php.net/~windows/releases/archives/php-8.4.26-nts-Win32-vs17-x64.zip',
    fallbackUrl: 'https://windows.php.net/downloads/releases/archives/php-8.4.26-nts-Win32-vs17-x64.zip',
    folder: 'php84',
    major: '8.4'
  },
  '8.3': {
    label: 'PHP 8.3',
    latestVersion: '8.3.35',
    activeSupportUntil: '2025-12-31',
    securitySupportUntil: '2027-12-31',
    url: 'https://downloads.php.net/~windows/releases/archives/php-8.3.35-nts-Win32-vs16-x64.zip',
    fallbackUrl: 'https://windows.php.net/downloads/releases/archives/php-8.3.35-nts-Win32-vs16-x64.zip',
    folder: 'php83',
    major: '8.3'
  },
  '8.2': {
    label: 'PHP 8.2',
    latestVersion: '8.2.34',
    activeSupportUntil: '2024-12-31',
    securitySupportUntil: '2026-12-31',
    url: 'https://downloads.php.net/~windows/releases/archives/php-8.2.34-nts-Win32-vs16-x64.zip',
    fallbackUrl: 'https://windows.php.net/downloads/releases/archives/php-8.2.34-nts-Win32-vs16-x64.zip',
    folder: 'php82',
    major: '8.2'
  },
  '8.1': {
    label: 'PHP 8.1',
    latestVersion: '8.1.34',
    activeSupportUntil: '2023-11-25',
    securitySupportUntil: '2025-12-31',
    url: 'https://downloads.php.net/~windows/releases/archives/php-8.1.34-nts-Win32-vs16-x64.zip',
    fallbackUrl: 'https://windows.php.net/downloads/releases/archives/php-8.1.34-nts-Win32-vs16-x64.zip',
    folder: 'php81',
    major: '8.1'
  }
};

function parsePhpVersion(value) {
  const match = String(value || '').match(/(?:PHP\s*)?(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  return {
    version: `${match[1]}.${match[2]}.${match[3] || '0'}`,
    major: `${match[1]}.${match[2]}`,
    parts: [Number(match[1]), Number(match[2]), Number(match[3] || 0)]
  };
}

function comparePhpVersions(left, right) {
  const a = parsePhpVersion(left)?.parts || [0, 0, 0];
  const b = parsePhpVersion(right)?.parts || [0, 0, 0];
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function findWindowsPhpReleases(payload) {
  const candidates = [];
  const visit = value => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;

    const strings = Object.entries(value)
      .filter(([, item]) => typeof item === 'string');
    for (const [key, item] of strings) {
      for (const possibleName of [key, item]) {
        const file = String(possibleName).match(/php-(\d+\.\d+\.\d+)-nts-Win32-vs\d+-x64\.zip/i);
        if (!file) continue;
        const checksumEntry = strings.find(([checksumKey, checksumValue]) =>
          /sha-?256|checksum/i.test(checksumKey) && /^[a-f\d]{64}$/i.test(checksumValue));
        candidates.push({
          major: file[1].split('.').slice(0, 2).join('.'),
          version: file[1],
          filename: file[0],
          sha256: checksumEntry ? checksumEntry[1].toLowerCase() : null
        });
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(payload);

  const latest = {};
  for (const candidate of candidates) {
    if (!KNOWN_RELEASES[candidate.major]) continue;
    if (!latest[candidate.major] || comparePhpVersions(candidate.version, latest[candidate.major].version) > 0) {
      latest[candidate.major] = candidate;
    }
  }
  return latest;
}

function getPhpSecurityStatus(version, now = new Date()) {
  const parsed = parsePhpVersion(version);
  if (!parsed) {
    return {
      status: 'unknown', severity: 'warning', updateAvailable: false,
      message: 'The PHP version could not be identified. Verify that it still receives security updates.'
    };
  }

  const release = KNOWN_RELEASES[parsed.major];
  if (!release) {
    return {
      version: parsed.version, major: parsed.major, status: 'unsupported', severity: 'critical',
      updateAvailable: false,
      message: `PHP ${parsed.major} is outside this app's supported security catalog. Upgrade to PHP 8.4 or 8.5.`
    };
  }

  const day = new Date(now);
  const securityEnd = new Date(`${release.securitySupportUntil}T23:59:59Z`);
  const activeEnd = new Date(`${release.activeSupportUntil}T23:59:59Z`);
  const updateAvailable = comparePhpVersions(parsed.version, release.latestVersion) < 0;
  let status = 'active';
  let severity = updateAvailable ? 'warning' : 'safe';
  let message = updateAvailable
    ? `PHP ${parsed.version} is behind the latest known ${parsed.major} security release (${release.latestVersion}).`
    : `PHP ${parsed.version} is on the latest known ${parsed.major} patch release.`;

  if (day > securityEnd) {
    status = 'eol';
    severity = 'critical';
    message = `PHP ${parsed.major} reached end of life on ${release.securitySupportUntil} and no longer receives security fixes.`;
  } else if (day > activeEnd) {
    status = 'security-only';
    severity = updateAvailable ? 'critical' : 'warning';
    message = updateAvailable
      ? `PHP ${parsed.version} is in security-only support and is missing the latest known security patch (${release.latestVersion}).`
      : `PHP ${parsed.major} receives security fixes only until ${release.securitySupportUntil}. Plan an upgrade to PHP 8.4 or 8.5.`;
  }

  return {
    version: parsed.version,
    major: parsed.major,
    latestVersion: release.latestVersion,
    status,
    severity,
    updateAvailable,
    activeSupportUntil: release.activeSupportUntil,
    securitySupportUntil: release.securitySupportUntil,
    message
  };
}

class PhpInstaller extends EventEmitter {
  constructor() {
    super();
    this.userProfile = process.env.USERPROFILE || os.homedir() || '';
    const appData = process.env.APPDATA || (this.userProfile ? path.join(this.userProfile, 'AppData', 'Roaming') : '');
    this.baseDir = path.join(appData, 'c-script-localhost', 'php');
    this.releaseCatalogUrl = 'https://windows.php.net/downloads/releases/releases.json';
    this.releaseCatalogCheckedAt = 0;
    this.releaseCatalogLive = false;
    this.releaseCatalogRefresh = null;
    this._ensureDir(this.baseDir);
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    }
  }

  _fetchJson(url, redirectCount = 0) {
    return new Promise((resolve, reject) => {
      if (redirectCount > 5) return reject(new Error('Too many redirects from PHP release service'));
      const request = https.get(url, { headers: { 'User-Agent': 'C-Script-LocalHost-Panel' } }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          this._fetchJson(new URL(response.headers.location, url).toString(), redirectCount + 1).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`PHP release service returned HTTP ${response.statusCode}`));
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          body += chunk;
          if (body.length > 5 * 1024 * 1024) request.destroy(new Error('PHP release catalog is too large'));
        });
        response.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
        });
      });
      request.setTimeout(10000, () => request.destroy(new Error('PHP release check timed out')));
      request.on('error', reject);
    });
  }

  async refreshReleaseCatalog(force = false) {
    const maxAge = 6 * 60 * 60 * 1000;
    if (!force && Date.now() - this.releaseCatalogCheckedAt < maxAge) return;
    if (this.releaseCatalogRefresh) return this.releaseCatalogRefresh;

    this.releaseCatalogRefresh = (async () => {
      try {
        const payload = await this._fetchJson(this.releaseCatalogUrl);
        const releases = findWindowsPhpReleases(payload);
        if (!Object.keys(releases).length) throw new Error('Official PHP catalog contained no compatible x64 NTS releases');
        for (const [major, release] of Object.entries(releases)) {
          const meta = KNOWN_RELEASES[major];
          if (!meta || comparePhpVersions(release.version, meta.latestVersion) < 0) continue;
          meta.latestVersion = release.version;
          meta.url = `https://windows.php.net/downloads/releases/${release.filename}`;
          meta.fallbackUrl = `https://downloads.php.net/~windows/releases/${release.filename}`;
          meta.sha256 = release.sha256;
        }
        this.releaseCatalogLive = true;
      } catch (error) {
        // Keep the bundled, last-known-safe catalog when the official service is offline.
        console.warn('[PHP Security] Could not refresh official release catalog:', error.message);
      } finally {
        this.releaseCatalogCheckedAt = Date.now();
        this.releaseCatalogRefresh = null;
      }
    })();
    return this.releaseCatalogRefresh;
  }

  _sha256(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('error', reject);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  /**
   * Get the standalone directory where the app stores PHP runtimes
   */
  getPhpDirectory() {
    return this.baseDir;
  }

  /**
   * List all standalone PHP versions currently installed in app storage
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
    await this.refreshReleaseCatalog();
    const installed = await this.listInstalled();
    const installedFolders = new Set(installed.map(i => i.folder.toLowerCase()));

    const catalog = Object.entries(KNOWN_RELEASES).map(([major, meta]) => {
      const isInst = installedFolders.has(meta.folder.toLowerCase());
      const instData = isInst ? installed.find(i => i.folder.toLowerCase() === meta.folder.toLowerCase()) : null;
      const security = instData
        ? getPhpSecurityStatus(instData.version)
        : getPhpSecurityStatus(meta.latestVersion);
      return {
        major,
        label: meta.label,
        folder: meta.folder,
        installed: isInst,
        exePath: instData ? instData.exe : null,
        version: instData ? instData.version : null,
        latestVersion: meta.latestVersion,
        security,
        updateAvailable: Boolean(instData && security.updateAvailable),
        downloadUrl: meta.url
      };
    });

    return {
      catalog,
      standaloneDir: this.baseDir
    };
  }

  /**
   * Build a security report for app-managed or externally discovered PHP runtimes.
   */
  async getSecurityReport(discovered = null) {
    await this.refreshReleaseCatalog();
    const runtimes = Array.isArray(discovered) ? discovered : await this.listInstalled();
    const items = runtimes.map(runtime => {
      const security = getPhpSecurityStatus(runtime.version || runtime.fullVersion);
      return {
        path: runtime.path || runtime.exe || '',
        source: runtime.source || 'Standalone',
        isAppManaged: Boolean(runtime.isAppManaged || runtime.isStandalone || runtime.exe),
        displayVersion: runtime.version || runtime.fullVersion || 'Unknown PHP',
        ...security
      };
    });
    const vulnerable = items.filter(item => item.severity === 'critical' || item.updateAvailable);
    return {
      checkedAt: new Date().toISOString(),
      catalogUpdatedAt: this.releaseCatalogCheckedAt
        ? new Date(this.releaseCatalogCheckedAt).toISOString()
        : '2026-10-24T00:00:00.000Z',
      catalogSource: this.releaseCatalogLive ? this.releaseCatalogUrl : 'bundled fallback',
      recommendedMajor: '8.5',
      latestKnownVersion: KNOWN_RELEASES['8.5'].latestVersion,
      hasWarnings: vulnerable.length > 0,
      criticalCount: items.filter(item => item.severity === 'critical').length,
      updateCount: items.filter(item => item.updateAvailable).length,
      items
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
    await this.refreshReleaseCatalog(true);
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

      // Verify official SHA-256 when the live PHP release catalog provides one.
      if (meta.sha256) {
        this.emit('install-status', { stage: 'verifying', message: `Verifying the PHP ${meta.latestVersion} security package...` });
        const actualHash = await this._sha256(tempZip);
        if (actualHash.toLowerCase() !== meta.sha256.toLowerCase()) {
          throw new Error('PHP download failed SHA-256 verification. The package was not installed.');
        }
      }

      // 2. Extract ZIP
      this.emit('install-status', { stage: 'extracting', message: `Extracting ${meta.label}...` });
      await this._extractZip(tempZip, targetDir);

      // PHP's Windows binaries require the MSVC runtime.
      // Copy runtime DLLs from bundled resources, or fallback to System32 / existing PHP runtimes.
      const candidateDirs = [
        process.resourcesPath ? path.join(process.resourcesPath, 'bundled', 'vc-runtime') : null,
        path.join(__dirname, '..', 'resources', 'bundled', 'vc-runtime'),
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
        // Check if any existing installed PHP folder in baseDir has runtime DLLs
        ...((() => {
          try {
            return fs.readdirSync(this.baseDir, { withFileTypes: true })
              .filter(d => d.isDirectory() && d.name !== meta.folder)
              .map(d => path.join(this.baseDir, d.name));
          } catch (e) { return []; }
        })())
      ].filter(Boolean);

      const vcRuntimeFiles = [
        'vcruntime140.dll', 'vcruntime140_1.dll', 'vcruntime140_threads.dll',
        'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll',
        'msvcp140_atomic_wait.dll', 'msvcp140_codecvt_ids.dll'
      ];

      // Copy available runtime DLLs from candidate directories to the target PHP folder
      for (const file of vcRuntimeFiles) {
        const dest = path.join(targetDir, file);
        if (fs.existsSync(dest)) continue;
        for (const dir of candidateDirs) {
          const src = path.join(dir, file);
          if (fs.existsSync(src)) {
            try {
              fs.copyFileSync(src, dest);
              break;
            } catch (copyErr) {}
          }
        }
      }

      // If critical VC++ runtime DLLs (vcruntime140.dll or msvcp140.dll) are missing from targetDir and System32,
      // download them from project repository raw assets as a reliable fallback
      const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
      const missingCritical = ['vcruntime140.dll', 'msvcp140.dll'].filter(f => 
        !fs.existsSync(path.join(targetDir, f)) && !fs.existsSync(path.join(system32, f))
      );
      if (missingCritical.length > 0) {
        this.emit('install-status', { stage: 'downloading-runtime', message: 'Downloading required Visual C++ runtime components...' });
        for (const file of vcRuntimeFiles) {
          const dest = path.join(targetDir, file);
          if (!fs.existsSync(dest)) {
            try {
              const rawUrl = `https://raw.githubusercontent.com/CHAMI-csr/c-script-localhost-panel/main/resources/bundled/vc-runtime/${file}`;
              await this._downloadFile(rawUrl, dest);
            } catch (dlErr) {}
          }
        }
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

PhpInstaller.KNOWN_RELEASES = KNOWN_RELEASES;
PhpInstaller.getPhpSecurityStatus = getPhpSecurityStatus;
PhpInstaller.comparePhpVersions = comparePhpVersions;
PhpInstaller.findWindowsPhpReleases = findWindowsPhpReleases;

module.exports = PhpInstaller;
