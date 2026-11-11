'use strict';

/**
 * Split MySQL text at top-level semicolons while preserving quoted strings,
 * identifiers, and comments. Returned ranges reference the original source.
 */
function splitSqlStatements(source) {
  const sql = String(source || '');
  const statements = [];
  let start = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  const push = end => {
    let from = start;
    let to = end;
    while (from < to && /\s/.test(sql[from])) from++;
    while (to > from && /\s/.test(sql[to - 1])) to--;
    if (to > from && !/^(?:--[^\r\n]*(?:\r?\n|$)|#[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/\s*)+$/.test(sql.slice(from, to))) {
      statements.push({ start: from, end: to, text: sql.slice(from, to) });
    }
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
    } else if (char === ';') {
      push(i);
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
