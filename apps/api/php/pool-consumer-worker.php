<?php
declare(strict_types=1);

// Private local IPC worker. This file is invoked by the LifeOS Node API over
// stdin/stdout and is never an HTTP endpoint.
ini_set('display_errors', '0');
ini_set('log_errors', '0');

function respond(array $payload, int $exitCode = 0): void {
    try {
        fwrite(STDOUT, json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n");
    } catch (Throwable) {
        fwrite(STDOUT, '{"ok":false,"error":{"code":"worker_response_failed"}}' . "\n");
        $exitCode = 1;
    }
    exit($exitCode);
}

function isWorkerTempFile(string $path, bool $mustExist): bool {
    $tmpRoot = realpath(sys_get_temp_dir());
    if ($tmpRoot === false || $path === '' || strpos($path, "\0") !== false) return false;
    $parent = realpath(dirname($path));
    if ($parent === false || ($parent !== $tmpRoot && strpos($parent, $tmpRoot . DIRECTORY_SEPARATOR) !== 0)) return false;
    if ($mustExist) {
        $real = realpath($path);
        return $real !== false && $real === $path && is_file($path) && !is_link($path);
    }
    return !file_exists($path) && !is_link($path);
}

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit(1);
}

$raw = stream_get_contents(STDIN);
if (!is_string($raw) || strlen($raw) > 16384) {
    respond(['ok' => false, 'error' => ['code' => 'invalid_request']], 1);
}

try {
    $input = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
} catch (Throwable) {
    respond(['ok' => false, 'error' => ['code' => 'invalid_request']], 1);
}
if (!is_array($input) || !is_string($input['op'] ?? null)) {
    respond(['ok' => false, 'error' => ['code' => 'invalid_request']], 1);
}

$consumer = getenv('LIFEOS_POOL_CONSUMER') ?: '2';
if (!preg_match('/^(?:[a-z][a-z0-9_-]{0,31}|[1-9][0-9]*)$/', $consumer)) {
    respond(['ok' => false, 'error' => ['code' => 'invalid_consumer_id']], 1);
}

define('STORE_CONSUMER', $consumer);
define('STORE_CONFIG', '/www/server/gdnbox-secrets/storage.php');
define('POOL_LEDGER_PATH', '/www/server/gdnbox-secrets/consumer-ledger.sqlite');

$realConfig = realpath(STORE_CONFIG);
$privateDirectory = realpath(dirname(POOL_LEDGER_PATH));
if (!is_file(STORE_CONFIG) || $realConfig !== STORE_CONFIG || $privateDirectory !== '/www/server/gdnbox-secrets'
    || !is_dir($privateDirectory) || !is_readable($privateDirectory) || !is_writable($privateDirectory)
    || (file_exists(POOL_LEDGER_PATH) && (!is_file(POOL_LEDGER_PATH) || !is_readable(POOL_LEDGER_PATH) || !is_writable(POOL_LEDGER_PATH)))) {
    respond(['ok' => false, 'error' => ['code' => 'private_storage_unavailable']], 1);
}

try {
    $consumerLayer = '/www/wwwroot/g.dnbox.cn/pool_consumer.php';
    if (!is_file($consumerLayer) || realpath($consumerLayer) !== $consumerLayer) {
        respond(['ok' => false, 'error' => ['code' => 'consumer_layer_unavailable']], 1);
    }
    require_once $consumerLayer;
    if (!class_exists('PoolConsumer', false)
        || !method_exists('PoolConsumer', 'downloadToFile')
        || !(new ReflectionMethod('PoolConsumer', 'downloadToFile'))->hasReturnType()
        || (string) (new ReflectionMethod('PoolConsumer', 'downloadToFile'))->getReturnType() !== 'string') {
        respond(['ok' => false, 'error' => ['code' => 'consumer_layer_outdated']], 1);
    }
    $pool = new PoolConsumer();
    $op = $input['op'];

    if ($op === 'usage') {
        $usage = $pool->usage();
        if (($usage['consumer'] ?? null) !== $consumer) {
            respond(['ok' => false, 'error' => ['code' => 'consumer_mismatch']], 1);
        }
        respond(['ok' => true, 'result' => $usage]);
    }

    if ($op === 'put') {
        $path = $input['path'] ?? null;
        $name = $input['name'] ?? '';
        $mime = $input['mime'] ?? 'application/octet-stream';
        if (!is_string($path) || !is_string($name) || !is_string($mime)) {
            respond(['ok' => false, 'error' => ['code' => 'invalid_request']], 1);
        }
        if (!isWorkerTempFile($path, true)) {
            respond(['ok' => false, 'error' => ['code' => 'invalid_temp_file']], 1);
        }
        $key = $pool->putFile($path, $name, $mime);
        if (!is_string($key) || $key === '') throw new RuntimeException('pool_upload_key_unavailable');
        respond(['ok' => true, 'result' => ['key' => $key]]);
    }

    if ($op === 'download') {
        $key = $input['key'] ?? null;
        $path = $input['path'] ?? null;
        if (!is_string($key) || !is_string($path)) {
            respond(['ok' => false, 'error' => ['code' => 'invalid_request']], 1);
        }
        if (!isWorkerTempFile($path, false)) {
            respond(['ok' => false, 'error' => ['code' => 'invalid_temp_file']], 1);
        }
        // PoolConsumer returns the exact UTC month it charged inside its write
        // transaction. Older layers that return void are rejected fail-closed.
        $month = $pool->downloadToFile($key, $path);
        if (!is_string($month) || !preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $month)) {
            throw new RuntimeException('pool_charged_month_unavailable');
        }
        $bytes = filesize($path);
        if ($bytes === false) throw new RuntimeException('download_size_unavailable');
        respond(['ok' => true, 'result' => ['month' => $month, 'bytes' => $bytes]]);
    }

    if ($op === 'delete') {
        $key = $input['key'] ?? null;
        if (!is_string($key)) {
            respond(['ok' => false, 'error' => ['code' => 'invalid_request']], 1);
        }
        $pool->delete($key);
        respond(['ok' => true, 'result' => ['deleted' => true]]);
    }

    respond(['ok' => false, 'error' => ['code' => 'unsupported_operation']], 1);
} catch (Throwable $error) {
    $message = $error->getMessage();
    $errorCode = str_contains($message, '额度不足') ? 'quota_exceeded' : 'pool_operation_failed';
    if (($input['op'] ?? null) === 'download') {
        if ($message === '对象不存在、未完成上传，或不属于本项目' || $message === '目标文件已存在，不会覆盖') {
            $errorCode = 'download_rejected';
        } elseif ($message === '无法创建下载目标文件' || $message === '下载失败或文件大小不符') {
            $errorCode = 'download_failed_refunded';
        }
    }
    $result = ['ok' => false, 'error' => ['code' => $errorCode]];
    // putFile deliberately keeps an ambiguous object as pending. Return its key
    // only over this private process pipe so LifeOS can reserve it for review.
    if (($input['op'] ?? null) === 'put' && preg_match('/key=([^\s]+)$/u', $message, $match) === 1) {
        $result['error']['code'] = 'upload_pending';
        $result['error']['pendingKey'] = $match[1];
    }
    respond($result, 1);
}
