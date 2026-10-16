'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const windowsConfig = packageJson.build?.win || {};
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

const failures = [];

if (windowsConfig.verifyUpdateCodeSignature !== false) {
  failures.push('build.win.verifyUpdateCodeSignature must be false while Windows releases are unsigned.');
}
if (windowsConfig.publisherName !== null) {
  failures.push('build.win.publisherName must be null so app-update.yml does not require a signer.');
}
if (!/autoUpdater\.verifyUpdateCodeSignature\s*=\s*\(\)\s*=>\s*Promise\.resolve\(null\)/.test(mainSource)) {
  failures.push('The runtime unsigned-update override is missing from main.js.');
}

if (failures.length) {
  console.error(`Unsafe updater configuration:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('Updater configuration permits the project\'s unsigned Windows releases.');
