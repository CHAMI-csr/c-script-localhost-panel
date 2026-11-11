'use strict';

/**
 * Split MySQL text at top-level delimiters while preserving quoted strings,
 * identifiers, comments, and DELIMITER blocks used by routines/triggers.
 * Returned ranges reference the original source; DELIMITER directives and
 * terminators are excluded from executable statement text.
 */
function splitSqlStatements(source) {
  const sql = String(source || '');
  const statements = [];
  let start = 0;
  let delimiter = ';';
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  const isCommentOnly = text => /^(?:(?:--[^\r\n]*(?:\r?\n|$))|(?:#[^\r\n]*(?:\r?\n|$))|(?:\/\*[\s\S]*?\*\/)|\s)+$/.test(text);
  const push = end => {
    let from = start;
    let to = end;
    while (from < to && /\s/.test(sql[from])) from++;
    while (to > from && /\s/.test(sql[to - 1])) to--;
    const text = sql.slice(from, to);
    if (text && !isCommentOnly(text)) statements.push({ start: from, end: to, text });
  };

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (char === '\\') { i++; continue; }
      if (char === quote) {
        if (next === quote) { i++; continue; }
        quote = null;
      }
      continue;
    }

    // DELIMITER is a mysql-client directive, not server SQL. Recognize it only
    // at the beginning of a physical line and omit the directive from output.
    if (i === 0 || sql[i - 1] === '\n') {
      const lineEnd = sql.indexOf('\n', i);
      const end = lineEnd === -1 ? sql.length : lineEnd;
      const directive = sql.slice(i, end).match(/^\s*DELIMITER\s+(\S+)\s*$/i);
      if (directive) {
        push(i);
        delimiter = directive[1];
        start = lineEnd === -1 ? sql.length : lineEnd + 1;
        i = start - 1;
        continue;
      }
    }

    if (char === '-' && next === '-' && (i + 2 >= sql.length || /\s/.test(sql[i + 2]))) {
      lineComment = true;
      i++;
    } else if (char === '#') {
      lineComment = true;
    } else if (char === '/' && next === '*') {
      blockComment = true;
      i++;
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (delimiter && sql.startsWith(delimiter, i)) {
      push(i);
      i += delimiter.length - 1;
      start = i + 1;
    }
  }
  push(sql.length);
  return statements;
}

function statementAtCursor(source, cursor) {
  const sql = String(source || '');
  const position = Math.max(0, Math.min(Number(cursor) || 0, sql.length));
  const statements = splitSqlStatements(sql);
  if (!statements.length) return null;
  return statements.find(statement => position >= statement.start && position <= statement.end)
    || statements.find(statement => statement.start > position)
    || statements[statements.length - 1];
}

module.exports = { splitSqlStatements, statementAtCursor };
