/**
 * Repair stale PHP ini settings before PHP is started.
 * Only missing absolute resources and duplicate extension directives are changed.
 */

const fs = require('fs');
const path = require('path');

function normalizeWindowsPath(value) {
  return String(value || '').replace(/[\\/]+/g, '\\');
}

function getDirectiveValue(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '').trim();
}

function getExtensionKey(type, value) {
  const filename = path.win32.basename(value);
  const moduleName = filename.replace(/^php_/i, '').replace(/\.dll$/i, '').toLowerCase();
  return `${String(type).toLowerCase()}:${moduleName}`;
}

function repairIniFile(iniPath) {
  if (!fs.existsSync(iniPath)) return [];

  let original;
  try {
    original = fs.readFileSync(iniPath, 'utf8');
  } catch (error) {
    return [];
  }

  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const seenExtensions = new Set();
  const repairs = [];
  const updated = original.split(/\r?\n/).map(line => {
    const prepend = line.match(/^(\s*)(;?)\s*(auto_prepend_file|auto_append_file)\s*=\s*(.*?)\s*$/i);
    if (prepend && prepend[2] !== ';') {
      const configuredPath = getDirectiveValue(prepend[4]);
      const normalizedPath = normalizeWindowsPath(configuredPath);
      if (path.win32.isAbsolute(configuredPath) && !fs.existsSync(normalizedPath)) {
        repairs.push(`Disabled missing PHP loader in ${path.basename(iniPath)}`);
        return `; Disabled missing PHP loader by C-Script LocalHost Panel: ${line.trim()}`;
      }
    }

    const extension = line.match(/^(\s*)(;?)\s*(extension|zend_extension)\s*=\s*(.*?)\s*$/i);
    if (!extension || extension[2] === ';') return line;

    const value = getDirectiveValue(extension[4]);
    const normalizedPath = normalizeWindowsPath(value);
    if (path.win32.isAbsolute(value) && !fs.existsSync(normalizedPath)) {
      const extensionName = path.win32.basename(normalizedPath).replace(/^php_/i, '').replace(/\.dll$/i, '');
      repairs.push(`Disabled missing ${extensionName} extension in ${path.basename(iniPath)}`);
      return `; Disabled missing PHP extension by C-Script LocalHost Panel: ${line.trim()}`;
    }

    const key = getExtensionKey(extension[3], value);
    if (seenExtensions.has(key)) {
      repairs.push(`Disabled duplicate ${key.split(':').pop()} extension in ${path.basename(iniPath)}`);
      return `; Disabled duplicate PHP extension by C-Script LocalHost Panel: ${line.trim()}`;
    }
    seenExtensions.add(key);
    return line;
  }).join(eol);

  if (updated !== original) {
    try {
      fs.writeFileSync(iniPath, updated, 'utf8');
    } catch (error) {
      return [];
    }
  }
  return repairs;
}

function repairPhpConfigForBinary(binaryPath) {
  if (!binaryPath || !path.isAbsolute(binaryPath)) return [];

  const runtimeDir = path.dirname(binaryPath);
  const repairs = [];
  for (const name of ['php.ini', 'php-cli.ini']) {
    repairs.push(...repairIniFile(path.join(runtimeDir, name)));
  }
  return repairs;
}

module.exports = { repairPhpConfigForBinary };
