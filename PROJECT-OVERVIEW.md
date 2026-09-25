# LifeOS 项目全貌（描述文档）

> **本文是什么**：对当前工作区 `E:\Projects\motion-lab\lifeos` 的一次**只读通读**结果，写给「第一次进场的人或 AI」。
> **本文不是什么**：它不是权威原文。权威文档仍是：需求 `docs/requirements.md`、架构 `docs/architecture.md`、路线图 `docs/roadmap.md`、协作规则 `AGENTS.md`、改动记录 `docs/changelog.md`、待办 `docs/todo.md`、自我审计 `docs/self-audit.md`。本文与它们的冲突，一律以它们为准。
> **快照时间**：2026-09-25（Asia/Shanghai）。代码在动，数字会过期；重新核对只需按文末「自查命令」跑一遍。

---

## 1. 一句话定位

**LifeOS 是一个以时间轴为核心的自托管个人生活记录工具**：日记 / 任务 / 事件 / 知识笔记放在同一条可回看的时间线上，用人物、地点、项目、主题、照片与其他记录建立上下文；数据默认落在**自己的一个 SQLite 文件**里，不依赖任何第三方账号即可记录、浏览、导出。

- 版本：`0.1.0`，`private: true`，**MIT License**。
- 形态：**monorepo（npm workspaces）**，零 Web 框架、零外部数据库。
- 分支现场：**仓库根目录就是主项目**；`deepseek-v1/`、`deepseek-v2/` 是历史快照，**不在那里施工**。
- 当前阶段：路线图 **M1 已完成**（记录与时间轴闭环），并已长出若干 **M1 之外的自建能力**（周/月日历照片底纹、时光机、笔记资料库、周期与亲密模块、观影模块、账户模式与多租户）。

---

## 2. 快速事实表

| 项 | 值 |
| --- | --- |
| 运行时 | **Node.js ≥ 24**（`node:sqlite` 需要 22.5+，项目以 24 为基线） |
| API | Node 原生 `node:http`，**零框架**；`node:sqlite` 的 `DatabaseSync`，参数化 SQL |
| Web | React **19.1** + Vite **7.1** + TypeScript **5.9**；图标用 `lucide-react` |
| 领域层 | `packages/core`，只放模型/校验/提及/摘要/导出，**不含存储实现** |
| 开发端口 | API `127.0.0.1:3001`，Vite `127.0.0.1:5173`（Vite 把 `/api` 代理到 3001） |
| 本机预览端口 | API **3011** + Web **5199**（`.review/accept-serve.mjs` 拉起，**服务的就是生产库 `data/`**） |
| 生产托管 | `npm start` 单进程，从 `apps/web/dist` 同源提供静态文件 |
| 默认数据库 | `./data/lifeos.sqlite`（WAL 模式；`LIFEOS_DATA_DIR` 可改） |
| 多租户身份库 | `data/identity.sqlite`（仅在 `LIFEOS_ACCOUNT_MODE=1` 时使用） |
| 测试 | `node:test`（无 vitest/jest）：**109 个用例**（core 29 / API 65 / web 11 / instance-backup 4），最后一次记录为全绿 |
| 许可 / 素材 | MIT；字体走 CSS `local()`，不在仓库内打包字体文件 |

---

## 3. 目录结构与体量

```text
lifeos/
├─ packages/core/     领域模型、校验、@/# 提及解析、摘要、JSON/Markdown 导出、端口接口
├─ apps/api/          Node 24 HTTP API、认证、SQLite 持久化、备份、可选外部服务
├─ apps/web/          React 19 + Vite 7 浏览器界面
├─ scripts/           开发启动、演示数据、SQLite 备份、整卷备份/校验/恢复
├─ data/              ⚠️ 生产数据目录（SQLite + 配置 + 备份 + 派生数据）
├─ pic-test/          本机资产根（房间里的照片原件目录，`LIFEOS_ASSET_ROOT` 指向它）
├─ docs/              需求 / 架构 / 路线图 / 待办 / 改动记录 / 审计报告
├─ .review/           验收工具箱（300+ 个脚本，**被 gitignore**，不随仓库走）
├─ .workbuddy*/       记忆与接力文件（**被 gitignore**）
├─ compose.yaml / Dockerfile
└─ AGENTS.md / README.md / PROJECT-OVERVIEW.md（本文）
```

**关键文件体量**（行数，用于判断「哪里是上帝文件」）：

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `apps/api/src/repository.ts` | ~1439 | SQLite 全部读写与建表 DDL，存储边界 |
| `apps/api/src/server.ts` | ~1003 | 路由装配、鉴权、限流、静态托管、账户网关 |
| `apps/api/test/api.test.ts` | ~3874 | 单文件 65 个用例，用真实临时 SQLite + 真实 HTTP |
| `apps/web/src/main.tsx` | ~1431 | **入口 + 根组件 + 全部状态**（正在被拆分，历史事故高发区） |
| `apps/web/src/styles.css` | ~11881 | 唯一全局样式表（136 个 CSS 变量，47 个媒体查询） |
| `apps/web/src/settings-cards.tsx` | ~951 | 全部设置卡片 |
| `apps/web/src/calendar-view.tsx` | ~655 | 日历视图（周/月、周卡照片底纹、周期面板） |
| `apps/web/src/api.ts` | ~452 | 前端唯一 API 客户端 |
| `packages/core/src/model.ts` | ~971 | 全部领域类型 + 校验 |
| `docs/changelog.md` | ~3969 | 改动记录（只追加，每条带 `AI:` 署名） |

