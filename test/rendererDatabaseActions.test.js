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

test('accepting SQL autocomplete closes it without an async request reopening it', () => {
  assert.match(renderer, /let sqlCompletionUpdateRequest = 0;/);
  assert.match(renderer, /suppressSqlCompletionOnce = true;[\s\S]*hideSqlCompletions\(\);[\s\S]*dispatchEvent\(new Event\('input'/);
  assert.match(renderer, /function hideSqlCompletions\(\)\s*{[\s\S]*sqlCompletionUpdateRequest\+\+/);
  assert.match(renderer, /if \(updateRequest !== sqlCompletionUpdateRequest\) return;/);
});

test('SQL autocomplete resolves explicit aliases before same-named tables', () => {
  const aliasLookup = renderer.indexOf('const aliasReference = references.find');
  const tableLookup = renderer.indexOf('const actualTable = sqlSchemaCache.tables.find', aliasLookup);
  assert.ok(aliasLookup > 0 && tableLookup > aliasLookup);
});
