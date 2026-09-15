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
| `LIFEOS_HOST` / `LIFEOS_PORT` | `127.0.0.1:3001`；对外监听时必须同时设置密码 |
| `LIFEOS_DATA_DIR` | `./data`；SQLite、加密配置和本地备份的默认目录 |
| `LIFEOS_DB_PATH` | 覆盖 SQLite 文件路径；优先于 `LIFEOS_DATA_DIR` |
| `LIFEOS_PASSWORD` | 单用户密码；非回环绑定必填，建议使用随机长密码 |
| `LIFEOS_ALLOWED_ORIGINS` | 逗号分隔的 Web Origin 白名单；不要用任意来源替代明确白名单 |
| `LIFEOS_COOKIE_SECURE` | HTTPS 反向代理后设为 `true` |
| `LIFEOS_BODY_LIMIT_BYTES` | JSON 请求体上限，默认 1 MiB；导入较大 bundle 时按需调高 |
| `LIFEOS_ASSET_ROOT` | 可选的本地原件根目录；只读预览会拒绝越界路径 |
| `LIFEOS_BACKUP_DIR` / `BACKUP_DIR` | 覆盖本地备份目录，默认是数据目录下的 `backups/` |
| `LIFEOS_DEEPSEEK_API_KEY` / `LIFEOS_DEEPSEEK_MODEL` / `LIFEOS_DEEPSEEK_BASE_URL` | 启动时配置可选 DeepSeek；也可在设置页配置 |
| `LIFEOS_AI_CONFIG_SECRET` | 设置页保存 AI Key 时使用的加密口令；不设置则依次使用 `LIFEOS_PASSWORD` 或本地目录派生值 |
| `QWEATHER_KEY` / `QWEATHER_LOCATION` / `QWEATHER_CITY` / `QWEATHER_HOST` | 启动时配置可选和风天气；也可在设置页配置 |
| `LIFEOS_WEATHER_CONFIG_SECRET` | 设置页保存天气 Key 时使用的加密口令 |
| `BACKUP_S3_*` | 可选 S3-compatible 备份的 Endpoint、Region、Bucket、Prefix、Path-style 和密钥 |
| `LIFEOS_BACKUP_CONFIG_SECRET` | 设置页保存对象存储密钥时使用的加密口令 |

AI、天气和对象存储配置页都会显示“是否已配置”，但不会把密钥回传到浏览器。API 运行日志可用 `LIFEOS_LOG_DIR` 指定目录；日志只用于诊断，也应视作本地运行数据。

## API 概览

API 默认前缀为 `/api`，所有写请求使用 JSON。密码模式下，除健康检查和登录状态外的接口需要会话 cookie。

| 路径组 | 用途 |
| --- | --- |
| `/api/health`、`/api/auth/*` | 健康检查、登录、会话状态和退出 |
| `/api/records`、`/api/summaries` | 记录 CRUD、日期/关键词筛选、任务状态和日摘要 |
| `/api/entities`、`/api/assets` | 人物/地点/项目/主题与外部资产引用 CRUD |
| `/api/export`、`/api/import` | JSON/Markdown 导出与 `lifeos.export` v1 导入 |
| `/api/backup/*` | 本地、对象存储、定时备份、运行历史和连接测试 |
| `/api/weather/*` | 天气状态、位置方案、日期天气和实时天气 |
| `/api/ai/*` | AI 状态、配置、连接测试和只读助手 |
| `/api/modules/cycle-intimacy/*` | 可选私密周期与亲密模块 |

更完整的 API 说明见 [apps/api/README.md](apps/api/README.md)，领域模型和存储边界见 [docs/architecture.md](docs/architecture.md)。

## 部署与安全

LifeOS 面向单用户自托管。部署到局域网、公网或容器时请把以下事项当作必需配置：

1. 非回环监听（例如 Docker Compose 的 `0.0.0.0`）必须设置 `LIFEOS_PASSWORD`。密码模式使用 HttpOnly、SameSite=Lax 会话 cookie，并对登录失败做简单限流。
2. 公网部署应放在 HTTPS 反向代理之后，并设置 `LIFEOS_COOKIE_SECURE=true`；`LIFEOS_ALLOWED_ORIGINS` 只填写实际 Web Origin。
3. 使用专用的数据目录和备份目录，不要把整个 NAS、照片根目录或宿主机根目录挂载给 LifeOS。SQLite 数据目录不要放在 SMB/NFS 网络共享上。
4. 不要把 `.env`、SQLite 文件、备份、运行日志、`LIFEOS_ASSET_ROOT` 下的原件或任何真实导出文件加入 Git。公开仓库的 `.gitignore` 已排除这些常见本地数据范围，但提交前仍应运行 `git status --ignored` 检查。
5. 启用 AI、天气或对象存储前，先确认第三方服务的数据保留、区域、费用和访问策略。AI 助手只组装非隐私记录，但启用真实服务仍意味着这些记录会发往所配置的 AI 服务。
6. 对象存储配置页的 Access Key、Secret Key、AI Key 和天气 Key 只在 API 服务端使用，并以 AES-256-GCM 加密写入数据目录；请限制数据目录权限并使用独立的最小权限凭据。

Docker Compose 示例：

```powershell
$env:LIFEOS_PASSWORD = "replace-with-a-long-random-password"
docker compose up -d --build
```

Compose 使用命名卷保存 `/data`。首次上线前请自行验证反向代理、卷权限、备份恢复和日志轮转；仓库提供配置和脚本，不替代目标环境的运维演练。

## 隐私、数据和备份

- 数据默认只写本机 SQLite；LifeOS 不要求第三方账号才能记录、浏览或导出。
- 记录的 `body.original` 永远保留，编辑内容写入独立的 `body.edited`；删除是软删除，数据库备份仍可保留已删除行。
- 隐私记录会在时间轴中遮罩，在日历摘要、任务摘要和 AI 上下文中排除。周期与亲密模块是单独的私密日历数据，关闭显示不会自动删除数据。
- 图片、音频和文件只保存 `assetId` 与可替换的 `storageRefs`，不会把原件复制进 SQLite 或仓库。仓库不携带任何本地照片。
- 设置页可以生成一致的 SQLite 本地副本；本地备份默认保留最近 30 天。可启用每天一次的定时备份，并在配置 S3-compatible 凭据后上传同一份副本。
- JSON 导出适合迁移记录、实体和资产引用，Markdown 适合阅读；完整恢复可使用已验证的 SQLite 备份。恢复前请停写，并清理同目录中与目标数据库对应的 `-wal`/`-shm` 文件。

`npm run backup` 也可以从命令行创建一次 SQLite 备份：

```bash
npm run backup -- data/lifeos.sqlite backup/lifeos.sqlite
```

备份文件可能包含隐私记录和密钥配置的密文，应和原数据库一样保护。不要把备份上传到公开 issue、公共对象存储或 Git 历史。

## 当前边界

- 当前是单用户 Web 应用，不提供多租户、角色权限或团队协作模型。
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