---

## 4. 运行方式

```bash
npm install
npm run dev            # API 3001 + Vite 5173，开发用
npm run build          # core → api → web 顺序构建
npm start              # 单进程生产模式，打开 http://127.0.0.1:3001/
npm run typecheck      # 覆盖 core / api / web
npm test               # core + api + web + instance-backup 四段
npm run seed:demo      # 灌虚构演示数据（--clean 清理）
npm run backup -- data/lifeos.sqlite backup/lifeos.sqlite
```

- `npm run dev` / `npm start` 都会用 `node --env-file-if-exists=.env` 自动加载根目录 `.env`，**改完要重启**；`.env` 必须是 **UTF-8 无 BOM**，否则第一个变量名被静默吃掉。
- 「`npm` 在本机走不通」已知且已归纳为配方：必须同时钉住 `C:\Program Files\nodejs`（24.x）的**绝对路径**与 `PATH`——因为 `npm test` 内层的 `node --test` 按 `PATH` 找 node，而 PATH 里 managed 的 22.x 不支持 `--test-isolation=none`。

### 环境变量分组（详见 `README.md` 与 `.env.example`）

| 组 | 代表变量 |
| --- | --- |
| 网络/认证 | `LIFEOS_HOST`、`LIFEOS_PORT`、`LIFEOS_PASSWORD`、`LIFEOS_ACCOUNT_MODE`、`LIFEOS_OWNER_USERNAME`、`LIFEOS_ALLOWED_ORIGINS`、`LIFEOS_COOKIE_SECURE` |
| 存储 | `LIFEOS_DATA_DIR`、`LIFEOS_DB_PATH`、`LIFEOS_ASSET_ROOT`、`LIFEOS_BACKUP_DIR`、`LIFEOS_LOG_DIR`、`LIFEOS_BODY_LIMIT_BYTES` |
| 集成 | `LIFEOS_DEEPSEEK_*`、`QWEATHER_*`、`BACKUP_S3_*` |
| 加密种子 | `LIFEOS_AI_CONFIG_SECRET`、`LIFEOS_WEATHER_CONFIG_SECRET`、`LIFEOS_MOVIE_CONFIG_SECRET`、`LIFEOS_BACKUP_CONFIG_SECRET` |

> **🔑 加密种子推导规则（核心坑）**：各 `*-config.ts` 的 AES-256-GCM 种子取自
> `LIFEOS_<模块>_CONFIG_SECRET` → `LIFEOS_PASSWORD` → `` `lifeos-local-<模块>:${dataDirectory}` ``。
> **后两者都没设时，种子就是数据目录路径本身** —— 一搬目录就换密钥，**已保存的 API Key 会静默解不开**（设置页只显示「未配置」，零报错）。所以本机 `.env` 里那 4 个 secret 是**故意钉成历史路径**的，不能删、不能改。

---

## 5. 领域模型（`packages/core`）

**公开出口**：`src/index.ts` 重导出 `model`、`mention`、`movie-query`、`ports`、`summary`、`export`。

| 模块 | 职责 |
| --- | --- |
| `model.ts` | 全部类型 + `assertValid*` 校验：`TimelineRecord`、`Entity`、`Asset`、`StorageReference{contentHash}`、`WeatherAttachment`、`CycleIntimacy*`、`LifeTime` 三态 |
| `mention.ts` | `findEntityMentions`：`@`=人物 / `#`=地点；NFKC 归一、拉丁字母边界、最长优先、双 marker 跳过 |
| `summary.ts` | `SUMMARY_MAX_LENGTH=16`、`trim/clamp/ruleSummaryText`、`summaryFingerprint`、`SUMMARY_SYSTEM_PROMPT` |
| `export.ts` | `lifeos.export` v1 bundle 的 create/serialize/parse/assert + `exportRecordMarkdown` |
| `ports.ts` | 仓储 / 资产 / AI / 摘要 / 语音**端口接口**（语音、照片索引等尚未实现） |
| `movie-query.ts` | `cleanMovieQuery`：把选中文本保守清洗成片名 |

### 5.1 记录的核心不变量

