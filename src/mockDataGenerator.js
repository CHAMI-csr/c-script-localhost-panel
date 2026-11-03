'use strict';

const crypto = require('crypto');

const FIRST_NAMES = ['Amara', 'Nimal', 'Kamal', 'Saman', 'Ishara', 'Emma', 'Olivia', 'Noah', 'Liam', 'Maya'];
const LAST_NAMES = ['Perera', 'Fernando', 'Silva', 'Jayasinghe', 'Smith', 'Brown', 'Garcia', 'Wilson'];
const CITIES = ['Colombo', 'Negombo', 'Kandy', 'Galle', 'Jaffna', 'London', 'Singapore', 'Sydney'];
const COUNTRIES = ['Sri Lanka', 'India', 'Singapore', 'Australia', 'United Kingdom', 'United States'];
const DOMAINS = ['example.com', 'mail.test', 'company.test', 'demo.local'];

const pick = (items, index) => items[Math.abs(index) % items.length];
const clampText = (value, maxLength) => {
  const text = String(value);
  return maxLength && maxLength > 0 ? text.slice(0, maxLength) : text;
};

function enumValues(columnType) {
  const match = String(columnType || '').match(/^(?:enum|set)\((.*)\)$/i);
  if (!match) return [];
  const values = [];
  const regex = /'((?:[^'\\]|\\.)*)'/g;
  let item;
  while ((item = regex.exec(match[1]))) values.push(item[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
  return values;
}

function columnIntent(name) {
  const normalized = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (/^(id|.*_id)$/.test(normalized)) return 'id';
  if (/first.*name|given.*name/.test(normalized)) return 'firstName';
  if (/last.*name|family.*name|surname/.test(normalized)) return 'lastName';
  if (/full.*name|display.*name|customer.*name|user.*name|^name$|author/.test(normalized)) return 'fullName';
  if (/email|e_mail/.test(normalized)) return 'email';
  if (/phone|mobile|telephone|^tel$|whatsapp/.test(normalized)) return 'phone';
  if (/country/.test(normalized)) return 'country';
  if (/city|town/.test(normalized)) return 'city';
  if (/postal|zip/.test(normalized)) return 'postalCode';
  if (/address/.test(normalized)) return 'address';
  if (/url|website|link/.test(normalized)) return 'url';
  if (/slug/.test(normalized)) return 'slug';
  if (/user.*name|login/.test(normalized)) return 'username';
  if (/password|passwd|pass_hash/.test(normalized)) return 'password';
  if (/token|api_key|secret/.test(normalized)) return 'token';
  if (/uuid|guid/.test(normalized)) return 'uuid';
  if (/ip_address|^ip$/.test(normalized)) return 'ip';
  if (/price|amount|total|cost|salary|balance/.test(normalized)) return 'money';
  if (/percentage|percent|rate/.test(normalized)) return 'percentage';
  if (/age/.test(normalized)) return 'age';
  if (/quantity|qty|stock|count/.test(normalized)) return 'quantity';
  if (/status|state/.test(normalized)) return 'status';
  if (/title|subject|headline/.test(normalized)) return 'title';
  if (/description|summary|content|body|message|notes?/.test(normalized)) return 'paragraph';
  if (/created|updated|deleted|published|date|time|_at$/.test(normalized)) return 'dateTime';
  if (/active|enabled|verified|visible|published|deleted|flag|^is_|^has_/.test(normalized)) return 'boolean';
  return 'generic';
}

function uuidFor(index) {
  const hex = crypto.createHash('sha256').update(`c-script-mock-${index}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function semanticValue(column, rowIndex, context = {}) {
  const name = column.field || column.name || '';
  const type = String(column.type || column.columnType || '').toLowerCase();
  const dataType = String(column.dataType || type.split('(')[0]).toLowerCase();
  const intent = columnIntent(name);
  const uniqueIndex = Number(context.seed || 0) + rowIndex + 1;
  const firstName = pick(FIRST_NAMES, uniqueIndex);
  const lastName = pick(LAST_NAMES, uniqueIndex * 3);
  const maxLength = Number(column.maxLength || (type.match(/(?:char|binary)\((\d+)\)/)?.[1])) || null;
  const choices = enumValues(type);

  if (context.foreignValues?.length) return pick(context.foreignValues, uniqueIndex);
  if (choices.length) {
    if (dataType === 'set') return pick(choices, uniqueIndex);
    return pick(choices, uniqueIndex);
  }

  if (intent === 'uuid') return clampText(uuidFor(uniqueIndex), maxLength);
  if (intent === 'firstName') return clampText(firstName, maxLength);
  if (intent === 'lastName') return clampText(lastName, maxLength);
  if (intent === 'fullName') return clampText(`${firstName} ${lastName}`, maxLength);
  if (intent === 'email') return clampText(`${firstName}.${lastName}.${uniqueIndex}@${pick(DOMAINS, uniqueIndex)}`.toLowerCase(), maxLength);
  if (intent === 'phone') return clampText(`+94 7${uniqueIndex % 10} ${String(1000000 + (uniqueIndex * 7919) % 8999999)}`, maxLength);
  if (intent === 'country') return clampText(pick(COUNTRIES, uniqueIndex), maxLength);
  if (intent === 'city') return clampText(pick(CITIES, uniqueIndex), maxLength);
  if (intent === 'postalCode') return clampText(String(10000 + uniqueIndex % 89999), maxLength);
  if (intent === 'address') return clampText(`${10 + uniqueIndex} ${pick(['Main Road', 'Lake Road', 'Station Road', 'Beach Road'], uniqueIndex)}, ${pick(CITIES, uniqueIndex)}`, maxLength);
  if (intent === 'url') return clampText(`https://${pick(DOMAINS, uniqueIndex)}/items/${uniqueIndex}`, maxLength);
  if (intent === 'slug') return clampText(`sample-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${uniqueIndex}`, maxLength);
  if (intent === 'username') return clampText(`${firstName}.${lastName}${uniqueIndex}`.toLowerCase(), maxLength);
  if (intent === 'password') return clampText('$2y$10$C.ScriptMockHashForDevelopmentOnly12345678901234567890', maxLength);
  if (intent === 'token') return clampText(crypto.createHash('sha256').update(`${name}-${uniqueIndex}`).digest('hex'), maxLength);
  if (intent === 'ip') return clampText(`192.0.2.${1 + uniqueIndex % 253}`, maxLength);
  if (intent === 'status') return clampText(pick(['active', 'pending', 'completed', 'inactive'], uniqueIndex), maxLength);
  if (intent === 'title') return clampText(`Sample ${String(name).replace(/_/g, ' ')} ${uniqueIndex}`, maxLength);
  if (intent === 'paragraph') return clampText(`Realistic sample ${String(name).replace(/_/g, ' ')} for record ${uniqueIndex}. Replace this development-only mock value before production use.`, maxLength);

  if (['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint'].includes(dataType)) {
    if (intent === 'boolean' || /tinyint\(1\)/.test(type)) return uniqueIndex % 2;
    if (intent === 'age') return 18 + uniqueIndex % 63;
    if (intent === 'quantity') return 1 + uniqueIndex % 100;
    if (intent === 'money') return 100 + uniqueIndex * 25;
    if (intent === 'percentage') return uniqueIndex % 101;
    return uniqueIndex;
  }
  if (['decimal', 'numeric', 'float', 'double', 'real'].includes(dataType)) {
    if (intent === 'percentage') return Number((uniqueIndex % 101).toFixed(2));
    return Number((10 + (uniqueIndex * 13.37) % 9990).toFixed(Math.min(Number(column.scale) || 2, 6)));
  }
  if (dataType === 'year') return 2020 + uniqueIndex % 7;
  if (dataType === 'date') return new Date(Date.now() - (uniqueIndex % 365) * 86400000).toISOString().slice(0, 10);
  if (dataType === 'time') return `${String(uniqueIndex % 24).padStart(2, '0')}:${String(uniqueIndex % 60).padStart(2, '0')}:00`;
  if (['datetime', 'timestamp'].includes(dataType) || intent === 'dateTime') return new Date(Date.now() - (uniqueIndex % 365) * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  if (dataType === 'json') return JSON.stringify({ mock: true, index: uniqueIndex, label: `${firstName} ${lastName}` });
  if (['blob', 'tinyblob', 'mediumblob', 'longblob', 'binary', 'varbinary'].includes(dataType)) return Buffer.from(`mock-${uniqueIndex}`);
  if (dataType === 'bit' || intent === 'boolean') return uniqueIndex % 2;
  if (intent === 'money') return Number((100 + uniqueIndex * 12.5).toFixed(2));
  if (intent === 'percentage') return uniqueIndex % 101;

  return clampText(`Sample ${String(name).replace(/_/g, ' ')} ${uniqueIndex}`, maxLength);
}

function shouldSkipColumn(column) {
  const extra = String(column.extra || '').toLowerCase();
  return extra.includes('auto_increment') || extra.includes('generated') || extra.includes('default_generated');
}

function generateRows(columns, count, options = {}) {
  const rows = [];
  const foreignValues = options.foreignValues || {};
  for (let index = 0; index < count; index++) {
    const row = {};
    for (const column of columns) {
      if (shouldSkipColumn(column)) continue;
      const dataType = String(column.dataType || column.type || '').toLowerCase().split('(')[0];
      if (['geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection'].includes(dataType)) {
        if (column.nullable === 'YES') { row[column.field] = null; continue; }
        throw new Error(`Cannot safely generate required spatial column ${column.field}. Make it nullable or provide a default.`);
      }
      const fkValues = foreignValues[column.field];
      if (Array.isArray(fkValues) && fkValues.length === 0) {
        if (column.nullable === 'YES') { row[column.field] = null; continue; }
        throw new Error(`Cannot generate ${column.field}: its referenced table has no rows.`);
      }
      row[column.field] = semanticValue(column, index, {
        seed: options.seed || 0,
        foreignValues: fkValues
      });
    }
    rows.push(row);
  }
  return rows;
}

module.exports = { columnIntent, enumValues, generateRows, semanticValue, shouldSkipColumn };
