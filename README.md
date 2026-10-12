# LifeOS

LifeOS 是一个以时间轴为核心的自托管个人生活记录工具。它把日记、笔记、任务和事件放在同一条可回看的时间线上，用人物、地点、项目、主题和其他记录建立上下文；数据默认保存在自己的 SQLite 文件中。

项目目前处于早期版本（`0.1.0`）。数据模型和 API 仍可能演进，正式部署前请先在副本上验证导入、导出和恢复流程。

## 界面预览

> 截图占位：发布前可在此处放置一张经许可的时间轴或日历界面截图。本仓库不包含个人照片、截图或其他本地媒体素材。

## 当前功能

- 时间轴记录：日记、笔记、任务和事件；发生时间、任务截止时间、补记标记、编辑历史、软删除和 `revision` 乐观并发控制。
- 周历与月历：按日期回看记录，月历支持摘要、法定休息日/调休上班日和节气标记；有外部照片引用时可在周卡或月历格显示照片背景。
- 关联与检索：人物、地点、项目、主题、别名、关系卡、记录间关联和基础关键词/类型/日期搜索。
- `@` 与 `#` 提及：`@` 只匹配人物，`#` 只匹配地点；匹配名称或别名后由 API 在写入时保存关联，未知标记不会被强行解释。
- 外部资产引用：可登记照片、音频或文件的稳定引用；LifeOS 不上传或复制原件。配置 `LIFEOS_ASSET_ROOT` 后，API 可在受限目录内只读提供本地图片、音频和视频预览。
- 隐私记录：时间轴默认遮罩隐私记录，点击后才显示；隐私记录不进入周/月日历摘要、任务摘要或 AI 助手上下文。
- 可选天气：接入和风天气（QWeather）后显示表头动画、地点、温度和日期天气，可按设备保存位置方案，也可以把当天或实时天气钉在记录上。没有 Key 时不会伪造天气。
- 可选 AI 助手：支持配置 DeepSeek 的服务地址、模型、思考开关和推理强度；未配置或请求失败时使用本地规则回答。真实 AI 只读取非隐私记录。
- 备份与迁移：直接展示备份月历、按需下载和导入单空间完整加密包、SQLite 本地/每日定时备份、可选 S3-compatible 对象存储、JSON/Markdown 导出和 `lifeos.export` v1 JSON 导入。
- 可选账户模式：owner 手动创建/停用独立账号；每个账号拥有独立 SQLite、配置密钥、资产与备份目录。默认不开启，旧单用户模式保持原样。
- 可选的“伴侣周期与亲密”日历模块：记录经期边界和亲密标记并显示非医疗周期估算；模块数据独立保存，关闭模块不会删除已有标记。

## 技术结构

```text
packages/core  领域模型、校验、提及解析、摘要和 JSON/Markdown 导出
apps/api       Node 24 HTTP API、认证、SQLite 持久化、备份和可选外部服务
apps/web       React 19 + Vite 7 浏览器界面
scripts/       开发启动、演示数据和 SQLite 备份脚本
```

API 使用 Node 24 内置的 `node:sqlite`，不依赖 Web 框架或外部数据库。生产构建后，API 进程会从 `apps/web/dist` 提供同源静态文件。

## 快速开始

### 环境要求

- Node.js 24 或更高版本（`node:sqlite` 需要 Node 22.5+，项目以 Node 24 为基线）
- npm

### 开发模式

```bash
npm install
npm run dev
```

打开 <http://127.0.0.1:5173/>。开发模式默认启动：

- API：<http://127.0.0.1:3001/>
- Vite Web：<http://127.0.0.1:5173/>
- SQLite：`./data/lifeos.sqlite`

回环地址默认不需要密码。第一次运行时，`data/` 会在 API 写入数据时创建。

### 加载虚构演示数据

先让 API 运行，再执行：

```bash
npm run seed:demo
```

种子脚本只通过公开 API 创建虚构人物、地点、项目、主题、记录、任务和关系，不包含照片、音频、文件、外部路径或真实个人资料，因此公开 clone 后不需要 `pic-test/` 或其他被忽略目录。演示数据均带内部 `isDemo` 标记，可在设置页隐藏或删除；也可以执行：

