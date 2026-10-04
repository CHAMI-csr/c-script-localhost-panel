/**
 * AutoProvisioner - Automatically provisions pre-bundled PHP, NGINX, and MySQL
 * from the app installation directory into the app's AppData runtime directory on first run.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

class AutoProvisioner {
  static _hasFile(filePath) {
    try {
      const stat = fs.statSync(filePath);
      return stat.isFile() && stat.size > 0;
    } catch (error) {
      return false;
    }
  }

  static _provisionRuntime(label, sourceDir, targetDir, requiredFiles, onStatus, force = false) {
    const missingSource = requiredFiles.filter(relativePath => !this._hasFile(path.join(sourceDir, relativePath)));
    if (missingSource.length) {
      return { installed: false, error: `Bundled ${label} files are missing: ${missingSource.join(', ')}` };
    }
    const missingTarget = () => requiredFiles.filter(relativePath => !this._hasFile(path.join(targetDir, relativePath)));
    if (!force && missingTarget().length === 0) {
      return { installed: true, copied: false, exePath: path.join(targetDir, requiredFiles[0]) };
    }

    if (onStatus) onStatus(`Restoring bundled ${label} runtime...`);
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      // If forced, overwrite files to repair corrupted runtimes
      fs.cpSync(sourceDir, targetDir, { recursive: true, force: !!force, errorOnExist: false });
      const stillMissing = missingTarget();
      if (stillMissing.length) {
        return { installed: false, error: `Could not provision ${label}; files are still missing: ${stillMissing.join(', ')}` };
      }
      return { installed: true, copied: true, exePath: path.join(targetDir, requiredFiles[0]) };
    } catch (error) {
      return { installed: false, error: `Failed to provision ${label}: ${error.message}` };
    }
  }

  static getBundledDir() {
    // 1. Packaged Electron app (NSIS installer or Portable): process.resourcesPath/bundled
    if (process.resourcesPath) {
      const p = path.join(process.resourcesPath, 'bundled');
      if (fs.existsSync(p)) return p;
    }
    // 2. Development or local directory: resources/bundled
    const devPath = path.join(__dirname, '..', 'resources', 'bundled');
    if (fs.existsSync(devPath)) return devPath;

    return null;
  }

  static getAppDataDir() {
    const userProfile = process.env.USERPROFILE || os.homedir() || '';
    const appData = process.env.APPDATA || (userProfile ? path.join(userProfile, 'AppData', 'Roaming') : '');
    const preferred = path.join(appData, 'c-script-localhost');
    const legacy = path.join(appData, 'antigravity-localhost');

    // Auto-migrate legacy directory if present
    if (!fs.existsSync(preferred) && fs.existsSync(legacy)) {
      try {
        fs.cpSync(legacy, preferred, { recursive: true });
      } catch (e) {}
    }

    return preferred;
  }

  static async provisionIfNeeded(onStatus = null, force = false) {
    const bundledDir = this.getBundledDir();
    if (!bundledDir) {
      return { success: false, reason: 'No bundled stack found' };
    }

    const appDataDir = this.getAppDataDir();
    if (!fs.existsSync(appDataDir)) {
      try { fs.mkdirSync(appDataDir, { recursive: true }); } catch (e) {}
    }

    const runtimes = {};

    // 1. Provision PHP 8.4 Runtime
    const bundledPhp = path.join(bundledDir, 'php', 'php84');
    const targetPhp = path.join(appDataDir, 'php', 'php84');
    runtimes.php = this._provisionRuntime('PHP 8.4', bundledPhp, targetPhp, [
      'php.exe', 'php8.dll', 'php.ini', path.join('ext', 'php_curl.dll'),
      path.join('ext', 'php_mysqli.dll'), path.join('ext', 'php_pdo_mysql.dll')
    ], onStatus, force);
    // PHP for Windows is built with MSVC. Keep the app-local runtime beside
    // php.exe so clean machines (including Windows Sandbox) don't depend on a
    // separately installed Visual C++ Redistributable.
    const bundledVcRuntime = path.join(bundledDir, 'vc-runtime');
    const vcRuntimeFiles = [
      'vcruntime140.dll', 'vcruntime140_1.dll', 'vcruntime140_threads.dll',
      'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll',
      'msvcp140_atomic_wait.dll', 'msvcp140_codecvt_ids.dll'
    ];
    const missingVcRuntime = vcRuntimeFiles.filter(file => !this._hasFile(path.join(bundledVcRuntime, file)));
    if (missingVcRuntime.length) {
      runtimes.php = { installed: false, error: `Bundled PHP Visual C++ runtime files are missing: ${missingVcRuntime.join(', ')}` };
    } else {
      try {
        fs.mkdirSync(targetPhp, { recursive: true });
        for (const file of vcRuntimeFiles) {
          const targetFile = path.join(targetPhp, file);
          if (force || !this._hasFile(targetFile)) fs.copyFileSync(path.join(bundledVcRuntime, file), targetFile);
        }
      } catch (error) {
        runtimes.php = { installed: false, error: `Failed to provision PHP Visual C++ runtime: ${error.message}` };
      }
    }

    // 2. Provision NGINX Web Server
    const bundledNginx = path.join(bundledDir, 'nginx');
    const targetNginx = path.join(appDataDir, 'nginx');
    runtimes.nginx = this._provisionRuntime('NGINX', bundledNginx, targetNginx, [
      'nginx.exe', path.join('conf', 'nginx.conf'), path.join('conf', 'mime.types')
    ], onStatus, force);

    if (runtimes.nginx.installed) {
      try {
        fs.mkdirSync(path.join(targetNginx, 'logs'), { recursive: true });
        fs.mkdirSync(path.join(targetNginx, 'temp'), { recursive: true });
        const confPath = path.join(targetNginx, 'conf', 'nginx.conf');
        if (fs.existsSync(confPath)) {
          let conf = fs.readFileSync(confPath, 'utf8');
          if (!conf.includes('server_names_hash_bucket_size')) {
            conf = conf.replace(/http\s*\{/i, 'http {\n    server_names_hash_bucket_size 128;\n    server_names_hash_max_size 2048;');
            fs.writeFileSync(confPath, conf, 'utf8');
          }
        }
      } catch (_) {}
    }

    // 3. Provision MySQL / MariaDB Server
    const bundledMysql = path.join(bundledDir, 'mysql');
    const targetMysql = path.join(appDataDir, 'mysql');
    runtimes.mysql = this._provisionRuntime('MySQL / MariaDB', bundledMysql, targetMysql, [
      path.join('bin', 'mysqld.exe'), path.join('bin', 'mariadbd.exe'),
      path.join('bin', 'mariadb-install-db.exe'), 'my.ini'
    ], onStatus, force);

    if (runtimes.mysql.installed) {
      try {
        const MysqlInstaller = require('./mysqlInstaller');
        const inst = new MysqlInstaller();
        const expectedBaseDir = inst.baseDir.replace(/\\/g, '/').toLowerCase();
        let config = '';
        try { config = fs.readFileSync(inst.confPath, 'utf8'); } catch (error) {}
        if (!config.toLowerCase().includes(`basedir="${expectedBaseDir}"`)) {
          inst.setupDefaultConf();
        }
      } catch (confErr) {
        runtimes.mysql.configError = confErr.message;
      }
    }

    const errors = Object.values(runtimes).filter(runtime => !runtime.installed).map(runtime => runtime.error);
    for (const error of errors) console.error(`[AutoProvisioner] ${error}`);
    return {
      success: errors.length === 0,
      provisionedCount: Object.values(runtimes).filter(runtime => runtime.copied).length,
      runtimes,
      errors
    };
  }
}

module.exports = AutoProvisioner;
