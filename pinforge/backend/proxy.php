<?php
// backend/proxy.php — OPTIONAL server proxy for PinForge.
// The extension sends { model, body } here; this script adds the secret Gemini key
// and forwards the request to Google. The key never reaches the browser.
//
// Requirements: PHP 8+, curl extension, HTTPS hosting.

declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');

$config = require __DIR__ . '/config.php';

function fail(int $code, string $message): void {
    http_response_code($code);
    echo json_encode(['error' => ['code' => $code, 'message' => $message]]);
    exit;
}

// --- CORS: only our extension may call this ---
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$allowedOrigins = array_map(fn($id) => 'chrome-extension://' . $id, $config['allowed_extension_ids']);
if ($origin !== '' && in_array($origin, $allowedOrigins, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, X-PinForge-Token');
}
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }
if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'Use POST.');
if ($origin !== '' && !in_array($origin, $allowedOrigins, true)) fail(403, 'Origin not allowed.');

// --- Auth ---
$token = $_SERVER['HTTP_X_PINFORGE_TOKEN'] ?? '';
if (!hash_equals((string)$config['access_token'], (string)$token)) fail(401, 'Invalid access token.');

// --- Rate limit (per IP, file based so it works on cheap hosting) ---
$ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$bucket = sys_get_temp_dir() . '/pinforge_rl_' . md5($ip) . '_' . date('YmdHi');
$count = (int)@file_get_contents($bucket) + 1;
@file_put_contents($bucket, (string)$count, LOCK_EX);
if ($count > (int)$config['max_requests_per_minute']) fail(429, 'Too many requests. Try again in a minute.');

// --- Validate input ---
$raw = file_get_contents('php://input');
if ($raw === false || strlen($raw) > 12 * 1024 * 1024) fail(413, 'Request too large.');
$data = json_decode($raw, true);
if (!is_array($data) || !isset($data['model'], $data['body']) || !is_array($data['body'])) fail(400, 'Invalid request.');
$model = (string)$data['model'];
if (!in_array($model, $config['allowed_models'], true)) fail(400, 'Model not allowed on this server.');

// --- Forward to Gemini ---
$url = 'https://generativelanguage.googleapis.com/v1beta/models/' . rawurlencode($model) . ':generateContent';
$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 90,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'x-goog-api-key: ' . $config['gemini_api_key']],
    CURLOPT_POSTFIELDS => json_encode($data['body']),
]);
$response = curl_exec($ch);
$status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErr = curl_error($ch);
curl_close($ch);
if ($response === false) fail(502, 'Could not reach Gemini: ' . $curlErr);

// --- Optional usage log ---
if (!empty($config['db']['dsn'])) {
    try {
        $pdo = new PDO($config['db']['dsn'], $config['db']['user'], $config['db']['pass'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $stmt = $pdo->prepare('INSERT INTO usage_log (ip_hash, model, http_status) VALUES (?, ?, ?)');
        $stmt->execute([hash('sha256', $ip), $model, $status]);
    } catch (Throwable $e) { /* logging must never break the proxy */ }
}

http_response_code($status ?: 502);
echo $response;