| 规则 | 落地方式 |
| --- | --- |
| 记录类型 | `journal` / `task` / `event` / `note`（task 带 `task.status`，note 带 `note.format`：`narticle` / `fragment` / `quote`） |
| **原文不可覆盖** | `body.original` 永远保留；PATCH 的正文只写 `body.edited`；SQL 列 `body_original` / `body_edited` |
| 时间语义分离 | `createdAt`（录入瞬间）≠ `occurredAt`（发生时间）≠ `dueAt`（任务计划）；时间轴按 `occurredAt` 排序，缺失回退 `createdAt` |
| `LifeTime` 三态 | date-only / 带偏移 instant / unresolved local；带偏移的按**请求时区**算显示日 |
| 乐观并发 | 每次写带 `revision`；`UPDATE ... WHERE id=? AND revision=?`，冲突回 **409 `revision_conflict`** |
| 软删除 | `deleted_at_json`；列表与导出恒排除软删行，**数据库备份仍保留** |
| 隐私 | `is_private`：时间轴默认遮罩；**不进**周/月摘要、任务摘要、AI 上下文 |
| 演示数据 | `is_demo`（持久化字段，**正文里看不到任何前缀**）+ 对象 id 以 `demo-` 开头；设置页可隐藏/删除 |
| 关联不悬空 | 写入前校验 `entityRefs` / `relatedRecordIds` / `assetRefs` 目标存在且类型匹配，否则 400；`entityRefs` 连当时名称一起存，实体改名不破坏可读性 |
| 删除被引用对象 | 返回 **409**，不级联改记录 |
| `@` 提及 | 只认已知名称/别名，且 `@` 前不能是拉丁字母数字（排除邮箱）；**只增不减**——手工取消的关联不会被旧文本悄悄加回 |

### 5.2 资产（照片/音频/文件）

- 资产**只存引用**（`assetId` + 可替换的 `storageRefs`），**不把原件复制进 SQLite**。
- 新上传文件名 = **`<sha256><ext>`（内容即地址）**，落在 `uploads/YYYY/MM/`；**库里旧行仍指 UUID 路径 —— 永不搬历史文件**。
- `contentHash` 挂在 **`storageRef`** 上，`GET /api/assets` **不返回它**（数覆盖率只能读库）。
- 只有 `POST /api/assets/uploads` 会算 hash；走 `POST /api/assets`（JSON 自带 storageRefs）进来的资产永远没有 → 补 hash 是**单向窗口**。
- 「孤儿」定义 = 活记录引用 ∪ **仍在货架上的本地快照**引用；快照读不了 → 整轮收集跳过（不敢把「不知道」当「没人引用」）。
- 派生缩略图**只允许两档宽度**：`?w=400`（网格/托盘）与 `?w=1200`（周卡/月历底纹），其它值 HTTP 400；加宽度必须同时改后端与前端。HEIC 不支持是故意。

---

## 6. 后端（`apps/api`）

### 6.1 文件分工

| 类别 | 文件 |
| --- | --- |
| 入口/装配 | `main.ts`、`config.ts`、`server.ts`、`route-context.ts` |
| HTTP 工具 | `http-kit.ts`、`http-body.ts`、`http-cookies.ts`、`field-validate.ts` |
| 领域服务 | `repository.ts`、`record-builders.ts`、`timeline-query.ts`、`summary.ts` / `summary-routes.ts`、`assistant.ts` |
| 身份与租户 | `identity-store.ts`、`tenant-config.ts` |
| 资产 | `asset-static.ts`（上传落盘/内容寻址）、`derived-thumbs.ts`（sharp 缩略图）、`asset-gc.ts` + `asset-gc-scheduler.ts` |
| 备份 | `backup.ts`、`backup-config.ts`、`backup-scheduler.ts`、`backup-timeline.ts`（时光机只读）、`backup-retention.ts` |
| 可选集成 | `ai-config.ts`、`weather.ts` / `weather-config.ts` / `weather-selection.ts` / `weather-archive-scheduler.ts`、`movie.ts` / `movie-config.ts` / `movie-input.ts` |
| 路由模块 | `routes-records.ts`、`routes-entities.ts`、`routes-assets.ts`、`routes-modules.ts`、`routes-weather.ts`、`routes-ai-movie.ts`、`routes-backup.ts` |

### 6.2 HTTP 路由（默认前缀 `/api`；预览 API 3011 代码相同）

