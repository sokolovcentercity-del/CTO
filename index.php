<?php
// FILE_MARKER: API-20260626-1312-v2
/**
 * REST API для хранения данных приложения «Оснащение организаций»
 * Файл: /api/index.php
 *
 * Endpoints:
 *   GET  ?action=ping               → { "ok": true }
 *   GET  ?action=getall             → { "ok": true, "data": { "key": "value", ... } }
 *   POST ?action=setall             body: { "data": { "key": "value", ... } }  → { "ok": true }
 *   GET  ?action=get&key=xxx        → { "ok": true, "value": "..." }
 *   POST ?action=set                body: { "key": "...", "value": "..." }  → { "ok": true }
 *   POST ?action=writefile          body: { "path": "...", "content": "...", "password": "..." } → { "ok": true }
 *   POST ?action=writefiles         body: { "files": [{"path":"...","content":"..."},...], "password": "..." } → { "ok": true, "results": [...] }
 *   POST ?action=append_log         body: { "entry": { "ts","q","a","mode","ms" } } → { "ok": true, "count": N }
 *   GET  ?action=get_logs           → { "ok": true, "logs": [...], "count": N }
 *   POST ?action=clear_logs         → { "ok": true }
 *   POST ?action=upload_act_media   multipart/form-data: file, kind=attachment|photo|video → { ok:true, file:{...} }
 *   GET  ?action=download_act_media&id=...&download=1|0 → binary stream
 *   POST ?action=delete_act_media   body: { "id": "..." } → { "ok": true }
 */

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// ── Конфиг ────────────────────────────────────────────────────────
define('DATA_FILE', __DIR__ . '/data/storage.json');
define('DATA_DIR',  __DIR__ . '/data');
define('LOGS_FILE', __DIR__ . '/data/assistant_logs.json');
define('LOGS_MAX',  2000);
define('ACT_MEDIA_DIR', __DIR__ . '/data/act_media');
define('ACT_MEDIA_INDEX_FILE', __DIR__ . '/data/act_media_index.json');
define('ACT_MEDIA_MAX_SIZE', 25 * 1024 * 1024); // 25 MB per file
define('API_FILE_MARKER', 'API-20260626-1312-v2');

define('WRITE_PASSWORD', 'sync2025');
define('SITE_ROOT', dirname(__DIR__));
define('ALLOWED_EXTENSIONS', ['js', 'css', 'html', 'json', 'php', 'md', 'txt', 'htaccess']);
define('FORBIDDEN_PATHS', ['api/data/storage.json', 'api/data/', 'api/index.php']);

// ── Helpers ───────────────────────────────────────────────────────

function ok($extra = []) {
    echo json_encode(array_merge(['ok' => true], $extra), JSON_UNESCAPED_UNICODE);
    exit;
}

function fail($msg = 'error', $code = 400) {
    http_response_code($code);
    echo json_encode(['ok' => false, 'error' => $msg], JSON_UNESCAPED_UNICODE);
    exit;
}

function ensureDir($dir) {
    if (!is_dir($dir)) {
        return mkdir($dir, 0755, true);
    }
    return true;
}

function loadJsonFile($path, $fallback = []) {
    if (!file_exists($path)) return $fallback;
    $raw = file_get_contents($path);
    if ($raw === false) return $fallback;
    $data = json_decode($raw, true);
    return is_array($data) ? $data : $fallback;
}

function saveJsonFile($path, $data) {
    $dir = dirname($path);
    if (!ensureDir($dir)) return false;
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    $tmp = $path . '.tmp';
    if (file_put_contents($tmp, $json, LOCK_EX) === false) return false;
    return rename($tmp, $path);
}

function loadData() {
    return loadJsonFile(DATA_FILE, []);
}

function saveData($data) {
    return saveJsonFile(DATA_FILE, $data);
}

function isPathAllowed($path) {
    $path = ltrim(str_replace('\\', '/', $path), '/');

    if (strpos($path, '..') !== false) return false;
    if (strpos($path, './') !== false) return false;

    foreach (FORBIDDEN_PATHS as $forbidden) {
        if (strpos($path, $forbidden) === 0) return false;
    }

    $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    $basename = strtolower(basename($path));
    if ($basename === '.htaccess' || $basename === 'htaccess') return true;
    if (!in_array($ext, ALLOWED_EXTENSIONS, true)) return false;

    return true;
}

