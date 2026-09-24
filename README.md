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
- 备份与迁移：SQLite 本地备份、按 `Asia/Shanghai` 的每日定时备份、可选 S3-compatible 对象存储、JSON/Markdown 导出和 `lifeos.export` v1 JSON 导入。
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
| `LIFEOS_ALLOWED_ORIGINS` | 逗号分隔的 Web Origin 白名单；不要用任意来源替代明确白名单 |
| `LIFEOS_COOKIE_SECURE` | 账户模式必须为 `true`；HTTPS 反向代理后也应设为 `true` |
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
| `/api/weather/*` | 天气状态、位置方案、日期天气和实时天气 |
| `/api/ai/*` | AI 状态、配置、连接测试和只读助手 |
| `/api/modules/cycle-intimacy/*` | 可选私密周期与亲密模块 |

更完整的 API 说明见 [apps/api/README.md](apps/api/README.md)，领域模型和存储边界见 [docs/architecture.md](docs/architecture.md)。

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

`npm run backup` 也可以从命令行创建一次 SQLite 备份：

```bash
npm run backup -- data/lifeos.sqlite backup/lifeos.sqlite
```

备份文件可能包含隐私记录和密钥配置的密文，应和原数据库一样保护。不要把备份上传到公开 issue、公共对象存储或 Git 历史。

账户模式上线前和每次重要升级后，请对**已停止写入的整个 `/data` 卷**做一次独立备份与空目录恢复演练。仓库提供 `scripts/backup-instance.mjs`：它逐个一致性复制活跃 SQLite 数据库（包括 `identity.sqlite` 与成员数据库），复制照片、配置和历史快照，写入 SHA-256 清单；`verify` 校验每个文件，`restore` 只接受**不存在的目标目录**，绝不覆盖现有数据。备份目标必须在 `/data` 卷之外，且需要足够容量。下面的 `/srv/lifeos-private-backups` 是示例，请换成服务器上仅管理员可访问、不会被宝塔网站直接提供的绝对路径；先创建该目录，并允许容器的 `node` 用户写入。

```bash
docker compose stop lifeos
docker compose run --rm --no-deps -v /srv/lifeos-private-backups:/recovery lifeos node scripts/backup-instance.mjs backup --source /data --output /recovery/lifeos-first --asset-root /data/assets --account-mode --offline-confirmed
docker compose run --rm --no-deps -v /srv/lifeos-private-backups:/recovery lifeos node scripts/backup-instance.mjs verify --snapshot /recovery/lifeos-first
docker compose run --rm --no-deps -v /srv/lifeos-private-backups:/recovery lifeos node scripts/backup-instance.mjs restore --snapshot /recovery/lifeos-first --target /recovery/restore-smoke
docker compose up -d lifeos
```

恢复演练的目标必须是新的空路径；上述命令只证明备份字节、身份主密钥、各数据库与资产可被还原，**还须在隔离实例验证登录和照片读取**。服务器 `.env` 中四个固定 `LIFEOS_*_CONFIG_SECRET` 不在 `/data` 内，必须单独安全保存并在恢复时原值注入；否则已保存的集成密钥可能无法解密。定期将这个整卷备份目录加密后复制到异地，并演练恢复；仅有设置页的单库 S3 备份不满足此要求。若将 `LIFEOS_ASSET_ROOT` 放在 `/data` 之外，此命令会拒绝声称“整站备份”，须先制定涵盖外部资产根的联合恢复方案。

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
