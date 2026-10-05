/**
 * MySQLManager - Full-featured MySQL connection & query manager
 * Uses query() instead of execute() to avoid prepared statement protocol issues
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');
const zlib = require('zlib');

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
         WHERE LOWER(TABLE_SCHEMA) = LOWER(?) AND LOWER(TABLE_NAME) = LOWER(?)`,
        [database, table]
      );

      let info = rows && rows[0] ? { ...rows[0] } : {};

      // Fallback to SHOW TABLE STATUS if information_schema returned empty
      if (!info.TABLE_NAME && !info.table_name && !info.Name) {
        try {
          const [statusRows] = await this.connection.query(
            `SHOW TABLE STATUS FROM ${quoteIdent(database)} LIKE ?`,
            [table]
          );
          if (statusRows && statusRows[0]) {
            const s = statusRows[0];
            const dataBytes = Number(s.Data_length || s.data_length || 0);
            const indexBytes = Number(s.Index_length || s.index_length || 0);
            info = {
              TABLE_NAME: s.Name || s.name || table,
              ENGINE: s.Engine || s.engine || 'InnoDB',
              TABLE_ROWS: s.Rows || s.rows || 0,
              dataMB: Number((dataBytes / 1024 / 1024).toFixed(3)),
              indexMB: Number((indexBytes / 1024 / 1024).toFixed(3)),
              totalMB: Number(((dataBytes + indexBytes) / 1024 / 1024).toFixed(3)),
              AUTO_INCREMENT: s.Auto_increment || s.auto_increment,
              TABLE_COLLATION: s.Collation || s.collation,
              CREATE_TIME: s.Create_time || s.create_time,
              UPDATE_TIME: s.Update_time || s.update_time,
              TABLE_COMMENT: s.Comment || s.comment || ''
            };
          }
        } catch (_) {}
      }

      // Count exact rows
      try {
        const [[{ exactCount }]] = await this.connection.query(
          `SELECT COUNT(*) as exactCount FROM ${quoteIdent(database)}.${quoteIdent(table)}`
        );
        info.exactCount = exactCount;
      } catch (_) {}

      // Count columns & get primary key
      try {
        const [cols] = await this.connection.query(
          `SELECT COLUMN_NAME, COLUMN_KEY FROM information_schema.COLUMNS
           WHERE LOWER(TABLE_SCHEMA) = LOWER(?) AND LOWER(TABLE_NAME) = LOWER(?)`,
          [database, table]
        );
        info.colCount = cols.length;
        const pkCol = cols.find(c => String(c.COLUMN_KEY || c.column_key).toUpperCase() === 'PRI');
        info.primaryKey = pkCol ? (pkCol.COLUMN_NAME || pkCol.column_name) : null;
      } catch (_) {}

      // Normalize property names for reliable casing
      const normalized = {
        ...info,
        TABLE_NAME: info.TABLE_NAME || info.table_name || table,
        ENGINE: info.ENGINE || info.engine || 'InnoDB',
        TABLE_ROWS: info.TABLE_ROWS ?? info.table_rows ?? info.exactCount ?? 0,
        TABLE_COLLATION: info.TABLE_COLLATION || info.table_collation || info.Collation || '—',
        AUTO_INCREMENT: info.AUTO_INCREMENT ?? info.auto_increment ?? '—',
        CREATE_TIME: info.CREATE_TIME || info.create_time || null,
        UPDATE_TIME: info.UPDATE_TIME || info.update_time || null,
        TABLE_COMMENT: info.TABLE_COMMENT || info.table_comment || '',
        dataMB: info.dataMB ?? 0,
        indexMB: info.indexMB ?? 0,
        totalMB: info.totalMB ?? ((Number(info.dataMB || 0) + Number(info.indexMB || 0)).toFixed(3))
      };

      return { success: true, info: normalized };
    } catch (err) { return { success: false, error: this._fmtErr(err) }; }
  }

  /** Database-level info: total size, table count, charset */
  async getDatabaseInfo(database) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    try {
      const [[sizes]] = await this.connection.query(
        `SELECT COUNT(*) as tableCount,
                COALESCE(SUM(TABLE_ROWS), 0) as totalRows,
                COALESCE(ROUND(SUM(DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2), 0) as totalMB
         FROM information_schema.TABLES WHERE LOWER(TABLE_SCHEMA) = LOWER(?)`,
        [database]
      );
      const [[schema]] = await this.connection.query(
        `SELECT DEFAULT_CHARACTER_SET_NAME as charset, DEFAULT_COLLATION_NAME as collation
         FROM information_schema.SCHEMATA WHERE LOWER(SCHEMA_NAME) = LOWER(?)`,
        [database]
      );
      return { success: true, ...(sizes || {}), ...(schema || {}) };
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
    if (!changes || !Object.keys(changes).length) return { success: false, error: 'No values to update' };
    try {
      const [columns] = await this.connection.query(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE LOWER(TABLE_SCHEMA)=LOWER(?) AND LOWER(TABLE_NAME)=LOWER(?)',
        [database, table]
      );
      const allowedColumns = new Set(columns.map(row => row.COLUMN_NAME));
      const setNames = Object.keys(changes).filter(c => allowedColumns.has(c));
      if (!setNames.length) return { success: false, error: 'No valid update columns' };

      const keyEntries = Object.entries(primary || {}).filter(([k]) => allowedColumns.has(k));
      if (!keyEntries.length) return { success: false, error: 'No matching row identifier provided' };

      const where = keyEntries.map(([k, v]) => v == null ? `${quoteIdent(k)} IS NULL` : `${quoteIdent(k)} = ?`);
      const whereValues = keyEntries.filter(([, v]) => v != null).map(([, v]) => v);
      const setValues = setNames.map(k => changes[k]);

      const sql = `UPDATE ${quoteIdent(database)}.${quoteIdent(table)} SET ${setNames.map(k => `${quoteIdent(k)} = ?`).join(', ')} WHERE ${where.join(' AND ')} LIMIT 1`;
      const [result] = await this.connection.query(sql, [...setValues, ...whereValues]);
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
    if (!primary || !Object.keys(primary).length) return { success: false, error: 'No row identifier provided for deletion' };
    try {
      const [columns] = await this.connection.query(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE LOWER(TABLE_SCHEMA)=LOWER(?) AND LOWER(TABLE_NAME)=LOWER(?)',
        [database, table]
      );
      const allowedColumns = new Set(columns.map(row => row.COLUMN_NAME));
      const keyEntries = Object.entries(primary).filter(([k]) => allowedColumns.has(k));
      if (!keyEntries.length) return { success: false, error: 'No valid columns provided for deletion' };

      const where = keyEntries.map(([k, v]) => v == null ? `${quoteIdent(k)} IS NULL` : `${quoteIdent(k)} = ?`);
      const values = keyEntries.filter(([, v]) => v != null).map(([, v]) => v);

      const sql = `DELETE FROM ${quoteIdent(database)}.${quoteIdent(table)} WHERE ${where.join(' AND ')} LIMIT 1`;
      const [result] = await this.connection.query(sql, values);
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

  _findMysqlCliBinary() {
    const candidates = [
      path.join(process.env.APPDATA || '', 'c-script-localhost', 'mysql', 'bin', 'mysql.exe'),
      path.join(process.env.APPDATA || '', 'antigravity-localhost', 'mysql', 'bin', 'mysql.exe'),
      path.join(process.cwd(), 'resources', 'bundled', 'mysql', 'bin', 'mysql.exe'),
      path.join(__dirname, '..', 'resources', 'bundled', 'mysql', 'bin', 'mysql.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'MySQL', 'MySQL Server 8.0', 'bin', 'mysql.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'MySQL', 'MySQL Server 8.4', 'bin', 'mysql.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'MariaDB 10.11', 'bin', 'mysql.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'MariaDB 11.4', 'bin', 'mysql.exe'),
      'C:\\xampp\\mysql\\bin\\mysql.exe',
      'C:\\laragon\\bin\\mysql\\current\\bin\\mysql.exe'
    ];
    for (const binPath of candidates) {
      if (binPath && fs.existsSync(binPath)) {
        return binPath;
      }
    }
    return null;
  }

    _readSqlFile(filePath) {
    let buf = fs.readFileSync(filePath);
    if (!buf || buf.length === 0) return '';
    if (buf.length >= 2 && buf[0] === 0x1F && buf[1] === 0x8B) {
      try {
        buf = zlib.gunzipSync(buf);
      } catch (gzErr) {
        console.warn('[MySQLManager] Could not gunzip SQL file:', gzErr.message);
      }
    }
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      return buf.slice(3).toString('utf8');
    }
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
      return buf.slice(2).toString('utf16le');
    }
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
      const swapped = Buffer.alloc(buf.length - 2);
      for (let i = 2; i < buf.length - 1; i += 2) {
        swapped[i - 2] = buf[i + 1];
        swapped[i - 1] = buf[i];
      }
      return swapped.toString('utf16le');
    }
    const sampleSize = Math.min(buf.length, 1024);
    let oddNulls = 0;
    let evenNulls = 0;
    for (let i = 0; i < sampleSize; i++) {
      if (buf[i] === 0x00) {
        if (i % 2 === 1) oddNulls++;
        else evenNulls++;
      }
    }
    if (oddNulls > 10 && oddNulls > evenNulls * 3) {
      return buf.toString('utf16le');
    }
    if (evenNulls > 10 && evenNulls > oddNulls * 3) {
      const swapped = Buffer.alloc(buf.length);
      for (let i = 0; i < buf.length - 1; i += 2) {
        swapped[i] = buf[i + 1];
        swapped[i + 1] = buf[i];
      }
      return swapped.toString('utf16le');
    }
    return buf.toString('utf8');
  }

  _sanitizeSqlForLocalhost(sql) {
    if (!sql) return '';
    // Replace remote DEFINER clauses from live/cPanel phpMyAdmin exports with CURRENT_USER to avoid Error 1449 / Error 1227
    return sql.replace(/DEFINER\s*=\s*[`'"]?[^@`'"\s]+[`'"]?@[`'"]?[^\s`'"\(\),;]+[`'"]?/gi, 'DEFINER=CURRENT_USER');
  }

  _isExecutableStatement(stmt) {
    if (!stmt || !stmt.trim()) return false;
    // Strip standard comments, but KEEP MySQL conditional version comments like /*!40101 ... */
    let clean = stmt.replace(/\/\*[\s\S]*?\*\//g, (match) => {
      if (match.startsWith('/*!')) return match;
      return '';
    });
    clean = clean.replace(/(--\s.*$)|(--\r?$)|(#.*$)/gm, '');
    return clean.trim().length > 0;
  }


  _splitSqlStatements(sql) {
    const statements = [];
    let delimiter = ';';
    let current = '';
    const len = sql.length;
    let i = 0;

    while (i < len) {
      const remaining = sql.slice(i);
      const delimMatch = remaining.match(/^[ \t]*DELIMITER[ \t]+(\S+)/i);
      if (delimMatch && (i === 0 || sql[i - 1] === '\n' || current.trim() === '')) {
        if (this._isExecutableStatement(current)) {
          statements.push(current.trim());
        }
        current = '';
        delimiter = delimMatch[1];
        const nextNewline = sql.indexOf('\n', i);
        i = nextNewline === -1 ? len : nextNewline + 1;
        continue;
      }

      const ch = sql[i];
      const next = i + 1 < len ? sql[i + 1] : '';

      if (ch === "'") {
        current += ch;
        i++;
        while (i < len) {
          const c = sql[i];
          current += c;
          if (c === '\\') {
            i++;
            if (i < len) current += sql[i];
          } else if (c === "'") {
            if (i + 1 < len && sql[i + 1] === "'") {
              i++;
              current += sql[i];
            } else {
              break;
            }
          }
          i++;
        }
        i++;
        continue;
      }

      if (ch === '"') {
        current += ch;
        i++;
        while (i < len) {
          const c = sql[i];
          current += c;
          if (c === '\\') {
            i++;
            if (i < len) current += sql[i];
          } else if (c === '"') {
            if (i + 1 < len && sql[i + 1] === '"') {
              i++;
              current += sql[i];
            } else {
              break;
            }
          }
          i++;
        }
        i++;
        continue;
      }

      if (ch === '`') {
        current += ch;
        i++;
        while (i < len) {
          const c = sql[i];
          current += c;
          if (c === '`') {
            if (i + 1 < len && sql[i + 1] === '`') {
              i++;
              current += sql[i];
            } else {
              break;
            }
          }
          i++;
        }
        i++;
        continue;
      }

      if ((ch === '-' && next === '-' && (i + 2 >= len || /\s/.test(sql[i + 2]))) || ch === '#') {
        const endLine = sql.indexOf('\n', i);
        if (endLine === -1) {
          current += sql.slice(i);
          i = len;
        } else {
          current += sql.slice(i, endLine + 1);
          i = endLine + 1;
        }
        continue;
      }

      if (ch === '/' && next === '*') {
        const endComment = sql.indexOf('*/', i + 2);
        if (endComment === -1) {
          current += sql.slice(i);
          i = len;
        } else {
          current += sql.slice(i, endComment + 2);
          i = endComment + 2;
        }
        continue;
      }

      if (sql.startsWith(delimiter, i)) {
        if (this._isExecutableStatement(current)) {
          statements.push(current.trim());
        }
        current = '';
        i += delimiter.length;
        continue;
      }

      current += ch;
      i++;
    }

    if (this._isExecutableStatement(current)) {
      statements.push(current.trim());
    }

    return statements;
  }

  _detectTargetDatabase(sql, fallbackDb, filePath) {
    const hasUseMatch = sql.match(/^[ \t]*USE[ \t]+[`"']?([a-zA-Z0-9_$-]+)[`"']?/im);
    if (hasUseMatch) {
      return { targetDb: hasUseMatch[1], explicitInSql: true };
    }
    const hasCreateDb = sql.match(/^[ \t]*CREATE\s+DATABASE[ \t]+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([a-zA-Z0-9_$-]+)[`"']?/im);
    if (hasCreateDb) {
      return { targetDb: hasCreateDb[1], explicitInSql: true };
    }

    // phpMyAdmin comment format: -- Database: `dbname`
    const pmaDbMatch = sql.match(/^[ \t]*--[ \t]*(?:Database|Datenbank|Base de données|Base de datos)[ \t]*:[ \t]*[`'"]?([a-zA-Z0-9_$-]+)[`'"]?/im);
    if (pmaDbMatch) {
      return { targetDb: pmaDbMatch[1], explicitInSql: false };
    }

    if (fallbackDb && typeof fallbackDb === 'string' && fallbackDb.trim()) {
      return { targetDb: fallbackDb.trim(), explicitInSql: false };
    }

    if (filePath) {
      let base = path.basename(filePath);
      if (base.toLowerCase().endsWith('.gz')) base = base.slice(0, -3);
      base = path.basename(base, path.extname(base));
      const sanitized = base.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64);
      if (sanitized && !SYSTEM_DBS.includes(sanitized)) {
        return { targetDb: sanitized, explicitInSql: false };
      }
    }

    return { targetDb: null, explicitInSql: false };
  }

  async _importViaCli(cliPath, targetDb, cleanSql, explicitInSql) {
    return new Promise((resolve) => {
      const host = this.config?.host || '127.0.0.1';
      const port = String(this.config?.port || 3306);
      const user = this.config?.user || 'root';
      const password = this.config?.password || '';

      const args = [
        '-h', host,
        '-P', port,
        '-u', user,
        '--default-character-set=utf8mb4',
        '--max-allowed-packet=512M'
      ];
      cleanSql = this._sanitizeSqlForLocalhost(cleanSql);
      if (password) {
        args.push(`--password=${password}`);
      }

      let child;
      try {
        child = spawn(cliPath, args, { windowsHide: true });
      } catch (spawnErr) {
        return resolve({ success: false, error: spawnErr.message });
      }

      let stderr = '';
      let stdout = '';

      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });

      child.on('error', err => {
        resolve({ success: false, error: err.message });
      });

      child.on('close', code => {
        if (code === 0) {
          const estimatedStatements = (cleanSql.match(/;\s*(\r?\n|$)/g) || []).length || 1;
          resolve({
            success: true,
            method: 'cli',
            database: targetDb,
            statements: estimatedStatements,
            affectedRows: 0
          });
        } else {
          const cleanStderr = stderr.split('\n')
            .filter(line => !line.toLowerCase().includes('using a password on the command line interface'))
            .join('\n')
            .trim();
          resolve({ success: false, error: cleanStderr || stderr.trim() || `MySQL CLI exited with code ${code}` });
        }
      });

      try {
        if (targetDb && !explicitInSql) {
          const escapedDb = targetDb.replace(/`/g, '``');
          child.stdin.write(`CREATE DATABASE IF NOT EXISTS \`${escapedDb}\`;\nUSE \`${escapedDb}\`;\n`);
        }
        child.stdin.end(Buffer.from(cleanSql, 'utf8'));
      } catch (writeErr) {
        // ignore stdin write errors
      }
    });
  }

  readSqlFileContent(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'SQL file not found' };
    try {
      const rawSql = this._readSqlFile(filePath);
      const cleanSql = rawSql.replace(/^\uFEFF/, '').replace(/\0/g, '');
      return { success: true, content: cleanSql, fileName: path.basename(filePath), filePath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async runScript(sql, targetDatabase = null) {
    if (!this.connection) return { success: false, error: 'Not connected to MySQL' };
    if (typeof sql !== 'string' || !sql.trim()) return { success: false, error: 'The SQL file is empty' };

    let cleanSql = sql.replace(/^\uFEFF/, '').replace(/\0/g, '').trim();
    cleanSql = this._sanitizeSqlForLocalhost(cleanSql);
    if (!cleanSql) return { success: false, error: 'The SQL file is empty' };
    cleanSql = this._sanitizeSqlForLocalhost(cleanSql);

    const { targetDb, explicitInSql } = this._detectTargetDatabase(cleanSql, targetDatabase);

    try {
      if (targetDb && !explicitInSql) {
        await this.connection.query(`CREATE DATABASE IF NOT EXISTS ${quoteIdent(targetDb)}`);
        await this.connection.query(`USE ${quoteIdent(targetDb)}`);
      }

      await this.connection.query('SET FOREIGN_KEY_CHECKS=0');
      try {
        await this.connection.query("SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO'");
      } catch (_) {}

      const statements = this._splitSqlStatements(cleanSql);
      if (!statements.length) {
        return { success: true, statements: 0, affectedRows: 0, database: targetDb };
      }

      let executed = 0;
      let totalAffected = 0;

      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i];
        if (!this._isExecutableStatement(stmt)) continue;

        try {
          const [result] = await this.connection.query(stmt);
          executed++;
          if (result && typeof result.affectedRows === 'number') {
            totalAffected += result.affectedRows;
          }
        } catch (stmtErr) {
          const preview = stmt.split('\n')[0].slice(0, 80);
          throw new Error(`Statement ${executed + 1} failed ("${preview}..."): ${this._fmtErr(stmtErr)}`);
        }
      }

      try { await this.connection.query('SET FOREIGN_KEY_CHECKS=1'); } catch (_) {}

      return {
        success: true,
        database: targetDb,
        statements: executed,
        affectedRows: totalAffected
      };
    } catch (err) {
      try { await this.connection.query('SET FOREIGN_KEY_CHECKS=1'); } catch (_) {}
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

  async importFile(filePath, targetDatabase = null) {
    if (!this.connection) return { success: false, error: 'Not connected to MySQL' };
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'SQL file not found' };

    let cleanSql;
    try {
      const rawSql = this._readSqlFile(filePath);
      cleanSql = rawSql.replace(/^\uFEFF/, '').replace(/\0/g, '').trim();
    } catch (readErr) {
      return { success: false, error: `Failed to read SQL file: ${readErr.message}` };
    }

    if (!cleanSql) return { success: false, error: 'The SQL file is empty' };

    const { targetDb, explicitInSql } = this._detectTargetDatabase(cleanSql, targetDatabase, filePath);

    // Primary Tier 1: Try native CLI binary for maximum speed and full syntax compatibility
    const cliPath = this._findMysqlCliBinary();
    if (cliPath) {
      try {
        const cliResult = await this._importViaCli(cliPath, targetDb, cleanSql, explicitInSql);
        if (cliResult.success) {
          return cliResult;
        }
        console.warn('[MySQLManager] CLI import failed, falling back to JS parser:', cliResult.error);
      } catch (cliErr) {
        console.warn('[MySQLManager] CLI import exception:', cliErr.message);
      }
    }

    // Tier 2: JavaScript lexer fallback
    return await this.runScript(cleanSql, targetDb);
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

  /** Drop a column from an existing table */
  async dropTableColumn(database, table, columnName) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    if (!columnName) return { success: false, error: 'Column name required' };
    try {
      await this.connection.query(
        `ALTER TABLE ${quoteIdent(database)}.${quoteIdent(table)} DROP COLUMN ${quoteIdent(columnName)}`
      );
      return { success: true };
    } catch (err) {
      return { success: false, error: this._fmtErr(err) };
    }
  }

  /** Modify an existing column in a table */
  async modifyTableColumn(database, table, oldName, column) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    if (!oldName || !column || !column.name) return { success: false, error: 'Column name is required' };
    const newName = column.name.trim();
    const type = (column.type || 'VARCHAR').toUpperCase();
    const length = column.length ? String(column.length).trim() : '';

    let definition = `${quoteIdent(newName)} ${type}${length ? `(${length})` : ''} ${column.nullable ? 'NULL' : 'NOT NULL'}`;
    if (column.defaultMode === 'null') definition += ' DEFAULT NULL';
    else if (column.defaultMode === 'literal' && column.defaultValue != null && column.defaultValue !== '') definition += ` DEFAULT ${this.connection.escape(String(column.defaultValue))}`;
    else if (column.defaultMode === 'current_timestamp') definition += ' DEFAULT CURRENT_TIMESTAMP';
    if (column.autoIncrement) definition += ' AUTO_INCREMENT';
    if (column.comment) definition += ` COMMENT ${this.connection.escape(String(column.comment))}`;

    try {
      await this.connection.query(
        `ALTER TABLE ${quoteIdent(database)}.${quoteIdent(table)} CHANGE COLUMN ${quoteIdent(oldName)} ${definition}`
      );
      return { success: true };
    } catch (err) {
      return { success: false, error: this._fmtErr(err) };
    }
  }

  /** Rename an existing table */
  async renameTable(database, oldName, newName) {
    if (!this.connection) return { success: false, error: 'Not connected' };
    if (!oldName || !newName) return { success: false, error: 'Both old and new table names are required' };
    try {
      await this.connection.query(
        `RENAME TABLE ${quoteIdent(database)}.${quoteIdent(oldName)} TO ${quoteIdent(database)}.${quoteIdent(newName)}`
      );
      return { success: true };
    } catch (err) {
      return { success: false, error: this._fmtErr(err) };
    }
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
      return {
        success: true,
        settings: {
          ...settings,
          account: account.account,
          hasEmptyPassword: !this.config?.password,
          supportedCollations
        }
      };
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
      if (typeof newPassword !== 'string' || !newPassword || newPassword.length > 128) {
        throw new Error('Enter a new password between 1 and 128 characters.');
      }
      const checkCurrentPassword = typeof currentPassword === 'string' ? currentPassword : '';
      const mysql2 = this._loadMysql2();

      // 1. Verify current credentials
      try {
        verifiedConnection = await mysql2.createConnection({
          ...this.config,
          password: checkCurrentPassword,
          connectTimeout: 10000,
          multipleStatements: false
        });
      } catch (authErr) {
        // If empty password failed but config has a saved password, test config.password
        if (!checkCurrentPassword && this.config.password) {
          try {
            verifiedConnection = await mysql2.createConnection({
              ...this.config,
              password: this.config.password,
              connectTimeout: 10000,
              multipleStatements: false
            });
          } catch (_) {
            throw new Error('Current password verification failed. Please enter your existing database password.');
          }
        } else {
          throw new Error('Current password is incorrect. (If no password was set yet, leave current password blank.)');
        }
      }

      const [[infoRow]] = await verifiedConnection.query('SELECT CURRENT_USER() AS account, VERSION() AS version');
      await verifiedConnection.end();
      verifiedConnection = null;

      const rawAccount = infoRow?.account || 'root@localhost';
      const versionStr = String(infoRow?.version || '').toLowerCase();
      const isMariaDB = versionStr.includes('mariadb');

      // Extract account components (e.g. root@localhost, 'root'@'127.0.0.1')
      const parts = rawAccount.split('@');
      const userName = (parts[0] || 'root').replace(/^'|'$/g, '');
      const userHost = (parts[1] || 'localhost').replace(/^'|'$/g, '');

      // 2. Discover all matching host accounts for this user (e.g. localhost, 127.0.0.1, %, ::1)
      let targetHosts = [];
      try {
        const [userRows] = await this.connection.query('SELECT Host FROM mysql.user WHERE User = ?', [userName]);
        if (Array.isArray(userRows) && userRows.length > 0) {
          targetHosts = userRows.map(r => r.Host).filter(Boolean);
        }
      } catch (_) {}

      if (targetHosts.length === 0) {
        targetHosts = [userHost];
        if (userName.toLowerCase() === 'root') {
          for (const h of ['localhost', '127.0.0.1', '::1', '%']) {
            if (!targetHosts.includes(h)) targetHosts.push(h);
          }
        }
      }

      // 3. Apply password change across all target host bindings
      const escapedPass = this.connection.escape(newPassword);
      let anyChanged = false;
      let lastErr = null;

      for (const host of targetHosts) {
        const hostLiteral = this.connection.escape(host);
        const userLiteral = this.connection.escape(userName);

        try {
          await this.connection.query(`ALTER USER ${userLiteral}@${hostLiteral} IDENTIFIED BY ${escapedPass}`);
          anyChanged = true;
          continue;
        } catch (alterErr) {
          lastErr = alterErr;
        }

        try {
          if (isMariaDB) {
            await this.connection.query(`SET PASSWORD FOR ${userLiteral}@${hostLiteral} = PASSWORD(${escapedPass})`);
          } else {
            await this.connection.query(`SET PASSWORD FOR ${userLiteral}@${hostLiteral} = ${escapedPass}`);
          }
          anyChanged = true;
          continue;
        } catch (setForErr) {
          lastErr = setForErr;
        }
      }

      // Also update the current active user session directly
      try {
        if (isMariaDB) {
          await this.connection.query(`SET PASSWORD = PASSWORD(${escapedPass})`);
        } else {
          await this.connection.query(`SET PASSWORD = ${escapedPass}`);
        }
        anyChanged = true;
      } catch (selfSetErr) {
        if (!anyChanged) lastErr = selfSetErr;
      }

      // For MySQL 8+, also ensure ALTER USER CURRENT_USER() is tried
      if (!isMariaDB) {
        try {
          await this.connection.query(`ALTER USER CURRENT_USER() IDENTIFIED BY ${escapedPass}`);
          anyChanged = true;
        } catch (_) {}
      }

      // Flush privileges so all host bindings update in memory
      try {
        await this.connection.query('FLUSH PRIVILEGES');
      } catch (_) {}

      if (!anyChanged && lastErr) {
        throw lastErr;
      }

      // 4. Update session configuration
      const nextConfig = { ...this.config, password: newPassword };
      this.config = nextConfig;

      // 5. Re-authenticate active connection with new password
      try {
        await this.connection.changeUser({
          user: nextConfig.user || userName,
          password: newPassword,
          database: nextConfig.database
        });
        await this.connection.query('SELECT 1');
        this.connected = true;
        return { success: true, account: rawAccount, reconnected: true };
      } catch (reauthError) {
        try {
          const replacement = await mysql2.createConnection({
            ...nextConfig,
            connectTimeout: 10000,
            multipleStatements: true
          });
          await replacement.query('SELECT 1');
          const oldConnection = this.connection;
          this.connection = replacement;
          this.connected = true;
          try { await oldConnection?.end(); } catch (_) {}
          return { success: true, account: rawAccount, reconnected: true };
        } catch (reconnectError) {
          const oldConnection = this.connection;
          this.connection = null;
          this.connected = false;
          try { await oldConnection?.end(); } catch (_) {}
          return {
            success: true,
            account: rawAccount,
            reconnected: false,
            error: `Password was successfully updated on the server, but reconnecting the current session failed: ${reconnectError.message || reauthError.message}`
          };
        }
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
