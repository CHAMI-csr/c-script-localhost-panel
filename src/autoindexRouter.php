<?php
/**
 * C-Script LocalHost Panel — Smart Developer Directory Indexer Router
 *
 * Automatically used by C-Script LocalHost Panel when Directory Indexing is enabled.
 * - If index.php or index.html exists, it passes through to PHP untouched.
 * - If missing, it provides a modern, fast developer file browser with click-to-run execution.
 */

$docRoot = realpath($_SERVER['DOCUMENT_ROOT'] ?? getcwd());
$reqUri  = urldecode(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH));

// Normalize path
$target = $docRoot . $reqUri;
$fullPath = realpath($target);

// Prevent directory traversal outside document root
if ($fullPath && strpos($fullPath, $docRoot) !== 0) {
    http_response_code(403);
    echo '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center;"><h2>403 Forbidden</h2><p>Access outside document root is forbidden.</p></body></html>';
    exit;
}

// 1. If requesting an existing file, let PHP's built-in server handle/execute it normally
if ($fullPath && is_file($fullPath)) {
    return false;
}

// 2. If requesting a directory, check if index.php/index.html exists
if ($fullPath && is_dir($fullPath)) {
    // Ensure trailing slash for directories so relative navigation and links behave consistently
    $rawUri = $_SERVER['REQUEST_URI'] ?? '/';
    $pathOnly = parse_url($rawUri, PHP_URL_PATH) ?: '/';
    if ($pathOnly !== '/' && substr($pathOnly, -1) !== '/') {
        $query = isset($_SERVER['QUERY_STRING']) && $_SERVER['QUERY_STRING'] !== '' ? '?' . $_SERVER['QUERY_STRING'] : '';
        header('Location: ' . $pathOnly . '/' . $query, true, 301);
        exit;
    }

    $indexCandidates = ['index.php', 'index.html', 'index.htm'];
    foreach ($indexCandidates as $idx) {
        if (is_file($fullPath . DIRECTORY_SEPARATOR . $idx)) {
            return false; // Hand off to built-in server to run index.php
        }
    }

    // No index file exists -> Render C-Script Smart Directory Index
    renderCScriptDirectoryIndex($docRoot, $fullPath, $reqUri);
    exit;
}

// Fallback: file does not exist, let PHP built-in server report 404
return false;

/**
 * Render the C-Script Modern Developer Directory Listing
 */