```bash
npm run seed:demo -- --clean
```

清理会删除 `demo-` 前缀的演示对象和演示记录，并保留应用约定的 `self` 身份对象。

如果 API 使用自定义地址，把地址作为第一个参数传入，例如 `npm run seed:demo -- http://127.0.0.1:3100`。

### 生产构建

```bash
npm run build
npm start
```

然后打开 <http://127.0.0.1:3001/>。`npm start` 运行编译后的 API，并由同一个进程提供 Web 静态文件。

### 测试和检查

```bash
npm run typecheck
npm test
npm run build
```

`npm test` 会运行 `packages/core` 和 `apps/api` 的测试；`npm run typecheck` 覆盖 core、API 和 Web。提交改动前建议至少执行以上三项。

## 配置

复制 `.env.example` 为本地 `.env`（不要提交 `.env`），按需要设置以下变量。
`npm run dev` 与 `npm start` 都会自动加载项目根目录的 `.env`（`node --env-file-if-exists`），**改完需重启才生效**；文件请存为 UTF-8 **不带 BOM**，否则第一个变量名会被静默吃掉。

| 变量 | 默认值/说明 |
| --- | --- |
| `LIFEOS_HOST` / `LIFEOS_PORT` | `127.0.0.1:3001`；legacy 非回环单用户模式需密码，账户模式需 Secure Cookie 与 HTTPS Origin 白名单 |
| `LIFEOS_DATA_DIR` | `./data`；SQLite、加密配置和本地备份的默认目录 |
| `LIFEOS_DB_PATH` | 覆盖 owner/legacy SQLite 文件路径；成员空间始终强制使用各自目录下的 `lifeos.sqlite` |
| `LIFEOS_ACCOUNT_MODE` | 默认关闭；明确设为 `1` 后启用账号登录和物理隔离租户 |
| `LIFEOS_OWNER_USERNAME` | 账户模式首次启动时的 owner 用户名；owner 创建后与引导密码一并移除 |
| `LIFEOS_PASSWORD` | legacy 单用户密码；账户模式只用于首次 owner 引导（至少 10 字符），owner 建立后移除用户名与密码两个引导值 |
| `LIFEOS_ALLOWED_ORIGINS` | 逗号分隔的 Web Origin 白名单，账户模式下**必须显式提供**（不回落开发默认值）。公网只接受 `https://`；`http://127.0.0.1:*` / `http://localhost:*` 仅在本地预览时接受 |
| `LIFEOS_COOKIE_SECURE` | 账户模式默认必须为 `true`；只有当白名单里**全部**是回环 HTTP Origin（本机预览）时才允许为 `false` |
| `LIFEOS_BODY_LIMIT_BYTES` | JSON 请求体上限，默认 1 MiB；导入较大 bundle 时按需调高 |
| `LIFEOS_ASSET_ROOT` | 可选的本地原件根目录；只读预览会拒绝越界路径 |
| `LIFEOS_BACKUP_DIR` / `BACKUP_DIR` | 覆盖本地备份目录，默认是数据目录下的 `backups/` |
| `LIFEOS_DEEPSEEK_API_KEY` / `LIFEOS_DEEPSEEK_MODEL` / `LIFEOS_DEEPSEEK_BASE_URL` | 启动时配置可选 DeepSeek；也可在设置页配置 |
| `LIFEOS_AI_CONFIG_SECRET` | 设置页保存 AI Key 时使用的加密口令；生产部署请固定强随机值，避免移除首次引导密码后 owner 密钥无法解密 |
| `QWEATHER_KEY` / `QWEATHER_LOCATION` / `QWEATHER_CITY` / `QWEATHER_HOST` | 启动时配置可选和风天气；也可在设置页配置 |
| `LIFEOS_WEATHER_CONFIG_SECRET` | 设置页保存天气 Key 时使用的加密口令；应固定并持久保存 |
| `LIFEOS_MOVIE_CONFIG_SECRET` | 设置页保存观影服务 Key 时使用的加密口令；应固定并持久保存 |
| `BACKUP_S3_*` | 可选 S3-compatible 备份的 Endpoint、Region、Bucket、Prefix、Path-style 和密钥 |
| `LIFEOS_BACKUP_CONFIG_SECRET` | 设置页保存对象存储密钥时使用的加密口令 |

