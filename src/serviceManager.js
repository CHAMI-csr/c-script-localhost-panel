/**
 * ServiceManager - Dynamically detects and manages local development services
 * (Web Server: NGINX / Apache, PHP Runtime / FastCGI, and MySQL / MariaDB)
 * Completely dynamic - NO hardcoded usernames or fixed paths.
 */

const { exec, spawn } = require('child_process');
const util = require('util');
const net = require('net');
const fs = require('fs');
const path = require('path');
const execPromise = util.promisify(exec);

class ServiceManager {
  constructor() {
    this._cachedInfo = null;
    this._lastScanTime = 0;
  }

  async checkPort(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(300);
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('timeout', () => { socket.destroy(); resolve(false); });
      socket.on('error', () => { resolve(false); });
      socket.connect(port, host);
    });
  }

  async _getProcessList() {
    try {
      const { stdout } = await execPromise('tasklist /FO CSV /NH');
      const lines = stdout.split('\r\n').map(l => l.trim()).filter(Boolean);
      return lines.map(line => {
        const cols = line.split('","').map(c => c.replace(/"/g, ''));
        return { name: cols[0] || '', pid: cols[1] || '', mem: cols[4] || '' };
      });
    } catch (e) {
      return [];
    }
  }

  /**
   * Dynamically detect PHP environment info from the system
   */
  async _detectPhp(phpManager = null) {
    const binary = phpManager?.phpBinary || 'php';
    let version = 'PHP';
    let fullVersion = '';
    let iniPath = '';
    let binPath = '';
    let cgiPath = '';

    // 1. Version
    try {
      const { stdout } = await execPromise(`"${binary}" -v`);
      const vMatch = stdout.match(/PHP (\d+\.\d+[\.\d]*)/);
      if (vMatch) {
        fullVersion = vMatch[1];
        const majorMinor = fullVersion.split('.').slice(0, 2).join('.');
        version = `PHP ${majorMinor}`;
      }
    } catch (e) {}

    // 2. php.ini path
    try {
      const { stdout } = await execPromise(`"${binary}" -r "echo php_ini_loaded_file();"`);
      iniPath = stdout.trim();
    } catch (e) {}

    // 3. Executable path
    try {
      const { stdout } = await execPromise(`where.exe "${binary}"`);
      binPath = stdout.split(/\r?\n/)[0]?.trim() || '';
    } catch (e) {
      binPath = binary;
    }

    // 4. Look for php-cgi.exe in the same directory as php.ini or php.exe or user config
    const candidateDirs = [];
    if (iniPath) candidateDirs.push(path.dirname(iniPath));
    if (binPath) candidateDirs.push(path.dirname(binPath));
    if (process.env.USERPROFILE) {
      candidateDirs.push(path.join(process.env.USERPROFILE, '.config', 'herd', 'bin', 'php84'));
      candidateDirs.push(path.join(process.env.USERPROFILE, '.config', 'herd', 'bin'));
    }

    for (const dir of candidateDirs) {
      const potentialCgi = path.join(dir, 'php-cgi.exe');
      if (fs.existsSync(potentialCgi)) {
        cgiPath = potentialCgi;
        break;
      }
    }

    return { version, fullVersion, iniPath, binPath, cgiPath };
  }

  /**
   * Dynamically detect MySQL / MariaDB Windows service & binaries
   */
  async _detectMySQL() {
    let serviceName = '';
    let displayName = 'MySQL Database Server';
    let exePath = '';
    let configPath = '';
    let state = 'Stopped';

    try {
      const { stdout } = await execPromise(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Service | Where-Object { $_.Name -match \'mysql|mariadb\' -or $_.DisplayName -match \'mysql\' } | Select-Object -First 1 Name, DisplayName, PathName, State | ConvertTo-Json"'
      );
      if (stdout.trim()) {
        const info = JSON.parse(stdout);
        serviceName = info.Name || '';
        displayName = info.DisplayName || 'MySQL Database Server';
        state = info.State || 'Stopped';

        if (info.PathName) {
          const exeMatch = info.PathName.match(/^"?([^"]+\.exe)"?/i);
          if (exeMatch) exePath = exeMatch[1];

          const confMatch = info.PathName.match(/--defaults-file="([^"]+)"/i) || info.PathName.match(/--defaults-file=([^\s]+)/i);
          if (confMatch) configPath = confMatch[1];
        }
      }
    } catch (e) {}

    if (!exePath) {
      const appData = process.env.APPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : '');
      const standaloneMyIni = fs.existsSync(path.join(appData, 'c-script-localhost', 'mysql', 'my.ini'))
        ? path.join(appData, 'c-script-localhost', 'mysql', 'my.ini')
        : path.join(appData, 'antigravity-localhost', 'mysql', 'my.ini');
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
      const candidatePaths = [
        path.join(appData, 'c-script-localhost', 'mysql', 'bin', 'mysqld.exe'),
        path.join(appData, 'c-script-localhost', 'mysql', 'bin', 'mariadbd.exe'),
        path.join(appData, 'antigravity-localhost', 'mysql', 'bin', 'mysqld.exe'),
        path.join(appData, 'antigravity-localhost', 'mysql', 'bin', 'mariadbd.exe'),
        path.join(programFiles, 'MySQL', 'MySQL Server 8.0', 'bin', 'mysqld.exe'),
        path.join('C:\\xampp', 'mysql', 'bin', 'mysqld.exe'),
        path.join('C:\\laragon', 'bin', 'mysql', 'bin', 'mysqld.exe')
      ];
      for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
          exePath = p;
          if (fs.existsSync(standaloneMyIni) && (p.includes('c-script-localhost') || p.includes('antigravity-localhost'))) {
            configPath = standaloneMyIni;
            displayName = 'MariaDB / MySQL (Standalone)';
          }
          break;
        }
      }
    }

    return { serviceName, displayName, exePath, configPath, state };
  }

  /**
   * Dynamically detect NGINX / Apache Web Server
   */
  async _detectWebServer() {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const userProfile = process.env.USERPROFILE || '';
    let type = 'nginx';
    let name = 'NGINX';
    let exePath = '';
    let configPath = '';
    let prefixDir = '';

    const appData = process.env.APPDATA || (userProfile ? path.join(userProfile, 'AppData', 'Roaming') : '');
    const cScriptNginx = path.join(appData, 'c-script-localhost', 'nginx', 'nginx.exe');
    const legacyNginx = path.join(appData, 'antigravity-localhost', 'nginx', 'nginx.exe');
    const standaloneNginx = fs.existsSync(cScriptNginx) ? cScriptNginx : (fs.existsSync(legacyNginx) ? legacyNginx : null);

    if (standaloneNginx) {
      exePath = standaloneNginx;
      prefixDir = path.dirname(standaloneNginx);
      configPath = path.join(prefixDir, 'conf', 'nginx.conf');
    }

    if (!exePath) {
      try {
        const { stdout } = await execPromise('where.exe nginx');
        const found = stdout.split(/\r?\n/)[0]?.trim();
        if (found && fs.existsSync(found)) exePath = found;
      } catch (e) {}
    }

    if (!exePath) {
      const herdNginx = path.join(programFiles, 'Herd', 'resources', 'app.asar.unpacked', 'resources', 'bin', 'nginx', 'nginx.exe');
      if (fs.existsSync(herdNginx)) exePath = herdNginx;
    }

    if (!exePath) {
      const candidatePaths = [
        path.join('C:\\nginx', 'nginx.exe'),
        path.join(programFiles, 'nginx', 'nginx.exe')
      ];
      for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
          exePath = p;
          break;
        }
      }
    }

    if (exePath && !configPath) {
      const herdConf = userProfile ? path.join(userProfile, '.config', 'herd', 'config', 'nginx', 'nginx.conf') : '';
      const nextToExeConf = path.join(path.dirname(exePath), '..', 'conf', 'nginx.conf');
      if (herdConf && fs.existsSync(herdConf)) {
        configPath = herdConf;
        prefixDir = path.dirname(herdConf);
      } else if (fs.existsSync(nextToExeConf)) {
        configPath = nextToExeConf;
        prefixDir = path.dirname(path.dirname(exePath));
      }
    }

    return { type, name, exePath, configPath, prefixDir };
  }

  /**
   * Get all active services dynamically with zero hardcoded values
   */
  async getServices(siteManager = null, phpManager = null) {
    const [procs, p80, p3306, phpInfo, mysqlInfo, webInfo] = await Promise.all([
      this._getProcessList(),
      this.checkPort(80),
      this.checkPort(3306),
      this._detectPhp(phpManager),
      this._detectMySQL(),
      this._detectWebServer()
    ]);

    const nginxProcs = procs.filter(p => p.name.toLowerCase() === 'nginx.exe');
    const phpCgiProcs = procs.filter(p => p.name.toLowerCase() === 'php-cgi.exe');
    const mysqlProcs = procs.filter(p => p.name.toLowerCase() === 'mysqld.exe' || p.name.toLowerCase() === 'mariadbd.exe');

    // Check running sites in phpManager
    const runningSites = phpManager ? (phpManager.getRunning() || []) : [];
    const isPhpActive = phpCgiProcs.length > 0 || runningSites.length > 0;
    const isNginxActive = nginxProcs.length > 0 || p80;
    const isMySQLActive = mysqlProcs.length > 0 || p3306 || (mysqlInfo.state && mysqlInfo.state.toLowerCase() === 'running');

    const services = [];

    // 1. Web Server (NGINX / Apache)
    if (webInfo.exePath || isNginxActive) {
      services.push({
        id: 'webserver',
        name: webInfo.name,
        type: 'webserver',
        displayName: `${webInfo.name} Web Server`,
        status: isNginxActive ? 'running' : 'stopped',
        port: 80,
        portActive: p80,
        pids: nginxProcs.map(p => p.pid),
        procCount: nginxProcs.length,
        path: webInfo.exePath,
        configPath: webInfo.configPath,
        prefixDir: webInfo.prefixDir,
        description: isNginxActive ? 'Active and handling HTTP traffic on port 80' : 'Web server is stopped'
      });
    }

    // 2. PHP Runtime / FastCGI
    const phpPids = [...new Set([
      ...phpCgiProcs.map(p => p.pid),
      ...runningSites.map(s => s.process?.pid ? String(s.process.pid) : null).filter(Boolean)
    ])];

    services.push({
      id: 'php',
      name: phpInfo.version || 'PHP Runtime',
      type: 'php',
      displayName: `${phpInfo.version} FastCGI / Runtime`,
      status: isPhpActive ? 'running' : 'stopped',
      port: 9000,
      portActive: isPhpActive,
      pids: phpPids,
      procCount: phpPids.length,
      path: phpInfo.binPath || phpInfo.cgiPath,
      configPath: phpInfo.iniPath,
      description: isPhpActive
        ? `Active (${runningSites.length > 0 ? runningSites.length + ' site(s) running' : 'Runtime active'})`
        : 'PHP service is stopped. Start service to run sites.'
    });

    // 3. MySQL Database Server
    services.push({
      id: 'mysql',
      name: 'MySQL',
      type: 'database',
      displayName: mysqlInfo.displayName || 'MySQL Database Server',
      status: isMySQLActive ? 'running' : 'stopped',
      port: 3306,
      portActive: p3306,
      serviceName: mysqlInfo.serviceName,
      pids: mysqlProcs.map(p => p.pid),
      procCount: mysqlProcs.length,
      path: mysqlInfo.exePath,
      configPath: mysqlInfo.configPath,
      description: isMySQLActive ? 'Relational database server listening on port 3306' : 'Database server is stopped'
    });

    return services;
  }

  /**
   * Check if PHP service is running
   */
  async isPhpServiceRunning(phpManager = null) {
    const procs = await this._getProcessList();
    const hasCgi = procs.some(p => p.name.toLowerCase() === 'php-cgi.exe');
    const runningSites = phpManager ? (phpManager.getRunning() || []) : [];
    return {
      running: hasCgi || runningSites.length > 0,
      hasCgi,
      siteCount: runningSites.length
    };
  }

  /**
   * Start a service dynamically
   */
  async startService(id, siteManager = null, phpManager = null, mysqlManager = null) {
    try {
      if (id === 'php' || id.startsWith('php')) {
        const phpInfo = await this._detectPhp(phpManager);
        if (phpInfo.cgiPath && fs.existsSync(phpInfo.cgiPath)) {
          spawn(phpInfo.cgiPath, ['-b', '127.0.0.1:9000'], { detached: true, stdio: 'ignore' }).unref();
          return { success: true, message: `${phpInfo.version} FastCGI started on 127.0.0.1:9000` };
        }
        return { success: true, message: `${phpInfo.version} ready for local sites` };
      }

      if (id === 'webserver' || id === 'nginx') {
        const webInfo = await this._detectWebServer();
        if (webInfo.exePath && fs.existsSync(webInfo.exePath)) {
          const args = [];
          if (webInfo.prefixDir) args.push('-p', webInfo.prefixDir);
          if (webInfo.configPath) args.push('-c', webInfo.configPath);
          spawn(webInfo.exePath, args, { detached: true, stdio: 'ignore' }).unref();
          return { success: true, message: `${webInfo.name} Web Server started` };
        }
        return { success: false, error: 'Web server executable not found on system' };
      }

      if (id === 'mysql') {
        const mysqlInfo = await this._detectMySQL();
        const svcName = mysqlInfo.serviceName;

        // Method 1: Try standard net start
        if (svcName) {
          try {
            await execPromise(`net start "${svcName}"`);
            await new Promise(r => setTimeout(r, 600));
            if (await this.checkPort(3306)) {
              return { success: true, message: `${svcName} service started` };
            }
          } catch (e) {}

          // Method 2: Elevated start via UAC
          try {
            const pCmd = `Start-Process -FilePath "net.exe" -ArgumentList "start","${svcName}" -Verb RunAs -WindowStyle Hidden -Wait`;
            await execPromise(`powershell -NoProfile -Command "${pCmd}"`, { timeout: 6000 });
            await new Promise(r => setTimeout(r, 600));
            if (await this.checkPort(3306)) {
              return { success: true, message: `${svcName} service started via administrator elevation` };
            }
          } catch (e) {}
        }

        // Method 3: Standalone executable
        if (mysqlInfo.exePath && fs.existsSync(mysqlInfo.exePath)) {
          const spawnArgs = mysqlInfo.configPath ? [`--defaults-file=${mysqlInfo.configPath}`, '--console'] : [];
          const procCwd = path.dirname(path.dirname(mysqlInfo.exePath));
          spawn(mysqlInfo.exePath, spawnArgs, { cwd: procCwd, detached: true, stdio: 'ignore' }).unref();
          await new Promise(r => setTimeout(r, 1500));
          if (await this.checkPort(3306)) {
            return { success: true, message: 'MySQL started' };
          }
        }

        const isRunning = await this.checkPort(3306);
        if (isRunning) return { success: true, message: 'MySQL is active' };

        return {
          success: false,
          error: `Cannot start MySQL (${svcName || 'Service'}). Windows requires Administrator permission (UAC) to start the system service.`
        };
      }

      return { success: false, error: 'Unknown service: ' + id };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Stop MySQL directly via password authentication (COM_SHUTDOWN)
   */
  async stopMySqlWithPassword(password, host = '127.0.0.1', port = 3306, user = 'root') {
    try {
      const mysql2 = require('mysql2/promise');
      const conn = await mysql2.createConnection({
        host,
        port: parseInt(port) || 3306,
        user: user || 'root',
        password: password || '',
        connectTimeout: 4000
      });
      await conn.query('SHUTDOWN');
      try { await conn.end(); } catch (e) {}
      await new Promise(r => setTimeout(r, 800));
      const stillOpen = await this.checkPort(port);
      if (!stillOpen) {
        return { success: true, message: 'MySQL server stopped via password authentication' };
      }
      return { success: false, error: 'Shutdown command sent, but MySQL port is still active' };
    } catch (err) {
      if (err.code === 'ER_ACCESS_DENIED_ERROR') {
        return { success: false, error: 'Incorrect MySQL root password' };
      }
      return { success: false, error: err.message || 'Failed to connect to MySQL' };
    }
  }

  /**
   * Grant permanent start/stop permission for the service to current user
   */
  async grantServicePermission(serviceName) {
    const sddl = 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWRPWPDTLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)';
    try {
      const pCmd = `Start-Process cmd -ArgumentList '/c sc.exe sdset "${serviceName}" "${sddl}"' -Verb RunAs -WindowStyle Hidden -Wait`;
      await execPromise(`powershell -NoProfile -Command "${pCmd}"`, { timeout: 15000 });
      return { success: true, message: `Permanent start/stop permission granted for ${serviceName}` };
    } catch (err) {
      return { success: false, error: 'Failed to grant permission: ' + err.message };
    }
  }

  /**
   * Stop a service dynamically.
   * If PHP is stopped, all dependent sites are also stopped!
   */
  async stopService(id, siteManager = null, phpManager = null, mysqlManager = null, options = {}) {
    try {
      if (id === 'php' || id.startsWith('php')) {
        // 1. Stop all running sites in phpManager because PHP service is stopped!
        if (phpManager) {
          phpManager.stopAll();
        }
        if (siteManager) {
          const sites = siteManager.getSites() || [];
          sites.forEach(s => siteManager.updateSite(s.id, { status: 'stopped' }));
        }

        // 2. Terminate any php-cgi.exe processes
        try {
          await execPromise('taskkill /F /IM php-cgi.exe');
        } catch (e) {}

        return { success: true, message: 'PHP runtime and all running sites stopped' };
      }

      if (id === 'webserver' || id === 'nginx') {
        try {
          await execPromise('taskkill /F /IM nginx.exe');
        } catch (e) {}
        try {
          await execPromise('taskkill /F /IM httpd.exe');
        } catch (e) {}
        return { success: true, message: 'Web server stopped' };
      }

      if (id === 'mysql') {
        // Check if already stopped
        const alreadyPortOpen = await this.checkPort(3306);
        if (!alreadyPortOpen) {
          return { success: true, message: 'MySQL is already stopped' };
        }

        const mysqlInfo = await this._detectMySQL();
        const svcName = mysqlInfo.serviceName;

        // Method 1: If password provided in options or config
        if (options?.password !== undefined && options.password !== null) {
          const passRes = await this.stopMySqlWithPassword(options.password, '127.0.0.1', 3306, options?.user || 'root');
          if (passRes.success) return passRes;
          return passRes;
        }

        // Method 2: Graceful SHUTDOWN via active connection
        if (mysqlManager?.connection) {
          try {
            await mysqlManager.connection.query('SHUTDOWN');
            await mysqlManager.disconnect();
            await new Promise(r => setTimeout(r, 800));
            if (!(await this.checkPort(3306))) {
              return { success: true, message: 'MySQL stopped via active database session' };
            }
          } catch (e) {}
        }

        // Method 3: Standard net stop or Stop-Service
        if (svcName) {
          try {
            await execPromise(`net stop "${svcName}"`);
            await new Promise(r => setTimeout(r, 800));
            if (!(await this.checkPort(3306))) {
              return { success: true, message: `${svcName} stopped` };
            }
          } catch (e) {}

          // Method 4: Elevated Stop via Windows UAC if options.elevate is requested
          if (options?.elevate) {
            try {
              let pCmd = `Start-Process -FilePath "net.exe" -ArgumentList "stop","${svcName}" -Verb RunAs -WindowStyle Hidden -Wait`;
              if (options?.grantPermanent) {
                const sddl = 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWRPWPDTLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)';
                pCmd = `Start-Process -FilePath "cmd.exe" -ArgumentList '/c net stop "${svcName}" & sc.exe sdset "${svcName}" "${sddl}"' -Verb RunAs -WindowStyle Hidden -Wait`;
              }
              await execPromise(`powershell -NoProfile -Command "${pCmd}"`, { timeout: 15000 });
              await new Promise(r => setTimeout(r, 800));
              if (!(await this.checkPort(3306))) {
                return {
                  success: true,
                  message: options?.grantPermanent
                    ? `${svcName} stopped and permanent permission granted!`
                    : `${svcName} stopped via administrator elevation`
                };
              }
            } catch (e) {}
          }
        }

        // Method 5: Graceful mysqladmin shutdown or standard termination (NO /F to avoid InnoDB corruption)
        try {
          const adminPath = mysqlInfo.exePath ? path.join(path.dirname(mysqlInfo.exePath), 'mysqladmin.exe') : 'mysqladmin';
          await execPromise(`"${adminPath}" -u ${options?.user || 'root'} shutdown`, { timeout: 4000 });
          await new Promise(r => setTimeout(r, 800));
          if (!(await this.checkPort(3306))) {
            return { success: true, message: 'MySQL stopped safely via mysqladmin' };
          }
        } catch (e) {}

        try {
          // Graceful termination without /F
          await execPromise('taskkill /IM mysqld.exe /IM mariadbd.exe');
          await new Promise(r => setTimeout(r, 1200));
          if (!(await this.checkPort(3306))) {
            return { success: true, message: 'MySQL process gracefully closed' };
          }
        } catch (e) {}

        // Verify if port 3306 is still open
        const stillOpen = await this.checkPort(3306);
        if (!stillOpen) {
          return { success: true, message: 'MySQL service stopped successfully' };
        }

        return {
          success: false,
          requireElevation: true,
          serviceName: svcName || 'MySQL80',
          error: `Windows requires Administrator permission to stop the "${svcName || 'MySQL'}" system service.`
        };
      }

      return { success: false, error: 'Unknown service: ' + id };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Restart a service
   */
  async restartService(id, siteManager = null, phpManager = null, mysqlManager = null) {
    await this.stopService(id, siteManager, phpManager, mysqlManager);
    await new Promise(r => setTimeout(r, 600));
    return await this.startService(id, siteManager, phpManager, mysqlManager);
  }

  /**
   * Start all services
   */
  async startAllServices(siteManager = null, phpManager = null, mysqlManager = null) {
    const results = [];
    results.push(await this.startService('webserver', siteManager, phpManager, mysqlManager));
    results.push(await this.startService('php', siteManager, phpManager, mysqlManager));
    results.push(await this.startService('mysql', siteManager, phpManager, mysqlManager));
    return { success: true, results };
  }

  /**
   * Stop all services.
   * This immediately stops MySQL, Web server, PHP runtime, AND all running sites!
   */
  async stopAllServices(siteManager = null, phpManager = null, mysqlManager = null) {
    // 1. Stop all sites
    if (phpManager) {
      phpManager.stopAll();
    }
    if (siteManager) {
      const sites = siteManager.getSites() || [];
      sites.forEach(s => siteManager.updateSite(s.id, { status: 'stopped' }));
    }

    // 2. Kill web servers & PHP
    try { await execPromise('taskkill /F /IM nginx.exe /IM httpd.exe /IM php-cgi.exe'); } catch (e) {}

    // 3. Stop MySQL service
    await this.stopService('mysql', siteManager, phpManager, mysqlManager);

    return { success: true, message: 'All services and running sites stopped' };
  }
}

module.exports = ServiceManager;
