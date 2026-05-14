<?php
declare(strict_types=1);

/**
 * Hardened webhook deploy endpoint for cPanel/HahuCloud.
 *
 * Required env vars:
 * - DEPLOY_WEBHOOK_SECRET
 *
 * Optional env vars:
 * - DEPLOY_REPO_DIR (default: /home/youruser/apps/40bingo)
 * - DEPLOY_PUBLIC_DIR (default: /home/youruser/public_html)
 * - DEPLOY_ALLOWED_REF (default: refs/heads/main)
 */

if (php_sapi_name() === 'cli') {
    fwrite(STDERR, "This script is meant to run through HTTP.\n");
    exit(1);
}

$secret = trim((string) getenv('DEPLOY_WEBHOOK_SECRET'));
$repoDir = trim((string) getenv('DEPLOY_REPO_DIR')) ?: '/home/youruser/apps/40bingo';
$publicDir = trim((string) getenv('DEPLOY_PUBLIC_DIR')) ?: '/home/youruser/public_html';
$allowedRef = trim((string) getenv('DEPLOY_ALLOWED_REF')) ?: 'refs/heads/main';
$allowedBranch = preg_replace('#^refs/heads/#', '', $allowedRef ?? '');
$logFile = __DIR__ . '/deploy.log';

function write_log(string $message): void
{
    global $logFile;
    $line = sprintf("[%s] %s\n", date('c'), $message);
    file_put_contents($logFile, $line, FILE_APPEND | LOCK_EX);
}

function fail(int $status, string $message): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode(['ok' => false, 'message' => $message], JSON_UNESCAPED_SLASHES);
    exit;
}

function run_command(string $command): void
{
    $output = [];
    $exitCode = 0;
    exec($command . ' 2>&1', $output, $exitCode);
    if ($exitCode !== 0) {
        throw new RuntimeException(
            sprintf("Command failed (%d): %s\n%s", $exitCode, $command, implode("\n", $output))
        );
    }
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    fail(405, 'Method not allowed');
}

if ($secret === '') {
    write_log('Missing DEPLOY_WEBHOOK_SECRET env var.');
    fail(500, 'Server not configured');
}
if (!is_string($allowedBranch) || $allowedBranch === '' || !preg_match('/^[A-Za-z0-9._\/-]+$/', $allowedBranch)) {
    write_log("Invalid DEPLOY_ALLOWED_REF value: {$allowedRef}");
    fail(500, 'Server ref configuration error');
}

$payload = file_get_contents('php://input');
if ($payload === false || $payload === '') {
    fail(400, 'Empty payload');
}

$sig256 = $_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? '';
$sig1 = $_SERVER['HTTP_X_HUB_SIGNATURE'] ?? '';
$expected256 = 'sha256=' . hash_hmac('sha256', $payload, $secret);
$expected1 = 'sha1=' . hash_hmac('sha1', $payload, $secret);

$validSignature = false;
if (is_string($sig256) && $sig256 !== '') {
    $validSignature = hash_equals($expected256, $sig256);
} elseif (is_string($sig1) && $sig1 !== '') {
    $validSignature = hash_equals($expected1, $sig1);
}

if (!$validSignature) {
    write_log('Rejected webhook due to invalid signature.');
    fail(403, 'Unauthorized');
}

$event = $_SERVER['HTTP_X_GITHUB_EVENT'] ?? '';
if ($event !== 'push') {
    fail(202, 'Ignored non-push event');
}

$data = json_decode($payload, true);
if (!is_array($data)) {
    fail(400, 'Invalid JSON payload');
}

$ref = (string) ($data['ref'] ?? '');
if ($ref !== $allowedRef) {
    write_log("Ignored ref {$ref}; allowed {$allowedRef}");
    fail(202, 'Ignored branch');
}

if (!is_dir($repoDir) || !is_dir($publicDir)) {
    write_log("Invalid path(s). repo={$repoDir} public={$publicDir}");
    fail(500, 'Server path configuration error');
}

try {
    $repoArg = escapeshellarg($repoDir);
    $publicArg = escapeshellarg(rtrim($publicDir, '/') . '/');
    $distArg = escapeshellarg(rtrim($repoDir, '/') . '/frontend/dist/');
    $branchArg = escapeshellarg($allowedBranch);

    run_command("git -C {$repoArg} fetch --prune origin {$branchArg}");
    run_command("git -C {$repoArg} reset --hard origin/{$allowedBranch}");
    run_command("cd {$repoArg} && npm ci --prefix frontend");
    run_command("cd {$repoArg} && npm run build --prefix frontend");
    run_command("rsync -a --delete {$distArg} {$publicArg}");

    write_log("Deployment successful for ref {$ref}.");
    header('Content-Type: application/json');
    echo json_encode(['ok' => true, 'message' => 'Deployment successful'], JSON_UNESCAPED_SLASHES);
} catch (Throwable $e) {
    write_log('Deployment failed: ' . $e->getMessage());
    fail(500, 'Deployment failed');
}
