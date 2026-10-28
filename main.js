/**
 * C-Script LocalHost Panel - Main Electron Process
 * Local PHP & MySQL development environment
 */

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  nativeTheme,
  Menu,
  Tray,
  session
} = require('electron');

// Ensure only a single instance of the application runs to prevent cache locking conflicts
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
}

app.setName('C-Script LocalHost Panel');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { execFile, exec } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const PhpManager = require('./src/phpManager');
const MySQLManager = require('./src/mysqlManager');
const SiteManager = require('./src/siteManager');
const ServiceManager = require('./src/serviceManager');
const VhostsManager = require('./src/vhostsManager');
const FrameworkManager = require('./src/frameworkManager');
const MailCatcher = require('./src/mailCatcher');
const LogManager = require('./src/logManager');
const LiveLogStreamer = require('./src/liveLogStreamer');
const PortManager = require('./src/portManager');
const TunnelManager = require('./src/tunnelManager');
const PhpInstaller = require('./src/phpInstaller');
const PhpMyAdminManager = require('./src/phpMyAdminManager');
const NginxInstaller = require('./src/nginxInstaller');
const MysqlInstaller = require('./src/mysqlInstaller');
const LaravelManager = require('./src/laravelManager');
const LocalProxyBypass = require('./src/localProxyBypass');

let portManager;
let tunnelManager = new TunnelManager();
let phpInstaller = null;
let phpMyAdminManager = null;
let nginxInstaller = null;
let mysqlInstaller = null;
let liveLogStreamer = null;
let autoUpdater = null;
let updaterCheckInFlight = false;
let latestUpdaterRelease = null;

function isUpdateSignatureError(error) {
  const message = String(error?.message || error || '');
  return error?.code === 'ERR_UPDATER_INVALID_SIGNATURE' ||
    /not signed by the application owner|not digitally signed/i.test(message);
}

function getManualUpdateDetails(error) {
  const version = latestUpdaterRelease?.version || '';
  return {
    message: 'This unsigned release cannot be installed automatically by older versions. Download and run Setup once; future updates will work normally.',
    technicalMessage: error?.message || String(error),
    version,
    releaseUrl: latestUpdaterRelease?.releaseUrl || (version
      ? `https://github.com/CHAMI-csr/c-script-localhost-panel/releases/tag/v${version}`
      : 'https://github.com/CHAMI-csr/c-script-localhost-panel/releases/latest')
  };
}

// ─── Config Paths ───────────────────────────────────────────────────────────
let CONFIG_DIR = path.join(os.homedir(), '.c-script');
let CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
let SITES_FILE = path.join(CONFIG_DIR, 'sites.json');

function ensureConfigDir() {
  const preferred = path.join(os.homedir(), '.c-script');
  CONFIG_DIR = preferred;

  CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
  SITES_FILE = path.join(CONFIG_DIR, 'sites.json');

  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

// ─── Default Config ──────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  mysql: { host: '127.0.0.1', port: 3306, user: 'root', password: '' },
  php: { binary: 'php', defaultVersion: '' },
  phpmyadmin: { version: '5.2.3' },
  app: {
    theme: 'dark',
    autoConnectMySQL: false,
    autoStartServices: false,
    tld: 'test',
    autoVirtualHosts: true,
    autoindex: true,
    mailCatcherPort: 1025,
    autoStartMailCatcher: true,
    pageSize: 50,
    portsScope: 'app',
    confirmDropTable: true,
    minimizeToTray: true
  }
};

function isPhpFileInsideFolder(rootFolder, filePath) {
  try {
    const rootReal = fs.realpathSync(rootFolder);
    const fileReal = fs.realpathSync(filePath);
    if (!fs.statSync(rootReal).isDirectory() || !fs.statSync(fileReal).isFile() || path.extname(fileReal).toLowerCase() !== '.php') return false;
    const relative = path.relative(rootReal, fileReal);
    return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch (err) {
    return false;
  }
}

// ─── State ───────────────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let isQuitting = false;
let phpManager = null;
let mysqlManager = null;
let siteManager = null;
let serviceManager = null;
let shutdownPromise = null;
let shutdownComplete = false;
let closeInstallPromptOpen = false;
let laravelManager = null;
let viteProxyTimer = null;
let viteProxySyncInFlight = false;
const localProxyBypass = new LocalProxyBypass();

async function stopAppRuntime() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const failures = [];
    const attempt = async (label, action) => {
      try {
        const result = await action();
        if (result?.success === false) failures.push(`${label}: ${result.error || result.errors?.join('; ') || 'could not stop'}`);
      } catch (error) { failures.push(`${label}: ${error.message}`); }
    };
    await attempt('Public tunnels', () => tunnelManager?.stopAll());
    await attempt('Artisan processes', () => laravelManager?.stopAll());
    await attempt('Framework installations', () => frameworkManager?.stopAll());
    await attempt('phpMyAdmin domain route', () => removePhpMyAdminDomainRoute());
    await attempt('phpMyAdmin local server', () => phpMyAdminManager?.stopAll());
    if (viteProxyTimer) clearInterval(viteProxyTimer);
    viteProxyTimer = null;
    await attempt('Laravel Vite proxy', () => {
      vhostsManager?.restoreLaravelViteHotFiles(siteManager?.getSites() || []);
      return { success: true };
    });
    await attempt('PHP site servers', () => phpManager?.stopAllAndWait());
    await attempt('NGINX', async () => {
      if (nginxInstaller?.ownedProcess && nginxInstaller.ownedProcess.exitCode === null) return nginxInstaller.stop();
      return { success: true };
    });
    await attempt('MySQL connection', () => mysqlManager?.disconnect());
    await attempt('MySQL runtime', async () => {
      if (mysqlInstaller?.ownedProcess || mysqlInstaller?.ownedWindowsService) return mysqlInstaller.stop();
      return { success: true };
    });
    await attempt('Managed services', () => serviceManager?.stopOwnedServices());
    await attempt('Mail catcher', () => mailCatcher?.stop());
    if (liveLogStreamer) liveLogStreamer.stop();
    if (failures.length) console.warn('[Shutdown] Some app-owned services reported errors:', failures);
    return { success: failures.length === 0, failures };
  })();
  return shutdownPromise;
}

async function stopAllSiteSharing() {
  if (tunnelManager) await tunnelManager.stopAll();
}

function requestAppQuit(onKeepRunning) {
  if (!frameworkManager?.hasActiveInstallations?.()) {
    isQuitting = true;
    app.quit();
    return;
  }
  if (closeInstallPromptOpen) return;
  closeInstallPromptOpen = true;
  const options = {
    type: 'warning',
    title: 'Installation in Progress',
    message: 'A project installation or repair is still running.',
    detail: 'Choose whether to keep the installation running in the background or stop it and close C-Script. Stopping may leave the selected project folder incomplete.',
    buttons: ['Keep Running in Background', 'Stop Installation & Close'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)).then(({ response }) => {
    closeInstallPromptOpen = false;
    if (response === 1) {
      isQuitting = true;
      app.quit();
    } else if (typeof onKeepRunning === 'function') {
      onKeepRunning();
    }
  }).catch(error => {
    closeInstallPromptOpen = false;
    console.warn('[Window] Could not show installation close confirmation:', error.message);
  });
}

function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  if (!fs.existsSync(iconPath)) return;

  try {
    tray = new Tray(iconPath);
    const showWindow = () => {
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
      else createWindow();
    };
    const buildTrayMenu = async () => {
      const sites = siteManager?.getSites?.() || [];
      const runningSites = sites.filter(site => phpManager?.isRunning?.(site.id));
      let serviceStates = new Map();
      try { serviceStates = new Map((await serviceManager?.getServices?.(siteManager, phpManager) || []).map(item => [item.id, item.status === 'running'])); } catch (_) {}
      return Menu.buildFromTemplate([
        { label: 'Show C-Script Panel', click: showWindow },
        { type: 'separator' },
        ...[
          { id: 'webserver', label: 'NGINX' },
          { id: 'mysql', label: 'MariaDB / MySQL' },
          { id: 'php', label: 'PHP Runtime' }
        ].map(service => ({
          label: `${service.label} (${serviceStates.get(service.id) ? 'Running' : 'Stopped'})`,
          submenu: [
            { label: `Start ${service.label}`, enabled: !serviceStates.get(service.id), click: async () => { const result = await serviceManager?.startService(service.id, siteManager, phpManager, mysqlManager); if (result?.success === false) logManager?.log('Tray', result.error || `Could not start ${service.label}`, 'error'); } },
            { label: `Stop ${service.label}`, enabled: !!serviceStates.get(service.id), click: async () => { const result = await serviceManager?.stopService(service.id, siteManager, phpManager, mysqlManager); if (result?.success === false) logManager?.log('Tray', result.error || `Could not stop ${service.label}`, 'error'); } }
          ]
        })),
        { label: 'Start All Services', click: async () => { if (serviceManager) await serviceManager.startAllServices(siteManager, phpManager, mysqlManager); } },
        { label: 'Stop All Services', click: async () => { await stopAllSiteSharing(); if (serviceManager) await serviceManager.stopAllServices(siteManager, phpManager, mysqlManager); } },
        { type: 'separator' },
        { label: 'Active virtual hosts', enabled: runningSites.length > 0, submenu: runningSites.length
          ? runningSites.map(site => {
            const domain = site.domain || vhostsManager?.getDomain(site.name);
            return { label: domain, click: () => shell.openExternal(`http://${domain}`) };
          })
          : [{ label: 'No active sites', enabled: false }] },
        { label: 'Open error logs', click: () => {
          showWindow();
          setTimeout(() => mainWindow?.webContents.executeJavaScript("switchPanel('logs')").catch(() => {}), 150);
        } },
        { type: 'separator' },
        { label: 'Quit C-Script Panel', click: () => requestAppQuit() }
      ]);
    };
    buildTrayMenu().then(menu => tray?.setContextMenu(menu)).catch(() => {});
    tray.on('right-click', () => buildTrayMenu().then(menu => tray?.setContextMenu(menu)).catch(() => {}));
    tray.setToolTip('C-Script LocalHost Panel');
    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      } else {
        createWindow();
      }
    });
  } catch (e) {
    console.warn('Tray initialization failed:', e.message);
  }
}

// ─── Window Creation ─────────────────────────────────────────────────────────
function createWindow() {
  nativeTheme.themeSource = 'dark';

  mainWindow = new BrowserWindow({
    title: 'C-Script LocalHost Panel',
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      sandbox: false
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0D0D14',
      symbolColor: '#9999B3',
      height: 36
    },
    backgroundColor: '#000000',
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png').replace(/\\/g, '/')
  });

  // Remove the default menu
  Menu.setApplicationMenu(null);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {}
    const minimizeToTray = cfg?.app?.minimizeToTray ?? cfg?.minimizeToTray ?? true;

    if (!isQuitting && frameworkManager?.hasActiveInstallations?.()) {
      event.preventDefault();
      requestAppQuit(() => {
        if (minimizeToTray && tray && mainWindow) mainWindow.hide();
      });
      return;
    }

    if (!isQuitting && minimizeToTray && tray) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (isQuitting) {
      phpManager?.stopAll();
      mysqlManager?.disconnect();
    }
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  if (!isQuitting && frameworkManager?.hasActiveInstallations?.()) {
    event.preventDefault();
    requestAppQuit();
    return;
  }
  event.preventDefault();
  isQuitting = true;
  stopAppRuntime().finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});