| 分组 | 端点 |
| --- | --- |
| 健康 / 会话 | `GET /api/health`、`GET /api/auth`、`POST /api/auth/login`、`POST /api/auth/logout` |
| 账户模式 | `POST /api/auth/invite/check`、`POST /api/auth/register`；owner 专属 `GET|POST /api/admin/accounts`、`PATCH /api/admin/accounts/:id/password`、`POST /api/admin/accounts/:id/disable`、`GET|POST /api/admin/invites`、`POST /api/admin/invites/:id/revoke` |
| 记录 / 摘要 | `GET|POST /api/records`、`PATCH|DELETE /api/records/:id`、`GET /api/summaries`、`POST /api/summaries/manual`、`POST /api/summaries/regenerate` |
| 迁移 | `GET /api/export?format=json\|markdown`、`POST /api/import`（`lifeos.export` v1，事务内校验 + 重复 ID 409） |
| 实体 | `GET|POST /api/entities`、`PATCH|DELETE /api/entities/:id`、`POST /api/entities/:id/relations`、`DELETE /api/entities/:id/relations/:targetId` |
| 资产 | `GET|POST /api/assets`、`POST /api/assets/uploads`、`POST /api/assets/resolve`、`PATCH|DELETE /api/assets/:id`、`GET /api/assets/:id/content`、`GET /api/assets/:id/thumbnail?w=`、`GET|DELETE /api/assets/thumbnails`、`GET /api/assets/trash`、`POST /api/assets/trash/:id/restore`、`DELETE /api/assets/trash/:id`、`GET /api/assets/trash/:id/content` |
| 私密模块 | `GET /api/modules/cycle-intimacy`、`PUT .../config`、`POST .../events`、`DELETE .../events/:id` |
| AI / 观影 | `GET /api/ai/status`、`POST /api/ai/config`、`POST /api/ai/config/test`、`POST /api/ai/assistant`；`GET /api/movie[s]/status`、`POST /api/movie/config`、`POST /api/movie/config/test`、`POST /api/movie/resolve`、`POST /api/movie/import`（`/upsert`） |
| 天气 | `GET /api/weather`、`POST /api/weather/current`、`POST /api/weather/config`、`POST /api/weather/config/test`、`GET /api/weather/archive`、`GET /api/weather/observations`、`POST /api/weather/device/location`、`POST /api/weather/device/locate`、`GET|POST /api/weather/profiles`、`POST /api/weather/profiles/activate` |
| 备份 | `GET /api/backup/status`、`GET /api/backup/snapshot`、`GET /api/backup/runs`、`POST /api/backup/local`、`POST /api/backup/s3`、`POST /api/backup/s3/test`、`POST /api/backup/dual`、`GET|POST /api/backup/config`、`GET|POST /api/backup/schedule`、`GET|POST /api/backup/retention` |
| 其它 | 非 `/api` 的 GET/HEAD 走 `apps/web/dist` 静态托管（生产同源） |

### 6.3 SQLite 结构与迁移

- 建表全在 `repository.ts` 构造函数内：全部 `CREATE TABLE IF NOT EXISTS ... STRICT` + **WAL**。
- 业务库表：`records`（含 `body_json`、`body_original`、`body_edited`、`occurred_at_json`、`entity_refs_json`、`asset_refs_json`、`task_json`、`note_json`、`is_private`、`is_demo`、`is_backfill`、`revision`、`timeline_sort`、`deleted_at_json` + 索引 `records_timeline_idx` / `records_kind_idx`）、`entities`、`assets`、`asset_trash`、`day_summaries`、`cycle_intimacy_module`、`cycle_intimacy_events`、`auth_sessions`、`backup_runs`、`backup_schedule`、`backup_retention`、`weather_device_locations`、`weather_day_cache`、`weather_observation`。
- 身份库表（`identity-store.ts`）：`identity_meta`、`tenants`、`accounts`、`identity_sessions`、`identity_invites`。
- **没有 migration 框架**：启动时用 `PRAGMA table_info` 探测缺列再 `ALTER TABLE ADD COLUMN`；另有一次性事务把旧的 `【示例】` 前缀迁成 `is_demo=1`。

### 6.4 请求边界与认证

- **回环绑定可无密码**；绑定非回环时 `LIFEOS_PASSWORD` 必填；无密码模式额外校验 Host 必须是 localhost/127.0.0.1/::1（防 DNS rebinding）。
- 密码/账户模式用 HttpOnly + SameSite=Lax 的 `lifeos_session` cookie；生产 HTTPS 反代下必须 `LIFEOS_COOKIE_SECURE=true`。
- 写请求**只接受 JSON**，限制 body 大小、检查 Origin，**不开放任意 CORS**。
- 账户模式是**显式开启**（`LIFEOS_ACCOUNT_MODE=1`）：最外层网关 fail-closed 包住全部 `/api/*`，再按**服务端身份**调度到对应租户 app；客户端自带的 tenant 头/路径/cookie 字段**不作为路由身份**。

### 6.5 可选集成的实现要点

| 集成 | 要点 |
| --- | --- |
| **AI（DeepSeek）** | Key 以 AES-256-GCM 写入 `data/ai-config.json`，状态接口**永不回传**；助手只读非隐私记录；无 Key 或请求失败**回退本地规则**；日摘要 provider 在 `summary.ts` |
| **天气（和风 QWeather）** | 支持「地点方案」按设备保存；有日缓存与历史观测表；设备跟随定位时**坐标换城市后即弃，只存城市不存轨迹**，60s 限流 |
| **观影（TMDb）** | 只走官方 `/find`、`/search/movie`、`/movie`，不抓豆瓣；关闭模块只停识别，不删已保存的电影 |
| **备份（S3-compatible）** | 手写 **AWS SigV4**，兼容 AWS S3 / MinIO / R2 / 七牛等；配置写 `data/backup-config.json`，密钥加密，状态接口不回传 |
| **多租户** | 成员租户目录 `data/tenants/<uuid>`（独立 SQLite / assets / backups）；四类集成密钥由 `HMAC-SHA256(masterSecret, "lifeos:tenant-config:v1:<tenantId>:<module>")` 派生；master secret 存 `identity_meta.config_master_secret` |

