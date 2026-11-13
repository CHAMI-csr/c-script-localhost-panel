'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  writeSqlDocument,
  saveSqlDraft,
  loadSqlDraft,
  clearSqlDraft
} = require('../src/sqlDocumentStore');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cscript-sql-doc-'));
}

test('writes an existing SQL document directly, including empty content', () => {
  const directory = temporaryDirectory();
  try {
    const filePath = path.join(directory, 'query.sql');
    assert.deepEqual(writeSqlDocument(filePath, 'SELECT 1;'), { success: true, filePath });
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'SELECT 1;');
    assert.deepEqual(writeSqlDocument(filePath, ''), { success: true, filePath });
    assert.equal(fs.readFileSync(filePath, 'utf8'), '');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects relative document paths', () => {
  const result = writeSqlDocument('relative-query.sql', 'SELECT 1;');
  assert.equal(result.success, false);
  assert.match(result.error, /absolute SQL file path/i);
});

test('atomically saves, restores, and clears the SQL recovery draft', () => {
  const directory = temporaryDirectory();
  try {
    assert.equal(saveSqlDraft(directory, 'SELECT *\nFROM employee;').success, true);
    const restored = loadSqlDraft(directory);
    assert.equal(restored.success, true);
    assert.equal(restored.content, 'SELECT *\nFROM employee;');
    assert.match(restored.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(clearSqlDraft(directory), { success: true });
    assert.deepEqual(loadSqlDraft(directory), { success: true, content: '', updatedAt: null });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('window close waits for renderer SQL persistence acknowledgement', () => {
  assert.match(mainSource, /mainWindow\.webContents\.send\('app:before-close'/);
  assert.match(mainSource, /ipcMain\.handle\('app:close-ready'/);
  assert.match(mainSource, /rendererCloseApproved = true;[\s\S]*mainWindow\?\.close\(\)/);
  assert.match(preloadSource, /onBeforeClose: \(callback\)/);
  assert.match(preloadSource, /closeReady: \(result\) => ipcRenderer\.invoke\('app:close-ready'/);
});
