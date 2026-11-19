'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const NgrokInstaller = require('../src/ngrokInstaller');

function temporaryAppData(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cscript-ngrok-test-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function versionExec(_file, args, _options, callback) {
  assert.deepEqual(args, ['version']);
  callback(null, 'ngrok version 3.33.0\n', '');
}

test('installs and verifies ngrok in the app-owned bin directory', async t => {
  const appData = temporaryAppData(t);
  const installer = new NgrokInstaller({ appData, execFile: versionExec });
  const stages = [];
  installer.on('install-status', event => stages.push(event.stage));
  installer._downloadFile = async (_url, destination) => fs.writeFileSync(destination, 'zip');
  installer._extractZip = async (_zip, destination) => {
    fs.mkdirSync(path.join(destination, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(destination, 'nested', 'ngrok.exe'), Buffer.from('MZmock executable'));
  };

  const result = await installer.downloadAndInstall();
  assert.equal(result.success, true);
  assert.equal(result.version, '3.33.0');
  assert.equal(result.exePath, path.join(appData, 'c-script-localhost', 'bin', 'ngrok.exe'));
  assert.equal(fs.existsSync(result.exePath), true);
  assert.deepEqual(stages, ['downloading', 'extracting', 'completed']);
  assert.deepEqual(await installer.getInfo(), {
    installed: true,
    managed: true,
    version: '3.33.0',
    exePath: result.exePath,
    binDir: path.dirname(result.exePath),
    downloadUrl: NgrokInstaller.DOWNLOAD_URL
  });
});

test('deduplicates concurrent ngrok installation requests', async t => {
  const appData = temporaryAppData(t);
  const installer = new NgrokInstaller({ appData, execFile: versionExec });
  let downloads = 0;
  installer._downloadFile = async (_url, destination) => {
    downloads++;
    await new Promise(resolve => setTimeout(resolve, 10));
    fs.writeFileSync(destination, 'zip');
  };
  installer._extractZip = async (_zip, destination) => {
    fs.writeFileSync(path.join(destination, 'ngrok.exe'), Buffer.from('MZmock executable'));
  };

  const [first, second] = await Promise.all([installer.downloadAndInstall(), installer.downloadAndInstall()]);
  assert.equal(first.success, true);
  assert.deepEqual(second, first);
  assert.equal(downloads, 1);
});

test('rejects an invalid download without replacing an existing ngrok executable', async t => {
  const appData = temporaryAppData(t);
  const installer = new NgrokInstaller({ appData, execFile: versionExec });
  fs.mkdirSync(installer.binDir, { recursive: true });
  fs.writeFileSync(installer.exePath, Buffer.from('MZexisting'));
  installer._downloadFile = async (_url, destination) => fs.writeFileSync(destination, 'zip');
  installer._extractZip = async (_zip, destination) => {
    fs.writeFileSync(path.join(destination, 'ngrok.exe'), Buffer.from('not a Windows executable'));
  };

  const result = await installer.downloadAndInstall();
  assert.equal(result.success, false);
  assert.match(result.error, /invalid/);
  assert.deepEqual(fs.readFileSync(installer.exePath), Buffer.from('MZexisting'));
});

test('renderer offers first-use installation and exposes the same installer in Settings', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(renderer, /res\?\.code === 'NGROK_NOT_INSTALLED'/);
  assert.match(renderer, /Do you want C-Script LocalHost Panel to download and install the official ngrok client now\?/);
  assert.match(renderer, /id="btn-install-ngrok" onclick="installNgrokAction\(\)"/);
  assert.match(renderer, /await api\.ngrok\.install\(\)/);
});