---

## 7. 前端（`apps/web`）

### 7.1 结构特点

- `src/` 是**扁平单层**（约 44 个文件）；**入口与根组件同在 `main.tsx`**，文件末尾 `createRoot(...).render(<App/>)`。
- **没有路由库**：`activeView` state 切视图 + `#settings/<page>` hash 做深链（`app-types.ts` 定义 `AppView` / `SettingsPageId`，`app-meta.ts` 定义导航表 `NAV_ITEMS` 与 `SETTINGS_PAGE_GROUPS`）。
- **没有状态库**：全部靠 `App()` 内约 100 个 `useState` + props 下钻；数据加载是一批 `useEffect` + `AbortController`。
- 缓存：`recordsCacheRef`（上限 24），今天视图预取前后一天。

### 7.2 视图清单

| 视图 | 文件 | 说明 |
| --- | --- | --- |
| 今天 / 时间轴 / 任务 | `main.tsx` + `timeline.tsx` | 三者共用一个 `Timeline`，靠 `queryPath`（`date` / `kind`）区分 |
| 日历（周/月） | `calendar-view.tsx` | 周卡照片底纹、月格照片、每日 AI 小结编辑、周期面板 |
| 笔记库 | `record-dialogs.tsx`（`NotesLibrary`） | 文章 / 碎片 / 摘抄 |
| 联系人与地点 | `dialogs.tsx`（`EntitiesView`） | 实体与关系卡 |
| 时光机 | `TimeMachine.tsx` | **只读**穿越：快照、差异三分类、隐私蒙版 |
| 设置 | `settings-cards.tsx` | 11 个子页：账号与会话 / 导入导出 / 备份 / 预置数据 / 照片 / 界面 / 天气 / AI / 观影 / 私密周期 / 关于 |
| 门禁 | `dialogs.tsx`（`LoginGate`）、`WelcomeGate.tsx` | 登录；受邀者四步欢迎（登录 → 邀请码 → 自设账号密码 → 选天气） |

主要组件：`composer.tsx`（记录编辑器 + 补记）、`timeline.tsx`（含照片网格 `RecordPhotoGrid`、关系胶囊 `TimelineEntityChip`、隐私遮罩、经期月亮算法）、`shell-nav.tsx`、`WeatherHeader.tsx` / `WeatherBackground.tsx` / `WeatherLocationPicker.tsx`、`AIAssistant.tsx`、`task-summary.tsx`、`task-schedule.tsx`、`date-field.tsx`、`shot-drop-zone.tsx`、`BackupCalendar.tsx`、`ScrollSlotStrip.tsx`；工具 `mention.tsx`、`photoScore.ts`、`movie.tsx`、`diagnostics.ts`、`webmcp.ts`、`time.ts`、`calendarData.ts`。

### 7.3 数据层与持久化

- **唯一 API 客户端** `api.ts`：同源 `credentials: same-origin`，非 OK 抛 `ApiError` 并记日志；`RecordView = TimelineRecord & { revision }`。
- **乐观更新**：写后 `reloadRecords()` + 就地替换；照片清空带「撤销」toast。
- **409 冲突**：PATCH/DELETE 必带 `revision`，捕获 409 后重读最新版合并，UI 保留草稿并提示。
- **localStorage 键**：`lifeos.hideDemo`、`lifeos.moviePromptHidden`、`lifeos.ai.assistant-visible`、`lifeos.composerShots`、`lifeos.uiFont`、`lifeos.ai.chat`、`lifeos.ai.launcher-position.v1`、`lifeos.weather.follow-location.<tenantId>`；退出登录时会清掉租户敏感键。**没有 Service Worker**。

### 7.4 样式与字体

- 单一全局表 `styles.css`（约 11.9k 行，136 个 `--*` 设计变量，47 个 `@media`，主断点 `560/900/720/390px`，17 个 `@keyframes` 多为天气动画）；另有 `welcome.css`。**无 Tailwind、无 CSS Modules。**
- 字体用 5 个 `@font-face` + `local()` 把 MiSans 各字面重映射到标准字重（**不打包字体文件，走系统安装**）；第三方许可说明在 `apps/web/public/fonts/THIRD-PARTY-NOTICES.md`。
- **界面文字不可选中**是硬规则：`body` 默认 `user-select: none`，只有①表单控件 ②正文白名单可选中；白名单**只放承载文字的叶子节点，绝不放容器**。守它的是 `.review/verify-selectability.mjs`（59 条断言，含真手势拖蓝）。

---

## 8. 数据与运维

### 8.1 `data/` 里有什么

```text
data/
├─ lifeos.sqlite (+ -wal / -shm)   生产库
├─ ai-config.json / weather-config.json / movie-config.json   加密的集成配置
├─ DO-NOT-DELETE.md                防误删说明（人写的警戒）
├─ backups/                        本地 SQLite 备份 + _trash/
└─ derived/
   ├─ snapshots/                   时光机快照（**只读穿越用**）
   └─ thumbs/                      派生的 webp 缩略图缓存
```

