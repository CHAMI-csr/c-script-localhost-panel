/**
 * MySQLManager - Full-featured MySQL connection & query manager
 * Uses query() instead of execute() to avoid prepared statement protocol issues
 */

const fs = require('fs');
const { once } = require('events');

const SYSTEM_DBS = ['information_schema', 'performance_schema', 'sys', 'mysql'];
const quoteIdent = (value) => `\`${String(value).replace(/`/g, '``')}\``;

class MySQLManager {
  constructor() {
    this.connection = null;
    this.config = null;
    this.connected = false;
    this.mysql2 = null;
  }

  _loadMysql2() {
    if (!this.mysql2) {
      try { this.mysql2 = require('mysql2/promise'); }
      catch (e) { throw new Error('mysql2 not installed. Run: npm install mysql2'); }
    }
    return this.mysql2;
  }

  /** Connect to MySQL server */
  async connect(config) {
    try {
      const mysql2 = this._loadMysql2();
      if (this.connection) await this.disconnect();
      this.config = { ...config };
      this.connection = await mysql2.createConnection({
        host: config.host || '127.0.0.1',
        port: parseInt(config.port) || 3306,
        user: config.user || 'root',
        password: config.password || '',
        connectTimeout: 10000,
        multipleStatements: true
      });
      // Use query() (not execute) - avoids prepared statement protocol issues
      await this.connection.query('SELECT 1');
      this.connected = true;
      const [[vRow]] = await this.connection.query('SELECT VERSION() as v, USER() as u, @@hostname as h');
      return { success: true, version: vRow.v, user: vRow.u, host: vRow.h };
    } catch (err) {
      this.connection = null;
      this.connected = false;
      return { success: false, error: this._fmtErr(err) };
    }
  }

  async disconnect() {
    if (this.connection) {
      try { await this.connection.end(); } catch (e) {}
      this.connection = null;
      this.connected = false;
    }
    return { success: true };
  }

  getStatus() {
    return { connected: this.connected, host: this.config?.host, port: this.config?.port, user: this.config?.user };
  }

