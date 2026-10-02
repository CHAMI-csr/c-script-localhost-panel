/**
 * TunnelManager - Multi-Engine Public Web Sharing
 * Supports SSH Tunnel (localhost.run) and Cloudflare Tunnel (cloudflared)
 * Automatically falls back to SSH Tunnel if Cloudflare edge connectivity is blocked (Error 1033 prevention)
 */

const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const { EventEmitter } = require('events');

class TunnelManager extends EventEmitter {
  constructor() {
    super();
    this.tunnels = {}; // siteId -> { process, url, port, provider }
  }

  /**
   * Find cloudflared executable path
   */
  getCloudflaredPath() {
    const userProfile = process.env.USERPROFILE || '';
    const appData = process.env.APPDATA || (userProfile ? path.join(userProfile, 'AppData', 'Roaming') : '');
    const localBin = path.join(appData, 'c-script-localhost', 'bin', 'cloudflared.exe');
    if (fs.existsSync(localBin)) return localBin;

    const legacyBin = path.join(appData, 'antigravity-localhost', 'bin', 'cloudflared.exe');
    if (fs.existsSync(legacyBin)) return legacyBin;

    const herdBin = path.join(userProfile, '.config', 'herd', 'bin', 'cloudflared.exe');
    if (fs.existsSync(herdBin)) return herdBin;

    const progFiles = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
    if (fs.existsSync(progFiles)) return progFiles;

    return 'cloudflared';
  }

  /**
   * Find OpenSSH ssh.exe path
   */
  getSshPath() {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const defaultSsh = path.join(sysRoot, 'System32', 'OpenSSH', 'ssh.exe');
    if (fs.existsSync(defaultSsh)) return defaultSsh;
    return 'ssh';
  }

  /**
   * Check if cloudflared binary is available
   */
  async isCloudflaredAvailable() {
    const bin = this.getCloudflaredPath();
    if (fs.existsSync(bin)) return true;

    return new Promise((resolve) => {
      exec('where.exe cloudflared', (err) => {
        resolve(!err);
      });
    });
  }

  /**
   * Check if ssh client is available
   */
  async isSshAvailable() {
    const bin = this.getSshPath();
    if (fs.existsSync(bin)) return true;

    return new Promise((resolve) => {
      exec('where.exe ssh', (err) => {
        resolve(!err);
      });
    });
  }

  /**
   * Start a Public Web Tunnel for a site
   * @param {string} siteId Site ID
   * @param {number} port Local HTTP port
   * @param {object} options { provider: 'auto' | 'ssh' | 'cloudflare' }
   */
  async startTunnel(siteId, port, options = {}) {
    if (this.tunnels[siteId]) {
      return {
        success: true,
        url: this.tunnels[siteId].url,
        provider: this.tunnels[siteId].provider,
        alreadyRunning: true
      };
    }

    const provider = options.provider || 'auto';

    if (provider === 'cloudflare') {
      const res = await this._startCloudflareTunnel(siteId, port);
      if (res.success) return res;
      // If Cloudflare explicitly failed and fallback allowed, try SSH
      if (options.fallback !== false) {
        console.warn(`[TunnelManager] Cloudflare tunnel failed (${res.error}). Falling back to SSH Tunnel...`);
        return this._startSshTunnel(siteId, port, 'fallback-cloudflare');
      }
      return res;
    }

    if (provider === 'ssh') {
      return this._startSshTunnel(siteId, port);
    }

    // Default 'auto': First try SSH tunnel directly because it bypasses ISP UDP/7844 blocks
    // and guarantees no Cloudflare Error 1033. If SSH fails, fallback to Cloudflare.
    const sshRes = await this._startSshTunnel(siteId, port);
    if (sshRes.success) return sshRes;

    console.warn(`[TunnelManager] SSH tunnel failed (${sshRes.error}). Trying Cloudflare...`);
    return this._startCloudflareTunnel(siteId, port);
  }

  /**
   * Start SSH tunnel via localhost.run (uses Windows built-in OpenSSH)
   */
  async _startSshTunnel(siteId, port, reason = '') {
    const sshBin = this.getSshPath();
    const args = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-R', `80:127.0.0.1:${port}`,
      'nokey@localhost.run'
    ];