### 8.2 三层备份体系

| 层 | 说明 |
| --- | --- |
| 本地备份 | 设置页一键生成一致性 SQLite 副本，默认保留 **30 天**；默认目录 `${LIFEOS_DATA_DIR}/backups` |
| 定时备份 | 可选每日一次，按 **Asia/Shanghai** 定时；可「双备份」（本地 + 对象存储同一份副本） |
| 对象存储 | S3-compatible（AWS SigV4），本机配置为 bitiful `cdnb` 桶的 `product-backup/lifeos` 前缀 |
| **整卷备份** | `scripts/backup-instance.mjs`：逐库一致性复制（含 `identity.sqlite` 与成员库）、复制照片与配置、写 SHA-256 清单；`verify` 校验、`restore` **只接受不存在的目标目录** |

> ⚠️ 单库备份**不包含** `identity.sqlite`、其他租户库、照片原件与 `data/*.json` 配置，**不能单独用于多租户整站恢复**。JSON/Markdown 导出适合迁移与阅读，也不是灾难恢复方案。
> ⚠️ 快照（时光机）**绝不能原地打开**（`readOnly:true` 照样生成 `-wal`/`-shm`）——先复制到 `derived/snapshots/`，用完连 sidecar 删。

### 8.3 资产生命周期

- 上传 → `uploads/YYYY/MM/<sha256>.ext`；删除 → 进 `asset_trash`（回收站），30 天宽限后由 GC 调度回收。
- 回收站支持恢复：先按记录路径找 → 再按 hash 在 `uploads/` 与 `uploads/_orphan-trash/` 找；找不到返回 **404**，绝不硬塞一条指向空气的行走。
- **按 hash 搬文件之前必须查 `claimed`**：文件名就是哈希 → 重传会落在同一路径 → 可能抢走活资产正用的文件。

### 8.4 容器与部署

- `Dockerfile`：两阶段构建（build → runtime），runtime 用 `node:24-bookworm-slim`，`USER node`，`VOLUME ["/data"]`，CMD 跑编译后的 `apps/api/dist/src/main.js`。
- `compose.yaml`：端口**只绑 `127.0.0.1:3001`**（宝塔/Nginx 反代到它）；`/data` 命名卷持久化；显式转发 `LIFEOS_*`、`BACKUP_S3_*`、各家 Key 与 `LIFEOS_LOG_DIR`。
- 公网上线清单（README 有完整版）：HTTPS 反代 + `LIFEOS_ACCOUNT_MODE=1` + `LIFEOS_COOKIE_SECURE=true` + 精确 `LIFEOS_ALLOWED_ORIGINS`；首次 owner 引导用 `LIFEOS_OWNER_USERNAME` + ≥10 字符密码，**建好后删掉这两个引导值并重启**；四个 `*_CONFIG_SECRET` 必须先固定强随机值且**永不复改**（改了就解不开旧密文）。
- **Docker / NAS / 真实域名链路至今未在真机验证**（本机没有 Docker），这是明确的「未验证」项，不能当已通过。

---

## 9. AI 协作与交接体系（这个项目特有）

这不是普通的仓库，它有一套**为多 AI 接力设计的现场**。

### 9.1 四份权威文件

| 文件 | 回答什么 | 写入规则 |
| --- | --- | --- |
| `AGENTS.md` | **规则**：协作铁律、环境坑、主人看重什么 | 只此一份 |
| `docs/changelog.md` | **改了什么**：每条必须带 `AI:` 署名，写重点不写流水账 | **只追加到最末尾**（正序旧→新），禁改历史 |
| `docs/todo.md` | **还没做的 / 等拍板的**：每条按「症状 → 已知事实（带证据）→ 未知/未验证 → 动手前必读 → 建议路线 → 复现命令」 | 按同一套写，证据必须给 文件+行号+命令 |
| `docs/self-audit.md` | 「我当初怎么说、后来怎么做、有没有说谎」 | 同样 append-only |

配套：`docs/audit-prompt.md`（三轮递进式 Debug 审计提示词，新开会话整段贴进去即可用；**新增「踩坑类别」时要追加进它的第 1 轮模式库**，否则会退化）。

### 9.2 协作铁律（摘要）

1. 改完必须追加 changelog，缺 `AI:` 署名视为交接未完成。
2. **先讨论、点头、再动手**（设计/创意/规则类）；确认过的小步执行可直接做。
3. 不要做没被要求的事。
4. **QA 的目标是「找问题」，不是「证明能用」**；结论落盘 `.review/*.txt`，末行 `RESULT: PASS/FAIL`。
5. 报告要能独立成立：路径 / 根因 / 已确认 vs 未验证 分清。
6. **不要主动出截图**：视觉验收全部靠 CDP 断言（计算样式 / 元素计数 / 尺寸），主人自己开 5199 看效果。
7. **`commit` 可自动做，`push` 必须先问**；禁止 `git checkout .` / `stash` / `reset --hard` / `clean -fd`（仓库常压着未提交成果）。

