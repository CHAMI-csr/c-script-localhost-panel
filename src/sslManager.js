/**
 * SslManager - Generates and manages local SSL/TLS certificates for .test domains
 * Integrates with Nginx to enable HTTPS on 127.0.0.1:443
 */

const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');

class SslManager {
  constructor(certsDir) {
    this.certsDir = certsDir || this._detectCertsDir();
    this.opensslBin = this._detectOpenSSL();
    this._ensureDir(this.certsDir);
  }

  _detectCertsDir() {
    const userProfile = process.env.USERPROFILE || '';
    const appData = process.env.APPDATA || (userProfile ? path.join(userProfile, 'AppData', 'Roaming') : '.');
    const standaloneSsl = path.join(appData, 'c-script-localhost', 'ssl');
    if (fs.existsSync(standaloneSsl)) return standaloneSsl;

    const legacySsl = path.join(appData, 'antigravity-localhost', 'ssl');
    if (fs.existsSync(legacySsl)) return legacySsl;

    const herdCerts = userProfile ? path.join(userProfile, '.config', 'herd', 'config', 'valet', 'Certificates') : '';
    if (herdCerts && fs.existsSync(herdCerts)) {
      return herdCerts;
    }
    return standaloneSsl;
  }

  _detectOpenSSL() {
    const gitOpenSSL = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
    if (fs.existsSync(gitOpenSSL)) return gitOpenSSL;

    const userProfile = process.env.USERPROFILE || '';
    const herdOpenSSL = path.join(userProfile, '.config', 'herd', 'bin', 'php84', 'openssl.exe');
    if (fs.existsSync(herdOpenSSL)) return herdOpenSSL;

    return 'openssl';
  }

  _ensureDir(dir) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (e) {
      console.warn('[SslManager] Could not create certs dir:', e.message);
    }
  }

  /**
   * Get paths to wildcard certificates for *.test
   */
  getWildcardCertPaths() {
    return {
      crt: path.join(this.certsDir, 'wildcard.test.crt'),
      key: path.join(this.certsDir, 'wildcard.test.key')
    };
  }

  /**
   * Ensure wildcard SSL certificates exist. Generates them if missing.
   */
  async ensureWildcardCert() {
    const { crt, key } = this.getWildcardCertPaths();
    if (fs.existsSync(crt) && fs.existsSync(key)) {
      return { success: true, crt, key, generated: false };
    }

    this._ensureDir(this.certsDir);

    return new Promise((resolve) => {
      const cmd = `"${this.opensslBin}" req -x509 -nodes -days 3650 -newkey rsa:2048 -keyout "${key}" -out "${crt}" -subj "/CN=*.test" -addext "subjectAltName=DNS:*.test,DNS:localhost,IP:127.0.0.1"`;
      exec(cmd, { windowsHide: true }, (err) => {
        if (err) {
          // Fallback with basic PowerShell certificate generation if openssl fails
          const psCmd = `powershell -NoProfile -Command "$cert = New-SelfSignedCertificate -DnsName '*.test', 'localhost' -CertStoreLocation 'cert:\\CurrentUser\\My'; Export-Certificate -Cert $cert -FilePath '${crt}'"`;
          exec(psCmd, { windowsHide: true }, (psErr) => {
            if (fs.existsSync(crt)) {
              return resolve({ success: true, crt, key, generated: true });
            }
            return resolve({ success: false, error: err.message });
          });
          return;
        }
        resolve({ success: true, crt, key, generated: true });
      });
    });
  }

  /**
   * Check if SSL is available and valid
   */
  hasValidCert() {
    const { crt, key } = this.getWildcardCertPaths();
    return fs.existsSync(crt) && fs.existsSync(key);
  }
}

module.exports = SslManager;
