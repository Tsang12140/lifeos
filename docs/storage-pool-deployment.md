# 弹指存储池同机接入核对

LifeOS 是 Node.js 服务，弹指接入层是 PHP。LifeOS 通过本机 PHP CLI 子进程调用 `PoolConsumer`，只用标准输入/输出传递操作结果；没有公开 PHP 接口，也没有把弹指的配置、密钥或账本复制到 LifeOS 网站目录。项目 ID 使用面板现存的 `2`。额度必须从 `PoolConsumer::usage()` 实时读取，不依据旧截图配置。已有用户数据的部署使用 [平滑接入第一阶段](storage-pool-transition.md)，后台只复制，日常继续使用旧存储。

## 上线前只读核对

在宝塔中打开 `lifeos.dnbox.cn` 的站点详情，记录反向代理上游和对应的 PM2 进程。打开 `g.dnbox.cn` 的站点详情，确认 `/www/wwwroot/g.dnbox.cn/pool_consumer.php` 就在**同一台操作系统主机**。两个域名解析到同一个公网 IP 只说明入口相同，不足以证明进程同机；如果 LifeOS 在容器中，还要确认容器能访问同一私有目录和同一 PHP CLI。现有代码固定要求这些绝对路径，路径无法访问时保持接入关闭。

在该主机终端只读查看（把实际 PM2 进程 PID 代入）：

```sh
pm2 describe lifeos
ps -o pid,user,group,args -p <LifeOS进程PID>
namei -l /www/wwwroot/g.dnbox.cn/pool_consumer.php
namei -l /www/server/gdnbox-secrets/storage.php
namei -l /www/server/gdnbox-secrets/consumer-ledger.sqlite
php -r 'echo PHP_VERSION, "\n"; foreach (["curl", "pdo_sqlite"] as $e) echo $e, ": ", extension_loaded($e) ? "yes" : "no", "\n"; echo "open_basedir: ", ini_get("open_basedir"), "\n";'
```

按 `ps` 得到的 LifeOS 运行用户执行只读权限探针，避免用当前管理员身份误判：

```sh
sudo -u <LifeOS运行用户> test -r /www/wwwroot/g.dnbox.cn/pool_consumer.php
sudo -u <LifeOS运行用户> test -r /www/server/gdnbox-secrets/storage.php
sudo -u <LifeOS运行用户> test -r /www/server/gdnbox-secrets/consumer-ledger.sqlite
sudo -u <LifeOS运行用户> test -w /www/server/gdnbox-secrets
sudo -u <LifeOS运行用户> test -w /www/server/gdnbox-secrets/consumer-ledger.sqlite
```

首次创建共享账本前，账本文件可以不存在；这时需要核对私有目录的读写和进入权限。PHP CLI 的 `open_basedir` 必须同时放行弹指接入层、私有配置与账本、LifeOS 上传临时文件和下载临时目录。只给运行用户必要的所有权、组权限或 ACL，不关闭防跨站保护，不使用 `chmod 777`。PHP 子进程继承 LifeOS 运行用户，因此应检查 **CLI** 配置和这个用户；仅检查弹指站点的 PHP-FPM 用户不够。既有共享账本还需允许弹指 PHP 用户读写，必要时为两个用户配置同一受限组或 ACL。

检查 `g.dnbox.cn` 上部署的 `pool_consumer.php` 已包含对已登记数字 ID `2` 的兼容修复，且 `downloadToFile()` 返回实际扣费的 UTC 月份字符串，并在弹指面板确认该 ID 及当时额度。LifeOS PHP worker 会在调用前检查后者；旧版接入层无法通过此检查。未部署修复时旧版 ID 校验也会拒绝 `2`。不要删除、重建项目或迁移已有对象。

## 统一账本检查工具