// ── Логи ИИ-помощника ─────────────────────────────────────────────

function loadLogs() {
    return loadJsonFile(LOGS_FILE, []);
}

function saveLogs($logs) {
    return saveJsonFile(LOGS_FILE, $logs);
}

function appendLog($entry) {
    $logs = loadLogs();
    $safe = [
        'ts'   => substr((string)($entry['ts']   ?? date('c')), 0, 40),
        'q'    => substr((string)($entry['q']    ?? ''), 0, 2000),
        'a'    => substr((string)($entry['a']    ?? ''), 0, 8000),
        'mode' => substr((string)($entry['mode'] ?? 'unknown'), 0, 20),
        'ms'   => (int)($entry['ms'] ?? 0),
    ];
    $logs[] = $safe;
    if (count($logs) > LOGS_MAX) {
        $logs = array_slice($logs, count($logs) - LOGS_MAX);
    }
    return saveLogs($logs) ? count($logs) : false;
}

// ── Работа с файлами проекта ─────────────────────────────────────

function writeFile($path, $content) {
    $path = ltrim(str_replace('\\', '/', $path), '/');
    $fullPath = SITE_ROOT . '/' . $path;
    $dir = dirname($fullPath);

    if (!ensureDir($dir)) {
        return ['ok' => false, 'error' => 'Не удалось создать директорию: ' . $dir];
    }

    $tmp = $fullPath . '.tmp_' . uniqid('', true);
    if (file_put_contents($tmp, $content, LOCK_EX) === false) {
        return ['ok' => false, 'error' => 'Не удалось записать файл: ' . $path];
    }
    if (!rename($tmp, $fullPath)) {
        @unlink($tmp);
        return ['ok' => false, 'error' => 'Не удалось сохранить файл: ' . $path];
    }

    return ['ok' => true, 'path' => $path, 'size' => strlen($content)];
}

// ── Файлы актов ───────────────────────────────────────────────────

function loadActMediaIndex() {
    return loadJsonFile(ACT_MEDIA_INDEX_FILE, []);
}

function saveActMediaIndex($index) {
    return saveJsonFile(ACT_MEDIA_INDEX_FILE, $index);
}

function ensureUtf8String($value) {
    $value = (string)$value;
    if ($value === '') return '';
    if (preg_match('//u', $value)) return $value;

    if (function_exists('mb_convert_encoding')) {
        $converted = @mb_convert_encoding($value, 'UTF-8', 'UTF-8,Windows-1251,CP1251,ISO-8859-1');
        if (is_string($converted) && $converted !== '' && preg_match('//u', $converted)) {
            return $converted;
        }
    }

    if (function_exists('iconv')) {
        foreach (['Windows-1251', 'CP1251', 'ISO-8859-1'] as $encoding) {
            $converted = @iconv($encoding, 'UTF-8//IGNORE', $value);
            if (is_string($converted) && $converted !== '' && preg_match('//u', $converted)) {
                return $converted;
            }
        }
    }

    return preg_replace('/[\x00-\x1F\x7F]/', '', $value) ?: $value;
}

function isGenericUploadedFilename($name) {
    $name = strtolower(trim((string)$name));
    if ($name === '') return true;
    return in_array($name, ['file', 'blob', 'image', 'photo', 'video', 'attachment'], true);
}

function sanitizeOriginalFilename($name) {
    $name = trim(ensureUtf8String($name));
    if ($name === '') return 'file';
    $name = preg_replace('/[\x00-\x1F\x7F]+/', '', $name);
    $name = preg_replace('/[\\\/]+/', '-', $name);
    $name = preg_replace('/[:*?"<>|]+/', '-', $name);
    $name = trim((string)$name, ". \t\n\r\0\x0B");
    return $name !== '' ? $name : 'file';
}

function decodeUploadedOriginalNameBase64($value) {
    $value = trim((string)$value);
    if ($value === '') return '';

    $decoded = base64_decode($value, true);
    if (!is_string($decoded) || $decoded === '') return '';

    if (function_exists('mb_convert_encoding')) {
        $converted = @mb_convert_encoding($decoded, 'UTF-8', 'UTF-8');
        if (is_string($converted) && $converted !== '' && preg_match('//u', $converted)) {
            return $converted;
        }
    }

    if (preg_match('//u', $decoded)) return $decoded;
    return '';
}