AI、天气和对象存储配置页都会显示“是否已配置”，但不会把密钥回传到浏览器。API 运行日志可用 `LIFEOS_LOG_DIR` 指定目录；日志只用于诊断，也应视作本地运行数据。

## API 概览

API 默认前缀为 `/api`，所有写请求使用 JSON。密码模式下，除健康检查和登录状态外的接口需要会话 cookie。

| 路径组 | 用途 |
| --- | --- |
| `/api/health`、`/api/auth/*` | 健康检查、登录、会话状态和退出；账户模式使用账号 + 密码，旧共享密码入口不可绕过 |
| `/api/admin/accounts` | 账户模式下仅 owner 可列出、创建、停用账号及重置密码；不开放公开注册 |
| `/api/records`、`/api/summaries` | 记录 CRUD、日期/关键词筛选、任务状态和日摘要 |
| `/api/entities`、`/api/assets` | 人物/地点/项目/主题与外部资产引用 CRUD |
| `/api/export`、`/api/import` | JSON/Markdown 导出与 `lifeos.export` v1 导入 |
| `/api/backup/*` | 本地、对象存储、定时备份、运行历史和连接测试 |
| `/api/archive/*` | 当前空间的完整加密包大小预估、按需生成/下载、上传校验与确认替换 |
| `/api/weather/*` | 天气状态、位置方案、日期天气和实时天气 |
| `/api/ai/*` | AI 状态、配置、连接测试和只读助手 |
| `/api/modules/cycle-intimacy/*` | 可选私密周期与亲密模块 |

更完整的 API 说明见 [apps/api/README.md](apps/api/README.md)，领域模型和存储边界见 [docs/architecture.md](docs/architecture.md)。

同机弹指存储池的启用前检查、权限和验收顺序见 [docs/storage-pool-deployment.md](docs/storage-pool-deployment.md)。该功能默认关闭；LifeOS 通过本机 PHP CLI 调用弹指现有 `PoolConsumer`。

## 部署与安全

LifeOS 默认保持旧的单用户本机模式；账户模式是显式开启的可选部署方式，一个账号对应一个私有空间，不支持公开注册或共享空间。停用账号会立即撤销已有会话。部署到公网或容器时请把以下事项当作必需配置：

1. 公网账户模式必须置于 HTTPS 反向代理后，并设置 `LIFEOS_ACCOUNT_MODE=1`、`LIFEOS_COOKIE_SECURE=true` 和精确的 `LIFEOS_ALLOWED_ORIGINS`（例如 `https://lifeos.dnbox.cn`）。反向代理需保留原始 `Host` 与 `Origin`；API 会拒绝不在白名单内的来源。
2. Compose 只把容器端口绑定到宿主机 `127.0.0.1:3001`。宝塔反向代理上游应为 `http://127.0.0.1:3001`，不要再配置公网直连端口；同时启用 HTTPS 证书并让代理向上游传递 `$host` 和 `$http_origin`。
3. 首次 owner 引导需同时设置 `LIFEOS_OWNER_USERNAME` 与至少 10 字符的 `LIFEOS_PASSWORD`。确认 owner 能登录后，移除这两个引导值并重启；账号、会话和租户身份保存在持久卷的 `/data/identity.sqlite`。所有配置与随机租户目录也必须随 `/data` 一起持久化。
4. 移除引导密码前，应先为 `LIFEOS_AI_CONFIG_SECRET`、`LIFEOS_WEATHER_CONFIG_SECRET`、`LIFEOS_MOVIE_CONFIG_SECRET` 与 `LIFEOS_BACKUP_CONFIG_SECRET` 设置并固定强随机值，再保存对应的集成密钥；不要轮换这些值，否则旧密文将无法解密。新租户使用独立派生种子，不继承 owner 的绝对 DB、资产或备份路径。
5. 给 Compose 配置持久化的空 `/data` 卷，并显式设 owner 资产目录 `LIFEOS_ASSET_ROOT=/data/assets`。新租户资产与本地备份由服务端放入独立子目录。启用旧实例账户模式前，先在数据库和资产副本上演练备份、回退和解密；本项目的首次部署示例以空库为目标，不会自动迁移已有单用户数据。
6. 不要把 `.env`、SQLite 文件、备份、运行日志、资产原件或真实导出文件加入 Git；SQLite 数据目录不要放在 SMB/NFS 网络共享上。
7. 启用 AI、天气或对象存储前，先确认第三方服务的数据保留、区域、费用和访问策略。AI 助手只组装非隐私记录，但启用真实服务仍意味着这些记录会发往所配置的 AI 服务。

