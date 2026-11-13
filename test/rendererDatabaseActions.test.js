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

test('SQL editor renders synchronized line numbers without clipping long documents', () => {
  assert.match(renderer, /id="sql-line-number-content"/);
  assert.match(renderer, /lineNumbers\.textContent = Array\.from/);
  assert.match(renderer, /lineNumbers\.style\.transform = `translateY/);
  assert.match(renderer, /\.sql-highlight\{position:absolute;top:0;left:0;width:100%;min-height:100%;height:auto/);
  assert.match(renderer, /if \(sql\.length > 500000\) return escapeSqlHtml/);
});

test('SQL editor saves current files directly and flushes changes before close', () => {
  assert.match(renderer, /api\.sqlDocument\.write\(filePath, content\)/);
  assert.match(renderer, /api\.sqlDocument\.saveDraft\(content\)/);
  assert.match(renderer, /api\.sqlDocument\.onBeforeClose/);
  assert.match(renderer, /await flushSqlDocument\(\)/);
  assert.match(renderer, /saveSQLFile\(event\.shiftKey\)/);
});