function resolveUploadedOriginalName($postedOriginalName, $fallbackUploadName) {
    $posted = sanitizeOriginalFilename($postedOriginalName);
    $fallback = sanitizeOriginalFilename($fallbackUploadName);

    if (!isGenericUploadedFilename($posted)) {
        $chosen = $posted;
    } elseif (!isGenericUploadedFilename($fallback)) {
        $chosen = $fallback;
    } else {
        $chosen = $posted !== 'file' ? $posted : $fallback;
    }

    $chosenExt = sanitizeExtension(pathinfo($chosen, PATHINFO_EXTENSION));
    $fallbackExt = sanitizeExtension(pathinfo($fallback, PATHINFO_EXTENSION));
    if ($chosenExt === '' && $fallbackExt !== '' && !isGenericUploadedFilename($fallback)) {
        $chosen .= '.' . $fallbackExt;
    }

    $chosen = trim((string)$chosen);
    return $chosen !== '' ? $chosen : 'file';
}

function sanitizeExtension($ext) {
    $ext = strtolower(trim((string)$ext));
    $ext = preg_replace('/[^a-z0-9]+/', '', $ext);
    return substr($ext, 0, 10);
}

function guessExtensionFromMime($mime) {
    $map = [
        'image/jpeg' => 'jpg',
        'image/png' => 'png',
        'image/webp' => 'webp',
        'image/gif' => 'gif',
        'video/mp4' => 'mp4',
        'video/webm' => 'webm',
        'video/quicktime' => 'mov',
        'video/x-m4v' => 'm4v',
        'video/3gpp' => '3gp',
        'application/pdf' => 'pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' => 'docx',
        'application/msword' => 'doc',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' => 'xlsx',
        'application/vnd.ms-excel' => 'xls',
        'text/plain' => 'txt',
        'text/csv' => 'csv',
    ];
    return $map[$mime] ?? 'bin';
}

function guessMimeFromExtension($ext) {
    $map = [
        'jpg' => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'png' => 'image/png',
        'webp' => 'image/webp',
        'gif' => 'image/gif',
        'mp4' => 'video/mp4',
        'webm' => 'video/webm',
        'mov' => 'video/quicktime',
        'm4v' => 'video/x-m4v',
        '3gp' => 'video/3gpp',
        'pdf' => 'application/pdf',
        'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'doc' => 'application/msword',
        'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'xls' => 'application/vnd.ms-excel',
        'txt' => 'text/plain',
        'csv' => 'text/csv',
        'json' => 'application/json',
    ];
    return $map[strtolower((string)$ext)] ?? 'application/octet-stream';
}

function normalizeUploadedMimeType($mime, $ext) {
    $mime = strtolower(trim((string)$mime));
    $ext = strtolower(trim((string)$ext));
    if ($mime === '' || $mime === 'application/octet-stream' || $mime === 'application/zip') {
        return guessMimeFromExtension($ext);
    }
    return $mime;
}

function buildActMediaRecord($id, $kind, $originalName, $storedName, $mimeType, $sizeBytes) {
    return [
        'id' => $id,
        'kind' => $kind,
        'originalName' => $originalName,
        'storedName' => $storedName,
        'mimeType' => $mimeType,
        'sizeBytes' => $sizeBytes,
        'uploadedAt' => date('c'),
    ];
}