  /** List all databases */
  async getDatabases() {
    if (!this.connection) return { success: false, error: 'Not connected' };
    try {
      const [rows] = await this.connection.query(
        `SELECT SCHEMA_NAME as name,
                DEFAULT_CHARACTER_SET_NAME as charset,
                DEFAULT_COLLATION_NAME as collation
         FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME`
      );
      return {
        success: true,
        databases: rows.filter(r => !SYSTEM_DBS.includes(r.name)),
        systemDatabases: rows.filter(r => SYSTEM_DBS.includes(r.name))
      };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  /** List tables in a database with size + row info */
  async getTables(database) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    try {
      const [rows] = await this.connection.query(
        `SELECT TABLE_NAME as name,
                TABLE_ROWS as rowCount,
                ENGINE as engine,
                TABLE_TYPE as type,
                ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024, 1) as sizeKB,
                TABLE_COMMENT as comment
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ?
         ORDER BY TABLE_TYPE, TABLE_NAME`,
        [database]
      );
      return { success: true, tables: rows };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  /** Full table structure: columns + indexes + foreign keys */
  async getTableStructure(database, table) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    try {
      const [columns] = await this.connection.query(
        `SELECT COLUMN_NAME as field,
                COLUMN_TYPE as type,
                IS_NULLABLE as nullable,
                COLUMN_KEY as key_type,
                COLUMN_DEFAULT as def,
                EXTRA as extra,
                COLUMN_COMMENT as comment,
                CHARACTER_SET_NAME as charset
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [database, table]
      );
      const [indexes] = await this.connection.query(
        `SELECT INDEX_NAME as name,
                NON_UNIQUE as nonUnique,
                COLUMN_NAME as column_name,
                INDEX_TYPE as type,
                SEQ_IN_INDEX as seq
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        [database, table]
      );
      const [fks] = await this.connection.query(
        `SELECT CONSTRAINT_NAME as name,
                COLUMN_NAME as column_name,
                REFERENCED_TABLE_NAME as ref_table,
                REFERENCED_COLUMN_NAME as ref_column
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [database, table]
      );
      return { success: true, columns, indexes, foreignKeys: fks };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  /** Table metadata: engine, size, rows, charset, dates */
  async getTableInfo(database, table) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    try {
      const [rows] = await this.connection.query(
        `SELECT TABLE_NAME, ENGINE, TABLE_ROWS,
                ROUND(DATA_LENGTH / 1024 / 1024, 3) as dataMB,
                ROUND(INDEX_LENGTH / 1024 / 1024, 3) as indexMB,
                ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 3) as totalMB,
                AUTO_INCREMENT, TABLE_COLLATION,
                CREATE_TIME, UPDATE_TIME, TABLE_COMMENT
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [database, table]
      );
      return { success: true, info: rows[0] || {} };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  /** Database-level info: total size, table count, charset */
  async getDatabaseInfo(database) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    try {
      const [[sizes]] = await this.connection.query(
        `SELECT COUNT(*) as tableCount,
                SUM(TABLE_ROWS) as totalRows,
                ROUND(SUM(DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2) as totalMB
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
        [database]
      );
      const [[schema]] = await this.connection.query(
        `SELECT DEFAULT_CHARACTER_SET_NAME as charset, DEFAULT_COLLATION_NAME as collation
         FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`,
        [database]
      );
      return { success: true, ...sizes, ...schema };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  /** Get paginated table data */
  async getTableData(database, table, limit = 50, offset = 0) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    try {
      const safeLimit = Math.max(1, Math.min(1000, parseInt(limit, 10) || 50));
      const safeOffset = Math.max(0, parseInt(offset, 10) || 0);
      const [rows] = await this.connection.query(
        `SELECT * FROM ${quoteIdent(database)}.${quoteIdent(table)} LIMIT ? OFFSET ?`,
        [safeLimit, safeOffset]
      );
      const [[{ total }]] = await this.connection.query(
        `SELECT COUNT(*) as total FROM ${quoteIdent(database)}.${quoteIdent(table)}`
      );
      return { success: true, data: rows, total, fields: rows.length ? Object.keys(rows[0]).map(n => ({ name: n })) : [] };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  async updateTableRow(database, table, primary, changes) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    if (!primary || !Object.keys(primary).length) return { success: false, error: 'This table has no primary key; row editing is disabled to avoid changing the wrong row.' };
    if (!changes || !Object.keys(changes).length) return { success: false, error: 'No values to update' };
    try {
      const [keys] = await this.connection.query(
        `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND CONSTRAINT_NAME='PRIMARY'`,
        [database, table]
      );
      const allowedKeys = new Set(keys.map(row => row.COLUMN_NAME));
      const [columns] = await this.connection.query(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
        [database, table]
      );
      const allowedColumns = new Set(columns.map(row => row.COLUMN_NAME));
      const keyNames = Object.keys(primary);
      if (!keyNames.length || keyNames.length !== allowedKeys.size || keyNames.some(key => !allowedKeys.has(key))) return { success: false, error: 'Provide every primary key column for this table' };
      const setNames = Object.keys(changes);
      if (setNames.some(column => !allowedColumns.has(column) || allowedKeys.has(column))) return { success: false, error: 'Invalid update column' };
      const where = keyNames.map(key => primary[key] == null ? `${quoteIdent(key)} IS NULL` : `${quoteIdent(key)} = ?`);
      const values = [...setNames.map(key => changes[key]), ...keyNames.filter(key => primary[key] != null).map(key => primary[key])];
      const [result] = await this.connection.query(
        `UPDATE ${quoteIdent(database)}.${quoteIdent(table)} SET ${setNames.map(key => `${quoteIdent(key)} = ?`).join(', ')} WHERE ${where.join(' AND ')}`,
        values
      );
      return { success: true, affectedRows: result.affectedRows };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  async insertTableRow(database, table, values) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    if (!values) return { success: false, error: 'Invalid row values' };
    try {
      const [columns] = await this.connection.query(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
        [database, table]
      );
      const allowed = new Set(columns.map(row => row.COLUMN_NAME));
      const names = Object.keys(values);
      if (names.some(column => !allowed.has(column))) return { success: false, error: 'Invalid insert column' };
      const sql = names.length
        ? `INSERT INTO ${quoteIdent(database)}.${quoteIdent(table)} (${names.map(quoteIdent).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`
        : `INSERT INTO ${quoteIdent(database)}.${quoteIdent(table)} () VALUES ()`;
      const [result] = await this.connection.query(sql, names.map(column => values[column]));
      return { success: true, insertId: result.insertId, affectedRows: result.affectedRows };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  async deleteTableRow(database, table, primary) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    if (!primary || !Object.keys(primary).length) return { success: false, error: 'This table has no primary key; row deletion is disabled to avoid deleting the wrong row.' };
    try {
      const [keys] = await this.connection.query(
        `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND CONSTRAINT_NAME='PRIMARY'`,
        [database, table]
      );
      const allowedKeys = new Set(keys.map(row => row.COLUMN_NAME));
      const keyNames = Object.keys(primary);
      if (!keyNames.length || keyNames.length !== allowedKeys.size || keyNames.some(key => !allowedKeys.has(key))) return { success: false, error: 'Provide every primary key column for this table' };
      const where = keyNames.map(key => primary[key] == null ? `${quoteIdent(key)} IS NULL` : `${quoteIdent(key)} = ?`);
      const values = keyNames.filter(key => primary[key] != null).map(key => primary[key]);
      const [result] = await this.connection.query(
        `DELETE FROM ${quoteIdent(database)}.${quoteIdent(table)} WHERE ${where.join(' AND ')}`,
        values
      );
      return { success: true, affectedRows: result.affectedRows };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  /** Run any user SQL query - uses query() not execute() for compatibility */
  async runQuery(database, sql) {
    if (!this.connection) return { success: false, error: 'Not connected to MySQL' };
    const start = Date.now();
    try {
      if (database) {
        await this.connection.query(`USE ${quoteIdent(database)}`);
      }
      // Use query() - not execute() - to support SHOW, DESCRIBE, CALL, and all SQL
      let [result, fields] = await this.connection.query(sql);
      const multiStatementResult = Array.isArray(result) && (
        result.some(Array.isArray) ||
        (Array.isArray(fields) && fields.length === result.length && fields.some(field => field == null || Array.isArray(field)))
      );
      if (multiStatementResult) {
        let selected = -1;
        for (let i = result.length - 1; i >= 0; i--) {
          if (Array.isArray(result[i]) && Array.isArray(fields?.[i]) && fields[i].length) { selected = i; break; }
        }
        if (selected >= 0) {
          result = result[selected];
          fields = fields[selected];
        } else {
          result = result[result.length - 1];
          fields = undefined;
        }
      }
      const elapsed = Date.now() - start;
      if (Array.isArray(result)) {
        return {
          success: true, data: result, elapsed,
          fields: fields ? fields.map(f => ({ name: f.name })) : Object.keys(result[0] || {}).map(n => ({ name: n })),
          rowCount: result.length
        };
      }
      return { success: true, data: [], fields: [], affectedRows: result.affectedRows, insertId: result.insertId, rowCount: 0, elapsed };
    } catch (err) {
      return { success: false, error: this._fmtErr(err), elapsed: Date.now() - start };
    }
  }

  async runScript(sql) {
    if (!this.connection) return { success: false, error: 'Not connected to MySQL' };
    if (typeof sql !== 'string' || !sql.trim()) return { success: false, error: 'The SQL file is empty' };
    try {
      const [results] = await this.connection.query(sql);
      try { await this.connection.query('SET FOREIGN_KEY_CHECKS=1'); } catch (restoreError) {}
      const items = sql.split(';').map(statement => statement.trim()).filter(Boolean);
      return {
        success: true,
        statements: items.length,
        affectedRows: items.reduce((sum, item) => sum + (item?.affectedRows || 0), 0)
      };
    } catch (err) {
      try { await this.connection.query('SET FOREIGN_KEY_CHECKS=1'); } catch (restoreError) {}
      return { success: false, error: this._fmtErr(err) };
    }
  }

  async exportDatabaseToFile(database, targetFilePath) {
    if (!this.connection) return { success: false, error: 'Not connected to MySQL' };
    if (!database) return { success: false, error: 'Select a database first' };
    if (!targetFilePath) return { success: false, error: 'Target file path is required' };

    const stream = fs.createWriteStream(targetFilePath, { encoding: 'utf8' });
    const writeLine = async (line = '') => {
      if (!stream.write(line + '\n')) {
        await once(stream, 'drain');
      }
    };

    try {
      const [[schema]] = await this.connection.query(
        'SELECT DEFAULT_CHARACTER_SET_NAME as charset, DEFAULT_COLLATION_NAME as collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',
        [database]
      );
      if (!schema) throw new Error('Database not found or access denied');
      const [objects] = await this.connection.query(
        'SELECT TABLE_NAME as name, TABLE_TYPE as type FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME',
        [database]
      );

      await writeLine(`-- C-Script SQL backup for ${database}`);
      await writeLine(`-- Generated: ${new Date().toISOString()}`);
      await writeLine(`CREATE DATABASE IF NOT EXISTS ${quoteIdent(database)} CHARACTER SET ${schema.charset} COLLATE ${schema.collation};`);
      await writeLine(`USE ${quoteIdent(database)};`);
      await writeLine('SET FOREIGN_KEY_CHECKS=0;\n');

      const sqlValue = value => {
        if (value === null || value === undefined) return 'NULL';
        if (value instanceof Date) value = value.toISOString().slice(0, 19).replace('T', ' ');
        return this.connection.escape(value);
      };

      for (const object of objects) {
        const tableRef = `${quoteIdent(database)}.${quoteIdent(object.name)}`;
        const dropKind = object.type === 'VIEW' ? 'VIEW' : 'TABLE';
        const [createRows] = await this.connection.query(`SHOW CREATE ${dropKind} ${tableRef}`);
        const createSql = Object.values(createRows[0] || {})[1];
        if (!createSql) continue;

        await writeLine(`DROP ${dropKind} IF EXISTS ${tableRef};`);
        await writeLine(`${createSql};\n`);
        if (object.type === 'VIEW') continue;

        const [columns] = await this.connection.query(
          'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',
          [database, object.name]
        );
        const names = columns.map(column => column.COLUMN_NAME);

        for (let offset = 0; ; offset += 500) {
          const [rows] = await this.connection.query(`SELECT * FROM ${tableRef} LIMIT 500 OFFSET ?`, [offset]);
          if (!rows.length) break;

          for (let i = 0; i < rows.length; i += 100) {
            const group = rows.slice(i, i + 100);
            await writeLine(`INSERT INTO ${tableRef} (${names.map(quoteIdent).join(', ')}) VALUES`);
            await writeLine(group.map(row => `(${names.map(name => sqlValue(row[name])).join(', ')})`).join(',\n') + ';');
          }
        }
        await writeLine();
      }

      await writeLine('SET FOREIGN_KEY_CHECKS=1;\n');
      stream.end();
      await once(stream, 'finish');
      return { success: true, filePath: targetFilePath };
    } catch (err) {
      stream.destroy();
      try { if (fs.existsSync(targetFilePath)) fs.unlinkSync(targetFilePath); } catch (e) {}
      return { success: false, error: this._fmtErr(err) };
    }
  }

  async importFile(filePath) {
    if (!this.connection) return { success: false, error: 'Not connected to MySQL' };
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'SQL file not found' };

    try {
      const sql = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
      return await this.runScript(sql);
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async exportDatabaseSQL(database) {
    if (!this.connection) return { success: false, error: 'Not connected to MySQL' };
    if (!database) return { success: false, error: 'Select a database first' };
    try {
      const [[schema]] = await this.connection.query(
        'SELECT DEFAULT_CHARACTER_SET_NAME as charset, DEFAULT_COLLATION_NAME as collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',
        [database]
      );
      if (!schema) return { success: false, error: 'Database not found or access denied' };
      const [objects] = await this.connection.query(
        'SELECT TABLE_NAME as name, TABLE_TYPE as type FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME',
        [database]
      );
      const dump = [
        `-- C-Script SQL backup for ${database}`,
        `CREATE DATABASE IF NOT EXISTS ${quoteIdent(database)} CHARACTER SET ${schema.charset} COLLATE ${schema.collation};`,
        `USE ${quoteIdent(database)};`,
        'SET FOREIGN_KEY_CHECKS=0;',
        ''
      ];
      const sqlValue = value => {
        if (value === null || value === undefined) return 'NULL';
        if (value instanceof Date) value = value.toISOString().slice(0, 19).replace('T', ' ');
        return this.connection.escape(value);
      };

      for (const object of objects) {
        const tableRef = `${quoteIdent(database)}.${quoteIdent(object.name)}`;
        const dropKind = object.type === 'VIEW' ? 'VIEW' : 'TABLE';
        const [createRows] = await this.connection.query(`SHOW CREATE ${dropKind} ${tableRef}`);
        const createSql = Object.values(createRows[0] || {})[1];
        if (!createSql) continue;
        dump.push(`DROP ${dropKind} IF EXISTS ${tableRef};`, `${createSql};`, '');
        if (object.type === 'VIEW') continue;

        const [columns] = await this.connection.query(
          'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',
          [database, object.name]
        );
        const names = columns.map(column => column.COLUMN_NAME);
        for (let offset = 0; ; offset += 500) {
          const [rows] = await this.connection.query(`SELECT * FROM ${tableRef} LIMIT 500 OFFSET ?`, [offset]);
          if (!rows.length) break;
          for (let i = 0; i < rows.length; i += 100) {
            const group = rows.slice(i, i + 100);
            dump.push(`INSERT INTO ${tableRef} (${names.map(quoteIdent).join(', ')}) VALUES`);
            dump.push(group.map(row => `(${names.map(name => sqlValue(row[name])).join(', ')})`).join(',\n') + ';');
          }
        }
        dump.push('');
      }
      dump.push('SET FOREIGN_KEY_CHECKS=1;', '');
      return { success: true, sql: dump.join('\n') };
    } catch (err) {
      return { success: false, error: this._fmtErr(err) };
    }
  }

  /** Create a new database */
  async createDatabase(name, charset = 'utf8mb4', collation = 'utf8mb4_unicode_ci') {
    if (!this.connection) return { success: false, error: 'Not connected' };
    const allowedCharsets = new Set(['utf8mb4', 'utf8', 'latin1', 'ascii']);
    const allowedCollations = new Set(['utf8mb4_unicode_ci', 'utf8mb4_general_ci', 'utf8_general_ci']);
    if (typeof name !== 'string' || !name.trim() || name.length > 64) return { success: false, error: 'Enter a valid database name (1–64 characters)' };
    if (!allowedCharsets.has(charset) || !allowedCollations.has(collation)) return { success: false, error: 'Unsupported character set or collation' };
    try {
      await this.connection.query(`CREATE DATABASE ${quoteIdent(name)} CHARACTER SET ${charset} COLLATE ${collation}`);
      return { success: true };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  /** Drop a database */
  async dropDatabase(name) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    try {
      await this.connection.query(`DROP DATABASE ${quoteIdent(name)}`);
      return { success: true };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  /** Truncate a table (delete all rows, keep structure) */
  async truncateTable(database, table) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    try {
      await this.connection.query(`TRUNCATE TABLE ${quoteIdent(database)}.${quoteIdent(table)}`);
      return { success: true };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  /** Drop a table */
  async dropTable(database, table) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    try {
      await this.connection.query(`DROP TABLE ${quoteIdent(database)}.${quoteIdent(table)}`);
      return { success: true };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  async addTableColumn(database, table, column) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    const supportedTypes = new Set(['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'VARCHAR', 'CHAR', 'TEXT', 'LONGTEXT', 'DECIMAL', 'DATE', 'DATETIME', 'TIMESTAMP', 'BOOLEAN', 'JSON']);
    const name = String(column?.name || '').trim();
    const type = String(column?.type || '').toUpperCase();
    if (!name || name.length > 64) return { success: false, error: 'Column name must be between 1 and 64 characters' };
    if (!supportedTypes.has(type)) return { success: false, error: 'Choose a supported column type' };
    let length = String(column.length || '').trim();
    if (length) {
      if (!['VARCHAR', 'CHAR', 'DECIMAL'].includes(type)) return { success: false, error: `${type} does not use a length here` };
      if (type === 'DECIMAL') {
        if (!/^\d{1,2}(,\d{1,2})?$/.test(length)) return { success: false, error: 'DECIMAL length must look like 10 or 10,2' };
        const [precision, scale = '0'] = length.split(',').map(Number);
        if (precision < 1 || precision > 65 || scale > 30 || scale > precision) return { success: false, error: 'DECIMAL precision/scale is outside MySQL limits' };
      } else {
        const size = Number(length);
        if (!/^\d+$/.test(length) || size < 1 || size > (type === 'CHAR' ? 255 : 16383)) return { success: false, error: `Invalid ${type} length` };
      }
    } else if (['VARCHAR', 'CHAR'].includes(type)) {
      return { success: false, error: `${type} requires a length` };
    }

    const autoIncrement = !!column.autoIncrement;
    const primary = !!column.primary;
    if (autoIncrement && !['INT', 'BIGINT', 'SMALLINT', 'TINYINT'].includes(type)) return { success: false, error: 'AUTO_INCREMENT requires an integer type' };
    if (autoIncrement && !primary) return { success: false, error: 'AUTO_INCREMENT columns must be marked as primary key' };
    if (autoIncrement && column.defaultMode && column.defaultMode !== 'none') return { success: false, error: 'AUTO_INCREMENT cannot have a default value' };
    if (column.defaultMode === 'current_timestamp' && !['TIMESTAMP', 'DATETIME'].includes(type)) return { success: false, error: 'CURRENT_TIMESTAMP defaults require TIMESTAMP or DATETIME' };

    try {
      const [[tableInfo]] = await this.connection.query(
        'SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
        [database, table]
      );
      if (!tableInfo || tableInfo.TABLE_TYPE !== 'BASE TABLE') return { success: false, error: 'Columns can only be added to a base table, not a view.' };
      const [existing] = await this.connection.query(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
        [database, table]
      );
      if (!existing.length) return { success: false, error: 'Table not found or access denied' };
      if (existing.some(item => item.COLUMN_NAME === name)) return { success: false, error: 'A column with that name already exists' };
      if (column.after && column.after !== '__FIRST__' && !existing.some(item => item.COLUMN_NAME === column.after)) {
        return { success: false, error: 'The selected position column no longer exists' };
      }

      let definition = `${quoteIdent(name)} ${type}${length ? `(${length})` : ''} ${primary ? 'NOT NULL' : (column.nullable ? 'NULL' : 'NOT NULL')}`;
      if (column.defaultMode === 'null') definition += ' DEFAULT NULL';
      else if (column.defaultMode === 'literal') definition += ` DEFAULT ${this.connection.escape(String(column.defaultValue ?? ''))}`;
      else if (column.defaultMode === 'current_timestamp') definition += ' DEFAULT CURRENT_TIMESTAMP';
      if (autoIncrement) definition += ' AUTO_INCREMENT';
      const clauses = [`ADD COLUMN ${definition}`];
      if (primary) clauses.push(`ADD PRIMARY KEY (${quoteIdent(name)})`);
      if (column.after === '__FIRST__') clauses[0] += ' FIRST';
      else if (column.after) clauses[0] += ` AFTER ${quoteIdent(column.after)}`;
      await this.connection.query(`ALTER TABLE ${quoteIdent(database)}.${quoteIdent(table)} ${clauses.join(', ')}`);
      return { success: true };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }
  /** Get all foreign key relationships for a specific table */
  async getTableRelationships(database, table) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    try {
      const [outgoing] = await this.connection.query(
        `SELECT kcu.CONSTRAINT_NAME as name,
                kcu.COLUMN_NAME as column_name,
                kcu.REFERENCED_TABLE_SCHEMA as ref_schema,
                kcu.REFERENCED_TABLE_NAME as ref_table,
                kcu.REFERENCED_COLUMN_NAME as ref_column,
                rc.UPDATE_RULE as on_update,
                rc.DELETE_RULE as on_delete
         FROM information_schema.KEY_COLUMN_USAGE kcu
         LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
           ON rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
           AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
         WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ?
           AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
        [database, table]
      );
      const [incoming] = await this.connection.query(
        `SELECT kcu.CONSTRAINT_NAME as name,
                kcu.TABLE_NAME as from_table,
                kcu.COLUMN_NAME as from_column,
                kcu.REFERENCED_COLUMN_NAME as ref_column,
                rc.UPDATE_RULE as on_update,
                rc.DELETE_RULE as on_delete
         FROM information_schema.KEY_COLUMN_USAGE kcu
         LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
           ON rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
           AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
         WHERE kcu.REFERENCED_TABLE_SCHEMA = ? AND kcu.REFERENCED_TABLE_NAME = ?
           AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY kcu.CONSTRAINT_NAME`,
        [database, table]
      );
      return { success: true, outgoing, incoming };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  /** Add a foreign key relationship */
  async addForeignKey(database, table, fk) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    const column = String(fk?.column || '').trim();
    const refTable = String(fk?.refTable || '').trim();
    const refColumn = String(fk?.refColumn || '').trim();
    const constraintName = String(fk?.name || '').trim();
    const onUpdate = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION'].includes(fk?.onUpdate) ? fk.onUpdate : 'RESTRICT';
    const onDelete = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION'].includes(fk?.onDelete) ? fk.onDelete : 'RESTRICT';
    if (!column || !refTable || !refColumn) return { success: false, error: 'Column, reference table and reference column are required' };
    try {
      let sql = `ALTER TABLE ${quoteIdent(database)}.${quoteIdent(table)} ADD`;
      if (constraintName) sql += ` CONSTRAINT ${quoteIdent(constraintName)}`;
      sql += ` FOREIGN KEY (${quoteIdent(column)}) REFERENCES ${quoteIdent(refTable)}(${quoteIdent(refColumn)})`;
      sql += ` ON UPDATE ${onUpdate} ON DELETE ${onDelete}`;
      await this.connection.query(sql);
      return { success: true };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  /** Drop a foreign key constraint */
  async dropForeignKey(database, table, constraintName) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    if (!constraintName) return { success: false, error: 'Constraint name is required' };
    try {
      await this.connection.query(
        `ALTER TABLE ${quoteIdent(database)}.${quoteIdent(table)} DROP FOREIGN KEY ${quoteIdent(constraintName)}`
      );
      return { success: true };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  /** Get full database ER Diagram metadata (all tables, columns, indexes, foreign keys) */
  async getDatabaseERDiagram(database) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    if (!database) return { success: false, error: 'Select a database first' };
    try {
      const [tables] = await this.connection.query(
        `SELECT TABLE_NAME as name,
                TABLE_ROWS as rowCount,
                TABLE_COMMENT as comment
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
         ORDER BY TABLE_NAME`,
        [database]
      );

      const [columns] = await this.connection.query(
        `SELECT TABLE_NAME as table_name,
                COLUMN_NAME as name,
                COLUMN_TYPE as type,
                DATA_TYPE as data_type,
                IS_NULLABLE as nullable,
                COLUMN_KEY as key_type,
                EXTRA as extra,
                COLUMN_COMMENT as comment
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ?
         ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [database]
      );

      const [foreignKeys] = await this.connection.query(
        `SELECT kcu.CONSTRAINT_NAME as name,
                kcu.TABLE_NAME as from_table,
                kcu.COLUMN_NAME as from_column,
                kcu.REFERENCED_TABLE_NAME as to_table,
                kcu.REFERENCED_COLUMN_NAME as to_column,
                rc.UPDATE_RULE as on_update,
                rc.DELETE_RULE as on_delete
         FROM information_schema.KEY_COLUMN_USAGE kcu
         LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
           ON rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
           AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
         WHERE kcu.TABLE_SCHEMA = ?
           AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
        [database]
      );

      const tableMap = {};
      tables.forEach(t => {
        tableMap[t.name] = {
          name: t.name,
          rowCount: t.rowCount || 0,
          comment: t.comment || '',
          columns: []
        };
      });

      columns.forEach(col => {
        if (tableMap[col.table_name]) {
          tableMap[col.table_name].columns.push({
            name: col.name,
            type: col.type,
            dataType: col.data_type,
            nullable: col.nullable === 'YES',
            isPrimary: col.key_type === 'PRI',
            isUnique: col.key_type === 'UNI',
            isIndex: col.key_type === 'MUL',
            extra: col.extra || ''
          });
        }
      });

      return {
        success: true,
        database,
        tables: Object.values(tableMap),
        foreignKeys
      };
    } catch (err) {
      return { success: false, error: this._fmtErr(err) };
    }
  }

  /** Get server variables */
  async getServerSettings() {
    if (!this.connection) return { success: false, error: 'Not connected' };
    try {
      const [[settings]] = await this.connection.query(`SELECT
        VERSION() AS version, @@hostname AS hostname, @@port AS port,
        @@character_set_server AS charset, @@collation_server AS collation,
        @@default_storage_engine AS engine, @@max_connections AS maxConnections,
        @@max_allowed_packet AS maxAllowedPacket, @@session.time_zone AS timeZone,
        @@session.sql_mode AS sqlMode, @@session.default_storage_engine AS sessionEngine,
        @@session.character_set_connection AS connectionCharset,
        @@session.collation_connection AS connectionCollation`);
      const [[account]] = await this.connection.query('SELECT CURRENT_USER() AS account');
      const supportedCollations = {};
      for (const charset of ['utf8mb4','utf8','latin1','ascii']) {
        const [rows] = await this.connection.query('SHOW COLLATION WHERE Charset = ?', [charset]);
        supportedCollations[charset] = rows.map(row => row.Collation);
      }
      return { success: true, settings: { ...settings, account: account.account, supportedCollations } };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  /** Apply safe per-connection defaults. These values reset on reconnect. */
  async applySessionSettings(settings = {}) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    try {
      const engines = ['InnoDB','MyISAM','MEMORY'];
      const charsets = ['utf8mb4','utf8','latin1','ascii'];
      const collations = { utf8mb4: ['utf8mb4_unicode_ci','utf8mb4_general_ci','utf8mb4_0900_ai_ci'], utf8: ['utf8_unicode_ci','utf8_general_ci'], latin1: ['latin1_swedish_ci','latin1_general_ci'], ascii: ['ascii_general_ci','ascii_bin'] };
      if (settings.engine !== undefined) {
        if (!engines.includes(settings.engine)) throw new Error('Unsupported default storage engine.');
        await this.connection.query(`SET SESSION default_storage_engine = ${this.connection.escape(settings.engine)}`);
      }
      if (settings.timeZone !== undefined) {
        if (typeof settings.timeZone !== 'string' || settings.timeZone.length > 64 || /[\0\r\n]/.test(settings.timeZone)) throw new Error('Invalid time zone value.');
        await this.connection.query(`SET SESSION time_zone = ${this.connection.escape(settings.timeZone)}`);
      }
      if (settings.sqlMode !== undefined) {
        if (typeof settings.sqlMode !== 'string' || settings.sqlMode.length > 1024 || !/^[A-Za-z0-9_, ]*$/.test(settings.sqlMode)) throw new Error('Invalid SQL mode list.');
        await this.connection.query(`SET SESSION sql_mode = ${this.connection.escape(settings.sqlMode)}`);
      }
      if (settings.charset !== undefined || settings.collation !== undefined) {
        const charset = settings.charset;
        const collation = settings.collation;
        if (!charsets.includes(charset) || !collations[charset]?.includes(collation)) throw new Error('Choose a supported character set and collation.');
        const [available] = await this.connection.query('SHOW COLLATION WHERE Charset = ?', [charset]);
        if (!available.some(item => item.Collation === collation)) throw new Error(`Collation ${collation} is not supported by this server.`);
        // Keep the mysql2 client/result wire encoding intact while changing
        // how the server parses and compares connection string literals.
        await this.connection.query(`SET SESSION character_set_connection = ${charset}`);
        await this.connection.query(`SET SESSION collation_connection = ${collation}`);
      }
      return { success: true };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  /** Change defaults for future objects in a database; existing tables are untouched. */
  async setDatabaseDefaults(database, charset, collation) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    try {
      if (typeof database !== 'string' || !database || database.length > 64 || /[\0]/.test(database)) throw new Error('Invalid database name.');
      const allowed = { utf8mb4: ['utf8mb4_unicode_ci','utf8mb4_general_ci','utf8mb4_0900_ai_ci'], utf8: ['utf8_unicode_ci','utf8_general_ci'], latin1: ['latin1_swedish_ci','latin1_general_ci'], ascii: ['ascii_general_ci','ascii_bin'] };
      if (!allowed[charset]?.includes(collation)) throw new Error('Choose a supported character set and collation.');
      const [available] = await this.connection.query('SHOW COLLATION WHERE Charset = ?', [charset]);
      if (!available.some(item => item.Collation === collation)) throw new Error(`Collation ${collation} is not supported by this server.`);
      await this.connection.query(`ALTER DATABASE ${quoteIdent(database)} CHARACTER SET ${charset} COLLATE ${collation}`);
      return { success: true, database, charset, collation };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  /** Runtime-only global limits. They may require elevated server privileges and reset on restart. */
  async setServerLimits(maxConnections, maxAllowedPacket) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    try {
      const connections = Number(maxConnections), packet = Number(maxAllowedPacket);
      if (!Number.isInteger(connections) || connections < 1 || connections > 100000) throw new Error('Maximum connections must be between 1 and 100000.');
      if (!Number.isInteger(packet) || packet < 1024 || packet > 1073741824) throw new Error('Maximum packet must be between 1 KB and 1 GB.');
      await this.connection.query(`SET GLOBAL max_connections = ${connections}`);
      await this.connection.query(`SET GLOBAL max_allowed_packet = ${packet}`);
      return { success: true };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  /** Create a table from validated structured column definitions. */
  async createTable(database, table, columns, options = {}) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    try {
      const validIdentifier = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\0]/.test(value);
      if (!validIdentifier(database) || !validIdentifier(table)) throw new Error('Database and table names must be 1–64 characters.');
      if (!Array.isArray(columns) || columns.length < 1 || columns.length > 100) throw new Error('Add between 1 and 100 columns.');
      const types = new Set(['INT','INTEGER','BIGINT','SMALLINT','TINYINT','MEDIUMINT','VARCHAR','CHAR','TEXT','MEDIUMTEXT','LONGTEXT','DATE','DATETIME','TIMESTAMP','TIME','DECIMAL','FLOAT','DOUBLE','BOOLEAN','JSON','BLOB','LONGBLOB']);
      const names = new Set();
      const primary = [];
      const definitions = columns.map((column, index) => {
        if (!validIdentifier(column.name)) throw new Error(`Column ${index + 1}: enter a name up to 64 characters.`);
        if (names.has(column.name.toLowerCase())) throw new Error(`Duplicate column name: ${column.name}`);
        names.add(column.name.toLowerCase());
        const type = String(column.type || '').toUpperCase();
        if (!types.has(type)) throw new Error(`Unsupported data type for ${column.name}.`);
        let sqlType = type;
        if (['VARCHAR','CHAR'].includes(type)) {
          const length = Number(column.length || 255);
          if (!Number.isInteger(length) || length < 1 || length > 16383) throw new Error(`Invalid length for ${column.name}.`);
          sqlType += `(${length})`;
        } else if (type === 'DECIMAL') {
          const precision = Number(column.precision || 10), scale = Number(column.scale || 2);
          if (!Number.isInteger(precision) || !Number.isInteger(scale) || precision < 1 || precision > 65 || scale < 0 || scale > Math.min(30, precision)) throw new Error(`Invalid decimal precision for ${column.name}.`);
          sqlType += `(${precision},${scale})`;
        }
        const isPrimary = !!column.primary;
        if (isPrimary) primary.push(column.name);
        const auto = !!column.autoIncrement;
        if (auto && !['INT','INTEGER','BIGINT','SMALLINT','TINYINT','MEDIUMINT'].includes(type)) throw new Error(`AUTO_INCREMENT requires an integer column (${column.name}).`);
        if (auto && !isPrimary && !column.unique) throw new Error(`AUTO_INCREMENT column ${column.name} must be indexed.`);
        if (auto && column.nullable) throw new Error(`AUTO_INCREMENT column ${column.name} cannot be nullable.`);
        let sql = `${quoteIdent(column.name)} ${sqlType}${column.unsigned && ['INT','INTEGER','BIGINT','SMALLINT','TINYINT','MEDIUMINT','DECIMAL'].includes(type) ? ' UNSIGNED' : ''}`;
        sql += column.nullable && !isPrimary ? ' NULL' : ' NOT NULL';
        if (auto) sql += ' AUTO_INCREMENT';
        if (column.defaultMode === 'current_timestamp' && ['TIMESTAMP','DATETIME'].includes(type)) sql += ' DEFAULT CURRENT_TIMESTAMP';
        else if (column.defaultMode === 'value' && column.defaultValue !== undefined && column.defaultValue !== '') sql += ` DEFAULT ${this.connection.escape(column.defaultValue)}`;
        if (column.unique && !isPrimary) sql += ', UNIQUE KEY ' + quoteIdent(`uq_${column.name.slice(0, 52)}_${index + 1}`) + ` (${quoteIdent(column.name)})`;
        return sql;
      });
      if (primary.length) definitions.push(`PRIMARY KEY (${primary.map(quoteIdent).join(', ')})`);
      const engine = ['InnoDB','MyISAM','MEMORY'].includes(options.engine) ? options.engine : 'InnoDB';
      const charset = ['utf8mb4','utf8','latin1','ascii'].includes(options.charset) ? options.charset : 'utf8mb4';
      const collations = { utf8mb4: ['utf8mb4_unicode_ci','utf8mb4_general_ci'], utf8: ['utf8_unicode_ci','utf8_general_ci'], latin1: ['latin1_swedish_ci','latin1_general_ci'], ascii: ['ascii_general_ci','ascii_bin'] };
      const collation = collations[charset].includes(options.collation) ? options.collation : collations[charset][0];
      const comment = String(options.comment || '').slice(0, 2048);
      const sql = `CREATE TABLE ${quoteIdent(database)}.${quoteIdent(table)} (${definitions.join(', ')}) ENGINE=${engine} DEFAULT CHARACTER SET ${charset} COLLATE ${collation}${comment ? ` COMMENT=${this.connection.escape(comment)}` : ''}`;
      await this.connection.query(sql);
      return { success: true, database, table };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  /** Change the password for the authenticated MySQL account. */
  async changeOwnPassword(currentPassword, newPassword) {
    if (!this.connection || !this.config) return { success: false, error: 'Not connected' };
    let verifiedConnection;
    try {
      if (typeof newPassword !== 'string' || !newPassword || newPassword.length > 128) throw new Error('Enter a new password between 1 and 128 characters.');
      if (typeof currentPassword !== 'string') throw new Error('Enter your current password.');
      const mysql2 = this._loadMysql2();
      verifiedConnection = await mysql2.createConnection({ ...this.config, password: currentPassword, connectTimeout: 10000, multipleStatements: false });
      const [[row]] = await verifiedConnection.query('SELECT CURRENT_USER() AS account');
      await verifiedConnection.end(); verifiedConnection = null;
      await this.connection.query(`ALTER USER CURRENT_USER() IDENTIFIED BY ${this.connection.escape(newPassword)}`);
      const nextConfig = { ...this.config, password: newPassword };
      try {
        const replacement = await mysql2.createConnection({ ...nextConfig, connectTimeout: 10000, multipleStatements: true });
        await replacement.query('SELECT 1');
        const oldConnection = this.connection;
        this.connection = replacement;
        this.config = nextConfig;
        try { await oldConnection.end(); } catch (_) {}
        return { success: true, account: row.account, reconnected: true };
      } catch (reconnectError) {
        this.config = nextConfig;
        return { success: true, account: row.account, reconnected: false, error: `Password changed, but reconnect failed: ${reconnectError.message}` };
      }
    } catch (err) {
      if (verifiedConnection) try { await verifiedConnection.end(); } catch (_) {}
      return { success: false, error: this._fmtErr(err) };
    }
  }

  async getServerVars() {
    if (!this.connection) return { success: false, error: 'Not connected' };
    try {
      const [rows] = await this.connection.query('SHOW VARIABLES LIKE "%version%"');
      return { success: true, vars: rows };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  _fmtErr(err) {
    if (err.code === 'ECONNREFUSED') return `Cannot connect to MySQL at ${this.config?.host}:${this.config?.port}. Is MySQL running?`;
    if (err.code === 'ER_ACCESS_DENIED_ERROR') return `Access denied for user '${this.config?.user}'.`;
    if (err.code === 'ETIMEDOUT') return 'Connection timed out.';
    return err.message || 'Unknown MySQL error';
  }
}

module.exports = MySQLManager;
