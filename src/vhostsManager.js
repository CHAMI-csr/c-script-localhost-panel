/**
 * VhostsManager - Windows Hosts File Manager for .dev Virtual Hosts
 * Maps local site domains (e.g., mysite.dev) to 127.0.0.1
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');
const SslManager = require('./sslManager');

const HOSTS_PATH = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
  : '/etc/hosts';

const MARKER_START = '# === C-Script LocalHost Panel (Auto-Managed) ===';
const MARKER_END = '# === End C-Script LocalHost Panel ===';
const LEGACY_MARKER_START = '# === Antigravity Dev Suite (Auto-Managed) ===';
const LEGACY_MARKER_END = '# === End Antigravity Dev Suite ===';

class VhostsManager {
  constructor(defaultTld = 'test') {
    this.defaultTld = defaultTld;
    this.hostsPath = HOSTS_PATH;
    this.sslManager = new SslManager();
  }

  /**
   * Convert arbitrary name into a clean hostname slug (e.g. "My Shop v2" -> "my-shop-v2")
   */
  slugify(name) {
    if (!name) return 'site';
    return String(name)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'site';
  }

  /**
   * Format full domain for a site name
   */
  getDomain(siteName, customTld) {
    const tld = (customTld || this.defaultTld || 'test').replace(/^\./, '');
    const slug = this.slugify(siteName);
    return `${slug}.${tld}`;
  }

  /**
   * Read hosts file content
   */
  readHosts() {
    try {
      if (fs.existsSync(this.hostsPath)) {
        return fs.readFileSync(this.hostsPath, 'utf8');
      }
    } catch (e) {
      console.warn('Could not read hosts file directly:', e.message);
    }
    return '';
  }

  _findManagedBlock(content) {
    for (const [startMarker, endMarker] of [
      [MARKER_START, MARKER_END],
      [LEGACY_MARKER_START, LEGACY_MARKER_END]
    ]) {
      const startIndex = content.indexOf(startMarker);
      const endIndex = content.indexOf(endMarker);
      if (startIndex !== -1 && endIndex > startIndex) {
        return { startMarker, endMarker, startIndex, endIndex };
      }
    }
    return null;
  }

  /**
   * List all domains currently managed by this app in the hosts file
   */
  listManagedDomains() {
    const content = this.readHosts();
    if (!content) return [];

    const managedBlock = this._findManagedBlock(content);
    if (!managedBlock) return [];

    const block = content.substring(managedBlock.startIndex + managedBlock.startMarker.length, managedBlock.endIndex);
    const domains = [];
    const lines = block.split(/\r?\n/);
    for (const line of lines) {
      const match = line.trim().match(/^127\.0\.0\.1\s+([a-zA-Z0-9.-]+)/);
      if (match && match[1]) {
        domains.push(match[1].toLowerCase());
      }
    }
    return [...new Set(domains)];
  }

  /**
   * Check if specific domain is already in hosts file
   */
  hasDomain(domain) {
    const content = this.readHosts();
    if (!content) return false;
    const regex = new RegExp(`^\\s*127\\.0\\.0\\.1\\s+${domain.replace('.', '\\.')}\\b`, 'm');
    return regex.test(content);
  }

  /**
   * Sync a list of site names/domains into the hosts file
   * @param {string[]} domains Array of full domain names (e.g. ['mysite.dev', 'api.dev'])
   */
  async syncHosts(domains) {
    const validDomains = [...new Set(
      (domains || [])
        .map(d => typeof d === 'object' && d ? (d.domain || d.name) : d)
        .map(d => String(d || '').trim().toLowerCase())
        .filter(d => d && /^[a-z0-9.-]+$/.test(d))
    )];

    let current = this.readHosts();
    const newBlockLines = [
      MARKER_START,
      ...validDomains.map(d => `127.0.0.1 ${d}`),
      MARKER_END
    ];
    const newBlockText = newBlockLines.join('\r\n');

    let updatedContent = '';
    const managedBlock = this._findManagedBlock(current);

    if (managedBlock) {
      // Replace existing block
      const before = current.substring(0, managedBlock.startIndex).trimEnd();
      const after = current.substring(managedBlock.endIndex + managedBlock.endMarker.length).trimStart();
      updatedContent = (before ? before + '\r\n\r\n' : '') + newBlockText + (after ? '\r\n\r\n' + after : '\r\n');
    } else {
      // Append block
      updatedContent = (current ? current.trimEnd() + '\r\n\r\n' : '') + newBlockText + '\r\n';
    }

    // Attempt direct write (works if process is elevated or hosts is writable)
    try {
      fs.writeFileSync(this.hostsPath, updatedContent, 'utf8');
      return { success: true, count: validDomains.length, domains: validDomains };
    } catch (writeErr) {
      // If permission denied, elevate on Windows using PowerShell RunAs
      if (process.platform === 'win32') {
        return this._elevatedWrite(updatedContent, validDomains);
      }
      return { success: false, error: writeErr.message };
    }
  }

  /**
   * Elevated write via PowerShell Start-Process RunAs
   */
  _elevatedWrite(content, domains) {
    return new Promise((resolve) => {
      const tempId = Date.now();
      const tempPath = path.join(process.env.TEMP || 'C:\\Windows\\Temp', `hosts_update_${tempId}.tmp`);
      const tempPs1 = path.join(process.env.TEMP || 'C:\\Windows\\Temp', `hosts_update_${tempId}.ps1`);

      try {
        fs.writeFileSync(tempPath, content, 'utf8');
      } catch (err) {
        return resolve({ success: false, error: 'Failed to write temporary hosts file: ' + err.message });
      }

      // Safe script to copy temp file to hosts and flush DNS inside elevated PowerShell
      const scriptContent = `
$tempFile = '${tempPath.replace(/'/g, "''")}';
$hostsFile = '${this.hostsPath.replace(/'/g, "''")}';
try {
  Copy-Item -Path $tempFile -Destination $hostsFile -Force
  Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
  & ipconfig /flushdns | Out-Null
  exit 0
} catch {
  exit 1
}
`;

      try {
        fs.writeFileSync(tempPs1, scriptContent, 'utf8');
      } catch (err) {
        try { fs.unlinkSync(tempPath); } catch (e) {}
        return resolve({ success: false, error: 'Failed to create elevation script: ' + err.message });
      }

      const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File','\\"${tempPs1}\\"'"`;

      exec(cmd, { timeout: 45000, windowsHide: true }, (error) => {
        // Clean up temporary files
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (e) {}
        try { if (fs.existsSync(tempPs1)) fs.unlinkSync(tempPs1); } catch (e) {}

        if (error) {
          resolve({
            success: false,
            error: 'Administrator permission was not granted or hosts update was cancelled.',
            requireElevation: true
          });
        } else {
          resolve({ success: true, count: domains.length, domains, elevated: true });
        }
      });
    });
  }

  /**
   * Find Nginx config directory and binary
   */
  getNginxInfo() {
    const userProfile = process.env.USERPROFILE || '';
    const appData = process.env.APPDATA || (userProfile ? path.join(userProfile, 'AppData', 'Roaming') : '');

    // 1. Application-managed NGINX
    const cScriptDir = path.join(appData, 'c-script-localhost', 'nginx');
    const legacyDir = path.join(appData, 'antigravity-localhost', 'nginx');
    const standaloneDir = fs.existsSync(path.join(cScriptDir, 'nginx.exe')) ? cScriptDir : (fs.existsSync(path.join(legacyDir, 'nginx.exe')) ? legacyDir : cScriptDir);
    const standaloneExe = path.join(standaloneDir, 'nginx.exe');
    const standaloneVhosts = path.join(standaloneDir, 'conf', 'vhosts');
    const standaloneConf = path.join(standaloneDir, 'conf', 'nginx.conf');
    if (fs.existsSync(standaloneExe)) {
      if (!fs.existsSync(standaloneVhosts)) {
        try { fs.mkdirSync(standaloneVhosts, { recursive: true }); } catch (e) {}
      }
      return {
        vhostsDir: standaloneVhosts,
        exePath: standaloneExe,
        confPath: standaloneConf,
        prefixDir: standaloneDir
      };
    }

    return null;
  }

  /**
   * Sync reverse proxy configurations for running sites so they can be accessed on port 80 without specifying a port!
   */
    _ensureNginxConfOptimized(confPath) {
    if (!confPath || !fs.existsSync(confPath)) return false;
    try {
      let content = fs.readFileSync(confPath, 'utf8');
      let changed = false;
      if (!content.includes('server_names_hash_bucket_size')) {
        content = content.replace(/http\s*\{/i, 'http {\n    server_names_hash_bucket_size 128;\n    server_names_hash_max_size 2048;');
        changed = true;
      } else {
        const match = content.match(/server_names_hash_bucket_size\s+(\d+);/i);
        if (match && parseInt(match[1]) < 128) {
          content = content.replace(/server_names_hash_bucket_size\s+\d+;/i, 'server_names_hash_bucket_size 128;');
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(confPath, content, 'utf8');
        return true;
      }
    } catch (e) {}
    return false;
  }

  async syncReverseProxy(sites = []) {
    const nginxInfo = this.getNginxInfo();

    if (nginxInfo && fs.existsSync(nginxInfo.vhostsDir)) {
      if (nginxInfo.confPath) this._ensureNginxConfOptimized(nginxInfo.confPath);
      if (this.sslManager) {
        try { await this.sslManager.ensureWildcardCert(); } catch (e) {}
      }
      const sslPaths = this.sslManager ? this.sslManager.getWildcardCertPaths() : null;
      const hasSsl = sslPaths && fs.existsSync(sslPaths.crt) && fs.existsSync(sslPaths.key);
      const crtFwd = hasSsl ? sslPaths.crt.replace(/\\/g, '/') : '';
      const keyFwd = hasSsl ? sslPaths.key.replace(/\\/g, '/') : '';

      let createdCount = 0;
      for (const site of sites) {
        if (!site || !site.domain || !site.port || site.status !== 'running') continue;

        const confFileName = `${site.domain}.conf`;
        const confPath = path.join(nginxInfo.vhostsDir, confFileName);
        const sslBlock = hasSsl ? `    listen 127.0.0.1:443 ssl;
    ssl_certificate "${crtFwd}";
    ssl_certificate_key "${keyFwd}";
` : '';
        const serverBlock = `server {
    listen 127.0.0.1:80;
${sslBlock}    server_name ${site.domain} www.${site.domain} *.${site.domain};
    client_max_body_size 128M;

    location / {
        proxy_pass http://127.0.0.1:${site.port};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
        try {
          fs.writeFileSync(confPath, serverBlock, 'utf8');
          createdCount++;
        } catch (err) {
          console.warn(`[VhostsManager] Failed to write proxy config for ${site.domain}:`, err.message);
        }
      }

      // Reload Nginx if binary is available
      if (nginxInfo.exePath) {
        let reloadCmd = `"${nginxInfo.exePath}" -s reload`;
        if (nginxInfo.prefixDir && nginxInfo.confPath) {
          reloadCmd = `"${nginxInfo.exePath}" -p "${nginxInfo.prefixDir}" -c "${nginxInfo.confPath}" -s reload`;
        }
        exec(reloadCmd, (err) => {
          if (err) console.warn('[VhostsManager] Nginx reload error:', err.message);
        });
      }

      return { success: true, method: 'nginx', count: createdCount, ssl: hasSsl };
    }

    // Fallback: Node.js internal HTTP reverse proxy on port 80 if port 80 is free
    return this._ensureInternalProxy(sites);
  }

  /**
   * Internal Node.js reverse proxy on port 80 if no web server is running
   */
  _ensureInternalProxy(sites = []) {
    if (!this._internalProxyServer) {
      this._internalProxySites = sites;
      try {
        this._internalProxyServer = http.createServer((req, res) => {
          const reqHost = (req.headers.host || '').split(':')[0].toLowerCase();
          const targetSite = (this._internalProxySites || []).find(s =>
            s.status === 'running' && s.port && (s.domain?.toLowerCase() === reqHost || `${s.name.toLowerCase()}.${this.defaultTld}` === reqHost)
          );

          if (!targetSite) {
            res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(`
              <!DOCTYPE html>
              <html>
              <head><title>Site Not Found - C-Script LocalHost Panel</title>
              <style>body{font-family:sans-serif;background:#0d0d14;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}</style>
              </head>
              <body>
                <div style="text-align:center;max-width:500px">
                  <h2>Site Not Running</h2>
                  <p>No active site found for <code>${reqHost}</code> on port 80.</p>
                  <p style="color:#888;font-size:13px">Make sure the site is started in C-Script LocalHost Panel.</p>
                </div>
              </body>
              </html>
            `);
          }

          const proxyReq = http.request({
            host: '127.0.0.1',
            port: targetSite.port,
            method: req.method,
            path: req.url,
            headers: {
              ...req.headers,
              'x-forwarded-host': req.headers.host,
              'x-forwarded-proto': 'http'
            }
          }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          });

          proxyReq.on('error', (err) => {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(`502 Bad Gateway: Site ${targetSite.name} on port ${targetSite.port} did not respond.`);
          });

          req.pipe(proxyReq);
        });

        this._internalProxyServer.on('error', (err) => {
          // Port 80 is occupied by something else
          this._internalProxyServer = null;
        });

        this._internalProxyServer.listen(80, '127.0.0.1');
      } catch (e) {
        this._internalProxyServer = null;
      }
    } else {
      this._internalProxySites = sites;
    }

    return { success: true, method: 'internal' };
  }
}

module.exports = VhostsManager;
