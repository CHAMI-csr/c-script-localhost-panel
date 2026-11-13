'use strict';

const fs = require('fs');
const path = require('path');

const DRAFT_FILE = 'sql-editor-draft.json';

function normalizeContent(content) {
  return typeof content === 'string' ? content : String(content ?? '');
}

function writeSqlDocument(filePath, content) {
  if (typeof filePath !== 'string' || !filePath.trim() || !path.isAbsolute(filePath)) {
    return { success: false, error: 'A valid absolute SQL file path is required' };
  }
  try {
    fs.writeFileSync(filePath, normalizeContent(content), 'utf8');
    return { success: true, filePath };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function draftPath(userDataPath) {
  return path.join(userDataPath, DRAFT_FILE);
}

function saveSqlDraft(userDataPath, content) {
  const target = draftPath(userDataPath);
  const temporary = `${target}.tmp`;
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({
      content: normalizeContent(content),
      updatedAt: new Date().toISOString()
    }), 'utf8');
    fs.renameSync(temporary, target);
    return { success: true, filePath: target };
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) {}
    return { success: false, error: error.message };
  }
}

function loadSqlDraft(userDataPath) {
  const target = draftPath(userDataPath);
  try {
    if (!fs.existsSync(target)) return { success: true, content: '', updatedAt: null };
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    return {
      success: true,
      content: normalizeContent(parsed?.content),
      updatedAt: parsed?.updatedAt || null
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function clearSqlDraft(userDataPath) {
  const target = draftPath(userDataPath);
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = { writeSqlDocument, saveSqlDraft, loadSqlDraft, clearSqlDraft };