function streamActMedia($record, $forceDownload = false) {
    $filePath = ACT_MEDIA_DIR . '/' . $record['storedName'];
    if (!file_exists($filePath) || !is_file($filePath)) {
        fail('Файл не найден', 404);
    }

    header_remove('Content-Type');
    header_remove('Content-Length');
    header('Content-Type: ' . ($record['mimeType'] ?: 'application/octet-stream'));
    header('Content-Length: ' . filesize($filePath));
    header('Cache-Control: private, max-age=3600');
    header('X-Content-Type-Options: nosniff');

    $disposition = $forceDownload ? 'attachment' : 'inline';
    $originalName = (string)($record['originalName'] ?? 'file');
    $safeName = str_replace(['"', "\r", "\n"], '', $originalName);
    $asciiFallback = preg_replace('/[^A-Za-z0-9._-]+/', '_', $safeName);
    if (!$asciiFallback || trim($asciiFallback, '_') === '') {
        $asciiFallback = 'file';
        $ext = pathinfo($safeName, PATHINFO_EXTENSION);
        if ($ext) $asciiFallback .= '.' . preg_replace('/[^A-Za-z0-9]+/', '', $ext);
    }
    $encodedName = rawurlencode($safeName);
    header("Content-Disposition: {$disposition}; filename=\"{$asciiFallback}\"; filename*=UTF-8''{$encodedName}");

    readfile($filePath);
    exit;
}

function deleteActMediaById($id) {
    $index = loadActMediaIndex();
    if (!isset($index[$id])) return false;
    $record = $index[$id];
    $filePath = ACT_MEDIA_DIR . '/' . ($record['storedName'] ?? '');
    if (is_file($filePath)) {
        @unlink($filePath);
    }
    unset($index[$id]);
    saveActMediaIndex($index);
    return true;
}

// ── Роутинг ───────────────────────────────────────────────────────

$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];

if ($action === 'ping') {
    ok(['write_enabled' => true, 'act_media_enabled' => true, 'file_marker' => API_FILE_MARKER]);
}

if ($action === 'getall' && $method === 'GET') {
    ok(['data' => loadData()]);
}

if ($action === 'setall' && $method === 'POST') {
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body) || !isset($body['data']) || !is_array($body['data'])) {
        fail('Invalid body: expected { "data": { ... } }');
    }
    if (!saveData($body['data'])) {
        fail('Failed to save data', 500);
    }
    ok();
}

if ($action === 'get' && $method === 'GET') {
    $key = $_GET['key'] ?? '';
    if ($key === '') fail('Missing key');
    $data = loadData();
    if (!array_key_exists($key, $data)) {
        ok(['value' => null]);
    }
    ok(['value' => $data[$key]]);
}

if ($action === 'set' && $method === 'POST') {
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body) || !isset($body['key'])) {
        fail('Invalid body: expected { "key": "...", "value": "..." }');
    }
    $data = loadData();
    $data[$body['key']] = $body['value'] ?? null;
    if (!saveData($data)) {
        fail('Failed to save data', 500);
    }
    ok();
}

if ($action === 'writefile' && $method === 'POST') {
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) fail('Invalid JSON body');

    $password = $body['password'] ?? '';
    if ($password !== WRITE_PASSWORD) fail('Неверный пароль синхронизации', 403);

    $path    = $body['path']    ?? '';
    $content = $body['content'] ?? '';
    if (!$path) fail('Не указан путь файла');
    if (!isPathAllowed($path)) fail('Путь не разрешён: ' . $path, 403);

    $result = writeFile($path, $content);
    if (!$result['ok']) fail($result['error'], 500);
    ok(['path' => $result['path'], 'size' => $result['size']]);
}

if ($action === 'writefiles' && $method === 'POST') {
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) fail('Invalid JSON body');

    $password = $body['password'] ?? '';
    if ($password !== WRITE_PASSWORD) fail('Неверный пароль синхронизации', 403);

    $files = $body['files'] ?? [];
    if (!is_array($files) || empty($files)) fail('Нет файлов для записи');

    $results = [];
    $ok_count = 0;
    $fail_count = 0;

    foreach ($files as $fileItem) {
        $path    = $fileItem['path']    ?? '';
        $content = $fileItem['content'] ?? '';

        if (!$path) {
            $results[] = ['ok' => false, 'path' => $path, 'error' => 'Пустой путь'];
            $fail_count++;
            continue;
        }

        if (!isPathAllowed($path)) {
            $results[] = ['ok' => false, 'path' => $path, 'error' => 'Путь не разрешён'];
            $fail_count++;
            continue;
        }

        $r = writeFile($path, $content);
        $results[] = $r;
        if ($r['ok']) $ok_count++; else $fail_count++;
    }

    ok([
        'ok_count'   => $ok_count,
        'fail_count' => $fail_count,
        'results'    => $results,
    ]);
}

