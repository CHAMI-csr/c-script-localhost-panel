/**
 * SslManager - Generates and manages local SSL/TLS certificates for .test domains
 * Integrates with Nginx to enable HTTPS on 127.0.0.1:443
 */

const fs = require('fs');
const path = require('path');
const { X509Certificate } = require('crypto');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

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

    return standaloneSsl;
  }

  _detectOpenSSL() {
    const gitOpenSSL = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
    if (fs.existsSync(gitOpenSSL)) return gitOpenSSL;

    return 'openssl';
  }

  _detectMkcert() {
    const userProfile = process.env.USERPROFILE || '';
    const appData = process.env.APPDATA || (userProfile ? path.join(userProfile, 'AppData', 'Roaming') : '');
    const candidates = [
      path.join(appData, 'c-script-localhost', 'bin', 'mkcert.exe'),
      path.join(appData, 'antigravity-localhost', 'bin', 'mkcert.exe')
    ];
    return candidates.find(candidate => fs.existsSync(candidate)) || 'mkcert';
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

  _getCertificateNames(domains = []) {
    const validDomains = (Array.isArray(domains) ? domains : [domains])
      .map(domain => String(domain || '').trim().toLowerCase())
      .filter(domain => domain && domain.length <= 253 && /^[a-z0-9.-]+$/.test(domain) && !domain.startsWith('.') && !domain.endsWith('.'));
    return [...new Set(['*.test', 'test', 'localhost', '127.0.0.1', '::1', ...validDomains])];
  }

  /**
   * Ensure wildcard SSL certificates exist. Generates them if missing.
   */
  async ensureWildcardCert(domains = []) {
    const { crt, key } = this.getWildcardCertPaths();
    const requestedDomains = this._getCertificateNames(domains).filter(name => !name.startsWith('*') && !name.includes(':'));
    if (fs.existsSync(crt) && fs.existsSync(key)) {
      try {
        const certificate = new X509Certificate(fs.readFileSync(crt));
        const names = new Set((certificate.subjectAltName || '').split(/,\s*/).filter(item => item.startsWith('DNS:')).map(item => item.slice(4)));
        if (requestedDomains.every(domain => names.has(domain))) return { success: true, crt, key, generated: false };
      } catch (_) {}
    }

    this._ensureDir(this.certsDir);
    // A leftover certificate without its private key is unusable by NGINX.
    // Remove only these app-managed files before generating a complete pair.
    for (const file of [crt, key]) {
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
    }

    const mkcert = this._detectMkcert();
    const certificateNames = this._getCertificateNames(domains);
    try {
      await execFileAsync(mkcert, ['-cert-file', crt, '-key-file', key, ...certificateNames], {
        windowsHide: true,
        timeout: 30000
      });
      if (fs.existsSync(crt) && fs.existsSync(key)) {
        return { success: true, crt, key, generated: true, provider: 'mkcert' };
      }
      throw new Error('mkcert did not create both certificate and private-key files.');
    } catch (mkcertError) {
      for (const file of [crt, key]) {
        try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
      }
      try {
        await execFileAsync(this.opensslBin, [
          'req', '-x509', '-nodes', '-days', '3650', '-newkey', 'rsa:2048',
          '-keyout', key, '-out', crt, '-subj', '/CN=*.test',
          '-addext', `subjectAltName=${certificateNames.map(name => name.includes(':') ? `IP:${name}` : `DNS:${name}`).join(',')}`
        ], { windowsHide: true, timeout: 30000 });
        if (!fs.existsSync(crt) || !fs.existsSync(key)) throw new Error('OpenSSL did not create both certificate and private-key files.');
        return { success: true, crt, key, generated: true, provider: 'openssl', trusted: false };
      } catch (opensslError) {
        for (const file of [crt, key]) {
          try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
        }
        const details = opensslError.code === 'ENOENT'
          ? 'Install mkcert or OpenSSL and make sure it is available to the app.'
          : `${opensslError.stderr || opensslError.message || 'Certificate generation failed.'}`.trim();
        return { success: false, error: `Could not create a complete local SSL certificate. ${details}`, cause: mkcertError.message };
      }
    }
  }

  /** Create a browser-trusted wildcard certificate using the user's mkcert CA.
   * This is intentionally a separate, user-triggered action because -install
   * adds a local CA to the current user's trusted root certificate store.
   */
  async ensureTrustedWildcardCert(domains = []) {
    const mkcert = this._detectMkcert();
    const { crt, key } = this.getWildcardCertPaths();
    const certificateNames = this._getCertificateNames(domains);
    this._ensureDir(this.certsDir);
    try {
      await execFileAsync(mkcert, ['-install'], { windowsHide: true, timeout: 30000 });
      await execFileAsync(mkcert, ['-cert-file', crt, '-key-file', key, ...certificateNames], {
        windowsHide: true,
        timeout: 30000
      });
      if (!fs.existsSync(crt) || !fs.existsSync(key)) {
        throw new Error('mkcert completed without creating both certificate files.');
      }
      return { success: true, trusted: true, crt, key, generated: true, provider: 'mkcert' };
    } catch (error) {
      // Windows can create and trust a local CA without a separate executable.
      // Keep this fallback behind the explicit UI confirmation for this action.
      try {
        await this._generateTrustedWindowsCertificate(crt, key, certificateNames);
        return { success: true, trusted: true, crt, key, generated: true, provider: 'Windows local CA' };
      } catch (windowsError) {
        return {
          success: false,
          trusted: false,
          error: `mkcert failed (${error.stderr || error.message || 'not installed'}); Windows certificate setup failed: ${windowsError.stderr || windowsError.message || windowsError}`
        };
      }
    }
  }

  async _generateTrustedWindowsCertificate(crt, key, certificateNames) {
    if (process.platform !== 'win32') throw new Error('The Windows certificate fallback is available on Windows only.');
    const caCertPath = path.join(this.certsDir, 'c-script-localhost-root-ca.cer');
    const quote = value => `'${String(value).replace(/'/g, "''")}'`;
    const dnsNames = [...new Set(certificateNames.filter(name => !name.includes(':')))].map(quote).join(',');
    const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module Microsoft.PowerShell.Security -Force -ErrorAction Stop
Import-Module PKI -Force -ErrorAction Stop
$caSubject = 'CN=C-Script Local Development Root CA'
$ca = Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -eq $caSubject -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) } | Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $ca) {
  $ca = New-SelfSignedCertificate -Type Custom -Subject $caSubject -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage CertSign,CRLSign,DigitalSignature -NotAfter (Get-Date).AddYears(10) -TextExtension @('2.5.29.19={critical}{text}ca=TRUE&pathlength=0') -CertStoreLocation 'Cert:\\CurrentUser\\My'
}
$rootPath = ${quote(caCertPath)}
Export-Certificate -Cert $ca -FilePath $rootPath -Force | Out-Null
$rootStore = [System.Security.Cryptography.X509Certificates.X509Store]::new([System.Security.Cryptography.X509Certificates.StoreName]::Root, [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
$rootStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
$rootInstalled = $false
foreach ($trustedCertificate in $rootStore.Certificates) { if ($trustedCertificate.Thumbprint -eq $ca.Thumbprint) { $rootInstalled = $true; break } }
if (-not $rootInstalled) { $rootStore.Add($ca) }
$rootStore.Close()
$leaf = New-SelfSignedCertificate -Type Custom -Subject 'CN=*.test' -DnsName @(${dnsNames}) -Signer $ca -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment -NotAfter (Get-Date).AddYears(2) -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.1') -CertStoreLocation 'Cert:\\CurrentUser\\My'
$rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($leaf)
if (-not $rsa) { throw 'Windows did not expose the generated certificate private key.' }
$parameters = $rsa.ExportParameters($true)
$leafBytes = $leaf.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
$caBytes = $ca.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
public static class CScriptPemWriter {
  static byte[] Len(int n) { if (n < 128) return new byte[] { (byte)n }; byte[] b = BitConverter.GetBytes(n); Array.Reverse(b); int i = 0; while (i < b.Length - 1 && b[i] == 0) i++; byte[] r = new byte[b.Length - i + 1]; r[0] = (byte)(0x80 | (r.Length - 1)); Buffer.BlockCopy(b, i, r, 1, r.Length - 1); return r; }
  static byte[] Tlv(byte tag, byte[] value) { byte[] l = Len(value.Length); byte[] r = new byte[1 + l.Length + value.Length]; r[0] = tag; Buffer.BlockCopy(l, 0, r, 1, l.Length); Buffer.BlockCopy(value, 0, r, 1 + l.Length, value.Length); return r; }
  static byte[] Int(byte[] value) { int i = 0; while (i < value.Length - 1 && value[i] == 0) i++; int n = value.Length - i; bool pad = (value[i] & 0x80) != 0; byte[] v = new byte[n + (pad ? 1 : 0)]; Buffer.BlockCopy(value, i, v, pad ? 1 : 0, n); return Tlv(0x02, v); }
  static byte[] Seq(params byte[][] values) { using (var m = new MemoryStream()) { foreach (var v in values) m.Write(v, 0, v.Length); return Tlv(0x30, m.ToArray()); } }
  static string Pem(byte[] bytes, string label) { string b64 = Convert.ToBase64String(bytes); var sb = new StringBuilder(); sb.Append("-----BEGIN ").Append(label).AppendLine("-----"); for (int i = 0; i < b64.Length; i += 64) sb.AppendLine(b64.Substring(i, Math.Min(64, b64.Length - i))); sb.Append("-----END ").Append(label).AppendLine("-----"); return sb.ToString(); }
  public static void Write(byte[] leaf, byte[] ca, RSAParameters p, string certPath, string keyPath) { byte[][] parts = { Int(new byte[] { 0 }), Int(p.Modulus), Int(p.Exponent), Int(p.D), Int(p.P), Int(p.Q), Int(p.DP), Int(p.DQ), Int(p.InverseQ) }; byte[] privateKey = Seq(parts); File.WriteAllText(certPath, Pem(leaf, "CERTIFICATE") + Environment.NewLine + Pem(ca, "CERTIFICATE"), new UTF8Encoding(false)); File.WriteAllText(keyPath, Pem(privateKey, "RSA PRIVATE KEY"), new UTF8Encoding(false)); }
}
'@
[CScriptPemWriter]::Write($leafBytes, $caBytes, $parameters, ${quote(crt)}, ${quote(key)})
if (-not (Test-Path -LiteralPath ${quote(crt)}) -or -not (Test-Path -LiteralPath ${quote(key)})) { throw 'Certificate or private key output is missing.' }
Write-Output 'Trusted local certificate and NGINX PEM key created.'
`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const windowsPowerShellModulePath = [
      path.join(process.env.USERPROFILE || '', 'Documents', 'WindowsPowerShell', 'Modules'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsPowerShell', 'Modules'),
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
    ].filter(modulePath => fs.existsSync(modulePath)).join(';');
    await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PSModulePath: windowsPowerShellModulePath }
    });
    if (!fs.existsSync(crt) || !fs.existsSync(key)) throw new Error('Certificate generation did not create both required files.');
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