> 边界提醒：`.gitignore` 排除了 `AGENTS.md`、`docs/changelog.md`、`.workbuddy/`、`.review/` —— **接力依赖链不在 git 里，只存在于本机磁盘**。git 只当「代码检查点」。

### 9.3 `.review/` 验收工具箱

- 规模：顶层约 **300** 个 `.mjs` 脚本（含 `lib/`、夹具、备份子目录，总计 695 个条目）；**已被 gitignore**，不随仓库走。
- 分类用法：
  - `accept-serve.mjs` —— **不是验收工具**，是「把主人的应用跑起来」（3011 + 5199，服务生产库 `data/`）；配套 `stop-accept-serve.mjs` 只关它那一棵树（靠 PID 文件）。
  - `data-inventory.mjs` —— 只读盘点 `data/`，**有主人写的记录就退出码 1**；动手前必跑。
  - `audit-toolbox-targets.mjs` —— 产出「哪些脚本会写生产库」的清单；有未守卫的写入脚本 → 退出码 1；存在无法分类脚本 → 退出码 2 / `RESULT: INCOMPLETE`。
  - `lib/production-guard.mjs` —— **直连生产端口的脚本必须把它放在第一条 import**；它读 `GET /api/backup/status` 的有效 `dataDirectory` / `databasePath` / `assetRoot` 判断目标，**fail-closed**；放行需 `LIFEOS_ALLOW_PROD_ACCEPTANCE=1`。
  - `run-acceptance.mjs` —— 全套回归，结论汇总到 `.review/acceptance-summary.txt`。
  - 一批 `verify-*.mjs` / `probe-*.mjs` —— 单项验收与只读探针（各自自备隔离实例与夹具，**造数据的脚本必须自清理**）。
  - 生产专用工具（**故意豁免守卫**）：`retract-record.mjs`、`seed-timemachine-demo.mjs`、`prune-duplicate-period-ends.mjs` —— 理由是「它们的职责就是生产」，且**都自带能撤干净的出口**。

### 9.4 验收铁律（踩出来的）

- 判据三件套一起看：**退出码 + FAIL 行 + 断言条数**。脚本中途抛异常时**一行 FAIL 都不打**，结果文件还留着上次的 `RESULT: PASS`。
- **更阴的假绿**：只把结论写进自己的 txt、既不打 stdout 也不设退出码的脚本，在批处理里永远绿。
- **截图对截图要「整图拟合」**（±N 像素内搜最佳对齐 + 加对照组），不能靠「数左右两半 / 分桶」——clip 原点是小数，两次拍摄会偏半像素到几像素，按半截统计必误报。
- **量尺不能覆盖「设计上本来就该变的东西」**；**必须配对照组** —— 测不出失败的测试等于没测。
- **断言要绑「接口说什么」，不绑「夹具还在不在」**；日期夹具**动态推导**，不许写死。
- 图片判据 = 画布采样（缩到 8×8 数不透明像素与颜色数）；`loading="lazy"` 未进视口会伪装成「坏了」，**不滚动就没有资格对「图是否加载」下结论**。

### 9.5 环境坑速查（都真踩过）

- bash 是**残缺 PortableGit**（无 `ls/cat/head/grep/find`）→ 用 `node -e` 或内置工具。
- 写含中文的文件**只用 Node 的 `readFileSync/writeFileSync(…, "utf8")`**；`Set-Content` / `Out-File` 是历次乱码源头。
- **按天对账一律 `Asia/Shanghai`**（`Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" })`）；UTC `slice(0,10)` 会把跨午夜记录归错天（已踩两次）。
- **42 格月历第一格 = 含 1 号那周的周一**，不是 1 号。
- 任何「先建后改」的脚本，**改写成功后必须用返回体刷新本地缓存的 revision**（乐观锁 409）。
- CDP 的 `--user-data-dir` **只放项目 `.review/`，绝不放 `%TEMP%`**（曾把 C 盘塞满 → 所有 shell 工具报 ENOSPC）；回收用 `sweep-profiles.mjs`。
- **改同一个文件时，一次消息只发一处 Edit**：同消息多发「找替换」时，工具每处都返回 success，但并发写会静默丢失后写者覆盖先写者的改动。

---

## 10. 当前状态、边界与已知未决项

### 10.1 已实现且有验收的能力

时间轴（日记/任务/事件/笔记）、周/月日历（含摘要、法定休息日/调休、节气、照片底纹）、关联与检索（人物/地点/项目/主题、别名、关系卡、记录间关联、关键词/类型/日期搜索）、`@`/`#` 提及、外部资产引用与只读预览、隐私记录、可选天气、可选 AI 助手、备份与迁移（本地/定时/S3/JSON/Markdown/`lifeos.export` v1）、可选账户模式与多租户、时光机（只读穿越）、笔记资料库、观影（TMDb）模块、周期与亲密模块（仅非医疗日历估算）。

### 10.2 明确的边界（不要当作已实现）