// ─── App Lifecycle ────────────────────────────────────────────────────────────
let vhostsManager = null;
let frameworkManager = null;
let mailCatcher = null;
let logManager = null;

app.whenReady().then(async () => {
  app.setName('C-Script LocalHost Panel');
  ensureConfigDir();

  // Keep in-app webviews on the OS proxy, but route loopback and local dev TLDs directly.
  try {
    await session.defaultSession.setProxy({
      mode: 'system',
      proxyBypassRules: '<local>,*.test,*.localhost,localhost,127.0.0.1,::1'
    });
  } catch (error) {
    console.warn('[LocalProxyBypass] Could not configure Electron local bypass rules:', error.message);
  }

  // Auto-provision bundled stack (PHP 8.4, NGINX, MySQL) on fresh install
  try {
    const AutoProvisioner = require('./src/autoProvisioner');
    const provision = await AutoProvisioner.provisionIfNeeded();
    if (!provision.success) {
      console.warn('[AutoProvisioner] Some bundled runtimes could not be prepared:', provision.errors);
    }
  } catch (provErr) {
    console.error('[AutoProvisioner] Startup provision error:', provErr);
  }

  // Construct installers only after provisioning; their constructors create AppData
  // directories that would otherwise make AutoProvisioner mistake empty folders for runtimes.
  phpInstaller = new PhpInstaller();
  nginxInstaller = new NginxInstaller();
  mysqlInstaller = new MysqlInstaller();

  phpManager = new PhpManager();
  const userProfile = process.env.USERPROFILE || os.homedir();
  const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
  phpMyAdminManager = new PhpMyAdminManager({
    baseDir: path.join(appData, 'c-script-localhost', 'phpmyadmin'),
    phpManager,
    phpInstaller
  });
  phpMyAdminManager.on('progress', data => mainWindow?.webContents.send('phpmyadmin:progress', data));
  mysqlManager = new MySQLManager();
  siteManager = new SiteManager(SITES_FILE);
  serviceManager = new ServiceManager();
  laravelManager = new LaravelManager();
  laravelManager.on('output', data => mainWindow?.webContents.send('laravel:output', data));

  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg?.php?.binary) phpManager.setPHPBinary(cfg.php.binary);
  } catch (e) { /* use default */ }

  const tld = cfg?.app?.tld || cfg?.tld || 'test';
  vhostsManager = new VhostsManager(tld);
  viteProxyTimer = setInterval(async () => {
    if (!vhostsManager || !siteManager || viteProxySyncInFlight) return;
    const proxySites = siteManager.getSites().map(site => ({
      ...site,
      domain: site.domain || vhostsManager.getDomain(site.name, vhostsManager.defaultTld),
      status: phpManager.isRunning(site.id) ? 'running' : 'stopped',
      port: phpManager.getPort(site.id) || site.port,
      fastCgiPort: phpManager.getFastCgiPort(site.id)
    }));
    try {
      if (!vhostsManager.refreshLaravelVite(proxySites)) return;
      viteProxySyncInFlight = true;
      await vhostsManager.syncReverseProxy(proxySites);
    } catch (error) {
      console.warn('[Laravel Vite] Could not refresh the NGINX proxy:', error.message);
    } finally {
      viteProxySyncInFlight = false;
    }
  }, 2000);
  viteProxyTimer.unref?.();
  frameworkManager = new FrameworkManager();
  frameworkManager.on('progress', data => mainWindow?.webContents.send('frameworks:progress', data));
  logManager = new LogManager();
  liveLogStreamer = new LiveLogStreamer({
    onLine: entry => logManager?.log(entry.source, entry.message, entry.level)
  });
  liveLogStreamer.start();
  mailCatcher = new MailCatcher(cfg?.app?.mailCatcherPort || cfg?.mail?.port || 1025);
  portManager = new PortManager();

  if (cfg?.app?.autoStartMailCatcher !== false && cfg?.mail?.autoStart !== false) {
    mailCatcher.start().catch(() => {});
  }

  // Forward PHP logs to renderer and log collector
  phpManager.on('log', (data) => {
    mainWindow?.webContents.send('php:log', data);
    logManager.log('PHP', data.message || JSON.stringify(data), data.type === 'error' ? 'error' : 'info');
  });

  tunnelManager.on('tunnel-stopped', ({ siteId }) => {
    mainWindow?.webContents.send('tunnel:stopped', { siteId });
  });

  // Forward site-stopped events to renderer
  phpManager.on('site-stopped', async (data) => {
    if (data.siteId) await tunnelManager.stopTunnel(data.siteId);
    mainWindow?.webContents.send('site:stopped', data);
    logManager.log('Sites', `Site ${data.siteId || ''} stopped`, 'warn');
  });

  mailCatcher.on('email', (data) => {
    mainWindow?.webContents.send('mail:new', data);
    logManager.log('MailCatcher', `New email received: "${data.subject}" to ${data.to?.join(', ')}`, 'info');
  });

  logManager.on('entry', (data) => {
    mainWindow?.webContents.send('log:entry', data);
  });

  if (phpInstaller) {
    phpInstaller.on('download-progress', (data) => {
      mainWindow?.webContents.send('php:download-progress', data);
    });
    phpInstaller.on('install-status', (data) => {
      mainWindow?.webContents.send('php:install-status', data);
    });
    phpInstaller.ensureStandalonePhp().catch(() => {});
  }

  if (nginxInstaller) {
    nginxInstaller.on('download-progress', (data) => {
      mainWindow?.webContents.send('nginx:download-progress', data);
    });
    nginxInstaller.on('install-status', (data) => {
      mainWindow?.webContents.send('nginx:install-status', data);
    });
  }

  if (mysqlInstaller) {
    mysqlInstaller.on('download-progress', (data) => {
      mainWindow?.webContents.send('mysql-installer:download-progress', data);
    });
    mysqlInstaller.on('install-status', (data) => {
      mainWindow?.webContents.send('mysql-installer:install-status', data);
    });
  }

  createWindow();
  setupAppUpdater();
  createTray();

  // Startup health check for PHP, NGINX, and MySQL services
  setTimeout(async () => {
    try {
      if (serviceManager) {
        const hc = await serviceManager.runHealthCheck(siteManager, phpManager, mysqlManager);
        if (logManager) {
          if (hc.errors && hc.errors.length > 0) {
            for (const err of hc.errors) {
              logManager.log('Application Error', `Service Health Check: ${err}`, 'error');
            }
          } else {
            logManager.log('System', 'All services passed startup health check.', 'info');
          }
        }
      }
    } catch (e) {
      if (logManager) logManager.log('Application Error', `Startup Health Check exception: ${e.message}`, 'error');
    }
  }, 2500);

  // Global uncaught errors routed to server logs under Application Error
  process.on('uncaughtException', (err) => {
    console.error('[Main] Uncaught Exception:', err);
    if (logManager) logManager.log('Application Error', `Uncaught Exception: ${err.message}\n${err.stack || ''}`, 'error');
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[Main] Unhandled Rejection:', reason);
    if (logManager) logManager.log('Application Error', `Unhandled Rejection: ${reason?.message || reason}`, 'error');
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
});

app.on('window-all-closed', () => {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {}
  const minimizeToTray = cfg?.app?.minimizeToTray ?? cfg?.minimizeToTray ?? true;

  if (!minimizeToTray || isQuitting) {
    if (process.platform !== 'darwin') app.quit();
  }
});

// ─── IPC: Sites ───────────────────────────────────────────────────────────────
ipcMain.handle('sites:list', () => {
  const sites = siteManager.getSites();
  let tld = 'test';
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg?.app?.tld) tld = cfg.app.tld;
    else if (cfg?.tld) tld = cfg.tld;
  } catch (e) {}

  return sites.map(site => {
    const isLaravel = LaravelManager.isLaravelProject(site.root);
    return {
      ...site,
      domain: site.domain || vhostsManager.getDomain(site.name, tld),
      status: phpManager.isRunning(site.id) ? 'running' : 'stopped',
      port: phpManager.getPort(site.id) || site.port,
      fastCgiPort: phpManager.getFastCgiPort(site.id),
      isLaravel,
      laravelReady: !isLaravel || fs.existsSync(path.join(site.root, 'vendor', 'autoload.php'))
    };
  });
});

ipcMain.handle('sites:add', async (event, siteData) => {
  let rootIsDirectory = false;
  try { rootIsDirectory = typeof siteData?.root === 'string' && fs.statSync(siteData.root).isDirectory(); } catch (_) {}
  if (!rootIsDirectory) {
    return { success: false, error: 'Choose an existing site folder.' };
  }
  const isLaravelSite = LaravelManager.isLaravelProject(siteData.root);
  if (isLaravelSite && !fs.existsSync(path.join(siteData.root, 'vendor', 'autoload.php'))) {
    return { success: false, error: 'Laravel dependencies are not installed yet. Select “Laravel Project (Composer install)” to install them before adding this site.' };
  }
  const laravelEntryFile = path.join(siteData.root, 'public', 'index.php');
  if (isLaravelSite && !fs.existsSync(laravelEntryFile)) {
    return { success: false, error: 'Laravel was found, but public/index.php is missing. No entry point was selected.' };
  }
  if (siteData.framework === 'laravel' &&
      (!isLaravelSite || !fs.existsSync(path.join(siteData.root, 'vendor', 'autoload.php')))) {
    return { success: false, error: 'Laravel is not fully installed in this folder yet. Finish the installation before adding or starting the site.' };
  }
  if (isLaravelSite && !siteData.entryFile) siteData.entryFile = laravelEntryFile;
  if (siteData.entryFile) {
    if (!path.isAbsolute(siteData.entryFile)) siteData.entryFile = path.resolve(siteData.root, siteData.entryFile);
    if (!isPhpFileInsideFolder(siteData.root, siteData.entryFile)) {
      return { success: false, error: 'Choose a PHP run file from inside the selected site folder.' };
    }
  }

  // Validate requested port or assign a dedicated free port
  const requestedPort = siteData?.port ? parseInt(siteData.port, 10) : 0;
  if (requestedPort > 0) {
    const conflict = siteManager.isPortUsedByOtherSite(requestedPort);
    if (conflict) {
      return { success: false, error: `Port ${requestedPort} is already assigned to site "${conflict.name}". Please choose another port.` };
    }
  } else {
    // If 0/auto, allocate a guaranteed free port so every site has its own reserved port
    const reserved = siteManager.getAllAssignedPorts();
    try {
      siteData.port = await phpManager.findFreePort(8000, reserved);
    } catch (_) {
      siteData.port = null;
    }
  }

  let tld = 'test';
  let autoVhosts = true;
  let defaultAutoindex = true;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg?.app?.tld) tld = cfg.app.tld;
    else if (cfg?.tld) tld = cfg.tld;
    if (cfg?.app?.autoVirtualHosts !== undefined) autoVhosts = cfg.app.autoVirtualHosts;
    else if (cfg?.autoVirtualHosts !== undefined) autoVhosts = cfg.autoVirtualHosts;
    if (cfg?.app?.autoindex !== undefined) defaultAutoindex = cfg.app.autoindex;
    else if (cfg?.autoindex !== undefined) defaultAutoindex = cfg.autoindex;
  } catch (e) {}

  if (siteData && siteData.autoindex === undefined) {
    siteData.autoindex = defaultAutoindex;
  }

  siteData.domain = siteData.domain || vhostsManager.getDomain(siteData.name, tld);
  const result = siteManager.addSite(siteData);
  if (result.success && autoVhosts) {
    const allSites = siteManager.getSites();
    const domains = allSites.map(s => s.domain || vhostsManager.getDomain(s.name, tld));
    vhostsManager.syncHosts(domains).catch(() => {});
  }
  return result;
});

