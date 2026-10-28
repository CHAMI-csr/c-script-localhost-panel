/** Manage a small, additive Windows per-user proxy bypass list for local dev hosts. */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const REGISTRY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const REQUIRED_BYPASS = ['<local>', '*.test', '*.localhost', 'localhost', '127.0.0.1', '::1'];

class LocalProxyBypass {
  async _readRegistryValue(valueName) {
    const { stdout } = await execFileAsync('reg.exe', ['query', REGISTRY_KEY, '/v', valueName], {
      windowsHide: true,
      timeout: 5000
    });
    const line = stdout.split(/\r?\n/).find(item => item.includes(valueName));
    if (!line) return '';
    const match = line.trim().match(new RegExp(`^${valueName}\\s+REG_\\w+\\s+(.*)$`, 'i'));
    return match ? match[1].trim() : '';
  }

  async status() {
    if (process.platform !== 'win32') {
      return { supported: false, applied: false, error: 'Windows per-user proxy settings are only available on Windows.' };
    }
    try {
      const readOptional = valueName => this._readRegistryValue(valueName).catch(() => '');
      const [enabledRaw, proxyServer, override] = await Promise.all([
        readOptional('ProxyEnable'),
        readOptional('ProxyServer'),
        readOptional('ProxyOverride')
      ]);
      const entries = override.split(';').map(item => item.trim().toLowerCase()).filter(Boolean);
      return {
        supported: true,
        proxyEnabled: enabledRaw === '0x1' || enabledRaw === '1',
        proxyServer,
        override,
        applied: REQUIRED_BYPASS.every(item => entries.includes(item.toLowerCase())),
        required: REQUIRED_BYPASS
      };
    } catch (error) {
      return { supported: true, applied: false, error: error.message, required: REQUIRED_BYPASS };
    }
  }

  async apply(localDomains = []) {
    if (process.platform !== 'win32') return { success: false, error: 'Windows per-user proxy settings are only available on Windows.' };
    try {
      const domains = [...new Set((Array.isArray(localDomains) ? localDomains : [])
        .map(domain => String(domain || '').trim().toLowerCase())
        .filter(domain => domain.length <= 253 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)))];
      const bypassEntries = [...new Set([...REQUIRED_BYPASS, ...domains])];
      let current = '';
      try { current = await this._readRegistryValue('ProxyOverride'); } catch (_) {}
      const entries = current.split(';').map(item => item.trim()).filter(Boolean);
      const existing = new Set(entries.map(item => item.toLowerCase()));
      for (const entry of bypassEntries) {
        if (!existing.has(entry.toLowerCase())) entries.push(entry);
      }
      const override = entries.join(';');
      await execFileAsync('reg.exe', [
        'add', REGISTRY_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', override, '/f'
      ], { windowsHide: true, timeout: 5000 });
      return { success: true, override, added: bypassEntries.filter(item => !existing.has(item.toLowerCase())) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = LocalProxyBypass;
