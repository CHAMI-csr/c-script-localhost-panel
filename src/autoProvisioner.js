/**
 * AutoProvisioner - Automatically provisions pre-bundled PHP, NGINX, and MySQL
 * from the app installation directory into %APPDATA%\antigravity-localhost on first run.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

class AutoProvisioner {
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

  static async provisionIfNeeded(onStatus = null) {
    const bundledDir = this.getBundledDir();
    if (!bundledDir) {
      return { success: false, reason: 'No bundled stack found' };
    }

    const appDataDir = this.getAppDataDir();
    if (!fs.existsSync(appDataDir)) {
      try { fs.mkdirSync(appDataDir, { recursive: true }); } catch (e) {}
    }

    let provisionedCount = 0;

    // 1. Provision PHP 8.4 Runtime
    const bundledPhp = path.join(bundledDir, 'php', 'php84');
    const targetPhp = path.join(appDataDir, 'php', 'php84');
    if (fs.existsSync(bundledPhp) && !fs.existsSync(targetPhp)) {
      if (onStatus) onStatus('Extracting bundled PHP 8.4 runtime...');
      try {
        fs.mkdirSync(path.join(appDataDir, 'php'), { recursive: true });
        fs.cpSync(bundledPhp, targetPhp, { recursive: true });
        provisionedCount++;
      } catch (err) {
        console.error('[AutoProvisioner] Failed to copy bundled PHP:', err);
      }
    }

    // 2. Provision NGINX Web Server
    const bundledNginx = path.join(bundledDir, 'nginx');
    const targetNginx = path.join(appDataDir, 'nginx');
    if (fs.existsSync(bundledNginx) && !fs.existsSync(targetNginx)) {
      if (onStatus) onStatus('Extracting bundled NGINX Web Server...');
      try {
        fs.cpSync(bundledNginx, targetNginx, { recursive: true });
        provisionedCount++;
      } catch (err) {
        console.error('[AutoProvisioner] Failed to copy bundled NGINX:', err);
      }
    }

    // 3. Provision MySQL / MariaDB Server
    const bundledMysql = path.join(bundledDir, 'mysql');
    const targetMysql = path.join(appDataDir, 'mysql');
    if (fs.existsSync(bundledMysql) && !fs.existsSync(targetMysql)) {
      if (onStatus) onStatus('Extracting bundled MySQL / MariaDB server...');
      try {
        fs.cpSync(bundledMysql, targetMysql, { recursive: true });

        // Update my.ini dynamically for the target user's AppData directory
        try {
          const MysqlInstaller = require('./mysqlInstaller');
          const inst = new MysqlInstaller();
          inst.setupDefaultConf();
        } catch (confErr) {
          console.error('[AutoProvisioner] Failed to update my.ini:', confErr);
        }

        provisionedCount++;
      } catch (err) {
        console.error('[AutoProvisioner] Failed to copy bundled MySQL:', err);
      }
    }

    return { success: true, provisionedCount };
  }
}

module.exports = AutoProvisioner;
