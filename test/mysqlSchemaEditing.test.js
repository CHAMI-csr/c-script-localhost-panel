'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MySQLManager = require('../src/mysqlManager');

function connectionWithQueries(handler) {
  return { query: handler, escape: value => `'${String(value).replace(/'/g, "''")}'` };
}

test('column editing can replace an ordinary index with a unique key and move the column', async () => {
  const manager = new MySQLManager();
  const calls = [];
  manager.connection = connectionWithQueries(async (sql, params) => {
    calls.push([sql, params]);
    if (/information_schema\.STATISTICS/.test(sql)) {
      return [[{ name: 'idx_email', non_unique: 1, column_name: 'email', seq: 1 }]];
    }
    return [{ affectedRows: 0 }];
  });

  const result = await manager.modifyTableColumn('app', 'users', 'email', {
    name: 'email_address', type: 'VARCHAR', length: '255', nullable: false,
    defaultMode: 'none', autoIncrement: false, comment: 'Login email',
    key: 'unique', position: 'id'
  });

  assert.deepEqual(result, { success: true });
  const alter = calls[1][0];
  assert.match(alter, /CHANGE COLUMN `email` `email_address` VARCHAR\(255\) NOT NULL/);
  assert.match(alter, /COMMENT 'Login email' AFTER `id`/);
  assert.match(alter, /DROP INDEX `idx_email`/);
  assert.match(alter, /ADD UNIQUE INDEX `uq_email_address` \(`email_address`\)/);
});

test('column editing refuses to silently destroy a composite index', async () => {
  const manager = new MySQLManager();
  manager.connection = connectionWithQueries(async sql => {
    if (/information_schema\.STATISTICS/.test(sql)) return [[
      { name: 'idx_name', non_unique: 1, column_name: 'first_name', seq: 1 },
      { name: 'idx_name', non_unique: 1, column_name: 'last_name', seq: 2 }
    ]];
    throw new Error('ALTER should not run');
  });
  const result = await manager.modifyTableColumn('app', 'users', 'first_name', {
    name: 'first_name', type: 'VARCHAR', length: '100', nullable: true,
    key: 'none', position: '__FIRST__'
  });
  assert.equal(result.success, false);
  assert.match(result.error, /composite index/i);
});

test('index deletion uses the correct primary and named-index syntax', async () => {
  const manager = new MySQLManager();
  const sql = [];
  manager.connection = connectionWithQueries(async statement => { sql.push(statement); return [{}]; });
  assert.deepEqual(await manager.dropTableIndex('app', 'users', 'PRIMARY'), { success: true });
  assert.deepEqual(await manager.dropTableIndex('app', 'users', 'idx_email'), { success: true });
  assert.equal(sql[0], 'ALTER TABLE `app`.`users` DROP PRIMARY KEY');
  assert.equal(sql[1], 'ALTER TABLE `app`.`users` DROP INDEX `idx_email`');
});

test('drop resolves views separately from base tables', async () => {
  const manager = new MySQLManager();
  const sql = [];
  manager.connection = connectionWithQueries(async (statement, params) => {
    sql.push(statement);
    if (/information_schema\.TABLES/.test(statement)) return [[{ type: 'VIEW' }]];
    return [{}];
  });
  assert.deepEqual(await manager.dropTable('app', 'active_users'), { success: true, objectType: 'view' });
  assert.equal(sql[1], 'DROP VIEW `app`.`active_users`');
});

test('database rename creates a matching schema, atomically moves tables, then drops the old schema', async () => {
  const manager = new MySQLManager();
  const sql = [];
  manager.connection = connectionWithQueries(async (statement, params) => {
    sql.push(statement);
    if (/FROM information_schema\.SCHEMATA WHERE SCHEMA_NAME/.test(statement)) {
      return params[0] === 'old_db'
        ? [[{ charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' }]]
        : [[]];
    }
    if (/FROM information_schema\.TABLES/.test(statement)) return [[
      { name: 'users', type: 'BASE TABLE' }, { name: 'orders', type: 'BASE TABLE' }
    ]];
    if (/FROM information_schema\.(TRIGGERS|ROUTINES)/.test(statement)) return [[]];
    return [{}];
  });

  assert.deepEqual(await manager.renameDatabase('old_db', 'new_db'), { success: true });
  assert.ok(sql.includes('CREATE DATABASE `new_db` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'));
  assert.ok(sql.includes('RENAME TABLE `old_db`.`users` TO `new_db`.`users`, `old_db`.`orders` TO `new_db`.`orders`'));
  assert.equal(sql.at(-1), 'DROP DATABASE `old_db`');
});

test('database rename blocks views instead of risking a partial migration', async () => {
  const manager = new MySQLManager();
  manager.connection = connectionWithQueries(async (statement, params) => {
    if (/FROM information_schema\.SCHEMATA WHERE SCHEMA_NAME/.test(statement)) {
      return params[0] === 'old_db' ? [[{ charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' }]] : [[]];
    }
    if (/FROM information_schema\.TABLES/.test(statement)) return [[{ name: 'report', type: 'VIEW' }]];
    if (/FROM information_schema\.(TRIGGERS|ROUTINES)/.test(statement)) return [[]];
    throw new Error('Database should not be created');
  });
  const result = await manager.renameDatabase('old_db', 'new_db');
  assert.equal(result.success, false);
  assert.match(result.error, /views cannot be safely renamed/i);
});
