'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { columnIntent, enumValues, generateRows } = require('../src/mockDataGenerator');

test('detects specific name fields before generic name fields', () => {
  assert.equal(columnIntent('first_name'), 'firstName');
  assert.equal(columnIntent('last_name'), 'lastName');
  assert.equal(columnIntent('customer_name'), 'fullName');
});

test('parses enum values and generates a valid enum option', () => {
  assert.deepEqual(enumValues("enum('draft','active','archived')"), ['draft', 'active', 'archived']);
  const [row] = generateRows([{ field: 'status', type: "enum('draft','active')", dataType: 'enum', nullable: 'NO' }], 1);
  assert.ok(['draft', 'active'].includes(row.status));
});

test('honors auto increment, varchar lengths, json, dates and booleans', () => {
  const [row] = generateRows([
    { field: 'id', type: 'bigint unsigned', dataType: 'bigint', extra: 'auto_increment', nullable: 'NO' },
    { field: 'first_name', type: 'varchar(5)', dataType: 'varchar', maxLength: 5, nullable: 'NO' },
    { field: 'metadata', type: 'json', dataType: 'json', nullable: 'NO' },
    { field: 'created_at', type: 'timestamp', dataType: 'timestamp', nullable: 'NO' },
    { field: 'is_active', type: 'tinyint(1)', dataType: 'tinyint', nullable: 'NO' }
  ], 1, { seed: 10 });
  assert.equal('id' in row, false);
  assert.ok(row.first_name.length <= 5);
  assert.equal(JSON.parse(row.metadata).mock, true);
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.ok(row.is_active === 0 || row.is_active === 1);
});

test('uses existing referenced values for foreign keys', () => {
  const rows = generateRows([
    { field: 'user_id', type: 'bigint', dataType: 'bigint', nullable: 'NO' }
  ], 3, { foreignValues: { user_id: [7, 11] } });
  assert.ok(rows.every(row => row.user_id === 7 || row.user_id === 11));
});

test('rejects required foreign keys when the parent table is empty', () => {
  assert.throws(() => generateRows([
    { field: 'user_id', type: 'bigint', dataType: 'bigint', nullable: 'NO' }
  ], 1, { foreignValues: { user_id: [] } }), /referenced table has no rows/);
});