随源码上传 `scripts/check-storage-pool.mjs`、`apps/api/php/pool-preflight.php` 后，在服务器 LifeOS 目录以实际服务运行用户执行。历史部署路径如下，若已变更应使用当前目录和 Node 24 路径；私有 `.env` 的 PHP CLI 路径须正确。

```sh
cd /www/server/lifeos-app
/www/server/nodejs/v24.21.0/bin/node --env-file-if-exists=.env scripts/check-storage-pool.mjs
```

默认检查只读：读取弹指真实接入层和私有配置的白名单元数据，核对现存项目 `2`、额度、数字ID/UTC月份协议、PHP扩展、私有目录和共享账本权限、账本结构与项目统计。不实例化 `PoolConsumer`，不上传/删除，不输出密钥或对象key；账本不存在时返回 `FAIL`，不会在本机另造一份。可以贴回完整检查输出，私有配置文件内容不要贴。

只读检查全部通过、当前部署已构建后，加 `--usage` 调用既有生产 worker 核实实际项目用量：

```sh
/www/server/nodejs/v24.21.0/bin/node --env-file-if-exists=.env scripts/check-storage-pool.mjs --usage
```

此调用不上传/删除，但既有 `PoolConsumer` 初始化会沿用其账本权限处理；前置检查失败时不调用。`--usage` 禁止覆盖路径，仅使用生产 worker 固定的私有配置/统一账本。默认工具可用 `--go-root` / `--private-root` 做本地只读诊断，这种结果不能当成服务器已连接。

