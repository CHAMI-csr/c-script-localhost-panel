'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PhpInstaller = require('../src/phpInstaller');

const checkDate = new Date('2026-10-24T00:00:00Z');

test('marks end-of-life PHP as critical', () => {
  const result = PhpInstaller.getPhpSecurityStatus('PHP 8.1.34', checkDate);
  assert.equal(result.status, 'eol');
  assert.equal(result.severity, 'critical');
  assert.equal(result.updateAvailable, false);
});

test('marks missing security-only patch as critical', () => {
  const result = PhpInstaller.getPhpSecurityStatus('8.2.20', checkDate);
  assert.equal(result.status, 'security-only');
  assert.equal(result.severity, 'critical');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.latestVersion, '8.2.34');
});

test('recognizes a current actively supported release', () => {
  const result = PhpInstaller.getPhpSecurityStatus('PHP 8.5.11', checkDate);
  assert.equal(result.status, 'active');
  assert.equal(result.severity, 'safe');
  assert.equal(result.updateAvailable, false);
});

test('flags unknown PHP branches for upgrade', () => {
  const result = PhpInstaller.getPhpSecurityStatus('7.4.33', checkDate);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.severity, 'critical');
});

test('extracts the newest official x64 NTS release and checksum', () => {
  const hash = 'a'.repeat(64);
  const releases = PhpInstaller.findWindowsPhpReleases({
    old: { path: 'php-8.4.25-nts-Win32-vs17-x64.zip' },
    current: { path: 'php-8.4.27-nts-Win32-vs17-x64.zip', sha256: hash },
    threadSafe: { path: 'php-8.4.99-Win32-vs17-x64.zip' }
  });
  assert.equal(releases['8.4'].version, '8.4.27');
  assert.equal(releases['8.4'].sha256, hash);
});
