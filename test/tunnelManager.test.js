'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const TunnelManager = require('../src/tunnelManager');

function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.exitCode = null;
  proc.pid = 123;
  proc.kill = () => {
    proc.exitCode = 0;
    queueMicrotask(() => proc.emit('exit', 0));
    return true;
  };
  return proc;
}

test('local origin validation accepts any HTTP response and rejects closed ports', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end('reachable');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const manager = new TunnelManager();

  assert.deepEqual(await manager.checkLocalOrigin(port), { success: true, statusCode: 404 });
  await new Promise(resolve => server.close(resolve));
  const failed = await manager.checkLocalOrigin(port, 100);
  assert.equal(failed.success, false);
  assert.match(failed.error, /not reachable|did not respond/);
});

test('startTunnel refuses to spawn a provider when the local site is unreachable', async () => {
  let spawned = false;
  const manager = new TunnelManager({ spawn: () => { spawned = true; return fakeProcess(); } });
  const result = await manager.startTunnel('site-a', 65534, { provider: 'ssh' });
  assert.equal(result.success, false);
  assert.equal(spawned, false);
  assert.match(result.error, /not reachable|did not respond/);
});

test('localhost.run URL parsing removes ANSI styling and understands terminal hyperlinks', () => {
  const styled = '\x1b[0mhttps://\x1b[7mbright\x1b[0m.lhr.life\x1b[0m';
  assert.equal(TunnelManager.extractSshTunnelUrl(styled), 'https://bright.lhr.life');
  const hyperlink = '\x1b]8;;https://linked.lhr.rocks\x1b\\Open tunnel\x1b]8;;\x1b\\';
  assert.equal(TunnelManager.extractSshTunnelUrl(hyperlink), 'https://linked.lhr.rocks');
  const cleaned = TunnelManager.sanitizeTerminalOutput(`\x1b[0m\x1b[7m banner\rline`);
  assert.equal(cleaned.includes('\x1b'), false);
  assert.match(cleaned, /banner\nline/);
});

test('SSH tunnel ignores the localhost.run admin link and parses a split public URL', async () => {
  const proc = fakeProcess();
  let spawnOptions;
  const manager = new TunnelManager({ spawn: (_bin, _args, options) => { spawnOptions = options; return proc; } });
  const pending = manager._startSshTunnel('site-b', 8080);
  assert.equal(spawnOptions.env.TERM, 'dumb');
  assert.equal(spawnOptions.env.NO_COLOR, '1');
  proc.stdout.emit('data', Buffer.from('Manage domains at https://admin.localhost.run/\n'));
  const early = await Promise.race([
    pending.then(() => 'resolved'),
    new Promise(resolve => setTimeout(() => resolve('pending'), 20))
  ]);
  assert.equal(early, 'pending', 'the account administration URL is not a public tunnel');
  proc.stdout.emit('data', Buffer.from('your app tunneled at https://sample.lhr.'));
  proc.stderr.emit('data', Buffer.from('life\n'));
  const result = await pending;

  assert.deepEqual(result, {
    success: true,
    url: 'https://sample.lhr.life',
    siteId: 'site-b',
    provider: 'SSH Tunnel (localhost.run)'
  });
  assert.equal(manager.getStatus('site-b').active, true);
  await manager.stopTunnel('site-b');
});

test('SSH detects a public URL before a large ANSI banner can evict it from the buffer', async () => {
  const proc = fakeProcess();
  const manager = new TunnelManager({ spawn: () => proc });
  const pending = manager._startSshTunnel('site-large-banner', 8080);
  const qrBanner = '\x1b[7m \x1b[0m'.repeat(12000);
  proc.stdout.emit('data', Buffer.from(`https://large-output.lhr.life\n${qrBanner}`));
  const result = await pending;
  assert.equal(result.success, true);
  assert.equal(result.url, 'https://large-output.lhr.life');
  await manager.stopTunnel('site-large-banner');
});

test('Cloudflare waits for both URL allocation and edge registration', async () => {
  const proc = fakeProcess();
  const manager = new TunnelManager({ spawn: () => proc });
  manager.isCloudflaredAvailable = async () => true;
  const pending = manager._startCloudflareTunnel('site-c', 8080);
  await new Promise(resolve => setImmediate(resolve));

  proc.stderr.emit('data', Buffer.from('Quick Tunnel: https://ready.trycloudflare.com\n'));
  const early = await Promise.race([
    pending.then(() => 'resolved'),
    new Promise(resolve => setTimeout(() => resolve('pending'), 20))
  ]);
  assert.equal(early, 'pending', 'URL allocation alone must not report readiness');

  proc.stderr.emit('data', Buffer.from('INF Registered tunnel connection connIndex=0\n'));
  const result = await pending;
  assert.equal(result.success, true);
  assert.equal(result.url, 'https://ready.trycloudflare.com');
  await manager.stopTunnel('site-c');
});

test('Cloudflare handles registration arriving before a split URL without crashing', async () => {
  const proc = fakeProcess();
  const manager = new TunnelManager({ spawn: () => proc });
  manager.isCloudflaredAvailable = async () => true;
  const pending = manager._startCloudflareTunnel('site-d', 8080);
  await new Promise(resolve => setImmediate(resolve));

  proc.stdout.emit('data', Buffer.from('INF Registered tunnel connection connIndex=0\nhttps://split.trycloud'));
  proc.stdout.emit('data', Buffer.from('flare.com\n'));
  const result = await pending;
  assert.equal(result.success, true);
  assert.equal(result.url, 'https://split.trycloudflare.com');
  await manager.stopTunnel('site-d');
});

test('missing ngrok returns an installable error code before token validation or spawn', async () => {
  let spawned = false;
  const manager = new TunnelManager({
    exec: (_command, callback) => setImmediate(() => callback(new Error('not found'))),
    spawn: () => { spawned = true; return fakeProcess(); }
  });
  const result = await manager._startNgrokTunnel('site-ngrok', 8080, '');
  assert.deepEqual(result, {
    success: false,
    code: 'NGROK_NOT_INSTALLED',
    error: 'ngrok is not installed.'
  });
  assert.equal(spawned, false);
  assert.equal(manager.getStatus('site-ngrok').active, false);
});

test('auto provider falls back from SSH to Cloudflare', async () => {
  const manager = new TunnelManager();
  manager.checkLocalOrigin = async () => ({ success: true });
  const calls = [];
  manager._startSshTunnel = async () => {
    calls.push('ssh');
    return { success: false, error: 'blocked' };
  };
  manager._startCloudflareTunnel = async () => {
    calls.push('cloudflare');
    return { success: true, url: 'https://fallback.trycloudflare.com' };
  };

  const result = await manager.startTunnel('site-e', 8080, { provider: 'auto' });
  assert.equal(result.success, true);
  assert.deepEqual(calls, ['ssh', 'cloudflare']);
});

test('tunnel IPC validates the site state and uses the backend-owned running port', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const handler = source.match(/ipcMain\.handle\('tunnel:start',[\s\S]*?\n\}\);/)[0];
  assert.match(handler, /siteManager\?\.getSite\(siteId\)/);
  assert.match(handler, /phpManager\?\.isRunning\(siteId\)/);
  assert.match(handler, /const runningPort = phpManager\.getPort\(siteId\)/);
  assert.match(handler, /startTunnel\(siteId, runningPort, options\)/);
  assert.doesNotMatch(handler, /startTunnel\(siteId, port, options\)/);
});
