'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const NginxInstaller = require('../src/nginxInstaller');
const SslManager = require('../src/sslManager');
const VhostsManager = require('../src/vhostsManager');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cscript-nginx-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('repairs vhosts that reference a missing certificate before config tests', (t) => {
  const dir = tempDir(t);
  const vhostsDir = path.join(dir, 'vhosts');
  fs.mkdirSync(vhostsDir);
  const missingCert = path.join(dir, 'missing.crt').replace(/\\/g, '/');
  const missingKey = path.join(dir, 'missing.key').replace(/\\/g, '/');
  const confPath = path.join(vhostsDir, 'example.test.conf');
  fs.writeFileSync(confPath, `server {\n  listen 127.0.0.1:80;\n  listen 127.0.0.1:443 ssl;\n  ssl_certificate "${missingCert}";\n  ssl_certificate_key "${missingKey}";\n  server_name example.test;\n}\n`);

  const installer = Object.create(NginxInstaller.prototype);
  installer.vhostsDir = vhostsDir;

  assert.equal(installer.repairMissingSslReferences(), 1);
  const repaired = fs.readFileSync(confPath, 'utf8');
  assert.match(repaired, /listen 127\.0\.0\.1:80;/);
  assert.doesNotMatch(repaired, /ssl_certificate|443 ssl/);
});

test('coalesces concurrent reloads into one validated signal', async () => {
  const installer = Object.create(NginxInstaller.prototype);
  installer._reloadPromise = null;
  installer.isInstalled = () => true;
  installer.isRunning = async () => true;
  let tests = 0;
  let signals = 0;
  installer._testConfiguration = async () => {
    tests++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return { success: true };
  };
  installer._execNginx = async (args) => {
    assert.equal(args.at(-1), 'reload');
    signals++;
    return { success: true };
  };

  const [first, second] = await Promise.all([installer.reload(), installer.reload()]);
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(tests, 1);
  assert.equal(signals, 1);
});

test('vhost sync reloads centrally only when generated config changes', async (t) => {
  const dir = tempDir(t);
  const vhostsDir = path.join(dir, 'conf', 'vhosts');
  fs.mkdirSync(vhostsDir, { recursive: true });
  const confPath = path.join(dir, 'conf', 'nginx.conf');
  const exePath = path.join(dir, 'nginx.exe');
  fs.writeFileSync(confPath, 'events {}\nhttp { include vhosts/*.conf; }\n');
  fs.writeFileSync(exePath, '');
  const crt = path.join(dir, 'wildcard.test.crt');
  const key = path.join(dir, 'wildcard.test.key');
  fs.writeFileSync(crt, 'certificate');
  fs.writeFileSync(key, 'key');

  let reloads = 0;
  const manager = new VhostsManager('test', {
    sslManager: {
      ensureWildcardCert: async () => ({ success: true, crt, key }),
      getWildcardCertPaths: () => ({ crt, key })
    },
    nginxInstaller: {
      reload: async () => { reloads++; return { success: true }; }
    }
  });
  manager.getNginxInfo = () => ({ vhostsDir, confPath, exePath, prefixDir: dir });
  const sites = [{ id: 'site-1', domain: 'example.test', port: 8080, status: 'running', root: dir }];

  assert.equal((await manager.syncReverseProxy(sites)).success, true);
  assert.equal((await manager.syncReverseProxy(sites)).success, true);
  assert.equal(reloads, 1);
});

test('failed certificate regeneration preserves the existing live pair', async (t) => {
  const dir = tempDir(t);
  const manager = new SslManager(dir);
  const { crt, key } = manager.getWildcardCertPaths();
  fs.writeFileSync(crt, 'old certificate');
  fs.writeFileSync(key, 'old key');
  manager._detectMkcert = () => path.join(dir, 'missing-mkcert');
  manager.opensslBin = path.join(dir, 'missing-openssl');

  const result = await manager.ensureWildcardCert(['example.test']);
  assert.equal(result.success, false);
  assert.equal(fs.readFileSync(crt, 'utf8'), 'old certificate');
  assert.equal(fs.readFileSync(key, 'utf8'), 'old key');
  assert.equal(fs.readdirSync(dir).some(name => name.includes('.tmp-')), false);
});