- **M2** 外部照片/文件只读索引、Synology Photos 接入：**未实现**，只预留端口。
- **M3** AI 分类与「带出处的检索」、可追溯派生数据：**未实现**（当前 AI 只有助手与日摘要）。
- **M4** 语音录音上传与转写：**未实现**，只预留三层数据模型（`audio_raw` / `transcript_raw` / `content_edited`）。
- 原生 App、离线同步（PWA）、外部日历同步、提醒中心：**未实现**。
- **账户模式只做过隔离环境验收，从未在真实服务器/DNS/HTTPS 反代上跑过**；旧单用户库的迁移与回退演练也**未执行**。
- Docker / Compose / NAS：配置齐全但**真机未验证**。

### 10.3 已知未决 / 工程债（详见 `docs/todo.md`）

- **生产守卫的语义已经收紧**：不再用可迁移的「备份目录」当身份证明；但「UNGUARDED = 0」**仍不是全库安全证明**（词法启发式分类 + 直接开库写 + 经 helper 隐藏的写入仍须人工复核）。
- 工具箱里仍有若干**历史红色**验收（如 `verify-asset-trash`、`verify-composer-shots`、`verify-hash-dedup`、`verify-search-ui`、`verify-thumbnails`、`probe-search-click`）——**是旧账，不是新回归**。
- 审计报告 `docs/debug-audit-report-2026-09-24.md` 共 18 项发现（P0 0 / P1 3 / P2 5 / P3 10），大部分已修；**仍留**：`A-09` revision 不在导出契约内、`A-10` Markdown 导出缺 `note` 元数据、`A-11` 日志两处重复实现且按 UTC 日切、`A-14` 未配置时回显真实 bucket/prefix、`A-15` 客户端按浏览器时区分天 vs 服务端固定上海（未复现）、`A-18` 生产库里的软删墓碑与 `A-05` 的整卷备份真实演练。
- 大文件拆分（`main.tsx` / `server.ts`）与 Web 层单测覆盖仍偏薄。
- **字体一致性待产品决定**：MiSans 只通过 CSS `local()` 使用，未向访客提供字体文件 → 未安装 MiSans 的设备会看到系统回退字体；内嵌需先确认小米许可的适用方式。Maple Mono 已于 2026-09-24 移除。
- 账户模式遗留：邀请码**只能创建时选有效期**（无编辑/续期，改就撤旧的）；「第二个管理员 / owner 转让」未做；手机定位天气需 HTTPS + 授权，**真机表现未验**。

---

## 11. 红线清单（照做就行）

1. **`data/` 是生产库**：不 `rm`、不清空、不「重置预览数据」、不跑 `seed-demo --clean`。要干净数据 → 另开 `LIFEOS_DATA_DIR`。动手前跑 `node .review/data-inventory.mjs`。
2. **3011 / 5199 是主人正在用的预览**：只有 `.review/accept-serve.mjs` 有权占用；收尾不要杀，**绝不把空目录留在她的端口上**；**她自己的 3001 永不可杀**。
3. **`.env` 里那 4 个 `*_CONFIG_SECRET` 不许删改**（种子换了 = 密钥全解不开）。搬数据目录前必须确认种子已钉住。
4. **会话里不主动出截图、不贴图**；视觉结论靠 CDP 断言，主人自己开 `http://127.0.0.1:5199/` 看。
5. **`push` 必须先问**；禁止任何会抹掉 working tree 的 git 命令。
6. 生产站点只做**无副作用探测**；任何会触发服务端动作的请求先问。
7. 对象存储只碰 LifeOS 自己的命名空间（`product-backup/lifeos/**`），**绝不列/覆盖/删 `backups/**`**（那是另一个项目的生产库 dump）。

---

## 12. 权威文档索引

| 想了解 | 去看 |
| --- | --- |
| 产品要什么 | `docs/requirements.md` |
| 为什么这么设计 | `docs/architecture.md` |
| 分阶段边界 | `docs/roadmap.md` |
| 怎么上手跑 | `README.md`、`apps/api/README.md`、`apps/web/README.md` |
| 人机协作规则 | `AGENTS.md` |
| 改过什么 | `docs/changelog.md` |
| 还剩什么 | `docs/todo.md` |
| 自我对账 | `docs/self-audit.md` |
| 审计方法学 | `docs/audit-prompt.md`、`docs/debug-audit-report-2026-09-24.md` |
| 账户模式这一棒的交接 | `docs/handoff-review-2026-09-24-account-mode.md` |
| 各专项执行计划 | `docs/notes-library-execution-plan.md`、`docs/date-switch-execution-plan.md`、`docs/mobile-layout-execution-plan.md`、`docs/calendar-summary-editing-plan.md` |

### 自查命令（只读，用于核对本文是否过期）

```bash
export PATH="/c/Program Files/nodejs:$PATH"
node .review/data-inventory.mjs                       # 生产库盘点（有主人记录 → exit 1）
node .review/audit-toolbox-targets.mjs                # 哪些验收脚本会写生产库
npm run typecheck && npm test                         # 基线是否仍全绿
```

---

*本文由「在下 / WorkBuddy」于 2026-09-25 只读通读后撰写；未修改任何既有文件。*