ipcMain.handle('sites:remove', async (event, id) => {
  await tunnelManager?.stopTunnel(id);
  phpManager.stop(id);
  return siteManager.removeSite(id);
});

ipcMain.handle('sites:start', async (event, id) => {
  const site = siteManager.getSite(id);
  if (!site) return { success: false, error: 'Site not found' };
  if (LaravelManager.isLaravelProject(site.root) && !fs.existsSync(path.join(site.root, 'vendor', 'autoload.php'))) {
    return { success: false, error: 'Laravel dependencies are still missing. Finish Composer installation before starting this site.' };
  }
  if (LaravelManager.isLaravelProject(site.root) && !fs.existsSync(path.join(site.root, 'public', 'index.php'))) {
    return { success: false, error: 'Laravel public/index.php was not found. The site was not started because no entry point is available.' };
  }

  // Load PHP binary from current config
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg?.php?.binary) phpManager.setPHPBinary(cfg.php.binary);
  } catch (e) { /* use default */ }

  // Check if PHP is installed and executable
  const phpCheck = await phpManager.getVersion(phpManager.getBinaryForSite(site));
  if (!phpCheck.available) {
    return {
      success: false,
      error: phpCheck.error || 'PHP runtime not found. Make sure PHP is installed or configure the PHP path in Settings.'
    };
  }

  // FastCGI sites start their own selected PHP-CGI worker below; other sites
  // may use the shared runtime service for their built-in PHP server.
  if (site.phpMode !== 'fastcgi') await serviceManager.startService('php', siteManager, phpManager);

  // Reserve all ports of other sites (stopped and running)
  const reservedPorts = siteManager.getAllAssignedPorts(site.id);
  if (site.phpMode === 'fastcgi') {
    if (!vhostsManager?.getNginxInfo()?.exePath) {
      return { success: false, error: 'NGINX FastCGI mode requires the app-managed NGINX server. Install NGINX in Settings, then start this site again.' };
    }
    const fastCgi = await phpManager.startFastCgi(site);
    if (!fastCgi.success) return fastCgi;
  }
  const result = await phpManager.start(site, reservedPorts);
  if (!result.success && site.phpMode === 'fastcgi') phpManager.stopFastCgi(site.id);
  if (result.success) {
    siteManager.updateSite(id, { status: 'running', port: result.port });
    // Sync hosts and reverse proxy so site is accessible on port 80 without entering any port number!
    if (vhostsManager) {
      const allSites = siteManager.getSites().map(s => ({
        ...s,
        domain: s.domain || vhostsManager.getDomain(s.name, vhostsManager.defaultTld),
        status: phpManager.isRunning(s.id) ? 'running' : 'stopped',
        port: phpManager.getPort(s.id) || s.port,
        fastCgiPort: phpManager.getFastCgiPort(s.id)
      }));
      const domains = allSites.map(s => s.domain);
      vhostsManager.syncHosts(domains).catch(() => {});
      const proxyResult = await vhostsManager.syncReverseProxy(allSites).catch(() => null);
      if (proxyResult?.method === 'nginx' && proxyResult.ssl === false) {
        result.warning = `HTTP is available, but HTTPS is not configured: ${proxyResult.sslError || 'A complete local certificate and private key are required.'}`;
      }
    }

    // Automatically ensure NGINX Web Server is started so custom domains (*.test on port 80/443) load in the browser!
    try {
      const nginxRes = await serviceManager.startService('webserver', siteManager, phpManager);
      if (nginxRes && !nginxRes.success) {
        result.warning = [result.warning, `NGINX could not start: ${nginxRes.error}`].filter(Boolean).join(' ');
      }
    } catch (nginxErr) {
      result.warning = [result.warning, `NGINX could not start: ${nginxErr.message}`].filter(Boolean).join(' ');
      console.warn('[Sites:Start] Auto-start NGINX error:', nginxErr.message);
    }
  }
  return result;
});

ipcMain.handle('sites:stop', async (event, id) => {
  await tunnelManager?.stopTunnel(id);
  const stopped = phpManager.stop(id);
  siteManager.updateSite(id, { status: 'stopped' });
  if (vhostsManager) {
    const allSites = siteManager.getSites().map(s => ({
      ...s,
      domain: s.domain || vhostsManager.getDomain(s.name, vhostsManager.defaultTld),
      status: phpManager.isRunning(s.id) ? 'running' : 'stopped',
      port: phpManager.getPort(s.id) || s.port,
      fastCgiPort: phpManager.getFastCgiPort(s.id)
    }));
    vhostsManager.syncReverseProxy(allSites).catch(() => {});
  }
  return { success: true, stopped };
});

ipcMain.handle('sites:update', (event, { id, data }) => {
  const site=siteManager.getSite(id);
  if (Object.prototype.hasOwnProperty.call(data || {}, 'port')) {
    const port=data.port==null?0:Number(data.port);
    if (!Number.isInteger(port)||port<0||port>65535) return { success: false, error: 'Port must be between 0 and 65535.' };
    if (port > 0) {
      const conflict = siteManager.isPortUsedByOtherSite(port, id);
      if (conflict) {
        return { success: false, error: `Port ${port} is already assigned to site "${conflict.name}". Please choose another port.` };
      }
    }
    data.port=port||null;
  }
  if (Object.prototype.hasOwnProperty.call(data || {}, 'entryFile') && data.entryFile &&
      (!site || !isPhpFileInsideFolder(site.root, data.entryFile))) {
    return { success: false, error: 'Choose a PHP run file from inside the selected site folder.' };
  }
  if (Object.prototype.hasOwnProperty.call(data || {}, 'autoindex')) {
    data.autoindex = !!data.autoindex;
  }
  if (Object.prototype.hasOwnProperty.call(data || {}, 'phpMode')) {
    if (!['builtin', 'fastcgi'].includes(data.phpMode)) return { success: false, error: 'Choose a supported PHP request handler.' };
  }
  return siteManager.updateSite(id, data);
});

ipcMain.handle('sites:suggest-port', async () => {
  const reserved = siteManager.getAllAssignedPorts();
  try {
    return await phpManager.findFreePort(8000, reserved);
  } catch (e) {
    return 8000;
  }
});