在服务器 `.env`（不要提交 Git）中配置并在首次成功创建 owner 后删除两项引导值：

```dotenv
LIFEOS_ACCOUNT_MODE=1
LIFEOS_OWNER_USERNAME=owner
LIFEOS_PASSWORD=<至少 10 字符的强随机引导密码>
LIFEOS_COOKIE_SECURE=true
LIFEOS_ALLOWED_ORIGINS=https://lifeos.dnbox.cn
LIFEOS_ASSET_ROOT=/data/assets
# 四个 *_CONFIG_SECRET 使用各自不同的强随机值，并长期固定
LIFEOS_AI_CONFIG_SECRET=<随机密钥>
LIFEOS_WEATHER_CONFIG_SECRET=<随机密钥>
LIFEOS_MOVIE_CONFIG_SECRET=<随机密钥>
LIFEOS_BACKUP_CONFIG_SECRET=<随机密钥>
```

启动命令：

```bash
docker compose up -d --build
```

确认 owner 登录成功后，从服务器 `.env` 删除 `LIFEOS_OWNER_USERNAME` 与 `LIFEOS_PASSWORD` 并重启容器；不要删除身份库或 `/data` 卷。Compose 使用命名卷保存 `/data`，且端口只暴露在宿主机回环。首次上线前仍须在目标环境确认 DNS、证书、反向代理原始 Host/Origin、卷权限、备份恢复和日志轮转；本仓库不连接或操作用户服务器。

## 隐私、数据和备份

- 数据默认只写本机 SQLite；LifeOS 不要求第三方账号才能记录、浏览或导出。
- 记录的 `body.original` 永远保留，编辑内容写入独立的 `body.edited`；删除是软删除，数据库备份仍可保留已删除行。
- 隐私记录会在时间轴中遮罩，在日历摘要、任务摘要和 AI 上下文中排除。周期与亲密模块是单独的私密日历数据，关闭显示不会自动删除数据。
- 图片、音频和文件只保存 `assetId` 与可替换的 `storageRefs`，不会把原件复制进 SQLite 或仓库。仓库不携带任何本地照片。
- 设置页可以生成一致的**单个空间的 SQLite 副本**；本地备份默认保留最近 30 天。可启用每天一次的定时备份，并在配置 S3-compatible 凭据后上传同一份副本。它**不包含** `identity.sqlite`、其他租户数据库、照片原件或数据目录里的配置文件，不能单独用于多租户整站恢复。
- JSON 导出适合迁移记录、实体和资产引用，Markdown 适合阅读；二者都不是整站灾难恢复方案。

### 下载和导入完整加密包

设置的「数据备份」和「导入导出」都有「完整加密包」入口。它包含当前空间的全部记录（包括私密与软删除记录）、人物地点、资产原件、仍可恢复的回收站原件、小结、周期数据与天气缓存。账号、会话、服务密钥、对象存储账本、排程和浏览器偏好不随包迁移。

点击下载时先显示原件合计与估计大小，生成成功后显示实际文件大小，再直接下载 `.lifeos` 文件到电脑。完整包只临时使用服务器磁盘，不另存对象存储副本；远端原件下载会计入存储池流量，生成前检查剩余额度。文件最大 20 GiB，任务及私有临时文件 15 分钟过期清理。原件缺失时拒绝生成，避免提供不完整的恢复包。

