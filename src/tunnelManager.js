/**
 * TunnelManager - Multi-Engine Public Web Sharing
 * Supports SSH Tunnel (localhost.run) and Cloudflare Tunnel (cloudflared)
 * Automatically falls back to SSH Tunnel if Cloudflare edge connectivity is blocked (Error 1033 prevention)
 */

const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const { EventEmitter } = require('events');
const http = require('http');

function extractSshTunnelUrl(output) {
  const match = String(output || '').match(/https:\/\/[a-z0-9][a-z0-9.-]*(?:\.lhr\.(?:life|rocks)|\.localhost\.run)/i);
  return match ? match[0] : null;
}

function extractCloudflareTunnelUrl(output) {
  const match = String(output || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match ? match[0] : null;
}

class TunnelManager extends EventEmitter {
  constructor(dependencies = {}) {
    super();
    this.spawnProcess = dependencies.spawn || spawn;
    this.execCommand = dependencies.exec || exec;
    this.httpClient = dependencies.http || http;
    this.tunnels = {}; // siteId -> { process, url, port, provider }
    this.stoppingTunnels = new Map();
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

  getNgrokPath() {
    const userProfile = process.env.USERPROFILE || '';
    const appData = process.env.APPDATA || (userProfile ? path.join(userProfile, 'AppData', 'Roaming') : '');
    const local = path.join(appData, 'c-script-localhost', 'bin', 'ngrok.exe');
    if (fs.existsSync(local)) return local;
    const legacy = path.join(appData, 'antigravity-localhost', 'bin', 'ngrok.exe');
    if (fs.existsSync(legacy)) return legacy;
    return 'ngrok';
  }

  /**
   * Check if cloudflared binary is available
   */
  async isCloudflaredAvailable() {
    const bin = this.getCloudflaredPath();
    if (fs.existsSync(bin)) return true;

    return new Promise((resolve) => {
      this.execCommand('where.exe cloudflared', (err) => {
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
      this.execCommand('where.exe ssh', (err) => {
        resolve(!err);
      });
    });
  }

  /** Verify the local HTTP origin is reachable before exposing it publicly. */
  checkLocalOrigin(port, timeoutMs = 5000) {
    const numericPort = Number(port);
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
      return Promise.resolve({ success: false, error: 'The site does not have a valid running HTTP port.' });
    }
    return new Promise(resolve => {
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const request = this.httpClient.get({
        hostname: '127.0.0.1',
        port: numericPort,
        path: '/',
        headers: { Host: 'localhost', Connection: 'close' },
        timeout: timeoutMs
      }, response => {
        response.resume();
        finish({ success: true, statusCode: response.statusCode });
      });
      request.once('timeout', () => {
        request.destroy();
        finish({ success: false, error: `The local site on port ${numericPort} did not respond in time.` });
      });
      request.once('error', error => {
        finish({ success: false, error: `The local site on port ${numericPort} is not reachable: ${error.message}` });
      });
    });
  }

  /**
   * Start a Public Web Tunnel for a site
   * @param {string} siteId Site ID
   * @param {number} port Local HTTP port
   * @param {object} options { provider: 'auto' | 'ssh' | 'cloudflare' | 'ngrok', authToken }
   */
  async startTunnel(siteId, port, options = {}) {
    if (this.stoppingTunnels.has(siteId)) await this.stoppingTunnels.get(siteId);
    if (this.tunnels[siteId]) {
      if (!this.tunnels[siteId].url) return { success: false, error: 'A tunnel is already starting for this site.' };
      return {
        success: true,
        url: this.tunnels[siteId].url,
        provider: this.tunnels[siteId].provider,
        alreadyRunning: true
      };
    }

    const origin = await this.checkLocalOrigin(port);
    if (!origin.success) return origin;
    const provider = options.provider || 'auto';

    if (provider === 'ngrok') return this._startNgrokTunnel(siteId, port, options.authToken);

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

  async _startNgrokTunnel(siteId, port, suppliedToken) {
    const authToken = String(suppliedToken || process.env.NGROK_AUTHTOKEN || '').trim();
    if (!authToken) return { success: false, error: 'Ngrok requires an authtoken. Set NGROK_AUTHTOKEN or enter it in the sharing prompt.' };
    const bin = this.getNgrokPath();
    return new Promise(resolve => {
      let settled = false;
      let output = '';
      let timer;
      const proc = this.spawnProcess(bin, ['http', '--log', 'stdout', '--log-format', 'logfmt', `127.0.0.1:${port}`], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NGROK_AUTHTOKEN: authToken }
      });
      this.tunnels[siteId] = { process: proc, url: null, port, provider: 'Connecting to ngrok', engine: 'ngrok' };
      const finish = (result, cleanup = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (cleanup) this.stopTunnel(siteId).finally(() => resolve(result));
        else resolve(result);
      };
      timer = setTimeout(() => finish({
        success: false,
        error: `Timed out waiting for ngrok to provide a public URL. ${output.slice(-500)}`.trim()
      }, true), 25000);
      const onData = chunk => {
        const text = chunk.toString();
        output = (output + text).slice(-16000);
        const match = output.match(/(?:url=|started tunnel[^\n]*?url=)["']?(https:\/\/[^\s"']+)/i) || output.match(/https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.app/i);
        if (!match || settled) return;
        const url = match[1] || match[0];
        this.tunnels[siteId] = { ...this.tunnels[siteId], url, provider: 'ngrok' };
        this.emit('tunnel-started', { siteId, url, provider: 'ngrok' });
        finish({ success: true, url, siteId, provider: 'ngrok' });
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.once('error', error => {
        if (this.tunnels[siteId]?.process === proc) delete this.tunnels[siteId];
        finish({ success: false, error: error.code === 'ENOENT' ? 'ngrok was not found. Install ngrok or place ngrok.exe in the app bin folder.' : error.message });
      });
      proc.once('exit', code => {
        if (this.tunnels[siteId]?.process === proc) delete this.tunnels[siteId];
        if (!settled) finish({ success: false, error: `ngrok exited with code ${code}. ${output.slice(-1000)}` });
        this.emit('tunnel-stopped', { siteId });
      });
    });
  }

  /**
   * Start SSH tunnel via localhost.run (uses Windows built-in OpenSSH)
   */
  async _startSshTunnel(siteId, port, reason = '') {
    const sshBin = this.getSshPath();
    const args = [
      '-T',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ConnectTimeout=12',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-R', `80:127.0.0.1:${port}`,
      'nokey@localhost.run'
    ];

    return new Promise((resolve) => {
      let resolved = false;
      let output = '';
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.stopTunnel(siteId).finally(() => resolve({
            success: false,
            error: `Timed out waiting for localhost.run to provide a public URL. ${output.slice(-500)}`.trim()
          }));
        }
      }, 30000);

      const proc = this.spawnProcess(sshBin, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.tunnels[siteId] = {
        process: proc,
        url: null,
        port,
        provider: 'Connecting to localhost.run',
        engine: 'ssh'
      };

      const onData = (data) => {
        const text = data.toString();
        output = (output + text).slice(-8000);
        this.emit('log', { siteId, message: text });
        const url = extractSshTunnelUrl(output);
        if (url && !resolved) {
          clearTimeout(timeout);
          resolved = true;
          this.tunnels[siteId] = { ...this.tunnels[siteId], url, provider: 'SSH Tunnel (localhost.run)' };
          this.emit('tunnel-started', { siteId, url, provider: 'ssh' });
          resolve({ success: true, url, siteId, provider: 'SSH Tunnel (localhost.run)' });
        }
      };

      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);

      proc.on('error', (err) => {
        clearTimeout(timeout);
        if (this.tunnels[siteId]?.process === proc) delete this.tunnels[siteId];
        if (!resolved) {
          resolved = true;
          resolve({ success: false, error: 'SSH Tunnel error: ' + err.message });
        }
      });

      proc.on('exit', (code) => {
        clearTimeout(timeout);
        if (this.tunnels[siteId]?.process === proc) delete this.tunnels[siteId];
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
      let registered = false;
      let output = '';

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          const errMsg = detectedUrl
            ? 'Cloudflare created a URL but did not register an edge connection. Check firewall access to port 7844.'
            : `Timed out waiting for Cloudflare Tunnel to initialize. ${output.slice(-500)}`.trim();
          this.stopTunnel(siteId).finally(() => resolve({ success: false, error: errMsg }));
        }
      }, 30000);

      const proc = this.spawnProcess(bin, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.tunnels[siteId] = {
        process: proc,
        url: null,
        port,
        provider: 'Connecting to Cloudflare Tunnel',
        engine: 'cloudflare'
      };

      const onData = (data) => {
        const text = data.toString();
        output = (output + text).slice(-16000);
        this.emit('log', { siteId, message: text });
        detectedUrl = detectedUrl || extractCloudflareTunnelUrl(output);
        registered = registered || /Registered tunnel connection/i.test(output);

        // A Quick Tunnel URL is allocated before the connector reaches Cloudflare's
        // edge. Do not expose it until both signals are present, otherwise users see
        // a public URL that only returns Cloudflare Error 1033.
        if (registered && detectedUrl && !resolved) {
          clearTimeout(timeout);
          resolved = true;
          const url = detectedUrl;
          this.tunnels[siteId] = { ...this.tunnels[siteId], url, provider: 'Cloudflare Tunnel' };
          this.emit('tunnel-started', { siteId, url, provider: 'cloudflare' });
          resolve({ success: true, url, siteId, provider: 'Cloudflare Tunnel' });
        }

        // Do not abort on a single QUIC/UDP dial error: cloudflared can retry or
        // switch transports. Only terminal Quick Tunnel setup errors fail early.
        if (/failed to request quick tunnel|quick tunnel request failed|error parsing tunnel configuration/i.test(text)) {
          if (!resolved) {
            clearTimeout(timeout);
            resolved = true;
            const result = {
              success: false,
              error: `Cloudflare Quick Tunnel setup failed. ${text.trim().slice(-500)}`.trim()
            };
            this.stopTunnel(siteId).finally(() => resolve(result));
          }
        }
      };

      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);

      proc.on('error', (err) => {
        clearTimeout(timeout);
        if (this.tunnels[siteId]?.process === proc) delete this.tunnels[siteId];
        if (!resolved) {
          resolved = true;
          resolve({ success: false, error: err.message });
        }
      });

      proc.on('exit', () => {
        clearTimeout(timeout);
        if (this.tunnels[siteId]?.process === proc) delete this.tunnels[siteId];
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
    if (this.stoppingTunnels.has(siteId)) return this.stoppingTunnels.get(siteId);
    const entry = this.tunnels[siteId];
    if (!entry) return Promise.resolve(false);

    const proc = entry.process;
    delete this.tunnels[siteId];
    this.emit('tunnel-stopped', { siteId });
    if (!proc || proc.exitCode !== null) return Promise.resolve(true);

    const stopping = new Promise(resolve => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        resolve(true);
      };
      const timeout = setTimeout(finish, 5000);
      proc.once('exit', finish);
      try {
        if (process.platform === 'win32' && proc.pid) {
          const killer = this.spawnProcess('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', finish);
          killer.once('close', () => {
            if (proc.exitCode !== null) finish();
          });
        } else {
          proc.kill('SIGTERM');
        }
      } catch (error) {
        finish();
      }
    });
    this.stoppingTunnels.set(siteId, stopping);
    stopping.finally(() => {
      if (this.stoppingTunnels.get(siteId) === stopping) this.stoppingTunnels.delete(siteId);
    });
    return stopping;
  }

  /**
   * Stop all running tunnels
   */
  async stopAll() {
    await Promise.all([
      ...Object.keys(this.tunnels).map(id => this.stopTunnel(id)),
      ...this.stoppingTunnels.values()
    ]);
  }

  /**
   * Get active tunnel status for a site
   */
  getStatus(siteId) {
    if (this.tunnels[siteId]) {
      return {
        active: Boolean(this.tunnels[siteId].url),
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