ipcMain.handle('sites:browse-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Site Document Root'
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('sites:open-folder', (event, folderPath) => {
  shell.openPath(folderPath);
  return { success: true };
});

ipcMain.handle('sites:open-code', (event, folderPath) => {
  if (!folderPath || !fs.existsSync(folderPath)) return { success: false, error: 'Directory does not exist' };
  exec(`code "${folderPath}"`, { windowsHide: true }, (err) => {
    if (err) console.warn('Could not launch VS Code:', err.message);
  });
  return { success: true };
});

ipcMain.handle('sites:open-terminal', (event, folderPath) => {
  if (!folderPath || !fs.existsSync(folderPath)) return { success: false, error: 'Directory does not exist' };
  const wtCmd = `wt.exe -d "${folderPath}"`;
  exec(wtCmd, { windowsHide: true }, (err) => {
    if (err) {
      const psCmd = `start powershell.exe -NoExit -Command "Set-Location -LiteralPath '${folderPath.replace(/'/g, "''")}'"`;
      exec(psCmd, { windowsHide: true }, () => {});
    }
  });
  return { success: true };
});

ipcMain.handle('sites:git-info', async (event, folderPath) => {
  if (!folderPath || !fs.existsSync(folderPath)) return { isGit: false };
  const gitDir = path.join(folderPath, '.git');
  if (!fs.existsSync(gitDir)) return { isGit: false };

  try {
    let branch = 'unknown';
    const headPath = path.join(gitDir, 'HEAD');
    if (fs.existsSync(headPath)) {
      const headContent = fs.readFileSync(headPath, 'utf8').trim();
      const match = headContent.match(/^ref:\s*refs\/heads\/(.+)$/);
      if (match) {
        branch = match[1];
      } else if (/^[0-9a-f]{7,40}$/i.test(headContent)) {
        branch = headContent.substring(0, 7);
      }
    }

    let isClean = true;
    try {
      const { stdout } = await execAsync(`git -C "${folderPath}" status --porcelain`, { timeout: 1500 });
      isClean = stdout.trim().length === 0;
    } catch (e) {}

    return { isGit: true, branch, isClean };
  } catch (err) {
    return { isGit: false };
  }
});

// ─── IPC: Services ────────────────────────────────────────────────────────────
ipcMain.handle('services:list', async () => {
  return await serviceManager.getServices(siteManager, phpManager);
});

ipcMain.handle('services:start', async (event, id, options) => {
  return await serviceManager.startService(id, siteManager, phpManager, mysqlManager, options);
});

ipcMain.handle('services:stop', async (event, id, options) => {
  if (id === 'php' || String(id).startsWith('php')) await stopAllSiteSharing();
  return await serviceManager.stopService(id, siteManager, phpManager, mysqlManager, options);
});

ipcMain.handle('services:restart', async (event, id, options) => {
  if (id === 'php' || String(id).startsWith('php')) await stopAllSiteSharing();
  return await serviceManager.restartService(id, siteManager, phpManager, mysqlManager, options);
});

ipcMain.handle('services:start-all', async () => {
  return await serviceManager.startAllServices(siteManager, phpManager, mysqlManager);
});

ipcMain.handle('services:stop-all', async () => {
  await stopAllSiteSharing();
  return await serviceManager.stopAllServices(siteManager, phpManager, mysqlManager);
});

ipcMain.handle('services:grant-permission', async (event, serviceName) => {
  return await serviceManager.grantServicePermission(serviceName);
});

ipcMain.handle('services:health-check', async () => {
  if (!serviceManager) return { healthy: false, errors: ['Service manager is not initialized'] };
  const res = await serviceManager.runHealthCheck(siteManager, phpManager, mysqlManager);
  if (logManager) {
    if (res.errors && res.errors.length > 0) {
      for (const err of res.errors) {
        logManager.log('Application Error', `Service Health Check: ${err}`, 'error');
      }
    } else {
      logManager.log('System', 'All services passed startup health check.', 'info');
    }
  }
  return res;
});

ipcMain.handle('services:reinstall', async (event, id) => {
  if (!serviceManager) return { success: false, error: 'Service manager is not ready' };
  const res = await serviceManager.reinstallService(id, siteManager, phpManager, mysqlManager, nginxInstaller, mysqlInstaller, phpInstaller);
  if (logManager) {
    logManager.log(
      res.success ? 'System' : 'Application Error',
      `Service Reinstall (${id}): ${res.success ? res.message : res.error}`,
      res.success ? 'success' : 'error'
    );
  }
  return res;
});

// ─── IPC: MySQL ───────────────────────────────────────────────────────────────
ipcMain.handle('mysql:connect', async (event, config) => {
  return await mysqlManager.connect(config);
});

ipcMain.handle('mysql:disconnect', async () => {
  return await mysqlManager.disconnect();
});

ipcMain.handle('mysql:status', () => {
  return mysqlManager.getStatus();
});

ipcMain.handle('mysql:databases', async () => {
  return await mysqlManager.getDatabases();
});

ipcMain.handle('mysql:tables', async (event, database) => {
  return await mysqlManager.getTables(database);
});

ipcMain.handle('mysql:columns', async (event, { database, table }) => {
  return await mysqlManager.getColumns(database, table);
});

ipcMain.handle('mysql:table-data', async (event, { database, table, limit, offset }) => {
  return await mysqlManager.getTableData(database, table, limit, offset);
});

ipcMain.handle('mysql:update-row', async (event, { database, table, primary, changes }) => {
  return await mysqlManager.updateTableRow(database, table, primary, changes);
});

ipcMain.handle('mysql:insert-row', async (event, { database, table, values }) => {
  return await mysqlManager.insertTableRow(database, table, values);
});

ipcMain.handle('mysql:delete-row', async (event, { database, table, primary }) => {
  return await mysqlManager.deleteTableRow(database, table, primary);
});

ipcMain.handle('mysql:query', async (event, { database, query }) => {
  return await mysqlManager.runQuery(database, query);
});

ipcMain.handle('mysql:create-db', async (event, { name, charset, collation }) => {
  return await mysqlManager.createDatabase(name, charset, collation);
});

function setupAppUpdater() {
  try {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    // Bypass code signature verification for open-source releases without a paid certificate
    autoUpdater.verifyUpdateCodeSignature = () => Promise.resolve(null);
    const report = (status, details = {}) => mainWindow?.webContents.send('updater:status', { status, ...details });
    autoUpdater.on('checking-for-update', () => report('checking'));
    autoUpdater.on('update-available', info => {
      updaterCheckInFlight = false;
      const relUrl = `https://github.com/CHAMI-csr/c-script-localhost-panel/releases/tag/v${info.version}`;
      latestUpdaterRelease = { version: info.version, releaseUrl: relUrl };
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
      let notes = info.releaseNotes || '';
      if (Array.isArray(notes)) {
        notes = notes.map(n => typeof n === 'string' ? n : (n.note || '')).filter(Boolean).join('\n\n');
      }
      report('available', { version: info.version, releaseDate: info.releaseDate, releaseNotes: notes, releaseUrl: relUrl });
    });
    autoUpdater.on('update-not-available', info => { updaterCheckInFlight = false; report('not-available', { version: info.version }); });
    autoUpdater.on('download-progress', progress => report('progress', { percent: progress.percent, transferred: progress.transferred, total: progress.total }));
    autoUpdater.on('update-downloaded', info => {
      let notes = info.releaseNotes || '';
      if (Array.isArray(notes)) {
        notes = notes.map(n => typeof n === 'string' ? n : (n.note || '')).filter(Boolean).join('\n\n');
      }
      const relUrl = `https://github.com/CHAMI-csr/c-script-localhost-panel/releases/tag/v${info.version}`;
      report('downloaded', { version: info.version, releaseNotes: notes, releaseUrl: relUrl });
    });
    autoUpdater.on('error', error => {
      updaterCheckInFlight = false;
      if (isUpdateSignatureError(error)) {
        report('manual-update-required', getManualUpdateDetails(error));
      } else {
        report('error', { message: error.message || String(error) });
      }
    });
    const firstCheck = setTimeout(() => requestAppUpdateCheck(), 2500);
    firstCheck.unref?.();
    // Check several times a day so security releases are surfaced promptly.
    const periodicCheck = setInterval(() => requestAppUpdateCheck(), 6 * 60 * 60 * 1000);
    periodicCheck.unref?.();
  } catch (error) {
    console.warn('[Updater] Could not initialize electron-updater:', error.message);
  }
}

function isNewerVersion(remote, local) {
  const clean = v => String(v || '').replace(/^v/i, '').trim().split('.').map(n => parseInt(n, 10) || 0);
  const r = clean(remote);
  const l = clean(local);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] || 0;
    const lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

function checkGitHubReleaseDirect() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/CHAMI-csr/c-script-localhost-panel/releases/latest',
      headers: {
        'User-Agent': 'c-script-localhost-panel',
        'Accept': 'application/vnd.github.v3+json'
      },
      timeout: 8000
    };
    const req = https.get(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const data = JSON.parse(body);
            const tag = data.tag_name || data.name || '';
            const version = tag.replace(/^v/i, '').trim();
            const current = app.getVersion();
            const hasUpdate = isNewerVersion(version, current);
            resolve({
              success: true,
              hasUpdate,
              version,
              releaseNotes: data.body || '',
              releaseUrl: data.html_url || 'https://github.com/CHAMI-csr/c-script-localhost-panel/releases'
            });
          } else {
            resolve({ success: false, error: `GitHub API returned ${res.statusCode}` });
          }
        } catch (e) {
          resolve({ success: false, error: e.message });
        }
      });
    });
    req.on('error', (err) => resolve({ success: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Request timeout' }); });
  });
}

async function requestAppUpdateCheck() {
  if (updaterCheckInFlight) return { success: false, error: 'An update check is already running.' };
  updaterCheckInFlight = true;
  try {
    if (app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR && autoUpdater) {
      try {
        await autoUpdater.checkForUpdates();
        return { success: true };
      } catch (err) {
        console.warn('[Updater] electron-updater check failed, falling back to GitHub API:', err.message);
      }
    }
    // Direct GitHub release check fallback
    const gh = await checkGitHubReleaseDirect();
    updaterCheckInFlight = false;
    if (gh.success && gh.hasUpdate) {
      latestUpdaterRelease = { version: gh.version, releaseUrl: gh.releaseUrl };
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
      }
      mainWindow?.webContents.send('updater:status', {
        status: 'available',
        version: gh.version,
        releaseNotes: gh.releaseNotes,
        releaseUrl: gh.releaseUrl
      });
      return { success: true, updateAvailable: true, version: gh.version, releaseNotes: gh.releaseNotes, releaseUrl: gh.releaseUrl };
    } else if (gh.success && !gh.hasUpdate) {
      mainWindow?.webContents.send('updater:status', {
        status: 'not-available',
        version: app.getVersion()
      });
      return { success: true, updateAvailable: false, version: app.getVersion() };
    }
    return gh;
  } catch (error) {
    updaterCheckInFlight = false;
    return { success: false, error: error.message };
  }
}

ipcMain.handle('updater:version', () => ({ version: app.getVersion(), packaged: app.isPackaged, portable: !!process.env.PORTABLE_EXECUTABLE_DIR }));
ipcMain.handle('updater:check', async () => {
  return requestAppUpdateCheck();
});
ipcMain.handle('updater:download', async () => {
  if (!autoUpdater) return { success: false, error: 'The updater could not be initialized.' };
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (error) {
    if (isUpdateSignatureError(error)) {
      return { success: false, manualUpdateRequired: true, ...getManualUpdateDetails(error) };
    }
    return { success: false, error: error.message };
  }
});
ipcMain.handle('updater:install', async () => {
  if (!autoUpdater) return { success: false, error: 'The updater could not be initialized.' };
  isQuitting = true;
  await stopAppRuntime();
  shutdownComplete = true;
  autoUpdater.quitAndInstall(false, true);
  return { success: true };
});

ipcMain.handle('mysql:create-table', async (event, { database, table, columns, options }) => {
  return await mysqlManager.createTable(database, table, columns, options);
});

ipcMain.handle('mysql:server-settings', async () => {
  return await mysqlManager.getServerSettings();
});

ipcMain.handle('mysql:apply-session-settings', async (event, settings) => {
  return await mysqlManager.applySessionSettings(settings);
});

ipcMain.handle('mysql:set-database-defaults', async (event, { database, charset, collation }) => {
  return await mysqlManager.setDatabaseDefaults(database, charset, collation);
});

ipcMain.handle('mysql:set-server-limits', async (event, { maxConnections, maxAllowedPacket }) => {
  return await mysqlManager.setServerLimits(maxConnections, maxAllowedPacket);
});

ipcMain.handle('mysql:change-password', async (event, { currentPassword, newPassword }) => {
  return await mysqlManager.changeOwnPassword(currentPassword, newPassword);
});

ipcMain.handle('mysql:drop-db', async (event, name) => {
  return await mysqlManager.dropDatabase(name);
});

ipcMain.handle('mysql:table-structure', async (event, { database, table }) => {
  return await mysqlManager.getTableStructure(database, table);
});

ipcMain.handle('mysql:table-info', async (event, { database, table }) => {
  return await mysqlManager.getTableInfo(database, table);
});

ipcMain.handle('mysql:db-info', async (event, database) => {
  return await mysqlManager.getDatabaseInfo(database);
});

ipcMain.handle('mysql:truncate-table', async (event, { database, table }) => {
  return await mysqlManager.truncateTable(database, table);
});

ipcMain.handle('mysql:drop-table', async (event, { database, table }) => {
  return await mysqlManager.dropTable(database, table);
});

ipcMain.handle('mysql:add-column', async (event, { database, table, column }) => {
  return await mysqlManager.addTableColumn(database, table, column);
});

ipcMain.handle('mysql:drop-column', async (event, { database, table, column }) => {
  return await mysqlManager.dropTableColumn(database, table, column);
});

ipcMain.handle('mysql:modify-column', async (event, { database, table, oldColumn, column }) => {
  return await mysqlManager.modifyTableColumn(database, table, oldColumn, column);
});

ipcMain.handle('mysql:rename-table', async (event, { database, oldName, newName }) => {
  return await mysqlManager.renameTable(database, oldName, newName);
});

ipcMain.handle('mysql:server-vars', async () => {
  return await mysqlManager.getServerVars();
});

