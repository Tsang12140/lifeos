# 弹指存储池同机接入核对

LifeOS 是 Node.js 服务，弹指接入层是 PHP。LifeOS 通过本机 PHP CLI 子进程调用 `PoolConsumer`，只用标准输入/输出传递操作结果；没有公开 PHP 接口，也没有把弹指的配置、密钥或账本复制到 LifeOS 网站目录。项目 ID 使用面板现存的 `2`。额度必须从 `PoolConsumer::usage()` 实时读取，不依据旧截图配置。

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

## 配置与启用顺序

只在 LifeOS 服务端私有 `.env` 写入：

```dotenv
LIFEOS_STORAGE_POOL_ENABLED=1
LIFEOS_POOL_CONSUMER=2
LIFEOS_POOL_PHP_BINARY=/usr/bin/php
LIFEOS_POOL_WORKER_PATH=/实际部署目录/apps/api/php/pool-consumer-worker.php
```

`LIFEOS_POOL_WORKER_PATH` 可以省略，前提是部署结构与仓库一致。接入需要 LifeOS 账户模式；单密码模式没有逐用户额度管理，启用存储池会拒绝启动。LifeOS 的用户额度与对象归属写进现有 owner SQLite 数据库；弹指项目的对象/流量账目始终写入 `/www/server/gdnbox-secrets/consumer-ledger.sqlite`。不要把后者、`storage.php` 或 AK/SK 放到网站根目录、日志、Git 或 HTTP 参数中。

先做只读 `GET /api/admin/storage-pool`（需 owner 会话），核对 `consumer`、UTC 月份、项目存储/流量已用及上限、历史本地文件盘点、未归属用量。只有账目可核对且历史归属与大小盘点完成后再分配用户额度并打开强制限额。分配额度只影响可分配余额，不会增加项目实际用量。历史本地文件不自动迁移，也不补记到弹指账本；如需迁移，应另行列清对象与归属、备份、重复/失败恢复和回滚方案，并在独立测试后执行。

历史迁移单独办理：先按租户 SQLite 的资产引用和磁盘文件逐件生成只读清单，列出文件大小、SHA-256、所属账号与无法归属的孤儿；无法归属的文件由管理员确认，不代填所有者。随后对数据库和原件做独立可恢复备份，在隔离实例演练“`putFile` 返回 key → 下载校验哈希 → 在 LifeOS 本地事务中更新引用和对象归属”的幂等批次。弹指账本与 LifeOS 数据库无法跨进程原子提交，所以批次失败时必须保留原本地文件和未决 key 供人工核对；验收后才决定旧本地原件的保留期限与清理。迁移下载会计入项目和用户月流量，必须按当时额度安排，不得用 S3 直链绕过计量。

在**隔离测试实例**依次用小文件验证上传、通过 `PoolConsumer` 下载、删除后的两级用量变化；再覆盖无效 ID、超额、其他项目 key、同用户并发请求。线上如要验收，须只对新造的测试文件操作，绝不测试性删除既有真实文件。刷新弹指「设置 → 存储池」，核对 LifeOS 卡片两个圆环和 `usage()` 字节值。能在本地跑通不代表线上已经联通，最终须记录服务器用户、目录权限、CLI 扩展与 `open_basedir` 的实际检查结果。
