/**
 * MysqlInstaller - Standalone MySQL / MariaDB Downloader & Service Manager
 * Detects existing Windows MySQL services (e.g. MySQL80) and provides
 * a 1-click standalone downloader for portable MariaDB / MySQL.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const https = require('https');
const { spawn, exec, execFile } = require('child_process');
const { EventEmitter } = require('events');

const MARIADB_VERSION = '11.4.3';
const MARIADB_DOWNLOAD_URL = `https://archive.mariadb.org/mariadb-${MARIADB_VERSION}/winx64-packages/mariadb-${MARIADB_VERSION}-winx64.zip`;

class MysqlInstaller extends EventEmitter {
  constructor() {
    super();
    this.userProfile = process.env.USERPROFILE || os.homedir() || '';
    const appData = process.env.APPDATA || (this.userProfile ? path.join(this.userProfile, 'AppData', 'Roaming') : '');
    this.baseDir = path.join(appData, 'c-script-localhost', 'mysql');
    this.binDir = path.join(this.baseDir, 'bin');
    this.exePath = path.join(this.binDir, 'mysqld.exe');
    this.mariadbExe = path.join(this.binDir, 'mariadbd.exe');
    this.dataDir = path.join(this.baseDir, 'data');
    this.confPath = path.join(this.baseDir, 'my.ini');

    this._ensureDir(this.baseDir);
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    }
  }

  /**
   * Check if standalone MySQL/MariaDB binary is installed in AppData
   */
  isStandaloneInstalled() {
    return fs.existsSync(this.exePath) || fs.existsSync(this.mariadbExe);
  }

  getEffectiveExe() {
    if (fs.existsSync(this.exePath)) return this.exePath;
    if (fs.existsSync(this.mariadbExe)) return this.mariadbExe;
    return null;
  }

  /**
   * Check if Port 3306 is open and listening
   */
  checkPort(port = 3306) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(800);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, '127.0.0.1');
    });
  }

  /**
   * Detect installed Windows MySQL/MariaDB service (e.g. MySQL80)
   */
  async getWindowsService() {
    return new Promise((resolve) => {
      exec(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Service | Where-Object { $_.Name -match \'mysql|mariadb\' -or $_.DisplayName -match \'mysql\' } | Select-Object -First 1 Name, DisplayName, PathName, State | ConvertTo-Json"',
        { timeout: 5000, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout || !stdout.trim()) {
            return resolve(null);
          }
          try {
            const data = JSON.parse(stdout);
            resolve({
              name: data.Name,
              displayName: data.DisplayName,
              state: data.State,
              pathName: data.PathName,
              isRunning: String(data.State || '').toLowerCase() === 'running'
            });
          } catch (e) {
            resolve(null);
          }
        }
      );
    });
  }

  /**
   * Check if standalone mysqld.exe process is running
   */
  async isProcessRunning() {
    return new Promise((resolve) => {
      exec('tasklist /FI "IMAGENAME eq mysqld.exe" /NH', (err, stdout) => {
        if (!err && stdout && stdout.toLowerCase().includes('mysqld.exe')) return resolve(true);
        exec('tasklist /FI "IMAGENAME eq mariadbd.exe" /NH', (err2, stdout2) => {
          resolve(!err2 && stdout2 && stdout2.toLowerCase().includes('mariadbd.exe'));
        });
      });
    });
  }

  /**
   * Get full MySQL/MariaDB status and installation info
   */
  async getInfo() {
    const isPortOpen = await this.checkPort(3306);
    const winService = await this.getWindowsService();
    const standaloneInstalled = this.isStandaloneInstalled();
    const standaloneRunning = await this.isProcessRunning();

    let mode = 'none';
    let status = 'stopped';
    let versionLabel = 'MySQL / MariaDB';

    if (winService && winService.isRunning) {
      mode = 'system_service';
      status = 'running';
      versionLabel = `${winService.displayName} (Port 3306)`;
    } else if (standaloneInstalled && (standaloneRunning || isPortOpen)) {
      mode = 'standalone';
      status = 'running';
      versionLabel = `MariaDB ${MARIADB_VERSION} (Standalone / Port 3306)`;
    } else if (isPortOpen) {
      mode = 'active_port';
      status = 'running';
      versionLabel = 'MySQL Server (Port 3306 Active)';
    } else if (winService) {
      mode = 'system_service';
      status = 'stopped';
      versionLabel = `${winService.displayName} (Stopped)`;
    } else if (standaloneInstalled) {
      mode = 'standalone';
      status = 'stopped';
      versionLabel = `MariaDB ${MARIADB_VERSION} (Standalone - Stopped)`;
    }

    return {
      status,
      mode,
      port: 3306,
      portOpen: isPortOpen,
      versionLabel,
      winService,
      standaloneInstalled,
      standalonePath: this.getEffectiveExe(),
      baseDir: this.baseDir,
      dataDir: this.dataDir,
      confPath: this.confPath,
      downloadUrl: MARIADB_DOWNLOAD_URL,
      targetVersion: `MariaDB ${MARIADB_VERSION} LTS (MySQL Compatible)`
    };
  }

  /**
   * Setup standard my.ini configuration for standalone MySQL/MariaDB
   */
  setupDefaultConf() {
    const bDir = this.baseDir.replace(/\\/g, '/');
    const dDir = this.dataDir.replace(/\\/g, '/');

    const iniContent = `[mysqld]
port=3306
basedir="${bDir}"
datadir="${dDir}"
character-set-server=utf8mb4
collation-server=utf8mb4_unicode_ci
default-storage-engine=INNODB
bind-address=127.0.0.1
max_allowed_packet=64M
sql_mode=NO_ENGINE_SUBSTITUTION

[mysql]
default-character-set=utf8mb4

[client]
port=3306
default-character-set=utf8mb4
`;

    try {
      fs.writeFileSync(this.confPath, iniContent, 'utf8');
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Download and install standalone MariaDB/MySQL
   */
  async downloadAndInstall() {
    const tempZip = path.join(os.tmpdir(), `mariadb_${MARIADB_VERSION}_${Date.now()}.zip`);
    const tempExtract = path.join(os.tmpdir(), `mariadb_ext_${Date.now()}`);

    this.emit('install-status', { stage: 'downloading', message: `Downloading MariaDB ${MARIADB_VERSION} LTS (~86MB)...` });

    try {
      // 1. Download official ZIP
      await this._downloadFile(MARIADB_DOWNLOAD_URL, tempZip);

      // 2. Extract ZIP
      this.emit('install-status', { stage: 'extracting', message: `Extracting MariaDB ${MARIADB_VERSION}...` });
      this._ensureDir(tempExtract);
      await this._extractZip(tempZip, tempExtract);

      // Clean up zip
      try { if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip); } catch (e) {}

      // Locate extracted folder
      let srcDir = tempExtract;
      const subEntries = fs.readdirSync(tempExtract, { withFileTypes: true });
      for (const sub of subEntries) {
        if (sub.isDirectory() && (sub.name.toLowerCase().startsWith('mariadb') || sub.name.toLowerCase().startsWith('mysql'))) {
          srcDir = path.join(tempExtract, sub.name);
          break;
        }
      }

      // 3. Move files to baseDir
      this._ensureDir(this.baseDir);
      fs.cpSync(srcDir, this.baseDir, { recursive: true });

      // Clean up tempExtract
      try { fs.rmSync(tempExtract, { recursive: true, force: true }); } catch (e) {}

      // 4. Configure my.ini
      this._ensureDir(this.dataDir);
      this.setupDefaultConf();

      // 5. Initialize database if data directory is empty
      const dataFiles = fs.existsSync(this.dataDir) ? fs.readdirSync(this.dataDir) : [];
      if (dataFiles.length === 0) {
        this.emit('install-status', { stage: 'initializing', message: 'Initializing MySQL database storage...' });
        await this._initializeDataDir();
      }

      this.emit('install-status', { stage: 'completed', message: 'MariaDB / MySQL installed successfully!' });

      return {
        success: true,
        version: `MariaDB ${MARIADB_VERSION}`,
        exePath: this.getEffectiveExe(),
        dataDir: this.dataDir
      };
    } catch (err) {
      try { if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip); } catch (e) {}
      try { if (fs.existsSync(tempExtract)) fs.rmSync(tempExtract, { recursive: true, force: true }); } catch (e) {}
      return { success: false, error: err.message };
    }
  }

  /**
   * Run initialization tool to create initial system databases and root user
   */
  async _initializeDataDir() {
    const installDb = path.join(this.binDir, 'mariadb-install-db.exe');
    const legacyInstallDb = path.join(this.binDir, 'mysql_install_db.exe');
    const exe = this.getEffectiveExe();

    const targetInstaller = fs.existsSync(installDb) ? installDb : (fs.existsSync(legacyInstallDb) ? legacyInstallDb : null);

    if (targetInstaller) {
      return new Promise((resolve) => {
        execFile(targetInstaller, [`--datadir=${this.dataDir}`], { windowsHide: true }, () => resolve());
      });
    }

    if (exe) {
      return new Promise((resolve) => {
        execFile(exe, ['--initialize-insecure', `--datadir=${this.dataDir}`], { windowsHide: true }, () => resolve());
      });
    }
  }

  /**
   * Start MySQL service or standalone process
   */
  async start() {
    const winService = await this.getWindowsService();
    if (winService && winService.name) {
      const netStarted = await new Promise((resolve) => {
        exec(`net start "${winService.name}"`, { windowsHide: true }, (err) => resolve(!err));
      });
      if (netStarted || await this.checkPort(3306)) {
        return { success: true, mode: 'system_service' };
      }

      // Try elevated UAC start
      try {
        const pCmd = `Start-Process -FilePath "net.exe" -ArgumentList "start","${winService.name}" -Verb RunAs -WindowStyle Hidden -Wait`;
        await new Promise((resolve) => {
          exec(`powershell -NoProfile -Command "${pCmd}"`, { windowsHide: true, timeout: 6000 }, () => resolve());
        });
        if (await this.checkPort(3306)) {
          return { success: true, mode: 'system_service' };
        }
      } catch (e) {}
    }

    const exe = this.getEffectiveExe();
    if (!exe) {
      return { success: false, error: 'No MySQL service or standalone binary found.' };
    }

    return new Promise((resolve) => {
      const proc = spawn(exe, [`--defaults-file=${this.confPath}`, '--console'], {
        cwd: this.baseDir,
        windowsHide: true,
        detached: true,
        stdio: 'ignore'
      });
      proc.unref();

      setTimeout(async () => {
        const isUp = await this.checkPort(3306);
        resolve({ success: isUp, mode: 'standalone' });
      }, 1500);
    });
  }

  /**
   * Stop MySQL service or standalone process
   */
  async stop() {
    const winService = await this.getWindowsService();
    if (winService && winService.name && winService.isRunning) {
      return new Promise((resolve) => {
        exec(`powershell -NoProfile -Command "Stop-Service -Name '${winService.name}' -Force"`, { windowsHide: true }, (err) => {
          resolve({ success: !err });
        });
      });
    }

    return new Promise((resolve) => {
      exec('taskkill /F /IM mysqld.exe /IM mariadbd.exe', () => {
        resolve({ success: true });
      });
    });
  }

  /**
   * Restart MySQL
   */
  async restart() {
    await this.stop();
    await new Promise(r => setTimeout(r, 1000));
    return this.start();
  }

  /**
   * Download file via HTTPS with progress events
   */
  _downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return this._downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`Failed to download database (HTTP ${res.statusCode})`));
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
          const psCmd = `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force`;
          const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { windowsHide: true });
          ps.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`Extraction failed with code ${c}`))));
          ps.on('error', reject);
        }
      });
      tarProc.on('error', () => {
        const psCmd = `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force`;
        const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { windowsHide: true });
        ps.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('PowerShell extract error'))));
        ps.on('error', reject);
      });
    });
  }
}

module.exports = MysqlInstaller;
