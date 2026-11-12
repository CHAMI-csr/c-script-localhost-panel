'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

test('database and table rename use an Electron-compatible modal instead of window.prompt', () => {
  assert.match(renderer, /id="modal-rename-db-object"/);
  assert.match(renderer, /function renameDatabaseAction\(oldName\)\s*{\s*openDbObjectRenameModal\('database'/);
  assert.match(renderer, /function renameTableAction\(database, oldName\)\s*{\s*openDbObjectRenameModal\('table'/);
  assert.doesNotMatch(renderer, /const newName = prompt\(/);
});

test('rename modal supports keyboard submission and invokes both rename APIs', () => {
  assert.match(renderer, /event\.key==='Enter'\)submitRenameDbObject\(\)/);
  assert.match(renderer, /api\.mysql\.renameDb\(request\.oldName, newName\)/);
  assert.match(renderer, /api\.mysql\.renameTable\(request\.database, request\.oldName, newName\)/);
});