function renderCScriptDirectoryIndex($docRoot, $dirPath, $reqUri) {
    $relPath = '/' . ltrim(str_replace('\\', '/', substr($dirPath, strlen($docRoot))), '/');
    $isRoot = ($dirPath === $docRoot);

    // Read items
    $items = [];
    $raw = @scandir($dirPath) ?: [];
    foreach ($raw as $name) {
        if ($name === '.' || $name === '..') continue;
        if ($name === '.git') continue;

        $itemPath = $dirPath . DIRECTORY_SEPARATOR . $name;
        $isDir = is_dir($itemPath);
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        $size = $isDir ? '-' : formatBytes(@filesize($itemPath) ?: 0);
        $mtime = @filemtime($itemPath) ? date('Y-m-d H:i:s', filemtime($itemPath)) : '—';
        $link = rtrim($reqUri, '/') . '/' . rawurlencode($name) . ($isDir ? '/' : '');

        $items[] = [
            'name' => $name,
            'isDir' => $isDir,
            'ext' => $ext,
            'size' => $size,
            'rawSize' => $isDir ? -1 : (@filesize($itemPath) ?: 0),
            'mtime' => $mtime,
            'link' => $link
        ];
    }

    // Sort: directories first, then files alphabetically
    usort($items, function($a, $b) {
        if ($a['isDir'] !== $b['isDir']) {
            return $a['isDir'] ? -1 : 1;
        }
        return strcasecmp($a['name'], $b['name']);
    });

    // Parent directory link
    $parentLink = null;
    if (!$isRoot) {
        $parent = dirname(rtrim($reqUri, '/'));
        $parentLink = ($parent === '/' || $parent === '\\') ? '/' : $parent . '/';
    }

    // Build breadcrumbs
    $parts = array_filter(explode('/', trim($relPath, '/')));
    $crumbs = '<a href="/" class="crumb">Home</a>';
    $accum = '';
    foreach ($parts as $p) {
        $accum .= '/' . $p;
        $crumbs .= ' <span class="sep">/</span> <a href="' . htmlspecialchars($accum . '/') . '" class="crumb">' . htmlspecialchars($p) . '</a>';
    }

    $siteHost = htmlspecialchars($_SERVER['HTTP_HOST'] ?? 'localhost');
    $phpVer = PHP_VERSION;

    header('Content-Type: text/html; charset=UTF-8');
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Index of <?= htmlspecialchars($relPath) ?> — <?= $siteHost ?></title>
  <style>
    :root {
      --bg: #0B0E14;
      --card-bg: #151922;
      --card-hover: #1C212D;
      --border: #262D3D;
      --text-main: #E2E8F0;
      --text-muted: #8E9BAE;
      --accent: #6366F1;
      --accent-glow: rgba(99, 102, 241, 0.15);
      --php-color: #8892BF;
      --folder-color: #F59E0B;
      --badge-bg: #1E293B;
      --badge-text: #94A3B8;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #F8FAFC;
        --card-bg: #FFFFFF;
        --card-hover: #F1F5F9;
        --border: #E2E8F0;
        --text-main: #0F172A;
        --text-muted: #64748B;
        --accent: #4F46E5;
        --accent-glow: rgba(79, 70, 229, 0.1);
        --php-color: #4F5B93;
        --folder-color: #D97706;
        --badge-bg: #EEF2FF;
        --badge-text: #4338CA;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      background: var(--bg);
      color: var(--text-main);
      padding: 30px 20px;
      line-height: 1.5;
    }
    .container {
      max-width: 980px;
      margin: 0 auto;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 16px;
      margin-bottom: 24px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }
    .brand-wrap {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: linear-gradient(135deg, #6366F1, #8B5CF6);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-weight: 800;
      font-size: 18px;
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
    }
    .title-block h1 {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.3px;
    }
    .title-block .domain {
      font-size: 13px;
      color: var(--text-muted);
    }
    .badges {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 20px;
      background: var(--badge-bg);
      color: var(--badge-text);
      border: 1px solid var(--border);
    }
    .badge.php {
      background: rgba(136, 146, 191, 0.15);
      color: var(--php-color);
      border-color: rgba(136, 146, 191, 0.3);
    }
    .search-bar {
      display: flex;
      align-items: center;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 8px 14px;
      margin-bottom: 18px;
      gap: 10px;
    }
    .search-bar input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: var(--text-main);
      font-size: 13px;
    }
    .search-bar input::placeholder {
      color: var(--text-muted);
    }
    .breadcrumbs {
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 16px;
      padding: 8px 12px;
      background: var(--card-bg);
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    .crumb {
      color: var(--accent);
      text-decoration: none;
      font-weight: 500;
    }
    .crumb:hover {
      text-decoration: underline;
    }
    .sep {
      color: var(--text-muted);
      margin: 0 4px;
    }
    .table-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      text-align: left;
    }
    th {
      background: rgba(124, 106, 247, 0.05);
      padding: 12px 16px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    tr:last-child td {
      border-bottom: none;
    }
    tr:hover td {
      background: var(--card-hover);
    }
    .file-link {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: var(--text-main);
      text-decoration: none;
      font-weight: 500;
      word-break: break-all;
    }
    .file-link:hover {
      color: var(--accent);
    }
    .file-link.is-php {
      font-weight: 600;
      color: var(--php-color);
    }
    .file-icon {
      font-size: 16px;
      width: 20px;
      text-align: center;
      flex-shrink: 0;
    }
    .badge-run {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 4px;
      background: var(--accent-glow);
      color: var(--accent);
      font-weight: 700;
      text-decoration: none;
      margin-left: 8px;
    }
    .badge-run:hover {
      background: var(--accent);
      color: #fff;
    }
    .size-col {
      color: var(--text-muted);
      font-family: monospace;
      font-size: 12px;
      width: 110px;
    }
    .date-col {
      color: var(--text-muted);
      font-size: 12px;
      width: 170px;
    }
    .empty-notice {
      padding: 40px;
      text-align: center;
      color: var(--text-muted);
    }
    .footer {
      margin-top: 24px;
      text-align: center;
      font-size: 12px;
      color: var(--text-muted);
    }
    .footer a {
      color: var(--accent);
      text-decoration: none;
    }
  </style>
</head>
<body>
<div class="container">

  <div class="header">
    <div class="brand-wrap">
      <div class="brand-icon">CS</div>
      <div class="title-block">
        <h1>Index of <?= htmlspecialchars($relPath) ?></h1>
        <div class="domain"><?= $siteHost ?> &bull; C-Script LocalHost Panel</div>
      </div>
    </div>
    <div class="badges">
      <span class="badge php">PHP <?= htmlspecialchars($phpVer) ?></span>
      <span class="badge">Autoindex Active</span>
    </div>
  </div>

  <div class="breadcrumbs">
    <?= $crumbs ?>
  </div>

  <div class="search-bar">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-muted);flex-shrink:0"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
    <input type="text" id="filter-input" placeholder="Quick filter files (type filename)..." autofocus oninput="filterFiles(this.value)">
    <span id="file-counter" style="font-size:11px;color:var(--text-muted);">Showing <?= count($items) ?> items</span>
  </div>

  <div class="table-card">
    <table id="files-table">
      <thead>
        <tr>
          <th>File / Directory</th>
          <th class="size-col">Size</th>
          <th class="date-col">Last Modified</th>
        </tr>
      </thead>
      <tbody>
        <?php if ($parentLink): ?>
        <tr class="item-row" data-name="..">
          <td>
            <a href="<?= htmlspecialchars($parentLink) ?>" class="file-link" style="color:var(--accent)">
              <span class="file-icon" style="display:inline-flex;align-items:center;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><polyline points="12 10 9 13 12 16"></polyline></svg>
              </span>
              <span>.. (Parent Directory)</span>
            </a>
          </td>
          <td class="size-col">—</td>
          <td class="date-col">—</td>
        </tr>
        <?php endif; ?>

        <?php if (empty($items)): ?>
        <tr>
          <td colspan="3" class="empty-notice">
            No files found in this directory. Create your first <code>.php</code> or <code>.html</code> file to get started!
          </td>
        </tr>
        <?php else: ?>
        <?php foreach ($items as $item): 
            $isPhp = ($item['ext'] === 'php');
            $icon = getFileSvgIcon($item['isDir'], $item['ext']);
        ?>
        <tr class="item-row" data-name="<?= htmlspecialchars(strtolower($item['name'])) ?>">
          <td>
            <a href="<?= htmlspecialchars($item['link']) ?>" class="file-link <?= $isPhp ? 'is-php' : '' ?>">
              <span class="file-icon" style="display:inline-flex;align-items:center;"><?= $icon ?></span>
              <span><?= htmlspecialchars($item['name']) ?><?= $item['isDir'] ? '/' : '' ?></span>
            </a>
            <?php if ($isPhp): ?>
              <a href="<?= htmlspecialchars($item['link']) ?>" class="badge-run" title="Execute script">Run &rarr;</a>
            <?php endif; ?>
          </td>
          <td class="size-col"><?= htmlspecialchars($item['size']) ?></td>
          <td class="date-col"><?= htmlspecialchars($item['mtime']) ?></td>
        </tr>
        <?php endforeach; ?>
        <?php endif; ?>
      </tbody>
    </table>
  </div>

  <div class="footer">
    Powered by <strong>C-Script LocalHost Panel</strong> &bull; Developer Directory Indexer
  </div>

</div>

<script>
function filterFiles(query) {
  const q = String(query || '').trim().toLowerCase();
  const rows = document.querySelectorAll('.item-row');
  let count = 0;
  rows.forEach(r => {
    const name = r.getAttribute('data-name') || '';
    if (name === '..') return; // Always keep parent directory
    const match = !q || name.includes(q);
    r.style.display = match ? '' : 'none';
    if (match) count++;
  });
  const counter = document.getElementById('file-counter');
  if (counter) counter.textContent = q ? `Found ${count} matching item(s)` : `Showing <?= count($items) ?> items`;
}
</script>
</body>
</html>
<?php
}

function formatBytes($bytes, $precision = 1) {
    if ($bytes <= 0) return '0 B';
    $units = ['B', 'KB', 'MB', 'GB', 'TB'];
    $i = (int) floor(log($bytes, 1024));
    if ($i >= count($units)) $i = count($units) - 1;
    return round($bytes / pow(1024, $i), $precision) . ' ' . $units[$i];
}

function getFileSvgIcon($isDir, $ext) {
    if ($isDir) {
        return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
    }
    if ($ext === 'php') {
        return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>';
    }
    if (in_array($ext, ['html', 'htm'])) {
        return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>';
    }
    if (in_array($ext, ['js', 'json', 'ts'])) {
        return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>';
    }
    if ($ext === 'css') {
        return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ec4899" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"></path></svg>';
    }
    if (in_array($ext, ['sql', 'db', 'sqlite'])) {
        return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>';
    }
    if (in_array($ext, ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'])) {
        return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';
    }
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';
}
