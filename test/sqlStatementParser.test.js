'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitSqlStatements, statementAtCursor, extractSqlTableReferences, toggleSqlLineComments } = require('../src/sqlStatementParser');

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

test('supports mysql DELIMITER blocks without emitting client directives', () => {
  const sql = `DELIMITER $$
CREATE PROCEDURE count_tracks()
BEGIN
  SELECT COUNT(*) FROM track;
  SELECT 'semi;colon';
END$$
DELIMITER ;
CALL count_tracks();`;
  assert.deepEqual(splitSqlStatements(sql).map(item => item.text), [
    "CREATE PROCEDURE count_tracks()\nBEGIN\n  SELECT COUNT(*) FROM track;\n  SELECT 'semi;colon';\nEND",
    'CALL count_tracks()'
  ]);
  assert.match(statementAtCursor(sql, sql.indexOf('COUNT')).text, /^CREATE PROCEDURE/);
});

test('extracts tables, databases, and aliases without matching literals or comments', () => {
  const sql = `SELECT a.Title, t.Name
FROM music.album AS a
JOIN \`track\` t ON t.AlbumId = a.AlbumId
WHERE a.Note = 'FROM fake_table f' AND a.OtherNote = "JOIN another_fake x"
-- JOIN ignored_table i
UPDATE inventory SET count = count - 1;`;
  assert.deepEqual(extractSqlTableReferences(sql), [
    { database: 'music', table: 'album', alias: 'a' },
    { database: '', table: 'track', alias: 't' },
    { database: '', table: 'inventory', alias: '' }
  ]);
});

test('extracts outer and nested aliases for the same table', () => {
  const sql = `SELECT E1.EmployeeId, E1.FirstName, E1.LastName, E1.Title, E1.BirthDate
FROM employee E1
WHERE E1.BirthDate < (
  SELECT AVG(E2.BirthDate)
  FROM employee E2
  WHERE E2.Title = E1.Title
);`;
  assert.deepEqual(extractSqlTableReferences(sql), [
    { database: '', table: 'employee', alias: 'E1' },
    { database: '', table: 'employee', alias: 'E2' }
  ]);
});

test('does not mistake SQL clauses for table aliases', () => {
  assert.deepEqual(extractSqlTableReferences('SELECT * FROM track WHERE id = 1'), [
    { database: '', table: 'track', alias: '' }
  ]);
});

test('toggles SQL line comments while preserving indentation and blank lines', () => {
  const source = 'SELECT *\n  FROM track\n\nWHERE id = 1';
  const commented = toggleSqlLineComments(source);
  assert.equal(commented.uncommented, false);
  assert.equal(commented.text, '-- SELECT *\n  -- FROM track\n\n-- WHERE id = 1');
  const restored = toggleSqlLineComments(commented.text);
  assert.equal(restored.uncommented, true);
  assert.equal(restored.text, source);
});

test('skips comment-only input', () => {
  assert.deepEqual(splitSqlStatements('-- nothing to run;\n/* still nothing */'), []);
  assert.equal(statementAtCursor('-- nothing', 2), null);
});