如果共享账本缺失，先在该服务器确认已有项目与双用户权限，再由既有接入层完成首次初始化，不能上传本地测试账本替代。CLI检查只代表当前用户和环境，不代表 PM2运行环境或弹指PHP-FPM权限；继续核对上面的进程和ACL。真实桶签名列举成功也不等于统一账本、用户额度、访问策略或完整恢复通过。按主人选择，本地真实数据测试接入既有项目 `2`，不创建单独消费方；指定测试账号的启动请求见 [迁移说明](storage-pool-transition.md#本地真实数据测试与统一账本)。

## 配置与启用顺序

2026-10-07 主人回传的云端检查已确认项目 `2`、四个桶和私有目录有效；未通过的项目为数字ID协议、下载UTC扣费月份和共享账本缺失。云端接入文件指纹对应旧 `299e272`。经主人明确授权，两个已验收修复 `58cdb06`、`e51d05e` 已推送到 `Tsang12140/go` 的 main，远端头确认 `e51d05ea9e754f3f059a3d9a07eb6d50d8c9218c`；服务器尚需拉取。不要用本地私有配置覆盖云端四桶配置，也不要重建项目 `2`。

按弹指 Git 发布流程，在宝塔 Git 部署对 `g.dnbox.cn` 点更新，或在终端执行：

```sh
cd /www/wwwroot/g.dnbox.cn
git fetch origin main
git merge --ff-only origin/main
git log -1 --oneline
cd /www/server/lifeos-app
/www/server/nodejs/v24.21.0/bin/node --env-file-if-exists=.env scripts/check-storage-pool.mjs
pm2 pid lifeos
ps -eo pid,user,group,comm | grep -E '(^ *PID|node|php-fpm)'
stat -c '%U:%G %a %n' /www/server/gdnbox-secrets /www/server/gdnbox-secrets/storage.php
```

`merge --ff-only` 若拒绝，不执行强制重置；保留现场并回传错误。终端若仍使用不可达的HTTPS远程，按弹指既有SSH over443流程将origin设为 `ssh://git@ssh.github.com:443/Tsang12140/go.git` 后再fetch/merge。更新后新接入文件SHA256应为 `8d0d8539b78cbf9f1102eb40b08c9ccc486cb464b5a1d03c351e432e5d7c82c8`，两个协议项通过；缺账本在初始化前仍为FAIL。

先看实际服务用户和私有目录归属，再通过既有接入层首次初始化统一账本。当前 `PoolConsumer` 每次初始化都执行账本 `chmod0600`，不能在root检查通过后就假设PHP-FPM用户能读取，也不能只设置一次ACL就认为后续不会被chmod收窄。按实际服务用户选择初始化主体并复核持续读写权限、面板及LifeOS用量一致；这个步骤尚未执行。上述进程探针只列PID、用户、组与程序名，不打印环境变量或命令参数中的凭据。

只在 LifeOS 服务端私有 `.env` 写入：

```dotenv
LIFEOS_STORAGE_POOL_ENABLED=1
# 已有数据平滑接入时同时开启，保护配置准备期间的本地写入。
LIFEOS_POOL_LOCAL_PRIMARY=1
LIFEOS_POOL_CONSUMER=2
LIFEOS_POOL_PHP_BINARY=/usr/bin/php
LIFEOS_POOL_WORKER_PATH=/实际部署目录/apps/api/php/pool-consumer-worker.php
```

`LIFEOS_POOL_WORKER_PATH` 可以省略，前提是部署结构与仓库一致。接入需要 LifeOS 账户模式；单密码模式没有逐用户额度管理，启用存储池会拒绝启动。LifeOS 的用户额度与对象归属写进现有 owner SQLite 数据库；弹指项目的对象/流量账目始终写入 `/www/server/gdnbox-secrets/consumer-ledger.sqlite`。不要把后者、`storage.php` 或 AK/SK 放到网站根目录、日志、Git 或 HTTP 参数中。

先做只读 `GET /api/admin/storage-pool`（需 owner 会话），核对 `consumer`、UTC 月份、项目存储/流量已用及上限、历史本地文件盘点、未归属用量。只有账目可核对且历史归属与大小盘点完成后再分配用户额度。分配额度只影响可分配余额，不会增加项目实际用量。第一阶段需管理员明确开启后台复制，不能把“启用接入”当作“迁移完成”；上传副本按真实字节记账，旧文件和引用保留。

历史清单工具为 `scripts/storage-pool-inventory.mjs`，只读列出文件大小、SHA-256、所属账号与无法归属的孤儿；无法归属的文件由管理员确认，不代填所有者。保留数据库、原件和身份库的独立可恢复备份后，第一阶段执行“`putFile` 返回 key → 下载校验哈希 → 记录复制映射”，不会更新原资产引用。弹指账本与 LifeOS 数据库无法跨进程原子提交，失败时保留原本地文件和未决 key 供核对。读取切换、旧原件保留期与撤旧属于后续阶段，当前未实施。迁移读回计入项目和用户月流量，不用 S3 直链绕过计量。

在**隔离测试实例**依次用小文件验证上传、通过 `PoolConsumer` 下载、删除后的两级用量变化；再覆盖无效 ID、超额、其他项目 key、同用户并发请求。线上如要验收，须只对新造的测试文件操作，绝不测试性删除既有真实文件。刷新弹指「设置 → 存储池」，核对 LifeOS 卡片两个圆环和 `usage()` 字节值。能在本地跑通不代表线上已经联通，最终须记录服务器用户、目录权限、CLI 扩展与 `open_basedir` 的实际检查结果。

## 2026-10-09 实际进度与当前发布边界

本节更新前面的历史状态。主人回传的服务器 `check-storage-pool.mjs` 已确认数字项目ID `2`、实际下载扣费UTC月份协议通过；接入文件指纹为 `8d0d8539b78cbf9f1102eb40b08c9ccc486cb464b5a1d03c351e432e5d7c82c8`，旧兼容修复已经部署。当前失败项是 `shared_ledger_exists_and_is_not_symlink`；`ledgerState`、`actualUsage` 均为空，未初始化共享账本，也不能据项目额度计算真实剩余容量。四个桶配置可读不等于已接通实际上传/下载/恢复。

进程输出确认 LifeOS 运行用户/主组是 `lifeos-svc:lifeos-svc`，PHP-FPM工作进程为 `www:www`。本次CLI检查以root执行，不能代表两个服务用户可持续访问。历史700/600权限信息还须在当前服务器重新核对，不能直接沿用。

主人明确授权仅修复本地 `D:/apps/go/storage.php` 与 `D:/apps/go/pool_consumer.php` 权限逻辑，并要求暂不推送。已实现：普通目录仍600；只有真实父目录精确2770、专用非root组且文件组一致时，配置临时文件/备份/替换后原件为640，统一账本为660。默认禁止其他用户访问；代码不会自行创建共享目录、修改组成员或变更服务器权限。策略17项、隔离PoolConsumer12项及原池7种模式141项通过，但Windows没有验证Linux实际setgid继承或线上双用户访问。

本次源码尚未发布。待主人允许发布后，先按既有Git流程部署，再确认目录与文件当前属主/组/权限并备份。可评估由www持有私有目录、使用已有lifeos-svc主组协作的2770方案；须确认该组确为专用组及其成员，不能给公共组开放配置。通过现有接入层在服务器首次初始化唯一共享账本，然后分别以www及lifeos-svc验证配置读取、账本读写、重复初始化、配置保存后权限及实际usage一致。不要手造SQLite表、上传本地账本或在旧0600源码上宣称一次chmod已解决持续权限。既有LifeOS进程已经以lifeos-svc主组运行，这种目录授权不要求重启Nginx；是否需要重启具体应用取决于部署与环境变更。

照片首载的本地修复另行完成：默认2048长边WebP适屏预览，显式操作才读取原件。它减少传输字节，但未实现浏览器直接从对象存储读取。被诊断的照片仍只有local引用，池原件仍由API代取代发。第一阶段复制保留本地文件/引用；浏览器云端投递必须同时满足身份、对象归属及既有统一计量，不能裸发可复用S3预签名URL绕过配额。线上复制、切读和直接投递均未验收。


### 2026-10-09 后续实况更新

主人已解除暂不推送限制。权限修复5e92f2ed1cdb9304cf2945337058509444b01087已推送，并回传服务器快进到该提交；前面的“源码尚未发布”是历史状态。当前私有目录www:www700、配置www:www600，LifeOS lifeos-svc:lifeos-svc(gid988)，PHP-FPM www:www(gid1003)。父目录遍历正常，当前卡点是www独占的私有目录/配置。初始化流程已准备，拟备份后启用www持有、lifeos-svc专用组协作2770/640，通过既有worker首次初始化唯一账本再双用户验证；截至本条，尚未收到初始化或真实usage通过的服务器证据。


### 2026-10-09 初始化结果

主人附件回传已完成root私有备份（/www/server/gdnbox-permission-backup.PfGuC6）、目录www:lifeos-svc2770、配置640、统一账本660；www/lifeos-svc/www三次usage成功一致，lifeos-svc的check-storage-pool --usage为14/14 PASS。消费方2实际storage0、UTC2026-10 traffic0，账本对象为空；此前缺账本阻塞已解除。不能重跑要求账本不存在和旧权限的首次bootstrap。该结果尚不代表运行中的PM2已经启用池、真实桶传输/私有性或旧照片复制完成；继续先核对有效启动环境，再对新造的唯一小测试文件验证真实上传、读回哈希和清理计量，不删除历史对象。


### 2026-10-09 运行应用开关核对

主人回传PM2 lifeos(id18,uid999)以--env-file=/www/server/lifeos-app/.env启动，账户模式已启用、端口3101、数据/www/server/lifeos-data/原件assets；.env尚无LIFEOS_STORAGE_POOL_ENABLED与LIFEOS_POOL_LOCAL_PRIMARY。因此前面的CLI真实usage通过只证明共享接入层，应用尚未开启。继续真实新造小文件传输/匿名访问/计量验证，再备份配置与必要数据库、同时启用池和本地主写保护，仅重启lifeos进程。不修改数据路径、旧密钥种子或其他项目。
