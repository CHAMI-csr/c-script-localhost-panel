'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitSqlStatements, statementAtCursor } = require('../src/sqlStatementParser');

test('splits SQL statements without splitting quoted semicolons', () => {
  const sql = "SELECT 'first;value' AS label;\nSELECT `odd;column` FROM track;";
  assert.deepEqual(splitSqlStatements(sql).map(item => item.text), [
    "SELECT 'first;value' AS label",
    'SELECT `odd;column` FROM track'
  ]);
});

test('ignores semicolons in line and block comments', () => {
  const sql = '-- comment; stays attached\nSELECT 1; /* another; comment */\nSELECT 2 # final; comment\n;';
  assert.deepEqual(splitSqlStatements(sql).map(item => item.text), [
    '-- comment; stays attached\nSELECT 1',
    '/* another; comment */\nSELECT 2 # final; comment'
  ]);
});

test('finds the statement at the cursor or the next statement in whitespace', () => {
  const sql = 'SELECT COUNT(*) FROM track;\n\nSELECT AVG(UnitPrice) FROM track;';
  assert.equal(statementAtCursor(sql, 10).text, 'SELECT COUNT(*) FROM track');
  assert.equal(statementAtCursor(sql, sql.indexOf('AVG')).text, 'SELECT AVG(UnitPrice) FROM track');
  assert.equal(statementAtCursor(sql, sql.indexOf('\n\n') + 1).text, 'SELECT AVG(UnitPrice) FROM track');
});

test('skips comment-only input', () => {
  assert.deepEqual(splitSqlStatements('-- nothing to run;\n/* still nothing */'), []);
  assert.equal(statementAtCursor('-- nothing', 2), null);
});