    return new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.stopTunnel(siteId);
          resolve({ success: false, error: 'Timed out waiting for SSH Tunnel connection (15s).' });
        }
      }, 15000);

      const proc = spawn(sshBin, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const onData = (data) => {
        const text = data.toString();
        // Regex to extract localhost.run URL: https://xxx.lhr.life
        const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.lhr\.life/i);
        if (match && !resolved) {
          clearTimeout(timeout);
          resolved = true;
          const url = match[0];
          this.tunnels[siteId] = {
            process: proc,
            url,
            port,
            provider: 'SSH Tunnel (localhost.run)',
            engine: 'ssh'
          };
          this.emit('tunnel-started', { siteId, url, provider: 'ssh' });
          resolve({ success: true, url, siteId, provider: 'SSH Tunnel (localhost.run)' });
        }
      };

      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);

      proc.on('error', (err) => {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          resolve({ success: false, error: 'SSH Tunnel error: ' + err.message });
        }
      });

      proc.on('exit', (code) => {
        clearTimeout(timeout);
        delete this.tunnels[siteId];
        this.emit('tunnel-stopped', { siteId });
        if (!resolved) {
          resolved = true;
          resolve({ success: false, error: `SSH Tunnel exited prematurely (code: ${code}).` });
        }
      });
    });
  }

  /**
   * Start Cloudflare quick tunnel (cloudflared)
   */
  async _startCloudflareTunnel(siteId, port) {
    const available = await this.isCloudflaredAvailable();
    if (!available) {
      return {
        success: false,
        error: 'cloudflared binary not found.'
      };
    }

    const bin = this.getCloudflaredPath();
    const args = ['tunnel', '--url', `http://127.0.0.1:${port}`];

    return new Promise((resolve) => {
      let resolved = false;
      let detectedUrl = null;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.stopTunnel(siteId);
          // If URL was detected but edge registration timed out (typical port 7844 block)
          const errMsg = detectedUrl
            ? 'Cloudflare edge connection blocked by ISP (Port 7844). Switching to SSH...'
            : 'Timed out waiting for Cloudflare Tunnel to initialize (15s).';
          resolve({ success: false, error: errMsg });
        }
      }, 15000);

      const proc = spawn(bin, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const onData = (data) => {
        const text = data.toString();

        // Check for URL
        const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/i);
        if (match && !detectedUrl) {
          detectedUrl = match[0];
        }

        // Check for edge connectivity or immediate readiness
        // If "Registered tunnel connection" is seen, it's 100% active without Error 1033!
        const hasRegistered = /Registered tunnel connection/i.test(text);
        if ((hasRegistered || detectedUrl) && !resolved) {
          // If registered or url detected, wait slightly or resolve
          clearTimeout(timeout);
          resolved = true;
          const url = detectedUrl || match[0];
          this.tunnels[siteId] = {
            process: proc,
            url,
            port,
            provider: 'Cloudflare Tunnel',
            engine: 'cloudflare'
          };
          this.emit('tunnel-started', { siteId, url, provider: 'cloudflare' });
          resolve({ success: true, url, siteId, provider: 'Cloudflare Tunnel' });
        }

        // If precheck failed or UDP connection failed, abort fast so fallback can run
        if (/UDP Connectivity.*status=fail|failed to dial to edge with quic|TLS handshake with edge error/i.test(text)) {
          if (!resolved) {
            clearTimeout(timeout);
            resolved = true;
            this.stopTunnel(siteId);
            resolve({
              success: false,
              error: 'Cloudflare edge connection blocked by ISP or firewall (port 7844 UDP/QUIC blocked).'
            });
          }
        }
      };

      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);

      proc.on('error', (err) => {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          resolve({ success: false, error: err.message });
        }
      });

      proc.on('exit', () => {
        clearTimeout(timeout);
        delete this.tunnels[siteId];
        this.emit('tunnel-stopped', { siteId });
        if (!resolved) {
          resolved = true;
          resolve({ success: false, error: 'Cloudflare Tunnel exited unexpectedly.' });
        }
      });
    });
  }

  /**
   * Stop a tunnel for a site
   */
  stopTunnel(siteId) {
    const entry = this.tunnels[siteId];
    if (!entry) return false;

    try {
      if (process.platform === 'win32' && entry.process && entry.process.pid) {
        spawn('taskkill', ['/pid', String(entry.process.pid), '/T', '/F'], { windowsHide: true });
      } else if (entry.process) {
        entry.process.kill('SIGTERM');
      }
    } catch (e) {}

    delete this.tunnels[siteId];
    this.emit('tunnel-stopped', { siteId });
    return true;
  }

  /**
   * Stop all running tunnels
   */
  stopAll() {
    Object.keys(this.tunnels).forEach(id => this.stopTunnel(id));
  }

  /**
   * Get active tunnel status for a site
   */
  getStatus(siteId) {
    if (this.tunnels[siteId]) {
      return {
        active: true,
        url: this.tunnels[siteId].url,
        port: this.tunnels[siteId].port,
        provider: this.tunnels[siteId].provider || 'Public Tunnel'
      };
    }
    return { active: false, url: null };
  }

  /**
   * List all running tunnels
   */
  listTunnels() {
    return Object.entries(this.tunnels).map(([id, t]) => ({
      siteId: id,
      url: t.url,
      port: t.port,
      provider: t.provider
    }));
  }
}

module.exports = TunnelManager;