if ($action === 'append_log' && $method === 'POST') {
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body) || !isset($body['entry']) || !is_array($body['entry'])) {
        fail('Invalid body: expected { "entry": { ... } }');
    }
    $count = appendLog($body['entry']);
    if ($count === false) fail('Не удалось сохранить запись', 500);
    ok(['count' => $count]);
}

if ($action === 'get_logs' && $method === 'GET') {
    $logs = loadLogs();
    ok(['logs' => $logs, 'count' => count($logs)]);
}

if ($action === 'clear_logs' && $method === 'POST') {
    if (file_exists(LOGS_FILE) && !unlink(LOGS_FILE)) {
        fail('Не удалось удалить файл логов', 500);
    }
    ok(['cleared' => true]);
}

if ($action === 'upload_act_media' && $method === 'POST') {
    if (!isset($_FILES['file'])) {
        fail('Файл не передан');
    }

    $file = $_FILES['file'];
    if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        fail('Ошибка загрузки файла');
    }

    $size = (int)($file['size'] ?? 0);
    if ($size <= 0) fail('Файл пустой');
    if ($size > ACT_MEDIA_MAX_SIZE) fail('Файл слишком большой. Максимум 25 МБ', 413);

    $kind = trim((string)($_POST['kind'] ?? 'attachment'));
    if (!in_array($kind, ['attachment', 'photo', 'video'], true)) {
        $kind = 'attachment';
    }
    $postedOriginalName = decodeUploadedOriginalNameBase64($_POST['originalNameBase64'] ?? '');
    if ($postedOriginalName === '') {
        $postedOriginalName = trim((string)($_POST['originalName'] ?? ''));
    }
    $fallbackUploadName = (string)($file['name'] ?? 'file');
    $originalName = resolveUploadedOriginalName($postedOriginalName, $fallbackUploadName);

    $mimeType = 'application/octet-stream';
    if (function_exists('finfo_open')) {
        $finfo = finfo_open(FILEINFO_MIME_TYPE);
        if ($finfo) {
            $detected = finfo_file($finfo, $file['tmp_name']);
            if (is_string($detected) && $detected !== '') $mimeType = $detected;
            finfo_close($finfo);
        }
    }

    $ext = sanitizeExtension(pathinfo($originalName, PATHINFO_EXTENSION));
    if ($ext === '') $ext = guessExtensionFromMime($mimeType);
    $mimeType = normalizeUploadedMimeType($mimeType, $ext);

    if (!ensureDir(ACT_MEDIA_DIR)) {
        fail('Не удалось создать директорию для файлов', 500);
    }

    try {
        $id = bin2hex(random_bytes(12));
    } catch (Throwable $e) {
        $id = uniqid('act_', true);
        $id = preg_replace('/[^a-zA-Z0-9_\-]+/', '', $id);
    }

    $storedName = $id . ($ext ? ('.' . $ext) : '');
    $targetPath = ACT_MEDIA_DIR . '/' . $storedName;

    if (!move_uploaded_file($file['tmp_name'], $targetPath)) {
        fail('Не удалось сохранить файл на сервере', 500);
    }

    $record = buildActMediaRecord($id, $kind, $originalName, $storedName, $mimeType, filesize($targetPath));
    $index = loadActMediaIndex();
    $index[$id] = $record;
    if (!saveActMediaIndex($index)) {
        @unlink($targetPath);
        fail('Не удалось сохранить индекс файлов', 500);
    }

    ok(['file' => $record]);
}

if ($action === 'download_act_media' && $method === 'GET') {
    $id = trim((string)($_GET['id'] ?? ''));
    if ($id === '') fail('Не указан id файла');
    $index = loadActMediaIndex();
    if (!isset($index[$id])) {
        fail('Файл не найден', 404);
    }
    $forceDownload = (string)($_GET['download'] ?? '') === '1';
    streamActMedia($index[$id], $forceDownload);
}

if ($action === 'delete_act_media' && $method === 'POST') {
    $body = json_decode(file_get_contents('php://input'), true);
    $id = trim((string)($body['id'] ?? ''));
    if ($id === '') fail('Не указан id файла');
    if (!deleteActMediaById($id)) {
        fail('Файл не найден', 404);
    }
    ok(['deleted' => true]);
}

fail('Unknown action', 404);