账户模式导出需要重新输入当前账号密码；无登录密码的本地实例设置独立包密码（至少 10 个字符）。加密采用 scrypt 派生密钥与 AES-256-GCM，文件内容和清单一起认证。改过账号密码后，旧包仍用生成时的旧密码解密。密码不会保存到配置或浏览器本地存储。服务端会处理原件和口令，这不提供对应用服务器本身的隔离。

导入先上传、解密并逐个校验原件，展示包内与目标空间的数量。确认「替换当前空间」后才执行：先自动保存当前 SQLite 快照，新原件使用独立路径，最后事务替换业务数据；旧原件保留。预览后当前空间有编辑则拒绝替换，需重新校验。导入完成按「刷新页面」更新界面。现有 SQLite 快照和 JSON/Markdown 导出仍保持原格式，不带完整原件加密。格式细节与边界见 [完整包协议](docs/archive-format.md)。

`npm run backup` 也可以从命令行创建一次 SQLite 备份：

```bash
npm run backup -- data/lifeos.sqlite backup/lifeos.sqlite
```

备份文件可能包含隐私记录和密钥配置的密文，应和原数据库一样保护。不要把备份上传到公开 issue、公共对象存储或 Git 历史。

### 宝塔 + PM2：整站本地与异地备份

现有宝塔部署不用 Docker。`scripts/run-instance-backup-pm2.sh` 只停止并重新启动名为 `lifeos` 的 PM2 进程，不碰其他项目：停止写入 → 完整本地快照 → 立即恢复服务 → 校验 → 上传异地。它需要 Node 24、`flock`、已启用的 S3-compatible 配置，并要求在服务器 `.env` **显式填写** `LIFEOS_INSTANCE_BACKUP_S3_BUCKET`。推荐专用私有桶；不要直接假设现有 `cdnb` 桶私有。专用桶若使用不同连接或密钥，`.env.example` 提供独立覆盖项。上传前脚本会放一个无害探针，若匿名可读取，便拒绝上传任何真实账号库和照片。

```bash
cd /www/server/lifeos-app
export LIFEOS_NODE_BIN=/www/server/nodejs/v24.21.0/bin/node
export LIFEOS_INSTANCE_DATA_DIR=/www/server/lifeos-data
export LIFEOS_INSTANCE_BACKUP_ROOT=/www/server/lifeos-private-backups
bash scripts/run-instance-backup-pm2.sh
```

脚本返回本地快照位置和异地 `manifestKey`，后者须安全保留。**先手动成功跑一次并完成恢复演练**，再安排宝塔计划任务/cron 在低峰期每天运行同一脚本；计划任务必须使用拥有 `lifeos` 的 PM2 用户并显式带入上述三个环境变量，失败时要告警。脚本会在本地备份失败时尽力恢复 LifeOS 服务，但不能代替运维监控。整站异地对象暂不自动删除，避免清理策略误删唯一恢复点；需要监测私有桶容量。

异地恢复演练只使用两个新的空目录，不覆盖运行数据：

```bash
cd /www/server/lifeos-app
LIFEOS_DATA_DIR=/www/server/lifeos-data /www/server/nodejs/v24.21.0/bin/node --env-file=.env scripts/backup-instance-remote.mjs download --manifest-key '上传返回的 manifestKey' --target /www/server/lifeos-private-backups/download-smoke
/www/server/nodejs/v24.21.0/bin/node scripts/backup-instance.mjs restore --snapshot /www/server/lifeos-private-backups/download-smoke --target /www/server/lifeos-private-backups/restore-smoke
```

恢复副本还应在隔离端口验证成员登录与照片读取。服务器 `.env` 里的固定配置密钥不在数据目录中，必须另行安全保存。整站上传通过 HTTPS 到私有桶，**不是客户端加密归档**；若需防止存储服务商读取，后续还须增加客户端加密。

### Docker 部署的离线备份示例

