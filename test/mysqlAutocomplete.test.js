'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MySQLManager = require('../src/mysqlManager');

test('loads the database column index with a parameterized schema query', async () => {
  const manager = new MySQLManager();
  const expected = [
    { table_name: 'album', name: 'AlbumId', data_type: 'int', key_type: 'PRI', ordinal_position: 1 },
    { table_name: 'album', name: 'Title', data_type: 'varchar', key_type: '', ordinal_position: 2 }
  ];
  manager.connection = {
    query: async (sql, params) => {
      assert.match(sql, /information_schema\.COLUMNS/);
      assert.match(sql, /TABLE_SCHEMA = \?/);
      assert.deepEqual(params, ['chinook']);
      return [expected];
    }
  };

  assert.deepEqual(await manager.getDatabaseColumns('chinook'), { success: true, columns: expected });
});

test('database column index reports disconnected state', async () => {
  const manager = new MySQLManager();
  assert.deepEqual(await manager.getDatabaseColumns('chinook'), { success: false, error: 'Not connected' });
});
