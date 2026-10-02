/**
 * Preload Script - Context Bridge
 * Exposes safe Electron IPC methods to the renderer process
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Sites ──────────────────────────────────────────────────────────────────
  sites: {
    list: () => ipcRenderer.invoke('sites:list'),
    add: (data) => ipcRenderer.invoke('sites:add', data),
    remove: (id) => ipcRenderer.invoke('sites:remove', id),
    start: (id) => ipcRenderer.invoke('sites:start', id),
    stop: (id) => ipcRenderer.invoke('sites:stop', id),
    update: (id, data) => ipcRenderer.invoke('sites:update', { id, data }),
    browseFolder: () => ipcRenderer.invoke('sites:browse-folder'),
    openFolder: (path) => ipcRenderer.invoke('sites:open-folder', path),
    openCode: (path) => ipcRenderer.invoke('sites:open-code', path),
    openTerminal: (path) => ipcRenderer.invoke('sites:open-terminal', path),
    getGitInfo: (path) => ipcRenderer.invoke('sites:git-info', path)
  },

  // ── MySQL ──────────────────────────────────────────────────────────────────
  mysql: {
    connect: (config) => ipcRenderer.invoke('mysql:connect', config),
    disconnect: () => ipcRenderer.invoke('mysql:disconnect'),
    status: () => ipcRenderer.invoke('mysql:status'),
    databases: () => ipcRenderer.invoke('mysql:databases'),
    tables: (database) => ipcRenderer.invoke('mysql:tables', database),
    columns: (database, table) => ipcRenderer.invoke('mysql:columns', { database, table }),
    tableData: (database, table, limit, offset) =>
      ipcRenderer.invoke('mysql:table-data', { database, table, limit, offset }),
    updateRow: (database, table, primary, changes) =>
      ipcRenderer.invoke('mysql:update-row', { database, table, primary, changes }),
    insertRow: (database, table, values) =>
      ipcRenderer.invoke('mysql:insert-row', { database, table, values }),
    deleteRow: (database, table, primary) =>
      ipcRenderer.invoke('mysql:delete-row', { database, table, primary }),
    query: (database, query) => ipcRenderer.invoke('mysql:query', { database, query }),
    createDb: (name, charset, collation) => ipcRenderer.invoke('mysql:create-db', { name, charset, collation }),
    dropDb: (name) => ipcRenderer.invoke('mysql:drop-db', name),
    tableStructure: (database, table) => ipcRenderer.invoke('mysql:table-structure', { database, table }),
    tableInfo: (database, table) => ipcRenderer.invoke('mysql:table-info', { database, table }),
    dbInfo: (database) => ipcRenderer.invoke('mysql:db-info', database),
    truncateTable: (database, table) => ipcRenderer.invoke('mysql:truncate-table', { database, table }),
    dropTable: (database, table) => ipcRenderer.invoke('mysql:drop-table', { database, table }),
    addColumn: (database, table, column) => ipcRenderer.invoke('mysql:add-column', { database, table, column }),
    importSQL: () => ipcRenderer.invoke('mysql:import-sql'),
    exportDatabase: (database) => ipcRenderer.invoke('mysql:export-database', database),
    serverVars: () => ipcRenderer.invoke('mysql:server-vars'),
    tableRelationships: (database, table) => ipcRenderer.invoke('mysql:table-relationships', { database, table }),
    addForeignKey: (database, table, fk) => ipcRenderer.invoke('mysql:add-foreign-key', { database, table, fk }),
    dropForeignKey: (database, table, constraintName) => ipcRenderer.invoke('mysql:drop-foreign-key', { database, table, constraintName }),
    erDiagram: (database) => ipcRenderer.invoke('mysql:er-diagram', database)
  },

  // ── MySQL / MariaDB Installer ──────────────────────────────────────────────
  mysqlInstaller: {
    getInfo: () => ipcRenderer.invoke('mysql-installer:info'),
    download: () => ipcRenderer.invoke('mysql-installer:download'),
    start: () => ipcRenderer.invoke('mysql-installer:start'),
    stop: () => ipcRenderer.invoke('mysql-installer:stop'),
    restart: () => ipcRenderer.invoke('mysql-installer:restart'),
    onInstallProgress: (callback) => {
      const dlHandler = (event, data) => callback('download', data);
      const stHandler = (event, data) => callback('status', data);
      ipcRenderer.on('mysql-installer:download-progress', dlHandler);
      ipcRenderer.on('mysql-installer:install-status', stHandler);
      return () => {
        ipcRenderer.removeListener('mysql-installer:download-progress', dlHandler);
        ipcRenderer.removeListener('mysql-installer:install-status', stHandler);
      };
    }
  },

  // ── PHP ────────────────────────────────────────────────────────────────────
  php: {
    version: () => ipcRenderer.invoke('php:version'),
    info: () => ipcRenderer.invoke('php:info'),
    openIni: (iniPath) => ipcRenderer.invoke('php:open-ini', { iniPath }),
    browseBinary: () => ipcRenderer.invoke('php:browse-binary'),
    browseCheckFolder: () => ipcRenderer.invoke('php:browse-check-folder'),
    browseEntryFile: (rootFolder) => ipcRenderer.invoke('php:browse-entry-file', rootFolder),
    checkFiles: (folderPath) => ipcRenderer.invoke('php:check-files', folderPath),
    scanVersions: () => ipcRenderer.invoke('php:scan-versions'),
    listExtensions: () => ipcRenderer.invoke('php:list-extensions'),
    toggleExtension: (name, enable) => ipcRenderer.invoke('php:toggle-extension', { name, enable }),
    getCatalog: () => ipcRenderer.invoke('php:get-catalog'),
    downloadVersion: (version) => ipcRenderer.invoke('php:download-version', version),
    migrateHerd: () => ipcRenderer.invoke('php:migrate-herd'),
    onInstallProgress: (callback) => {
      const dlHandler = (event, data) => callback('download', data);
      const stHandler = (event, data) => callback('status', data);
      ipcRenderer.on('php:download-progress', dlHandler);
      ipcRenderer.on('php:install-status', stHandler);
      return () => {
        ipcRenderer.removeListener('php:download-progress', dlHandler);
        ipcRenderer.removeListener('php:install-status', stHandler);
      };
    }
  },

  // ── NGINX ──────────────────────────────────────────────────────────────────
  nginx: {
    getInfo: () => ipcRenderer.invoke('nginx:info'),
    download: () => ipcRenderer.invoke('nginx:download'),
    migrateHerd: () => ipcRenderer.invoke('nginx:migrate'),
    start: () => ipcRenderer.invoke('nginx:start'),
    stop: () => ipcRenderer.invoke('nginx:stop'),
    reload: () => ipcRenderer.invoke('nginx:reload'),
    onInstallProgress: (callback) => {
      const dlHandler = (event, data) => callback('download', data);
      const stHandler = (event, data) => callback('status', data);
      ipcRenderer.on('nginx:download-progress', dlHandler);
      ipcRenderer.on('nginx:install-status', stHandler);
      return () => {
        ipcRenderer.removeListener('nginx:download-progress', dlHandler);
        ipcRenderer.removeListener('nginx:install-status', stHandler);
      };
    }
  },

  // ── SSL / HTTPS ────────────────────────────────────────────────────────────
  ssl: {
    status: () => ipcRenderer.invoke('ssl:status'),
    ensure: () => ipcRenderer.invoke('ssl:ensure')
  },

  // ── Cloudflare Tunnel (Share to Web) ───────────────────────────────────────
  tunnel: {
    status: (siteId) => ipcRenderer.invoke('tunnel:status', siteId),
    start: (siteId, port, options) => ipcRenderer.invoke('tunnel:start', { siteId, port, options }),
    stop: (siteId) => ipcRenderer.invoke('tunnel:stop', siteId)
  },

  // ── Virtual Hosts (.dev) ───────────────────────────────────────────────────
  vhosts: {
    list: () => ipcRenderer.invoke('vhosts:list'),
    sync: (domains) => ipcRenderer.invoke('vhosts:sync', domains),
    getDomain: (siteName, tld) => ipcRenderer.invoke('vhosts:get-domain', { siteName, tld })
  },

  // ── Framework Scaffolding ──────────────────────────────────────────────────
  frameworks: {
    scaffold: (framework, targetDir, options) =>
      ipcRenderer.invoke('frameworks:scaffold', { framework, targetDir, options })
  },

  // ── Mail Catcher (SMTP) ────────────────────────────────────────────────────
  mail: {
    status: () => ipcRenderer.invoke('mail:status'),
    list: () => ipcRenderer.invoke('mail:list'),
    get: (id) => ipcRenderer.invoke('mail:get', id),
    clear: () => ipcRenderer.invoke('mail:clear'),
    start: () => ipcRenderer.invoke('mail:start'),
    stop: () => ipcRenderer.invoke('mail:stop')
  },

  // ── Logs ───────────────────────────────────────────────────────────────────
  logs: {
    list: (source) => ipcRenderer.invoke('logs:list', source),
    clear: () => ipcRenderer.invoke('logs:clear')
  },

  // ── Export / File Dialogs ──────────────────────────────────────────────────
  export: {
    saveFile: (data) => ipcRenderer.invoke('export:save-file', data)
  },

  // ── Ports & Process Termination ────────────────────────────────────────────
  ports: {
    list: () => ipcRenderer.invoke('port:list'),
    kill: (port) => ipcRenderer.invoke('port:kill', port),
    killPid: (pid, processName, port) => ipcRenderer.invoke('port:kill-pid', { pid, processName, port })
  },

  // ── Services ───────────────────────────────────────────────────────────────
  services: {
    list: () => ipcRenderer.invoke('services:list'),
    start: (id, options) => ipcRenderer.invoke('services:start', id, options),
    stop: (id, options) => ipcRenderer.invoke('services:stop', id, options),
    restart: (id, options) => ipcRenderer.invoke('services:restart', id, options),
    startAll: () => ipcRenderer.invoke('services:start-all'),
    stopAll: () => ipcRenderer.invoke('services:stop-all'),
    grantPermission: (serviceName) => ipcRenderer.invoke('services:grant-permission', serviceName)
  },

  // ── Config ─────────────────────────────────────────────────────────────────
  config: {
    save: (config) => ipcRenderer.invoke('config:save', config),
    load: () => ipcRenderer.invoke('config:load')
  },

  // ── Shell ──────────────────────────────────────────────────────────────────
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
    openPath: (path) => ipcRenderer.invoke('shell:open-path', path)
  },

  // ── Theme ──────────────────────────────────────────────────────────────────
  theme: {
    set: (themeName) => ipcRenderer.invoke('theme:set', themeName)
  },

  // ── Window Controls ────────────────────────────────────────────────────────
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close')
  },

  // ── Events (IPC → Renderer) ────────────────────────────────────────────────
  on: (channel, callback) => {
    const validChannels = ['php:log', 'php:install-progress', 'site:stopped', 'webview:navigate', 'mail:new', 'log:entry'];
    if (validChannels.includes(channel)) {
      const listener = (event, ...args) => callback(...args);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }
  },

  removeAllListeners: (channel) => {
    const validChannels = ['php:log', 'php:install-progress', 'site:stopped', 'webview:navigate', 'mail:new', 'log:entry'];
    if (validChannels.includes(channel)) {
      ipcRenderer.removeAllListeners(channel);
    }
  }
});