ipcMain.handle('mysql:import-sql', async (event, options) => {
  let filePath = options?.filePath;
  const targetDatabase = typeof options === 'string' ? options : (options?.database || null);

  if (!filePath) {
    const picked = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'SQL Files', extensions: ['sql', 'gz'] }, { name: 'All Files', extensions: ['*'] }],
      title: 'Select SQL file to import'
    });
    if (picked.canceled || !picked.filePaths[0]) return { success: false, canceled: true };
    filePath = picked.filePaths[0];
  }

  try {
    const res = await mysqlManager.importFile(filePath, targetDatabase);
    return { ...res, fileName: path.basename(filePath), filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('mysql:load-sql-file', async () => {
  const picked = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'SQL Files', extensions: ['sql', 'gz'] }, { name: 'All Files', extensions: ['*'] }],
    title: 'Select SQL file to open in Query Editor'
  });
  if (picked.canceled || !picked.filePaths[0]) return { success: false, canceled: true };
  try {
    const res = mysqlManager.readSqlFileContent(picked.filePaths[0]);
    return res;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('mysql:export-database', async (event, database) => {
  const picked = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `${database}_backup.sql`,
    filters: [{ name: 'SQL Backup', extensions: ['sql', 'gz'] }],
    title: 'Export database backup'
  });
  if (picked.canceled || !picked.filePath) return { success: false, canceled: true };
  try {
    const result = await mysqlManager.exportDatabaseToFile(database, picked.filePath);
    return { ...result, filePath: picked.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('mysql:table-relationships', async (event, { database, table }) => {
  return await mysqlManager.getTableRelationships(database, table);
});

ipcMain.handle('mysql:add-foreign-key', async (event, { database, table, fk }) => {
  return await mysqlManager.addForeignKey(database, table, fk);
});

ipcMain.handle('mysql:drop-foreign-key', async (event, { database, table, constraintName }) => {
  return await mysqlManager.dropForeignKey(database, table, constraintName);
});

ipcMain.handle('mysql:er-diagram', async (event, database) => {
  return await mysqlManager.getDatabaseERDiagram(database);
});

// ─── IPC: PHP ─────────────────────────────────────────────────────────────────
ipcMain.handle('php:version', async () => {
  return await phpManager.getVersion();
});

ipcMain.handle('php:info', async () => {
  try {
    const [verResult, infoResult] = await Promise.all([
      phpManager.getVersion(),
      phpManager.getInfo()
    ]);

    if (!verResult.available && !infoResult.success) {
      return {
        success: false,
        error: verResult.error || infoResult.error || 'PHP executable not found. Configure PHP in Settings.'
      };
    }

    const iniPath = infoResult.iniPath && infoResult.iniPath !== 'Not found' && infoResult.iniPath !== 'None'
      ? infoResult.iniPath
      : null;

    let directives = {
      upload_max_filesize: '2M',
      memory_limit: '128M',
      post_max_size: '8M',
      max_execution_time: '30s',
      display_errors: 'Off',
      timezone: 'UTC',
      opcache: 'Disabled'
    };

    if (iniPath && fs.existsSync(iniPath)) {
      try {
        const content = fs.readFileSync(iniPath, 'utf8');
        const getVal = (name, def = 'Default') => {
          const regex = new RegExp('^\\s*' + name.replace('.', '\\.') + '\\s*=\\s*([^\\r\\n;]+)', 'm');
          const m = content.match(regex);
          return m ? m[1].trim() : def;
        };
        directives = {
          upload_max_filesize: getVal('upload_max_filesize', '2M'),
          memory_limit: getVal('memory_limit', '128M'),
          post_max_size: getVal('post_max_size', '8M'),
          max_execution_time: getVal('max_execution_time', '30') + 's',
          display_errors: getVal('display_errors', 'Off'),
          timezone: getVal('date.timezone', 'UTC'),
          opcache: getVal('opcache.enable', '0') === '1' ? 'Enabled' : 'Disabled'
        };
      } catch (e) {}
    }

    return {
      success: true,
      version: verResult.version || infoResult.version || 'Unknown',
      binary: verResult.binary || 'php',
      fullOutput: verResult.fullOutput || '',
      iniPath: iniPath || 'No php.ini file loaded',
      extensions: infoResult.extensions || [],
      directives
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('php:open-ini', async (event, { iniPath } = {}) => {
  try {
    let p = iniPath;
    if (!p) {
      const info = await phpManager.getInfo();
      p = info.iniPath;
    }
    if (p && p !== 'Not found' && p !== 'None' && fs.existsSync(p)) {
      await shell.openPath(p);
      return { success: true, path: p };
    }
    return { success: false, error: 'php.ini file not found or not loaded' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('php:list-extensions', async () => {
  try {
    const info = await phpManager.getInfo();
    const iniPath = info.iniPath && info.iniPath !== 'Not found' && info.iniPath !== 'None' ? info.iniPath : null;
    const loadedExts = new Set((info.extensions || []).map(e => e.toLowerCase()));

    if (!iniPath || !fs.existsSync(iniPath)) {
      return {
        success: true,
        iniPath: null,
        extensions: (info.extensions || []).map(e => ({
          name: e,
          enabled: true,
          isLoaded: true
        }))
      };
    }

    const content = fs.readFileSync(iniPath, 'utf8');
    const lines = content.split(/\r?\n/);
    const extMap = new Map();

    const descriptions = {
      curl: 'HTTP client requests, cURL library',
      fileinfo: 'Detect file MIME types and formats',
      gd: 'Image processing and thumbnail generation',
      intl: 'Internationalization functions (ICU)',
      mbstring: 'Multibyte string support (UTF-8)',
      mysqli: 'MySQL Improved extension for MySQL 5+',
      openssl: 'Secure Sockets Layer & TLS cryptography',
      pdo_mysql: 'PDO driver for MySQL databases',
      pdo_pgsql: 'PDO driver for PostgreSQL databases',
      pdo_sqlite: 'PDO driver for SQLite databases',
      sqlite3: 'SQLite 3 embedded database support',
      soap: 'SOAP XML web services protocol',
      sockets: 'Low-level socket communication interface',
      sodium: 'Modern libsodium cryptography',
      zip: 'Zip archive creation and decompression',
      exif: 'Read image EXIF metadata (camera data)',
      bz2: 'Bzip2 compression library',
      ffi: 'Foreign Function Interface for C libraries',
      ftp: 'FTP protocol client access',
      gmp: 'GNU Multiple Precision large numbers',
      ldap: 'Lightweight Directory Access Protocol',
      opcache: 'Zend OPcache bytecode caching engine',
      tidy: 'HTML cleanup and repair tool',
      xsl: 'XSLT XML transformation processor'
    };

    lines.forEach((line) => {
      const match = line.match(/^\s*(;?)\s*(extension|zend_extension)\s*=\s*(?:php_)?([a-zA-Z0-9_\-]+)(?:\.dll)?/i);
      if (match) {
        const isCommented = match[1] === ';';
        const type = match[2].toLowerCase();
        const extName = match[3].toLowerCase();
        const enabled = !isCommented;
        const isLoaded = loadedExts.has(extName);
        
        extMap.set(extName, {
          name: extName,
          enabled,
          isLoaded,
          isZend: type === 'zend_extension',
          desc: descriptions[extName] || `${extName.toUpperCase()} PHP extension`
        });
      }
    });

    loadedExts.forEach(e => {
      if (!extMap.has(e) && !['core', 'standard', 'pcre', 'spl', 'reflection', 'date'].includes(e)) {
        extMap.set(e, {
          name: e,
          enabled: true,
          isLoaded: true,
          isZend: false,
          desc: descriptions[e] || `${e.toUpperCase()} PHP extension`
        });
      }
    });

    const extensions = Array.from(extMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    return { success: true, iniPath, extensions };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('php:toggle-extension', async (event, { name, enable }) => {
  try {
    const info = await phpManager.getInfo();
    const iniPath = info.iniPath && info.iniPath !== 'Not found' && info.iniPath !== 'None' ? info.iniPath : null;
    if (!iniPath || !fs.existsSync(iniPath)) {
      return { success: false, error: 'php.ini file not found or not loaded' };
    }

    const content = fs.readFileSync(iniPath, 'utf8');
    const lines = content.split(/\r?\n/);
    const target = String(name).toLowerCase().trim();
    let modified = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/^(\s*)(;?)\s*(extension|zend_extension)\s*=\s*(?:php_)?([a-zA-Z0-9_\-]+)(?:\.dll)?(.*)$/i);
      if (match && match[4].toLowerCase() === target) {
        const indent = match[1] || '';
        const extType = match[3];
        const rawName = match[4];
        const trailing = match[5] || '';
        
        if (enable) {
          lines[i] = `${indent}${extType}=${rawName}${trailing}`;
        } else {
          lines[i] = `${indent};${extType}=${rawName}${trailing}`;
        }
        modified = true;
        break;
      }
    }

    if (!modified && enable) {
      lines.push(target === 'opcache' ? `zend_extension=${target}` : `extension=${target}`);
      modified = true;
    }

    if (modified) {
      fs.writeFileSync(iniPath, lines.join('\r\n'), 'utf8');

      // Restart running PHP sites to apply new extension configuration
      const runningSites = siteManager.getSites().filter(s => phpManager.isRunning(s.id));
      for (const s of runningSites) {
        await tunnelManager.stopTunnel(s.id);
        phpManager.stop(s.id);
        await phpManager.start(s);
      }
      if (vhostsManager) {
        const allSites = siteManager.getSites().map(s => ({
          ...s,
          domain: s.domain || vhostsManager.getDomain(s.name, vhostsManager.defaultTld),
          status: phpManager.isRunning(s.id) ? 'running' : 'stopped',
          port: phpManager.getPort(s.id) || s.port,
          fastCgiPort: phpManager.getFastCgiPort(s.id)
        }));
        vhostsManager.syncReverseProxy(allSites).catch(() => {});
      }
    }

    return { success: true, name: target, enabled: enable, iniPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('ssl:status', async () => {
  if (!vhostsManager || !vhostsManager.sslManager) {
    return { available: false };
  }
  const hasValid = vhostsManager.sslManager.hasValidCert();
  const paths = vhostsManager.sslManager.getWildcardCertPaths();
  return {
    available: true,
    hasValid,
    crt: paths.crt,
    key: paths.key
  };
});

ipcMain.handle('ssl:ensure', async () => {
  if (!vhostsManager || !vhostsManager.sslManager) {
    return { success: false, error: 'SSL manager not initialized' };
  }
  return await vhostsManager.sslManager.ensureWildcardCert();
});

ipcMain.handle('ssl:ensure-trusted', async () => {
  if (!vhostsManager?.sslManager) return { success: false, error: 'SSL manager not initialized' };
  const domains = siteManager.getSites().map(site => site.domain || vhostsManager.getDomain(site.name, vhostsManager.defaultTld));
  const result = await vhostsManager.sslManager.ensureTrustedWildcardCert(domains);
  if (result.success) {
    logManager?.log('SSL', 'Generated a trusted .test wildcard certificate with mkcert.', 'success');
    if (vhostsManager) {
      const allSites = siteManager.getSites().map(site => ({
        ...site,
        domain: site.domain || vhostsManager.getDomain(site.name, vhostsManager.defaultTld),
        status: phpManager.isRunning(site.id) ? 'running' : 'stopped',
        port: phpManager.getPort(site.id) || site.port,
        fastCgiPort: phpManager.getFastCgiPort(site.id)
      }));
      await vhostsManager.syncReverseProxy(allSites);
    }
  } else {
    logManager?.log('SSL', result.error || 'Could not create trusted SSL certificate.', 'error');
  }
  return result;
});

ipcMain.handle('php:browse-binary', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'PHP Executable', extensions: ['exe', 'bat', 'cmd'] }, { name: 'All Files', extensions: ['*'] }],
    title: 'Select PHP executable (php.exe)'
  });
  return result.canceled ? null : result.filePaths[0];
});

/** Open a folder picker dialog for the PHP file checker */
ipcMain.handle('php:browse-check-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select PHP Project Folder to Check'
  });
  return result.canceled ? null : result.filePaths[0];
});

/** Pick a PHP router file contained inside the selected site's document root. */
ipcMain.handle('php:browse-entry-file', async (event, rootFolder) => {
  if (typeof rootFolder !== 'string' || !rootFolder.trim()) {
    return { success: false, error: 'Select the site folder first.' };
  }
  let rootReal;
  try {
    rootReal = fs.realpathSync(rootFolder);
    if (!fs.statSync(rootReal).isDirectory()) throw new Error('not a directory');
  } catch (err) {
    return { success: false, error: 'The selected site folder does not exist or cannot be accessed.' };
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    defaultPath: rootReal,
    filters: [{ name: 'PHP Files', extensions: ['php'] }],
    title: 'Select PHP Entry Point / Router File'
  });
  if (result.canceled || !result.filePaths[0]) return { success: true, path: null };
  try {
    const selectedReal = fs.realpathSync(result.filePaths[0]);
    const relative = path.relative(rootReal, selectedReal);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return { success: false, error: 'Choose a PHP file inside the selected site folder.' };
    }
    if (!fs.statSync(selectedReal).isFile() || path.extname(selectedReal).toLowerCase() !== '.php') {
      return { success: false, error: 'Choose a PHP file inside the selected site folder.' };
    }
    return { success: true, path: selectedReal };
  } catch (err) {
    return { success: false, error: 'The selected PHP file could not be accessed.' };
  }
});

/** Recursively scan a folder for PHP files and run `php -l` syntax check on each */
ipcMain.handle('php:check-files', async (event, folderPath) => {
  const { execFile } = require('child_process');

  // Get PHP binary
  let phpBinary = 'php';
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg?.php?.binary) phpBinary = cfg.php.binary;
  } catch (e) {}

  // Recursively scan folder for .php files
  function scanDir(dir, depth = 0) {
    if (depth > 8) return [];
    const results = [];
    const SKIP_DIRS = new Set(['.git','vendor','node_modules','storage','cache','.idea','.vscode']);
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory() && !item.name.startsWith('.') && !SKIP_DIRS.has(item.name)) {
          results.push(...scanDir(path.join(dir, item.name), depth + 1));
        } else if (item.isFile() && item.name.endsWith('.php')) {
          results.push(path.join(dir, item.name));
        }
      }
    } catch (e) {}
    return results;
  }

  if (typeof folderPath !== 'string' || !folderPath.trim() || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    return { success: false, error: `Folder not found or is not accessible: ${folderPath || '(empty path)'}` };
  }

  const allFiles = scanDir(folderPath);
  if (allFiles.length === 0) {
    return { success: true, files: [], total: 0, checked: 0, ok: 0, errors: 0, folderPath, message: 'No .php files found. Check that this is the project folder containing your PHP files.' };
  }
  const filesToCheck = allFiles.slice(0, 200); // limit 200 files

  // Check each file with php -l
  const checkFile = (file) => new Promise((resolve) => {
    execFile(phpBinary, ['-l', file], { shell: true, timeout: 8000 }, (err, stdout, stderr) => {
      const output = (stdout + stderr).trim();
      // php -l exits 0 on success
      resolve({
        file: file.substring(folderPath.length).replace(/^[/\\]/, ''),
        fullPath: file,
        status: err ? 'error' : 'ok',
        message: err ? output : 'No syntax errors detected'
      });
    });
  });

  const results = await Promise.all(filesToCheck.map(checkFile));
  return {
    success: true,
    files: results,
    total: allFiles.length,
    checked: filesToCheck.length,
    ok: results.filter(r => r.status === 'ok').length,
    errors: results.filter(r => r.status === 'error').length,
    folderPath
  };
});

// ─── IPC: App Config ──────────────────────────────────────────────────────────
ipcMain.handle('config:save', (event, config) => {
  try {
    let existing = {};
    if (fs.existsSync(CONFIG_FILE)) {
      try { existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { /* ignore */ }
    }

    const appSettings = {
      theme: config.theme ?? config.app?.theme ?? existing.app?.theme ?? existing.theme ?? DEFAULT_CONFIG.app.theme,
      tld: (config.tld ?? config.app?.tld ?? existing.app?.tld ?? existing.tld ?? DEFAULT_CONFIG.app.tld).replace(/^\./, ''),
      autoVirtualHosts: config.autoVirtualHosts !== undefined ? config.autoVirtualHosts : (config.app?.autoVirtualHosts !== undefined ? config.app.autoVirtualHosts : existing.app?.autoVirtualHosts ?? DEFAULT_CONFIG.app.autoVirtualHosts),
      autoindex: config.autoindex !== undefined ? config.autoindex : (config.app?.autoindex !== undefined ? config.app.autoindex : existing.app?.autoindex ?? DEFAULT_CONFIG.app.autoindex),
      pageSize: parseInt(config.pageSize ?? config.app?.pageSize ?? existing.app?.pageSize ?? existing.pageSize) || 50,
      portsScope: config.portsScope ?? config.app?.portsScope ?? existing.app?.portsScope ?? existing.portsScope ?? 'app',
      mailCatcherPort: parseInt(config.mail?.port ?? config.mailCatcherPort ?? config.app?.mailCatcherPort ?? existing.app?.mailCatcherPort ?? existing.mailCatcherPort) || 1025,
      autoStartMailCatcher: config.mail?.autoStart !== undefined ? config.mail.autoStart : (config.autoStartMailCatcher !== undefined ? config.autoStartMailCatcher : config.app?.autoStartMailCatcher ?? existing.app?.autoStartMailCatcher ?? true),
      confirmDropTable: config.confirmDropTable !== undefined ? config.confirmDropTable : (config.app?.confirmDropTable !== undefined ? config.app.confirmDropTable : true),
      minimizeToTray: config.minimizeToTray !== undefined ? config.minimizeToTray : (config.app?.minimizeToTray !== undefined ? config.app.minimizeToTray : true)
    };

    const merged = {
      ...DEFAULT_CONFIG,
      ...existing,
      ...config,
      theme: appSettings.theme,
      tld: appSettings.tld,
      autoVirtualHosts: appSettings.autoVirtualHosts,
      autoindex: appSettings.autoindex,
      pageSize: appSettings.pageSize,
      portsScope: appSettings.portsScope,
      mailCatcherPort: appSettings.mailCatcherPort,
      autoStartMailCatcher: appSettings.autoStartMailCatcher,
      confirmDropTable: appSettings.confirmDropTable,
      minimizeToTray: appSettings.minimizeToTray,
      mail: {
        port: appSettings.mailCatcherPort,
        autoStart: appSettings.autoStartMailCatcher
      },
      mysql: { ...DEFAULT_CONFIG.mysql, ...existing.mysql, ...config?.mysql },
      php: { ...DEFAULT_CONFIG.php, ...existing.php, ...config?.php },
      phpmyadmin: {
        version: PhpMyAdminManager.SUPPORTED_VERSIONS.includes(String(config?.phpmyadmin?.version || existing.phpmyadmin?.version || DEFAULT_CONFIG.phpmyadmin.version))
          ? String(config?.phpmyadmin?.version || existing.phpmyadmin?.version || DEFAULT_CONFIG.phpmyadmin.version)
          : DEFAULT_CONFIG.phpmyadmin.version
      },
      app: {
        ...DEFAULT_CONFIG.app,
        ...existing.app,
        ...config?.app,
        ...appSettings
      }
    };

    fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
    if (merged.php?.binary) phpManager.setPHPBinary(merged.php.binary);
    if (merged.app?.tld && vhostsManager) vhostsManager.defaultTld = merged.app.tld;
    return { success: true, config: merged, configDir: CONFIG_DIR };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('config:load', () => {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return { success: true, config: JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')), configDir: CONFIG_DIR };
    }
    return { success: true, config: DEFAULT_CONFIG, configDir: CONFIG_DIR };
  } catch (err) {
    return { success: true, config: DEFAULT_CONFIG, configDir: CONFIG_DIR };
  }
});

// ─── IPC: Windows local-domain system proxy bypass ───────────────────────────
ipcMain.handle('network-proxy:local-bypass-status', () => localProxyBypass.status());
ipcMain.handle('network-proxy:apply-local-bypass', async () => {
  if (process.platform !== 'win32') return { success: false, error: 'This action is available on Windows only.' };
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: 'Bypass proxy for local development sites?',
    message: 'Add local addresses and your registered local site domains to this Windows user’s system proxy bypass list?',
    detail: 'This preserves existing entries and changes only the current user’s Internet proxy override. V2Ray TUN or transparent routing modes may need a direct route in the V2Ray client as well.',
    buttons: ['Apply bypass rules', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  if (confirmation.response !== 0) return { success: false, canceled: true };
  const domains = (siteManager?.getSites?.() || []).map(site =>
    site.domain || vhostsManager?.getDomain(site.name, vhostsManager.defaultTld) || ''
  );
  const result = await localProxyBypass.apply(domains);
  if (result.success) {
    try { await session.defaultSession.closeAllConnections(); } catch (_) {}
    logManager?.log('Network', 'Added local development domains to the Windows proxy bypass list.', 'success');
  }
  return result;
});

// ─── Helpers: PHP Versions Scanner ───────────────────────────────────────────
async function scanInstalledPhps() {
  const candidates = new Set();
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

  try {
    const { stdout } = await execAsync('where.exe php');
    stdout.split(/\r?\n/).forEach(p => {
      const trimmed = p.trim();
      if (trimmed && fs.existsSync(trimmed)) candidates.add(path.normalize(trimmed));
    });
  } catch (e) {}

  const searchRoots = [
    path.join(appData, 'c-script-localhost', 'php'),
    path.join(appData, 'c-script-localhost', 'php', 'php84'),
    path.join(appData, 'c-script-localhost', 'php', 'php85'),
    path.join(appData, 'c-script-localhost', 'php', 'php83'),
    path.join(appData, 'c-script-localhost', 'php', 'php82'),
    path.join(appData, 'c-script-localhost', 'php', 'php81'),
    path.join(appData, 'antigravity-localhost', 'php'),
    path.join(appData, 'antigravity-localhost', 'php', 'php84'),
    path.join(appData, 'antigravity-localhost', 'php', 'php85'),
    'C:\\php', 'C:\\tools\\php', 'C:\\xampp\\php', 'C:\\laragon\\bin\\php'
  ];

  for (const root of searchRoots) {
    if (fs.existsSync(root)) {
      const exe = path.join(root, 'php.exe');
      if (fs.existsSync(exe)) candidates.add(path.normalize(exe));
      try {
        const subdirs = fs.readdirSync(root, { withFileTypes: true });
        for (const sub of subdirs) {
          if (sub.isDirectory()) {
            const subExe = path.join(root, sub.name, 'php.exe');
            if (fs.existsSync(subExe)) candidates.add(path.normalize(subExe));
          }
        }
      } catch (e) {}
    }
  }

  const list = [];
  for (const bin of candidates) {
    try {
      const { stdout } = await execAsync(`"${bin}" -v`);
      const vMatch = stdout.match(/PHP (\d+\.\d+[\.\d]*)/);
      if (vMatch) {
        const fullVer = vMatch[1];
        const majorMinor = fullVer.split('.').slice(0, 2).join('.');
        const norm = bin.toLowerCase();
        const isStandalone = norm.includes('c-script-localhost') || norm.includes('antigravity-localhost');
        const source = isStandalone ? 'Standalone' : 'System';
        list.push({ path: bin, version: `PHP ${fullVer}`, major: majorMinor, source, isStandalone, isAppManaged: isStandalone, isBundled: isStandalone });
      }
    } catch (e) {}
  }
  return list;
}

// ─── IPC: Scan PHP Versions ──────────────────────────────────────────────────
ipcMain.handle('php:scan-versions', async () => {
  const versions = await scanInstalledPhps();
  return { success: true, versions };
});

// ─── IPC: Standalone PHP Catalog & Download ──────────────────────────────────
ipcMain.handle('php:get-catalog', async () => {
  return phpInstaller ? phpInstaller.getVersionCatalog() : { catalog: [] };
});

ipcMain.handle('php:security-report', async () => {
  if (!phpInstaller) return { hasWarnings: false, items: [], error: 'PhpInstaller not ready' };
  const versions = await scanInstalledPhps();
  return phpInstaller.getSecurityReport(versions);
});

ipcMain.handle('php:download-version', async (event, version) => {
  if (!phpInstaller) return { success: false, error: 'PhpInstaller not ready' };
  const res = await phpInstaller.downloadAndInstall(version);
  if (logManager) {
    logManager.log('PHP', res.success ? `PHP ${version} installed to ${res.exePath}` : `PHP ${version} download failed: ${res.error}`, res.success ? 'success' : 'error');
  }
  return res;
});

// ─── IPC: Standalone NGINX Installer & Manager ───────────────────────────────
ipcMain.handle('nginx:info', async () => {
  return nginxInstaller ? nginxInstaller.getInfo() : { installed: false };
});

ipcMain.handle('nginx:download', async () => {
  if (!nginxInstaller) return { success: false, error: 'NginxInstaller not ready' };
  const res = await nginxInstaller.downloadAndInstall();
  if (logManager) {
    logManager.log('NGINX', res.success ? `NGINX ${res.version} installed to ${res.exePath}` : `NGINX download failed: ${res.error}`, res.success ? 'success' : 'error');
  }
  return res;
});

ipcMain.handle('nginx:start', async () => {
  return nginxInstaller ? nginxInstaller.start() : { success: false };
});

ipcMain.handle('nginx:stop', async () => {
  return nginxInstaller ? nginxInstaller.stop() : { success: false };
});

ipcMain.handle('nginx:reload', async () => {
  return nginxInstaller ? nginxInstaller.reload() : { success: false };
});

// ─── IPC: Standalone MySQL / MariaDB Installer & Manager ─────────────────────
ipcMain.handle('mysql-installer:info', async () => {
  return mysqlInstaller ? mysqlInstaller.getInfo() : { status: 'none' };
});

ipcMain.handle('mysql-installer:open-config', async () => {
  if (!mysqlInstaller) return { success: false, error: 'MySQL installer is not ready.' };
  let configPath = mysqlInstaller.confPath;
  try {
    const winService = await mysqlInstaller.getWindowsService();
    const servicePath = winService?.pathName || '';
    const match = servicePath.match(/--defaults-file(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"]+))/i);
    const serviceConfigPath = match?.[1] || match?.[2] || match?.[3];
    if (serviceConfigPath && fs.existsSync(serviceConfigPath)) configPath = serviceConfigPath;
  } catch (error) {}

  if (!fs.existsSync(configPath) && !mysqlInstaller.setupDefaultConf()) {
    return { success: false, error: `MySQL configuration file was not found: ${configPath}` };
  }
  const openError = await shell.openPath(configPath);
  return openError
    ? { success: false, path: configPath, error: openError }
    : { success: true, path: configPath };
});

ipcMain.handle('mysql-installer:download', async () => {
  if (!mysqlInstaller) return { success: false, error: 'MysqlInstaller not ready' };
  const res = await mysqlInstaller.downloadAndInstall();
  if (logManager) {
    logManager.log('MySQL', res.success ? `MySQL/MariaDB installed to ${res.exePath}` : `MySQL download failed: ${res.error}`, res.success ? 'success' : 'error');
  }
  return res;
});

ipcMain.handle('mysql-installer:start', async () => {
  return mysqlInstaller ? mysqlInstaller.start() : { success: false };
});

ipcMain.handle('mysql-installer:stop', async () => {
  return mysqlInstaller ? mysqlInstaller.stop() : { success: false };
});

ipcMain.handle('mysql-installer:restart', async () => {
  return mysqlInstaller ? mysqlInstaller.restart() : { success: false };
});

// ─── IPC: Virtual Hosts (.test) ──────────────────────────────────────────────
ipcMain.handle('vhosts:list', () => {
  return vhostsManager ? vhostsManager.listManagedDomains() : [];
});

ipcMain.handle('vhosts:sync', async (event, domains) => {
  if (!vhostsManager) return { success: false, error: 'VhostsManager not ready' };
  let targetDomains = [];
  let tld = 'test';
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg?.tld) tld = cfg.tld;
    else if (cfg?.app?.tld) tld = cfg.app.tld;
  } catch (e) {}

  if (Array.isArray(domains) && domains.length > 0) {
    targetDomains = domains
      .map(d => {
        if (typeof d === 'string') return d;
        if (typeof d === 'object' && d) return d.domain || vhostsManager.getDomain(d.name, tld);
        return null;
      })
      .filter(Boolean);
  }

  if (targetDomains.length === 0) {
    targetDomains = siteManager.getSites().map(s => s.domain || vhostsManager.getDomain(s.name, tld));
  }

  const result = await vhostsManager.syncHosts(targetDomains);
  if (logManager) {
    logManager.log('VHosts', result.success ? `Synchronized ${result.count || 0} .test domains to hosts file` : `Hosts sync failed: ${result.error}`, result.success ? 'success' : 'error');
  }
  return result;
});

ipcMain.handle('vhosts:get-domain', (event, { siteName, tld }) => {
  return vhostsManager ? vhostsManager.getDomain(siteName, tld || 'test') : `${siteName}.test`;
});

// ─── IPC: Frameworks ──────────────────────────────────────────────────────────
ipcMain.handle('frameworks:inspect-laravel-target', (_event, targetDir) => {
  if (!frameworkManager) return { success: false, error: 'Framework manager is not ready.' };
  return frameworkManager.inspectLaravelTarget(targetDir);
});

ipcMain.handle('frameworks:inspect-project-target', (_event, targetDir) => {
  if (!frameworkManager) return { success: false, error: 'Framework manager is not ready.' };
  return frameworkManager.inspectProjectTarget(targetDir);
});

ipcMain.handle('frameworks:install-project-dependencies', async (_event, { targetDir, php } = {}) => {
  if (!frameworkManager) return { success: false, error: 'Framework manager is not ready.' };
  const phpBinary = phpManager?.getBinaryForSite({ php }) || 'php';
  return frameworkManager.installProjectDependencies(targetDir, phpBinary);
});

ipcMain.handle('frameworks:cancel-installation', async (_event, targetDir) => {
  if (!frameworkManager) return { success: false, error: 'Framework manager is not ready.' };
  return frameworkManager.cancelInstallation(targetDir);
});

ipcMain.handle('frameworks:scaffold', async (event, { framework, targetDir, options } = {}) => {
  if (!frameworkManager) return { success: false, error: 'FrameworkManager not ready' };
  const safeOptions = { ...(options || {}) };
  if (framework === 'laravel') safeOptions.phpBinary = phpManager?.getBinaryForSite({ php: safeOptions.php }) || 'php';
  const res = await frameworkManager.scaffold(framework, targetDir, safeOptions);
  if (logManager) {
    logManager.log('Framework', `Scaffolded ${framework} in ${targetDir}`, res.success ? 'success' : 'error');
  }
  return res;
});

// ─── IPC: Local phpMyAdmin ──────────────────────────────────────────────────
const PHPMYADMIN_DOMAIN = 'phpmyadmin.test';
const PHPMYADMIN_PROXY_MARKER = '# Managed by C-Script LocalHost Panel: phpMyAdmin proxy route.';

function getConfiguredPhpMyAdminVersion() {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}
  return PhpMyAdminManager.SUPPORTED_VERSIONS.includes(String(config.phpmyadmin?.version))
    ? String(config.phpmyadmin.version)
    : DEFAULT_CONFIG.phpmyadmin.version;
}

ipcMain.handle('phpmyadmin:paths', () => phpMyAdminManager
  ? phpMyAdminManager.paths(getConfiguredPhpMyAdminVersion())
  : { success: false, error: 'phpMyAdmin manager is not ready.' });

ipcMain.handle('phpmyadmin:open-folder', async () => {
  if (!phpMyAdminManager) return { success: false, error: 'phpMyAdmin manager is not ready.' };
  const paths = phpMyAdminManager.paths(getConfiguredPhpMyAdminVersion());
  try {
    const folderPath = paths.installed ? paths.versionDir : paths.baseDir;
    fs.mkdirSync(folderPath, { recursive: true });
    const error = await shell.openPath(folderPath);
    return error ? { success: false, error } : { success: true, path: folderPath };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('phpmyadmin:open-config', async () => {
  if (!phpMyAdminManager) return { success: false, error: 'phpMyAdmin manager is not ready.' };
  const paths = phpMyAdminManager.paths(getConfiguredPhpMyAdminVersion());
  if (!paths.installed || !paths.configExists) {
    return { success: false, error: 'Install and open phpMyAdmin once to create its configuration file.' };
  }
  try {
    const error = await shell.openPath(paths.configPath);
    return error ? { success: false, error } : { success: true, path: paths.configPath };
  } catch (error) { return { success: false, error: error.message }; }
});

function getRunningProxySites() {
  return (siteManager?.getSites?.() || []).map(site => ({
    ...site,
    domain: site.domain || vhostsManager?.getDomain(site.name, vhostsManager.defaultTld),
    status: phpManager?.isRunning(site.id) ? 'running' : 'stopped',
    port: phpManager?.getPort(site.id) || site.port,
    fastCgiPort: phpManager?.getFastCgiPort(site.id)
  }));
}

async function configurePhpMyAdminDomain(port) {
  if (!vhostsManager || !serviceManager) return { success: false, error: 'Local domain routing is not ready.' };
  const sites = getRunningProxySites();
  if (sites.some(site => String(site.domain || '').toLowerCase() === PHPMYADMIN_DOMAIN)) {
    return { success: false, error: `${PHPMYADMIN_DOMAIN} is already assigned to another site. Change that site’s domain first.` };
  }

  const siteDomains = (siteManager?.getSites?.() || [])
    .map(site => site.domain || vhostsManager.getDomain(site.name, vhostsManager.defaultTld));
  const hostsResult = await vhostsManager.syncHosts([...siteDomains, PHPMYADMIN_DOMAIN]);
  if (!hostsResult?.success) {
    return { success: false, error: `Could not register ${PHPMYADMIN_DOMAIN} in the Windows hosts file. ${hostsResult?.error || ''}`.trim() };
  }

  const nginxInfo = vhostsManager.getNginxInfo();
  if (!nginxInfo && await serviceManager.checkPort(80) && !vhostsManager.isInternalProxyRunning()) {
    return { success: false, error: 'Port 80 is already in use, so phpmyadmin.test cannot be routed. Stop the other web server or free port 80.' };
  }

  const proxySite = {
    id: 'cscript-phpmyadmin',
    name: 'phpMyAdmin',
    domain: PHPMYADMIN_DOMAIN,
    status: 'running',
    port: Number(port),
    phpMode: 'proxy',
    root: ''
  };
  const proxyResult = await vhostsManager.syncReverseProxy([...sites, proxySite]);
  if (!proxyResult?.success) return { success: false, error: proxyResult?.error || 'Could not configure the phpMyAdmin local domain.' };

  if (proxyResult.method === 'nginx') {
    const generatedConfig = path.join(nginxInfo.vhostsDir, `${PHPMYADMIN_DOMAIN}.conf`);
    if (!fs.existsSync(generatedConfig) || !fs.readFileSync(generatedConfig, 'utf8').includes(PHPMYADMIN_PROXY_MARKER)) {
      return { success: false, error: `NGINX did not create the ${PHPMYADMIN_DOMAIN} proxy configuration.` };
    }
    const nginxResult = await serviceManager.startService('webserver', siteManager, phpManager, mysqlManager);
    if (!nginxResult?.success) {
      await removePhpMyAdminDomainRoute();
      return { success: false, error: `Could not start NGINX for ${PHPMYADMIN_DOMAIN}: ${nginxResult?.error || 'unknown error'}` };
    }
  } else if (!vhostsManager.isInternalProxyRunning()) {
    await removePhpMyAdminDomainRoute();
    return { success: false, error: `Could not start the local proxy for ${PHPMYADMIN_DOMAIN}. Check whether port 80 is available.` };
  }
  return { success: true, domain: PHPMYADMIN_DOMAIN, url: `http://${PHPMYADMIN_DOMAIN}/`, method: proxyResult.method };
}

async function removePhpMyAdminDomainRoute() {
  const nginxInfo = vhostsManager?.getNginxInfo?.();
  let removedProxy = false;
  if (nginxInfo?.vhostsDir) {
    const configPath = path.join(nginxInfo.vhostsDir, `${PHPMYADMIN_DOMAIN}.conf`);
    try {
      if (fs.existsSync(configPath) && fs.readFileSync(configPath, 'utf8').includes(PHPMYADMIN_PROXY_MARKER)) {
        fs.unlinkSync(configPath);
        removedProxy = true;
      }
    } catch (error) {
      return { success: false, error: `Could not remove the phpMyAdmin NGINX route: ${error.message}` };
    }
  }
  const activeSites = getRunningProxySites();
  if ((removedProxy && nginxInfo) || vhostsManager?.isInternalProxyRunning()) {
    await vhostsManager.syncReverseProxy(activeSites);
  }
  return { success: true };
}

ipcMain.handle('phpmyadmin:status', () => {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}
  if (!phpMyAdminManager) return { success: false, error: 'phpMyAdmin manager is not ready.' };
  const status = phpMyAdminManager.status(config.phpmyadmin?.version || DEFAULT_CONFIG.phpmyadmin.version);
  return { ...status, url: status.running ? `http://${PHPMYADMIN_DOMAIN}/` : null, domain: PHPMYADMIN_DOMAIN };
});

ipcMain.handle('phpmyadmin:open', async () => {
  if (!phpMyAdminManager) return { success: false, error: 'phpMyAdmin manager is not ready.' };
  let config = {};
  try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}
  const selectedVersion = PhpMyAdminManager.SUPPORTED_VERSIONS.includes(String(config.phpmyadmin?.version))
    ? String(config.phpmyadmin.version)
    : DEFAULT_CONFIG.phpmyadmin.version;
  const result = await phpMyAdminManager.open(
    selectedVersion,
    config.mysql || DEFAULT_CONFIG.mysql
  );
  if (result.success && result.port) {
    const route = await configurePhpMyAdminDomain(result.port);
    if (!route.success) {
      await phpMyAdminManager.stop();
      return route;
    }
    result.localUrl = result.url;
    result.url = route.url;
  }
  return result;
});

ipcMain.handle('phpmyadmin:stop', async () => {
  if (!phpMyAdminManager) return { success: true, stopped: false };
  const stopped = await phpMyAdminManager.stop();
  const route = await removePhpMyAdminDomainRoute();
  if (logManager) logManager.log('phpMyAdmin', route.success ? 'phpMyAdmin stopped' : `phpMyAdmin stopped, but route cleanup failed: ${route.error}`, route.success ? 'info' : 'warn');
  return { ...stopped, success: stopped.success !== false, domain: PHPMYADMIN_DOMAIN, warning: route.success ? null : route.error };
});

// ─── IPC: Guarded Laravel Artisan tasks ──────────────────────────────────────
ipcMain.handle('laravel:run', async (_event, { siteId, action } = {}) => {
  if (!siteManager || !laravelManager) return { success: false, error: 'Laravel tools are not ready.' };
  const site = siteManager.getSite(siteId);
  if (!site) return { success: false, error: 'Site not found.' };
  const result = await laravelManager.run(site, action, phpManager);
  if (logManager) {
    logManager.log('Laravel', `${action} for ${site.name}${result.success ? ' started' : ` failed: ${result.error}`}`, result.success ? 'info' : 'error');
  }
  return result;
});

ipcMain.handle('laravel:stop', (_event, jobId) => {
  return laravelManager ? laravelManager.stop(jobId) : { success: false, error: 'Laravel tools are not ready.' };
});

// ─── IPC: Mail Catcher ────────────────────────────────────────────────────────
ipcMain.handle('mail:status', () => {
  return mailCatcher ? mailCatcher.getStatus() : { running: false, port: 1025, emailCount: 0 };
});
ipcMain.handle('mail:list', () => {
  return mailCatcher ? mailCatcher.getEmails() : [];
});
ipcMain.handle('mail:get', (event, id) => {
  return mailCatcher ? mailCatcher.getEmail(id) : null;
});
ipcMain.handle('mail:clear', () => {
  return mailCatcher ? mailCatcher.clearEmails() : { success: true };
});
ipcMain.handle('mail:start', () => {
  return mailCatcher ? mailCatcher.start() : { success: false, error: 'MailCatcher not ready' };
});
ipcMain.handle('mail:stop', () => {
  return mailCatcher ? mailCatcher.stop() : { success: true };
});

// ─── IPC: Logs ────────────────────────────────────────────────────────────────
ipcMain.handle('logs:list', (event, source) => {
  return logManager ? logManager.getEntries(source) : [];
});
ipcMain.handle('logs:streams', () => liveLogStreamer ? liveLogStreamer.list() : []);
ipcMain.handle('logs:clear', () => {
  return logManager ? logManager.clear() : { success: true };
});

ipcMain.handle('logs:add', (event, { source, message, level }) => {
  return logManager ? logManager.log(source, message, level) : null;
});

ipcMain.handle('logs:report-app-error', (event, { title, message, stack, details }) => {
  const fullMsg = [title, message, stack ? `Stack: ${stack}` : '', details ? `Details: ${JSON.stringify(details)}` : ''].filter(Boolean).join(' | ');
  if (logManager) {
    logManager.log('Application Error', fullMsg, 'error');
  }
  return { success: true };
});

// ─── IPC: Cloudflare Tunnel (Share to Web) ──────────────────────────────────
ipcMain.handle('tunnel:status', (event, siteId) => {
  return tunnelManager ? tunnelManager.getStatus(siteId) : { active: false };
});

ipcMain.handle('tunnel:start', async (event, { siteId, port, options }) => {
  if (!tunnelManager) return { success: false, error: 'TunnelManager not ready' };
  const res = await tunnelManager.startTunnel(siteId, port, options);
  if (logManager) {
    const detail = res.success ? `Public URL generated: ${res.url} (${res.provider || 'Tunnel'})` : `Tunnel failed: ${res.error}`;
    logManager.log('Tunnel', detail, res.success ? 'success' : 'error');
  }
  return res;
});

ipcMain.handle('tunnel:stop', async (event, siteId) => {
  if (!tunnelManager) return { success: false };
  const stopped = await tunnelManager.stopTunnel(siteId);
  if (logManager) {
    logManager.log('Tunnel', `Tunnel closed for site ${siteId}`, 'info');
  }
  return { success: true, stopped };
});

// ─── IPC: Export Save File ────────────────────────────────────────────────────
ipcMain.handle('export:save-file', async (event, { defaultFilename, content, filters }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultFilename,
    filters: filters || [{ name: 'All Files', extensions: ['*'] }]
  });
  if (result.canceled || !result.filePath) return { success: false, canceled: true };
  try {
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { success: true, filePath: result.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Theme ───────────────────────────────────────────────────────────────
ipcMain.handle('theme:set', (event, theme) => {
  const isLight = theme === 'light';
  nativeTheme.themeSource = isLight ? 'light' : 'dark';
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      const colors = {
        dark: { color: '#000000', symbolColor: '#F2F3F5' },
        dracula: { color: '#1E1F29', symbolColor: '#F8F8F2' },
        nord: { color: '#242933', symbolColor: '#ECEFF4' },
        monokai: { color: '#1E1F1C', symbolColor: '#F8F8F2' },
        light: { color: '#F8FAFC', symbolColor: '#0F172A' }
      };
      const themeColors = colors[theme] || colors.dark;
      mainWindow.setTitleBarOverlay({
        color: themeColors.color,
        symbolColor: themeColors.symbolColor,
        height: 36
      });
    } catch (e) {}
  }
  return { success: true };
});

// ─── IPC: Ports & Process Termination ─────────────────────────────────────────
ipcMain.handle('port:list', async () => {
  if (!portManager) return [];
  return await portManager.getListeningPorts();
});

ipcMain.handle('port:kill', async (event, port) => {
  if (!portManager) return { success: false, error: 'PortManager not ready' };
  const res = await portManager.killPort(port);
  if (logManager) {
    logManager.log('Ports', res.success ? `Port :${port} freed. ${res.message}` : `Failed to kill port :${port}: ${res.error}`, res.success ? 'success' : 'error');
  }
  return res;
});

ipcMain.handle('port:kill-pid', async (event, { pid, processName, port }) => {
  if (!portManager) return { success: false, error: 'PortManager not ready' };
  const res = await portManager.killPid(pid, processName, port);
  if (logManager) {
    logManager.log('Ports', res.success ? `Process ${processName || pid} (PID ${pid}) killed` : `Failed to kill PID ${pid}: ${res.error}`, res.success ? 'success' : 'error');
  }
  return res;
});

// ─── IPC: Shell ───────────────────────────────────────────────────────────────
ipcMain.handle('shell:open-external', async (_event, url) => {
  try {
    const parsed = new URL(String(url || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return { success: false, error: 'Only HTTP and HTTPS links can be opened externally.' };
    await shell.openExternal(parsed.toString());
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || 'Could not open the link in your browser.' };
  }
});

ipcMain.handle('shell:open-path', (event, filePath) => {
  shell.openPath(filePath);
  return { success: true };
});

// ─── IPC: Window Controls ────────────────────────────────────────────────────
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.restore();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());
