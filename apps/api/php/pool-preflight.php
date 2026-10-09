<?php
declare(strict_types=1);
// CLI metadata probe. Never instantiate PoolConsumer, create a ledger or print credentials.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit(1); }
ini_set('display_errors', '0'); ini_set('log_errors', '0');
try {
    $input = json_decode((string)stream_get_contents(STDIN), true, 8, JSON_THROW_ON_ERROR);
    $consumer = (string)($input['consumer'] ?? '2');
    $goRoot = (string)($input['goRoot'] ?? '/www/wwwroot/g.dnbox.cn');
    $privateRoot = (string)($input['privateRoot'] ?? '/www/server/gdnbox-secrets');
    if (!preg_match('/^(?:[a-z][a-z0-9_-]{0,31}|[1-9][0-9]*)$/', $consumer)) throw new RuntimeException();
    $config = realpath($privateRoot . '/storage.php');
    $layer = realpath($goRoot . '/pool_consumer.php');
    if ($config === false || $layer === false || !is_readable($config) || !is_readable($layer)) throw new RuntimeException();
    define('STORE_CONFIG', $config); define('STORE_CONSUMER', $consumer);
    require_once $layer;
    $backends = [];
    foreach (store_backends() as $id => $b) $backends[] = [
        'id'=>(string)$id, 'bucket'=>$b['bucket'], 'prefix'=>$b['prefix'],
        'storageLimitBytes'=>(int)$b['storage_limit'], 'trafficLimitBytes'=>(int)$b['traffic_limit'],
        'credentialsConfigured'=>$b['access_key'] !== '' && $b['secret_key'] !== '',
        'usageApiConfigured'=>!empty($b['api_token']),
    ];
    $consumers = array_values(store_consumers());
    $registered = store_consumers()[$consumer] ?? null;
    $method = new ReflectionMethod('PoolConsumer', 'downloadToFile');
    $source = (string)file_get_contents($layer);
    echo json_encode(['ok'=>true, 'consumer'=>$consumer, 'registered'=>$registered !== null,
        'project'=>$registered === null ? null : [
            'id'=>(string)$registered['id'], 'name'=>(string)$registered['name'],
            'storage_limit'=>(int)$registered['storage_limit'], 'traffic_limit'=>(int)$registered['traffic_limit'],
        ], 'backends'=>$backends,
        'reservedStorageBytes'=>array_sum(array_column($consumers,'storage_limit')),
        'reservedTrafficBytes'=>array_sum(array_column($consumers,'traffic_limit')),
        'chargedMonthProtocol'=>$method->hasReturnType() && (string)$method->getReturnType() === 'string',
        'numericConsumerProtocol'=>!ctype_digit($consumer) || preg_match('/\|\[0-9\]\{1,32\}/', $source) === 1,
        'poolConsumerSha256'=>hash_file('sha256',$layer),
        'cliExtensions'=>['curl'=>extension_loaded('curl'),'pdo_sqlite'=>extension_loaded('pdo_sqlite')],
    ], JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR), "\n";
} catch (Throwable) {
    echo '{"ok":false,"error":"pool_metadata_unavailable"}', "\n"; exit(1);
}