账户模式上线前和每次重要升级后，请对**已停止写入的整个 `/data` 卷**做一次独立备份与空目录恢复演练。仓库提供 `scripts/backup-instance.mjs`：它逐个一致性复制活跃 SQLite 数据库（包括 `identity.sqlite` 与成员数据库），复制照片、配置和历史快照，写入 SHA-256 清单；`verify` 校验每个文件，`restore` 只接受**不存在的目标目录**，绝不覆盖现有数据。备份目标必须在 `/data` 卷之外，且需要足够容量。下面的 `/srv/lifeos-private-backups` 是示例，请换成服务器上仅管理员可访问、不会被宝塔网站直接提供的绝对路径；先创建该目录，并允许容器的 `node` 用户写入。

```bash
docker compose stop lifeos
docker compose run --rm --no-deps -v /srv/lifeos-private-backups:/recovery lifeos node scripts/backup-instance.mjs backup --source /data --output /recovery/lifeos-first --asset-root /data/assets --account-mode --offline-confirmed
docker compose run --rm --no-deps -v /srv/lifeos-private-backups:/recovery lifeos node scripts/backup-instance.mjs verify --snapshot /recovery/lifeos-first
docker compose run --rm --no-deps -v /srv/lifeos-private-backups:/recovery lifeos node scripts/backup-instance.mjs restore --snapshot /recovery/lifeos-first --target /recovery/restore-smoke
docker compose up -d lifeos
```

恢复演练的目标必须是新的空路径；上述命令只证明备份字节、身份主密钥、各数据库与资产可被还原，**还须在隔离实例验证登录和照片读取**。服务器 `.env` 中四个固定 `LIFEOS_*_CONFIG_SECRET` 不在 `/data` 内，必须单独安全保存并在恢复时原值注入；否则已保存的集成密钥可能无法解密。定期将这个整卷备份目录加密后复制到异地，并演练恢复；仅有设置页的单库 S3 备份不满足此要求。若将 `LIFEOS_ASSET_ROOT` 放在 `/data` 之外，此命令会拒绝声称“整站备份”，须先制定涵盖外部资产根的联合恢复方案。

## 天气定位与高德备用服务

天气设置提供「获取当前位置」，天气卡的城市名称也可重新定位；天气图标和温度只刷新天气。固定城市在检测到不同位置时先确认，确认只切换本次城市，不会自动打开「跟随当前位置」。自动检测仅在浏览器已授权时尝试，不会在进入页面时主动申请新权限。

默认使用浏览器定位和现有和风天气城市解析，无需高德 Key。「设置 → 服务接入 → 天气」下的「高德备用定位」可保存 **Web 服务**类型 Key，默认关闭。启用后仅在手动浏览器定位失败时查询 IP 大致城市；网络定位结果始终先确认。基础 IP 服务仅支持国内 IPv4，IPv6、代理或网络出口位置可能导致不可用或偏差。

也可以在项目根目录 `.env` 填写 `LIFEOS_AMAP_API_KEY=你的高德Web服务Key`，随后重启 API。该字段供天气备用定位及地点搜索共用；填写 Key 不会自动开启 IP 备用定位，仍需在天气设置勾选启用。地点搜索独立于 IP 开关，不另设一份 Key。

界面保存的 Key 按空间加密保存在数据目录的 `amap-config.json`，优先于环境变量；留空保留，明确清除后恢复使用环境变量。接口仅返回配置状态及来源，不返回 Key。密文无法解密时保留并提示问题，不静默切换环境变量。账户模式下环境变量 Key 仅供主人空间使用，成员空间需独立配置。加密沿用当前空间的固定天气配置种子并使用独立盐；可单独设置 `LIFEOS_AMAP_CONFIG_SECRET`，设定后须保持不变并随部署机密备份。

宝塔 Nginx 反代若连接本机 API，备用 IP 定位还需在反代中**覆盖**设置 `proxy_set_header X-Real-IP $remote_addr;`，并给 API 进程设置 `LIFEOS_TRUST_PROXY=1` 后重启。仅信任回环地址连接的反代头；不能确认真实客户端 IPv4 时直接停止备用查询，避免误用服务器城市。不要透传客户端自带的 `X-Real-IP`。正常浏览器定位不需要这项配置。

### 地点搜索与保存

日记的地点按钮和「联系人与地点 → 地点」共用店铺、地址搜索。先列出自己的地点，默认按当前设备的天气城市搜索；可自由输入城市，也提供近期/经常在非私密日记中提及的城市，以及省内常用城市（静态推荐，并非实时热度排名）。输入不调用高德，点击搜索或回车才调用搜索 POI 2.0，每页 10 条，最多 20 页；连接中断等临时网络错误自动重试一次，两次共享 10 秒时限，Key 权限/额度及无结果不会重试。重试可能产生额外一次供应商请求，每空间每分钟最多接受 30 次搜索操作。

如果用 `HTTPS_PROXY` 访问海外服务，请在 `.env` 的现有 `NO_PROXY` 列表中追加 `restapi.amap.com`，例如 `NO_PROXY=localhost,127.0.0.1,::1,restapi.amap.com`，并重启 API。这让地点搜索和天气备用 IP 定位直连高德，避免本地代理偶发断连，同时保留其他服务的代理。搜索连接错误日志只记安全错误码和重试次数，不记录带 Key 的请求地址。

选中后名称、地址、城市、电话、GCJ-02 坐标和可用的图片链接保存到当前空间。同一高德 POI ID 重复选用会复用已有地点；以后读取和选择自己的地点不查询高德，不自动刷新已保存资料。选用时会尝试将高德照片压成 160×160 WebP，存入当前配置的自有资产目录或存储池，复用头像的去重、额度校验和引用保留；已有自有照片不再下载。抓图仅接受指定高德图片域名的公开 HTTPS 地址，不跟随跳转，限时 6 秒且图片不超过 2 MB 或配置上传上限。抓图失败不影响地点保存，可在地点详情重试；尚未补存的图片会暂用外部链接，可能缺失、并非门头照或以后失效。点击地点缩略图仍可沿用联系人头像的选择/粘贴/拖入、裁切上传机制替换照片。日记显示小图、名称和一行地址，点击卡片或管理页地点名称，可查看地址、导航、拨号和相关日记；这些读取不重新请求高德 POI。地点支持默认角色和自定义角色，管理页可按角色筛选，也支持电话号码拨号和地图链接。供应商资料及图片的使用、保存应遵循高德当前服务协议及授权范围。

## 当前边界

- 可选账户模式已由本地隔离 API/CDP 验收覆盖；生产空库部署仍需由部署者验证 DNS、HTTPS 反代、持久卷与恢复流程。首版仅 owner 管理独立账号，不提供公开注册、共享空间或团队协作模型。
- 外部资产目前是引用/只读预览链路，不是照片库同步或通用上传服务；Synology Photos、NAS 专用 API、离线同步、原生 App、语音转写和外部日历同步仍属于后续适配方向。
- AI 和天气是可选集成，网络、供应商可用性、Key 权限和费用由部署者负责；无 Key 时核心记录功能仍可用。
- 周/月摘要在没有 AI Key 时使用本地规则生成。周期模块的预测仅为非医疗的日历估算，不应作为诊断、避孕或治疗依据。
- Dockerfile 和 Compose 已纳入仓库，但请在自己的 NAS、云主机或反向代理环境中完成独立验收。

## 贡献

欢迎通过 Issue 或 Pull Request 报告问题、补充文档和提交改进。建议：

1. 先说明复现步骤、预期行为和实际行为；涉及隐私时请使用虚构数据。
2. 保持改动聚焦，补充对应的 core/API 测试或客观 UI 验收。
3. 提交前运行 `npm run typecheck`、`npm test` 和 `npm run build`。
4. 不要提交 `.env`、SQLite/备份文件、运行日志、真实照片、个人导出或服务商密钥；第三方字体和其他素材请保留各自许可证说明。

## 许可

LifeOS 以 [MIT License](LICENSE) 发布。仓库中的第三方字体等素材可能适用各自许可证，详见 [apps/web/public/fonts/THIRD-PARTY-NOTICES.md](apps/web/public/fonts/THIRD-PARTY-NOTICES.md)。
