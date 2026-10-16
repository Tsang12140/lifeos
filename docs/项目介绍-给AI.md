# LifeOS 项目介绍（交给外部 AI 的完整背景）

> **这份文档是干什么的**：把 LifeOS 的全部必要背景一次性讲给一个**读不到代码库、看不到文件**的 AI。
> 读完它，你应该能在不追问"能不能看下代码"的前提下，对 LifeOS 的功能设计、技术方案、交互取舍给出**可落地的建议**。
>
> **快照时间**：2026-10-16（Asia/Shanghai）。项目仍在快速演进，数字会过期，但结构、约束、红线相对稳定。
>
> **阅读顺序建议**：§1–§3 必读（产品是什么、约束是什么）；§5–§8 写方案前必读（不变量与架构边界）；
> §9–§10 是这个项目特有的工程/设计规矩；**§11 是最常被咨询的部分**（现状、已知问题、待拍板项）；§12–§13 是术语与"怎么答才有用"。
>
> **一条总原则**：本文里的"红线""铁律"**不是审美偏好，是踩过事故之后定下来的**。
> 如果你的建议和某条红线冲突，请**显式指出冲突并给出替代路径**，不要默默绕开。

---

# 1. 一句话定位

**LifeOS 是一个以时间轴为核心的自托管个人生活记录工具。**
日记、任务、事件、知识笔记放在同一条可回看的时间线上，用人物、地点、项目、主题、照片与其他记录建立上下文；
数据默认落在**自己的一个 SQLite 文件**里，不依赖任何第三方账号即可记录、浏览、导出。

| 维度 | 说明 |
| --- | --- |
| **谁在用** | 目前是**一位真实主人**（中文母语）。她把 `http://127.0.0.1:5199/`（本机）和线上 `lifeos.dnbox.cn` 当作**日常应用**在用，不是 Demo。这一点决定了很多约束。 |
| **核心价值链** | 快速记录 → 按时间回看 → 未来能"找回来"。所有设计都服务这条链。 |
| **产品气质** | 内容优先、克制、不打扰；不靠 AI 也完整可用；数据可迁移优先于功能多。 |
| **明确不是什么** | 不是团队协作/多用户 SaaS；不是照片库同步工具（照片原件永远留在 NAS）；不是 Obsidian 的替代品（不与它的复杂配置耦合）；不是通用知识库。 |
| **版本 / 许可** | `0.1.0`，`private: true` 的 monorepo，**MIT License**。 |
| **阶段** | 路线图 M1（记录与时间轴闭环）已完成，并已长出**大量 M1 之外的自建能力**（日历、AI 管家、OCR、时光机、地点、账户模式、存储池…）。 |

---

# 2. 快速事实表

| 项 | 值 |
| --- | --- |
| 运行时 | **Node.js ≥ 24**（`node:sqlite` 需要 22.5+，项目以 24 为基线） |
| 后端 | Node 原生 `node:http` + `node:sqlite` 的 `DatabaseSync`，参数化 SQL。**零 Web 框架、零 ORM** |
| 前端 | React **19.1** + Vite **7.1** + TypeScript **5.9**；图标用 `lucide-react`。**无路由库、无状态库、无 CSS 框架** |
| 领域层 | `packages/core`：模型 / 校验 / 提及解析 / 摘要 / 导出 / **端口接口**。不含任何存储实现 |
| 仓库形态 | npm workspaces monorepo：`packages/core` + `apps/api` + `apps/web` + `scripts` |
| 开发端口 | API `127.0.0.1:3001`，Vite `127.0.0.1:5173`（Vite 把 `/api` 代理到 3001） |
| **本机预览端口** | API **3011** + Web **5199**。⚠️ **这两个端口是主人正在用的实例** |
| 生产 | 宝塔（Linux）+ PM2 进程 `lifeos`，源码在 `/www/server/lifeos-app`，数据在 `/www/server/lifeos-data`，域名 `lifeos.dnbox.cn`。**不用 Docker** |
| 生产机器 | **4 核 4G，且上面还跑着别的项目** ← 任何"加个常驻服务"的建议都要先过这一关 |
| 数据库 | `./data/lifeos.sqlite`（WAL 模式）；账户模式下另有 `data/identity.sqlite` |
| 单元/集成用例 | **421 条**（core 46 / api 268 / web 97 / scripts 10），`node:test`，无 vitest/jest |
| 规模 | `apps/api/src` 85 个 `.ts`；`apps/web/src` 127 个 `.ts/.tsx` + 大量 `.css` |
| 上帝文件 | `repository.ts` 2275 行、`main.tsx` 2118 行、`server.ts` 1434 行、`styles.css` **12786 行** |
| 改动记录 | `docs/changelog.md` 1.4 MB、**131 条带 `AI:` 署名的条目**（只追加） |
| 待办 | `docs/todo.md` 435 KB（每条按「症状 → 证据 → 未知 → 建议路线 → 复现命令」写） |
| 验收工具箱 | `.review/` **700+ 个 `.mjs` 脚本**（已被 gitignore，不随仓库走） |

---

# 3. 产品功能全貌

> 标注 **【核心】** 的是一切的中心；**【已上线】** 指主人日常在用；**【有但未验证】** 指代码完整但没在真机/生产跑过。

## 3.1 记录与时间轴【核心】【已上线】

四种记录类型，共处一条按时间排序的时间轴：

| 类型 | 说明 |
| --- | --- |
| `journal` 日记 | 主体。**可以没有文字，只要有照片**（纯照片日记）。 |
| `task` 待办/任务 | 带 `task.status`，有截止时间 `dueAt`、完成反馈、右侧任务栏。 |
| `event` 事件 | 带时间点的日程。 |
| `note` 知识笔记 | 带 `note.format`：`narticle`（文章）/ `fragment`（碎片）/ `quote`（摘抄）。另有独立的**笔记资料库**视图（§3.7）。 |

- 时间轴按 `occurredAt`（发生时间）排序，缺失时回退 `createdAt`（录入时间）；`dueAt` **只表示未来计划**，绝不被当成"已经发生"。
- **补记**：可以补写过去某天的事，记录带 `isBackfill` 标记。
- 视图：今天 / 时间轴 / 任务三者共用一个 `Timeline` 组件，靠查询参数区分。
- 隐私记录：时间轴默认遮罩（点击才显示），**不进**任何摘要、也不进 AI 上下文。
- 删除是软删除，且**删除后原卡片原地保留 5 秒可撤销**（见 §10）。

## 3.2 日历（周 / 月）【已上线】

- 周视图 + 月视图（42 格，**第一格 = 含 1 号那周的周一**，不是 1 号）。
- 月历标记：法定休息日 / 调休上班日 / 节气 / 自定义习惯 / 周期标记 / 天气。
- **照片背景**：周卡与月历格子可以铺满照片当底纹（不是底部小条）。有固定的选片规则（1 图平铺 / 2–4 图上下分段 / >4 只取 4 段；取样固定"第一张 + 最后一张 + 中间均匀"；月历格子只放 1 张，算法选最优），并且有白蒙版保证文字可读。
- **每日小结**：可编辑、可由 AI 生成、可恢复原样；无 AI key 时用本地规则生成。手写的小结压过自动生成的。
- 空日期格不写"没有记录"、不放"—"占位，保留纸张底色与日期大字。

## 3.3 关联体系【核心】

- 四类实体：**人物 / 地点 / 项目 / 主题**（`entityRefs`），各有别名 `aliases` 与关系卡。
- 记录之间可互相关联（`relatedRecordIds`），可双向跳转。
- 正文里的 **`@名称` 只匹配人物**、**`#名称` 只匹配地点**，在**写入时**由 API 解析成关联；展示层用同一个函数渲染胶囊。
  - 两条保守规则：只认**已知的名称或别名**；`@`/`#` 前一个字符**不能是拉丁字母数字**（排除邮箱 `a@b.com`）。
  - 匹配按最长优先；**提及只增不减** —— 手工取消的关联不会被正文里的旧提及悄悄加回来。
- 关联不悬空：写入前校验被引用对象存在且类型匹配，否则 400。删除仍被引用的实体/资产返回 **409**，不级联改记录。
- `entityRefs` 会**连当时的名称一起存**，所以实体改名后，老记录读起来仍然正确。
- **联系人活跃度**：`contact-activity.ts` 用 60 天半衰期给人物打分排序（谁最近常出现）。

## 3.4 搜索与检索【已上线，但已知是短板】

- 现状：关键词搜索就是**一个 SQL `instr` 子串匹配**（区分大小写、不归一化、无分词），可叠加类型/日期/隐私过滤。
- 库里**没有 FTS5 表、也没有向量表**。实测：FTS5 语义查询命中 **0%**，比零依赖的 char-overlap（67%）还差，所以**不要建议引入 FTS5**。
- 已接入检索的内容包括记录正文，以及**照片的 AI 描述与 OCR 文字**（通过 `json_each` 判 EXISTS，前端零改动）。
- **语义检索是明确的终局方向**，选型已实测但未实施（见 §11.4）。

## 3.5 照片与资产【已上线】

- 资产**只存引用，不把原件复制进 SQLite**：`Asset.storageRefs[]`（`sourceId` / `sourceRef` / 可选链接 / 可选 hash）。
  换存储位置时 `assetId` 不变 ⇒ 记录不用跟着改。
- 上传走 `POST /api/assets/uploads`，文件名 = **`<sha256><ext>`（内容即地址）**，落在 `uploads/YYYY/MM/`。
  **历史文件永不搬**（库里旧行仍指 UUID 路径）。
- 派生缩略图**只允许两档宽度**：`?w=400`（网格/托盘）与 `?w=1200`（周卡/月历底纹），其它值 HTTP 400。加宽度必须同时改前后端。
- 回收站：删除进 `asset_trash`，30 天宽限；恢复时按记录路径找 → 再按 hash 在 `uploads/` 与 `uploads/_orphan-trash/` 找，找不到返回 404（**绝不硬塞一条指向空气的行**）。
- **照片 AI 描述**（VLM）：可选能力，默认档位是「中成本档 `context`」。
- **照片文字 OCR**（腾讯云）：与描述**正交** —— "OCR 出字、VLM 出意"，互补不替代（书页/菜单/小票是 OCR 强区）。
  有降级链「高精度 → Basic」，有"确认无字"的空标记（三态：有字 / 没字 / 没读成）。
- **图片阅读器**：全屏查看、缩放、切换，有已知的切换闪烁问题（§11.3）。

## 3.6 AI 管家【已上线，是近期的重心】

- 一个**对话式助手**，挂在界面上（桌面默认停靠，移动端是上拉 popover）。
- 能力：
  - **问答**：基于非隐私记录回答问题（隐私正文**永不进 prompt**，只告诉模型"另有 N 条"）。
  - **补记（backfill）**：把一段碎片文字/截图变成候选记录 → 生成草稿 → **由人确认后**才落库。
  - **UI 控制命令**：模型可以驱动界面（切视图、筛选记录、定位某条记录）。契约在 `packages/core/src/ui-command.ts`。
    - 两条承重规则：① **模型从不执行任何东西**，它只提议；服务端把提议编译成白名单内的命令；② **P0 没有写命令** —— 创建/修改/删除仍然只能走"草稿 → 人点确认"。
    - `settings` 故意不在可跳转视图里（主人可以被送到她读的页面，不能被送到存凭据的页面）。
  - **分享图**：把对话导出成白底竖幅文字海报（有半小时窗口、两屏上限等约束）。
  - 流式回复、停止生成、对话历史存档（**0 条消息的空会话不进存档列表**）。
- 供应商：DeepSeek（服务地址 / 模型 / 思考开关 / 推理强度可配）。
- **无 key 或请求失败时回退本地规则**，核心功能不依赖 AI。

## 3.7 笔记资料库与分享【已上线】

- 独立视图，含**纸签瀑布流**布局、文件夹（`NoteFolder`，ID 稳定可迁移）、笔记版本历史。
- **公开分享**：`/api/public/notes/:space/:token`，可选密码保护、可选允许编辑；公开页有独立 cookie。
  这是唯一一条"不登录也能读"的路径，所以它的安全模型是单独的。

## 3.8 自定义习惯【已上线】

- 最多 100 个习惯，每个有名字（≤40 字）、图标（来自固定图标库）、以及**逐日打卡的日期数组**（≤40000 天）。
- 显示在月历上，属于"周期与亲密"模块路由下（`/api/modules/cycle-intimacy/habits`）但数据独立。

## 3.9 地点（高德集成）【已上线，真机待验证】

- 日记的地点按钮、联系人与地点管理页共用**店铺/地址搜索**（高德 Web 服务 API）。
- 框选日记文字再点地点按钮会自动搜索；直接输入停顿 600ms 后搜索；中文输入法组词期间不请求。
- 浏览器定位 → 转 GCJ-02 → 周边搜索；附近 5 公里排序，可扩到 50 公里。
- 选中后保存名称、地址、城市、电话、GCJ-02 坐标、可用的图片链接。
- 地点卡在时间轴上位于照片之后；点击可看地址、导航、拨号、相关日记。
- **地图**：周边静态小地图（后端代理，Key 不下发浏览器）；跳外部 App 支持高德/百度/苹果地图。
- **收录档案**：记录这个地点第一次被哪篇日记关联。
- **备用 IP 定位**（高德，默认关闭）：只在手动浏览器定位失败时用；需要反代 `X-Real-IP` + `LIFEOS_TRUST_PROXY=1`。

## 3.10 天气（和风 QWeather）【已上线】

- 表头动画 + 地点 + 温度 + 日期天气；可把当天/实时天气**钉在记录上**。
- 按设备保存"位置方案"；三级省市区下拉（数据 3572 个位置）。
- 跟随定位时：**坐标换城市后即弃，只存城市不存轨迹**，60 秒限流。
- 日出/日落图标只在"距事件 3 小时内 + 天气已配置"才存在。
- 没有 Key 时不伪造天气。

## 3.11 观影模块（TMDb）【已上线】

- 只走 TMDb 官方 `/find`、`/search/movie`、`/movie`，**不抓豆瓣**。
- 关闭模块只停识别，**不删已保存的电影**。

## 3.12 周期与亲密模块【已上线，私密】

- 记录经期边界与亲密标记，显示**非医疗的日历估算**。
- 数据独立保存；关闭显示不删数据。
- 有"一段经期只有一个结束日"的不变量（历史脏行清理工具存在）。

## 3.13 时光机【已上线】

- **只读**穿越：选一个历史快照 → 看它与今天的差异，分三类（不在了 / 改过了 / 后来才有）。
- 隐私记录在差异里也打蒙版。
- 快照**绝不能原地打开**（`readOnly:true` 照样生成 `-wal`/`-shm`）——先复制出来用完连 sidecar 删。

## 3.14 备份 / 导入导出【已上线】

四层，用途不同，**不要互相替代**：

| 层 | 内容 | 边界 |
| --- | --- | --- |
| **JSON / Markdown 导出** | `lifeos.export` v1 bundle；Markdown 适合阅读 | 适合迁移与阅读，**不是灾难恢复** |
| **单库本地备份** | 一致性 SQLite 副本，默认保留 30 天；可每日定时 | **不含** `identity.sqlite`、其他租户库、照片原件、`data/*.json` |
| **S3-compatible 对象存储** | 同一份副本上传（**手写 AWS SigV4**，兼容 S3/MinIO/R2/七牛） | 同上 |
| **整卷备份** | `scripts/backup-instance.mjs`：逐库一致性复制 + 照片 + 配置 + SHA-256 清单；`restore` **只接受不存在的目标目录** | 真正的整站恢复方案 |
| **`.lifeos` 完整加密包** | 单空间全量（含私密与软删除记录、资产原件、小结、周期、天气缓存） | **不含**账号/会话/密钥/排程/浏览器偏好 |

`.lifeos` 包格式（细节见 `docs/archive-format.md`）：
magic `LIFEOS01` + 随机 salt + 随机 IV + AES-256-GCM 密文 + tag；
密钥由密码经 **scrypt(N=131072, r=8, p=1, dkLen=32)** 派生；最大 20 GiB；原件缺失时**拒绝生成**（不提供不完整的恢复包）。
导入先解密校验 → 展示差异 → 人确认「替换当前空间」→ 先自动存一份当前快照 → 事务替换。

## 3.15 账户模式与多租户【已上线，仅隔离环境验收过】

- **显式开启**（`LIFEOS_ACCOUNT_MODE=1`），默认关闭，旧单用户模式保持原样。
- 最外层网关 **fail-closed** 包住全部 `/api/*`，再按**服务端身份**调度到对应租户 app；
  客户端自带的 tenant 头/路径/cookie **不作为路由身份**。
- 每个账号：独立 SQLite、独立资产目录、独立备份目录（`data/tenants/<uuid>`）。
- 集成密钥由 `HMAC-SHA256(masterSecret, "lifeos:tenant-config:v1:<tenantId>:<module>")` 派生。
- 无公开注册；owner 手动创建/停用账号；停用立即撤销会话。

## 3.16 存储池（弹指）【有但未上线】

- LifeOS 是 Node，弹指接入层是 PHP。LifeOS 通过**本机 PHP CLI 子进程**调用 `PoolConsumer`，只用 stdin/stdout 传结果。
- 用途：把照片原件存到弹指的对象存储池，而非本地磁盘。
- 有平滑迁移（后台只复制，日常继续用旧存储）、额度校验、读金丝雀（read-canary）。
- **上线前的只读核对清单在 `docs/storage-pool-deployment.md`**，涉及 PM2 用户权限、`open_basedir`、共享账本权限等。

## 3.17 视频【已上线】

- 浏览器内压缩（原片**永不离开浏览器**），限制在 `packages/core/src/video.ts`：输入 ≤200 MB / ≤180 秒，输出 ≤50 MB，长边 ≤1920，帧率 ≤30，码率 2 Mbps。
- 压缩后作为资产上传。**新增媒体类型必须补同规格 CSS**（曾因 `.shot-tile video` 从来没写过，导致视频按原始分辨率画）。

---

# 4. 系统架构

## 4.1 分层与数据流

```text
浏览器 (React 19 + Vite 7, apps/web)
   │  同源 fetch，credentials: same-origin，唯一客户端 apps/web/src/api.ts
   ▼
Node 24 HTTP API (apps/api)  ← 零框架，手写路由
   ├─ packages/core   领域模型 / 校验 / 提及解析 / 摘要 / 导出 / 端口接口
   ├─ repository.ts   SqliteRecordRepository（唯一存储边界，DDL 也在这里）
   ▼
SQLite (WAL)  data/lifeos.sqlite
   │
   └─ 可选外部：和风天气 / DeepSeek / TMDb / 高德 / 腾讯 OCR / S3 / 弹指存储池
```

- 开发时 Vite 在 5173 代理 `/api` 到 3001；生产构建后**同一个 Node 进程**从 `apps/web/dist` 提供同源静态文件。
- **默认不连任何第三方服务**；只有显式配置后才启用。
- 选 SQLite 是为了让单用户实例能在本机/NAS/云主机之间**直接迁移**；将来若要换数据库，只替换 API 适配器，core 模型与导出协议不变。

## 4.2 后端模块分工（`apps/api/src`，85 个 `.ts`）

| 类别 | 文件 |
| --- | --- |
| 入口/装配 | `main.ts`、`config.ts`、`server.ts`、`route-context.ts` |
| HTTP 工具 | `http-kit.ts`、`http-body.ts`、`http-cookies.ts`、`field-validate.ts` |
| 领域服务 | `repository.ts`、`record-builders.ts`、`timeline-query.ts`、`summary.ts`、`summary-routes.ts` |
| AI 管家 | `assistant.ts`、`assistant-conversation.ts`、`assistant-stream.ts`、`assistant-backfill.ts`、`assistant-material.ts`、`assistant-persona.ts`、`assistant-chat-history.ts`、`assistant-actions.ts`、`assistant-cancellation.ts`、`assistant-place-context.ts`、`assistant-json.ts` |
| 照片智能 | `photo-description.ts`、`photo-text-chain.ts`、`photo-text-config.ts`、`photo-text-trigger.ts`、`tencent-ocr.ts`、`photo-metadata.ts`、`photo-details.ts`、`place-photo.ts` |
| 资产 | `asset-static.ts`（上传落盘/内容寻址）、`derived-thumbs.ts`（sharp 缩略图）、`asset-gc.ts`、`asset-gc-scheduler.ts`、`video-assets.ts` |
| 备份/归档 | `backup.ts`、`backup-config.ts`、`backup-scheduler.ts`、`backup-timeline.ts`（时光机只读）、`backup-retention.ts`、`archive-service.ts`、`encrypted-archive.ts`、`portable-space.ts` |
| 笔记 | `notes-store.ts`、`note-shares.ts` |
| 地点 | `amap-location.ts`、`place-proximity.ts`、`place-static-map.ts` |
| 日历 | `calendar-days.ts`、`calendar-backgrounds.ts`、`calendar-background-renderer.ts`、`calendar-background-source.ts`、`calendar-task-labels.ts` |
| 身份/租户 | `identity-store.ts`、`tenant-config.ts` |
| 存储池 | `storage-pool.ts`、`storage-pool-store.ts`、`pool-transition.ts` |
| 路由模块 | `routes-records.ts`、`routes-entities.ts`、`routes-assets.ts`、`routes-modules.ts`、`routes-weather.ts`、`routes-ai-movie.ts`、`routes-backup.ts`、`routes-archive.ts`、`routes-notes.ts`、`routes-note-shares.ts`、`routes-places.ts`、`routes-habits.ts`、`routes-calendar-backgrounds.ts`、`routes-photo-description.ts`、`routes-assistant-backfill.ts`、`routes-assistant-history.ts` |
| 其它 | `weather*.ts`、`movie*.ts`、`ai-config.ts`、`entity-name-history.ts` |

## 4.3 前端结构特点（**以及它的代价**）

- `src/` 是**扁平单层**（127 个 `.ts/.tsx`）。
- **入口与根组件同在 `main.tsx`（2118 行）**：`createRoot(...).render(<App/>)` 在文件末尾。
- **没有路由库**：`activeView` state 切视图 + `#settings/<page>` hash 做深链。
- **没有状态库**：全部靠 `App()` 内约 100 个 `useState` + props 下钻；数据加载是一批 `useEffect` + `AbortController`。
- 样式：**单一全局表 `styles.css`（12786 行，136 个 CSS 变量，47 个媒体查询）**，无 Tailwind、无 CSS Modules。
- 字体：5 个 `@font-face` + `local()` 把 MiSans 重映射到标准字重，**不打包字体文件**；其他平台跟随系统字体。
- **已知代价**：`main.tsx` / `server.ts` 过大、Web 层单测覆盖偏薄，这是**已登记的工程债**（§11.3）。
  ⚠️ 但**不要因此建议引入状态库/路由库** —— 见 §13。

## 4.4 存储边界（端口接口）

`packages/core/src/ports.ts` 定义了仓储 / 资产 / AI / 摘要 / 语音的**端口接口**。
设计意图：**core 不知道底下是本地磁盘、NAS 还是对象存储**。
语音、照片只读索引等端口**已预留但尚未实现** —— 不要把它们当成已连接的服务。

---

# 5. 领域模型与不变量（**写方案前必读**）

这些不是"实现细节"，是**产品契约**。任何建议如果违反其中一条，基本会被否决。

| 不变量 | 落地方式 | 为什么重要 |
| --- | --- | --- |
| **原文不可覆盖** | `body.original` 永远保留；PATCH 的正文只写 `body.edited`；SQL 列 `body_original` / `body_edited` | 主人手改过就以 `edited` 为准，但原文永远能查回来。**读记录一律取 `body.edited ?? body.original`**（只读 `original` 会拿旧稿对账） |
| **时间语义三分** | `createdAt`（录入瞬间）≠ `occurredAt`（发生时间）≠ `dueAt`（任务计划） | 时间轴按 `occurredAt` 排序；`dueAt` 不代表已发生 |
| **`LifeTime` 三态** | date-only / 带偏移 instant / unresolved local | 带偏移的按**请求时区**算显示日；date-only 保留"墙上时间"含义 |
| **乐观并发** | 每次写带 `revision`；`UPDATE ... WHERE id=? AND revision=?`，冲突回 **409 `revision_conflict`** | 多端/多标签页并发保护。前端收到 409 要重读合并、保留草稿 |
| **软删除** | `deleted_at_json`；列表与导出恒排除软删行，**数据库备份仍保留** | 数据不静默消失 |
| **隐私** | `is_private`：时间轴默认遮罩；**不进**周/月摘要、任务摘要、AI 上下文 | 隐私是硬边界，不是 UI 遮罩 |
| **演示数据** | `is_demo`（持久化字段，**正文里看不到任何前缀**）+ 对象 id 以 `demo-` 开头 | 设置页可隐藏/删除；只删 `is_demo=1`，不动主人写的内容 |
| **关联不悬空** | 写入前校验目标存在且类型匹配，否则 400；删除被引用对象返回 **409** | 宁可报错，不级联改用户数据 |
| **提及只增不减** | 手工取消的关联不会被正文里的旧提及加回来 | 用户的显式操作优先于文本解析 |
| **资产只存引用** | `storageRefs` 可整体替换而 `assetId` 稳定 | 这是"不复制照片库"的技术基础 |

---

# 6. 数据与存储

## 6.1 SQLite 结构

- 建表全在 `repository.ts` 构造函数内：`CREATE TABLE IF NOT EXISTS ... STRICT` + **WAL**。
- **没有 migration 框架**：启动时用 `PRAGMA table_info` 探测缺列再 `ALTER TABLE ADD COLUMN`。
- 业务库表：`records`、`entities`、`assets`、`asset_trash`、`day_summaries`、`cycle_intimacy_module`、`cycle_intimacy_events`、`auth_sessions`、`backup_runs`、`backup_schedule`、`backup_retention`、`weather_device_locations`、`weather_day_cache`、`weather_observation`。
- 身份库表（`identity.sqlite`）：`identity_meta`、`tenants`、`accounts`、`identity_sessions`、`identity_invites`。
- `records` 关键列：`body_json`、`body_original`、`body_edited`、`occurred_at_json`、`entity_refs_json`、`asset_refs_json`、`task_json`、`note_json`、`is_private`、`is_demo`、`is_backfill`、`revision`、`timeline_sort`、`deleted_at_json`。

## 6.2 数据目录

```text
data/
├─ lifeos.sqlite (+ -wal / -shm)     生产库
├─ identity.sqlite                    账户模式的身份库
├─ ai-config.json / weather-config.json / movie-config.json / backup-config.json / amap-config.json
├─ DO-NOT-DELETE.md                   防误删说明
├─ backups/                           本地 SQLite 备份 + _trash/
├─ tenants/<uuid>/                    账户模式的成员空间
└─ derived/
   ├─ snapshots/                      时光机快照（只读穿越用）
   └─ thumbs/                         派生的 webp 缩略图缓存
```

## 6.3 资产生命周期与内容寻址

- 上传 → `uploads/YYYY/MM/<sha256>.ext`；删除 → `asset_trash`；30 天后由 GC 调度回收。
- **孤儿判定** = 活记录引用 ∪ **仍在货架上的本地快照**引用；快照读不了 → 整轮跳过（不敢把"不知道"当"没人引用"）。
- ⚠️ **按 hash 搬文件前必须查 `claimed`**：文件名就是哈希 ⇒ 重传会落在同一路径 ⇒ 可能抢走活资产正用的文件。
- `contentHash` 挂在 **`storageRef`** 上，`GET /api/assets` **不返回它**（数覆盖率只能读库）。
- 只有 `POST /api/assets/uploads` 会算 hash；走 `POST /api/assets`（JSON 自带 storageRefs）进来的资产永远没有 ⇒ **补 hash 是单向窗口**。

## 6.4 环境变量与加密种子（**最容易出人命的地方**）

分组：网络/认证、存储、集成、加密种子。

| 组 | 代表变量 |
| --- | --- |
| 网络/认证 | `LIFEOS_HOST`、`LIFEOS_PORT`、`LIFEOS_PASSWORD`、`LIFEOS_ACCOUNT_MODE`、`LIFEOS_OWNER_USERNAME`、`LIFEOS_ALLOWED_ORIGINS`、`LIFEOS_COOKIE_SECURE`、`LIFEOS_TRUST_PROXY` |
| 存储 | `LIFEOS_DATA_DIR`、`LIFEOS_DB_PATH`、`LIFEOS_ASSET_ROOT`、`LIFEOS_BACKUP_DIR`、`LIFEOS_LOG_DIR`、`LIFEOS_BODY_LIMIT_BYTES` |
| 集成 | `LIFEOS_DEEPSEEK_*`、`QWEATHER_*`、`LIFEOS_AMAP_API_KEY`、`LIFEOS_TENCENT_*`、`BACKUP_S3_*`、`LIFEOS_INSTANCE_BACKUP_*` |
| 加密种子 | `LIFEOS_AI_CONFIG_SECRET`、`LIFEOS_WEATHER_CONFIG_SECRET`、`LIFEOS_MOVIE_CONFIG_SECRET`、`LIFEOS_BACKUP_CONFIG_SECRET`、`LIFEOS_AMAP_CONFIG_SECRET` |

> 🔑 **加密种子推导规则**：各 `*-config.ts` 的 AES-256-GCM 种子取自
> `LIFEOS_<模块>_CONFIG_SECRET` → `LIFEOS_PASSWORD` → `` `lifeos-local-<模块>:${dataDirectory}` ``。
> **后两者都没设时，种子就是数据目录路径本身** ⇒ 一搬数据目录就换密钥，**所有已保存的 API Key 会静默解不开**（设置页只显示"未配置"，零报错）。
> 所以生产 `.env` 里那几个 secret 是**故意钉死的，不能删、不能改**。
> 另有更阴的一条：在"解不开"的状态下**再保存一次**配置，密文会被静默删除，此后改回种子也救不回。

---

# 7. HTTP 接口面

默认前缀 `/api`，所有写请求只接受 JSON，检查 Origin，不开放任意 CORS。密码/账户模式下除健康检查与登录外都需要会话 cookie。

| 分组 | 端点（节选） |
| --- | --- |
| 健康 / 会话 | `GET /api/health`、`GET /api/auth`、`POST /api/auth/login|logout`、`POST /api/auth/invite/check`、`POST /api/auth/register` |
| 管理（仅 owner） | `GET|POST /api/admin/accounts`、`PATCH /api/admin/accounts/:id/password`、`POST /api/admin/accounts/:id/disable`、`GET|POST /api/admin/invites`、`POST /api/admin/invites/:id/revoke`、`/api/admin/storage-pool/*` |
| 记录 / 摘要 | `GET|POST /api/records`、`PATCH|DELETE /api/records/:id`、`GET /api/summaries`、`POST /api/summaries/manual|regenerate` |
| 迁移 | `GET /api/export?format=json|markdown`、`POST /api/import` |
| 实体 / 联系人 | `GET|POST /api/entities`、`PATCH|DELETE /api/entities/:id`、`POST /api/entities/:id/relations`、`GET /api/contacts/activity` |
| 资产 | `GET|POST /api/assets`、`POST /api/assets/uploads`、`POST /api/assets/resolve`、`PATCH|DELETE /api/assets/:id`、`GET /api/assets/:id/content|thumbnail?w=`、`GET /api/assets/trash`、`POST /api/assets/trash/:id/restore`、`GET /api/assets/videos`、`GET /api/assets/materials` |
| 笔记 | `GET /api/note-folders`、`POST|PATCH|DELETE /api/note-folders[/:id]`、`POST /api/notes/import-links`、`GET /api/notes/:id/versions` |
| 公开分享 | `GET /api/public/notes/:space/:token`、`POST .../unlock`、`GET .../assets/:id` |
| 日历 | `GET /api/calendar/days`、`/api/calendar/tasks/labels`、`/api/calendar/background*` |
| 私密模块 | `GET|PUT /api/modules/cycle-intimacy[/config]`、`POST /api/modules/cycle-intimacy/events`、`POST .../day-edit[/undo]`、`POST|PATCH /api/modules/cycle-intimacy/habits[/:id[/days]]` |
| 地点 | `GET /api/places/cities`、`POST /api/places/search`、`GET|POST /api/location/config|ip` |
| 天气 | `GET /api/weather`、`POST /api/weather/current|config|config/test`、`GET /api/weather/archive|observations`、`POST /api/weather/device/location|locate`、`GET|POST /api/weather/profiles[/activate]` |
| AI | `GET /api/ai/status`、`POST /api/ai/config|config/test`、`POST /api/ai/assistant`、`/api/ai/assistant/history*`、**`POST /api/ai/backfill/chat`（真实对话主链路）**、`POST /api/ai/backfill/chat/stop`、`/api/ai/backfill/prepare|material-text`、`POST /api/ai/photo-description`、`/api/ai/photo-description/config` |
| 观影 | `GET /api/movies/status`、`POST /api/movies/config|config/test|resolve|import|upsert` |
| 备份 | `GET /api/backup/status|snapshot|runs`、`POST /api/backup/local|s3|s3/test|dual`、`GET|POST /api/backup/config|schedule|retention` |
| 加密包 | `GET /api/archive/estimate`、`POST /api/archive/export`、`/api/archive/uploads`、`/api/archive/commit`、`/api/archive/import` |
| 静态 | 非 `/api` 的 GET/HEAD 走 `apps/web/dist` 同源托管 |

> 实现方式：每个 `routes-*.ts` 导出一个 `RouteHandler`，内部用 `pathname === "..."` 与正则匹配。
> 字面量路径约 100 条，另有若干正则子资源。

---

# 8. 安全与隐私

- **回环绑定可无密码**；绑定非回环时 `LIFEOS_PASSWORD` 必填。无密码模式额外校验 Host 必须是 `localhost/127.0.0.1/::1`（防 DNS rebinding）。
- 密码/账户模式用 **HttpOnly + SameSite=Lax** 的 `lifeos_session` cookie；生产 HTTPS 反代下必须 `LIFEOS_COOKIE_SECURE=true`。
- 账户模式白名单 `LIFEOS_ALLOWED_ORIGINS` **必须显式提供**，公网只接受 `https://`。
- **集成密钥只写形状与来源，绝不回显值**；状态接口只回答"是否已配置"。
- AI 上下文**只组装非隐私记录**；隐私正文永不进 prompt。
- 主人对本项目有一条硬要求：**凡是会被存档的输出（日志、报告、截图、提交信息）都不许回显密钥值**。

---

# 9. 工程约定（**这个项目最独特的部分**）

LifeOS 不是普通的单人仓库，它有一套**为「多个 AI 接力开发」而设计的现场**。理解它，你的建议才会被采纳。

## 9.1 四份权威文档，各司其职

| 文件 | 回答什么 | 写入规则 |
| --- | --- | --- |
| `AGENTS.md` | **规则**：协作铁律、环境坑、主人看重什么 | 只此一份 |
| `docs/changelog.md` | **改了什么**：每条必须带 `AI:` 署名 | **只追加到最末尾**（旧→新），禁改历史 |
| `docs/todo.md` | **还没做的 / 等拍板的** | 每条按「症状 → 已知事实（带证据）→ 未知/未验证 → 动手前必读 → 建议路线 → 复现命令」 |
| `docs/self-audit.md` | 「我当初怎么说、后来怎么做、有没有说谎」 | 同样 append-only |

⚠️ 边界提醒：`.gitignore` 排除了 `AGENTS.md`、`docs/changelog.md`、`.review/`、`.workbuddy-ai/`
—— **接力依赖链不在 git 里，只存在于本机磁盘**。git 只当"代码检查点"。

## 9.2 协作铁律（摘要）

1. 改完必须追加 changelog，缺 `AI:` 署名视为**交接未完成**。
2. **先讨论、点头、再动手**：设计/创意/规则类工作必须先出方案等确认；确认过的小步执行可以直接做。
3. **不要做没被要求的事**。想做附加改进，先说一句。
4. **QA 的目标是"找问题"，不是"证明能用"**。验收必须给证据：typecheck + `npm test` + 浏览器 CDP 客观断言，结论落盘 `.review/*.txt`，最后一行 `RESULT: PASS/FAIL`。
5. 报告要能独立成立：文件路径、根因分析、**已确认 vs 未验证要分清**。
6. **不要主动出截图**：视觉验收全部靠 CDP 断言（`getComputedStyle` / `getBoundingClientRect` / 元素计数）。主人自己开 5199 看效果。
7. **`commit` 可自动做，`push` 必须先问。** 禁止 `git checkout .` / `stash` / `reset --hard` / `clean -fd`（仓库常压着多轮 AI 未提交的成果）。

## 9.3 验收方法论（踩出来的，很值得借鉴）

- 判据三件套一起看：**退出码 + FAIL 行 + 断言条数**。
  脚本中途抛异常时**一行 FAIL 都不打**，结果文件还留着上次的 `RESULT: PASS` ⇒ **看到 PASS 先确认断言条数**。
- **更阴的假绿**：只把结论写进自己的 txt、既不打 stdout 也不设退出码的脚本，在批处理里永远绿。
- **必须配对照组**：测不出失败的测试等于没测。很多验收脚本自带"验收尺子自己必须能报红"的自检。
- **判据要挂在"这次改了什么"上，不要挂在理论值上**；**量尺不能是"不可能满足的几何"**。
- **断言要自带证据**（数字写进消息）；**点错元素 CDP 不报错** → 用 `elementFromPoint` 命中测试。
- **图片"加载成功" ≠ "画出来有东西"**：判据 = 画布采样（请求成功 + 滚动后仍成功 + 采样后有内容）。
- **日期夹具动态推导**，不许写死；按天对账一律走 `Asia/Shanghai`。
- **偶发的网络类 FAIL 先重跑一次再怀疑产品**。
- 验收脚本分两类：自带隔离实例的（安全）与**直连 3011/5199 的**（那就是主人的生产库，必须挂生产守卫，且守卫 fail-closed）。

## 9.4 环境坑（都真踩过）

- 本机 bash 是**残缺 PortableGit**；`npm test` 内层的 `node --test` 按 PATH 找 node，必须把 `C:\Program Files\nodejs`（24.x）放到 PATH 最前，否则 managed 的 22.x 不支持 `--test-isolation=none`。
- **沙箱在每轮结束时回收子进程** ⇒ 开工先探端口；"读不了 / 数据不见了"第一嫌疑永远是**服务没在跑**。
- 沙箱对"单轮删除 > 50 个文件"有闸门（`SAFE_DELETE_BULK_*`），**删任何东西之前就抛**，重试无用。
- 同一条命令有时会被跑两趟 ⇒ 验收脚本与批量改写要**幂等**。
- Windows 上 `rmSync` 可能抛 **EPERM**（libvips 释放句柄晚于函数返回），**会把测试判失败**，看起来像产品坏了。

## 9.5 「档案卡」（profile）机制

主人要的不是"更好的备份"，而是**可插拔的档案卡**：导入第二份方案时第一份完全冻结，可切回、可删，而且**切回来不能把跑过的 OCR / AI 派生重跑一遍**。

- 一张卡 = 一套完整环境（自己的库、照片目录、派生缓存、备份轴）。真档案 = `profiles/real`，指向仓库自带的 `data/` + `pic-test/`。
- **冻结 / 释放 = 只改 `profiles/.active` 指针，目录一个字节都不搬** ⇒ 库、缩略图、OCR 结果原地保留，切回来直接命中。**没有"解冻"这个动作。**
- 四条不许破：① 卡片**绝不共用照片目录**（资产回收器每次启动立刻跑，库与照片目录错配会把老照片当孤儿收走）；② `.env` 的 4 个 `*_CONFIG_SECRET` 别删；③ 非真档案的备份前缀强制 `product-backup/lifeos/archives/<卡>/`；④ **浏览器里的设置也按卡分开**（`localStorage`/`sessionStorage`/`IndexedDB` 按 origin 分，而换卡不换端口）。
- **凭据（天气 / OCR / AI key）是全局 `.env` 共用的一份 —— 只分设置，不分凭据。**
- 现成假档案卡：`fake-2y`（2024-10-17 → 2026-10-16，1893 条记录 / 219 张程序生成照片 / 25 个虚构对象，用于试 AI 管家而不泄露真数据）。

---

# 10. 界面设计规范（**已定案的红线**）

主人的设计取向：**内容优先、克制但可辨**。把空间交给正文，减少重复标签、重复说明、装饰框和固定提示。

**已定案的硬规则（不要建议推翻）：**

| 规则 | 内容 |
| --- | --- |
| **按钮层级** | 同一操作组的主/次/危险按钮**共用高度、字号、行高、内边距、圆角**；重要性只用颜色、描边、文案、顺序表达。**禁止把主按钮单独做高/做宽/拉满一行**。普通组 40px，紧凑组 34px。 |
| **间距归容器** | 用 `gap` 和区域 `padding`，基础按钮类不携带各自外边距。边缘与分隔线留 ≥8px。 |
| **界面文字不可选中** | `body` 默认 `user-select: none`；只有①表单控件 ②正文白名单能选。**白名单只放承载文字的叶子节点，绝不放容器**。新加的界面元素天生选不中，不用管。 |
| **不用间隔号 `·`** | 自有界面文案禁用 `·` 连接短语（用户原文、书名不受限）。 |
| **人物胶囊** | 中性灰圆角矩形，**不是蓝字**。避免无处不在的蓝色强调（但角色/选中/核对操作可用既有语义色）。 |
| **时间轴轴点** | 主人选定的 **C 细空心环**：7px、1px 灰蓝边框，纸色内底，无蓝芯无光晕。 |
| **照片做底纹** | 指**铺满整卡/整格当背景**，不是底部小条；白蒙版唯一使命是保证文字可读。 |
| **任务卡** | 左上角黄色类型标签**保留**（曾删除被主人明确纠正）；完成正文默认单行省略、点击展开；完成保存后用约 240ms 短过渡收成单行。 |
| **空日历格** | 不写"没有记录"、不放"—"占位，保留纸张底色与日期大字。 |
| **未来日期** | 周/月的未来日期**不能点击或键盘进入**（桌面端右键菜单除外）。 |
| **弹窗** | 查看相关日记先用弹窗保留上下文，用户主动"进入原记录"才导航；点外侧只收起、**不透点底层**。 |
| **单条删除** | 360px 上限、两行摘要、两个 34px 文字按钮、默认焦点在取消；删除成功后**原卡片原地保留 5 秒可撤销**。 |
| **操作菜单** | 参考微信菜单的独立浮层与分组；外圆角 12px、内留白 6px、行圆角 7px；键盘全支持（上下/Home/End/Enter/Esc）。 |

**还有一条工程性的设计约束**：**不依赖 AI key 也能工作** —— 摘要无 key 时回退规则生成，选图用纯客户端算法。

---

# 11. 当前状态

## 11.1 已实现且有验收的能力

时间轴（日记/任务/事件/笔记）、周/月日历（摘要、法定休息日/调休、节气、照片底纹、习惯、周期标记）、
关联与检索（四类实体、别名、关系卡、记录互链、关键词/类型/日期搜索）、`@`/`#` 提及、
外部资产引用与只读预览、隐私记录、可选天气（含地点方案）、可选 AI 管家（对话/补记/UI 控制/分享图）、
照片 AI 描述与腾讯云 OCR（含降级链与空标记）、笔记资料库与公开分享、观影（TMDb）、
周期与亲密模块、时光机（只读穿越）、备份与迁移（本地/定时/S3/JSON/Markdown/`.lifeos` 加密包/整卷）、
可选账户模式与多租户、弹指存储池接入（未上线）、视频（浏览器压缩）。

## 11.2 明确的边界（**不要当作已实现**）

- **M2** 外部照片/文件只读索引、Synology Photos 接入：**未实现**，只预留端口。
- **M3** AI 分类与"带出处的检索"、可追溯派生数据：**未实现**（当前 AI 只有管家与日摘要、照片描述、OCR）。
- **M4** 语音录音上传与转写：**未实现**，只预留三层数据模型（`audio_raw` / `transcript_raw` / `content_edited`）。
- 原生 App、离线同步（PWA）、外部日历同步、提醒中心：**未实现**。
- **账户模式只在隔离环境验收过**，从未在真实服务器/DNS/HTTPS 反代上跑过；旧单用户库的迁移与回退演练**未执行**。
- **Docker / Compose / NAS：配置齐全但真机从未验证**（本机没有 Docker）。
- 存储池：代码完整，**线上未接入**。
- 手机端多项：**真机待验证**（周期复选密度、长文展开、地图 App 唤起、字体观感等）。

## 11.3 已知缺陷与工程债

| 项 | 状态 |
| --- | --- |
| **照片切换闪烁**（P2） | 原因已确认（`asset-preview.tsx` 按 URL 替换 img + 固定 160ms 淡入叠加 ⇒ 新图已 loaded 但仍 opacity 0），**待主人授权修复** |
| 语义检索（阶段 2） | 选型已实测，**未实施**（§11.4） |
| OCR 本地熔断 | 一次全库跑会为每张照片各发一次注定失败的请求，**≈10 行的熔断待拍板** |
| 设置页"读取失败" | 曾把读取失败静默当成可保存的默认配置（已修，属重点防御项） |
| 大文件拆分 | `main.tsx` / `server.ts` 过大；Web 层单测覆盖偏薄 |
| 字体一致性 | MiSans 只通过 CSS `local()` 使用，未安装的设备会看到系统回退字体；内嵌需先确认许可 |
| 历史红色验收 | 工具箱里若干 `verify-*` 是**旧账不是新回归** |
| 审计遗留 | 审计报告 18 项发现（P0 0 / P1 3 / P2 5 / P3 10），大部分已修；仍留 revision 不在导出契约内、Markdown 导出缺 note 元数据、日志按 UTC 日切、未配置时回显真实 bucket/prefix 等 |
| 工具箱审计 | 仍有 **8 个历史遗留的"裸写入生产"脚本**（不是新引入的） |

## 11.4 等主人拍板的问题（**最适合拿来咨询**）

1. **语义检索的落地形态**：已实测"语义只把 r@3 从 67% 提到 92%、r@1 持平，代价 +373 MB"，
   建议方案 B+C（255.7 MB）等拍板。约束是 4C4G 服务器 + 不能影响其他项目。
   另有前置 bug："悄悄漏" —— 补记只取前 100 条，已静默丢 56 条。
2. **OCR 的成本与精度取舍**：只跑一个引擎时选 Basic 还是高精度？实测 Basic 保住 89.1% 的可搜子串覆盖，
   但丢的恰是最值钱的短词（品牌/日期/金额）。是否加本地熔断？
3. **照片切换闪烁怎么修**：是改 `asset-preview` 的替换时序，还是改 CSS 过渡？
4. **网页内一键切档案卡**：需要常驻 gateway 进程（与 4C4G 冲突），待拍板。
5. **移动端信息架构**：手机输入区与 AI 管家还有 Demo 待选型。
6. **是否把加密备份简化成单一开关**（用户已确认界面方向，实现待排期）。
7. **云端加密备份**：整站上传目前是 HTTPS 到私有桶，**不是客户端加密归档**；是否需要客户端加密。

---

# 12. 术语表

| 术语 | 含义 |
| --- | --- |
| **记录 / Record** | 时间轴上的一个条目（`journal` / `task` / `event` / `note`） |
| **实体 / Entity** | 人物 / 地点 / 项目 / 主题，可被记录引用 |
| **资产 / Asset** | 照片、音频、文件、视频的**引用**（不含原件字节） |
| **storageRef** | 资产指向外部原件的可替换引用（`sourceId` + `sourceRef` + 链接 + hash） |
| **`is_demo`** | 演示数据标记（持久化字段，正文里看不到前缀） |
| **补记 / backfill** | 补写过去某天的事，或由 AI 把碎片整理成候选记录 |
| **管家 / AI 管家** | 项目的对话式 AI 助手 |
| **时光机** | 只读的历史快照对比视图 |
| **卡片 / profile** | 可插拔的档案卡（一套完整数据环境） |
| **`lifeos.export` v1** | 项目自己的 JSON 导出协议 |
| **`.lifeos`** | 单空间完整加密包（scrypt + AES-256-GCM） |
| **`.review/`** | 验收工具箱（700+ 脚本，被 gitignore） |
| **生产守卫** | 防止验收脚本写进主人生产库的安全闸门，fail-closed |
| **弹指存储池** | 外部对象存储池，LifeOS 通过本机 PHP CLI 调用 |
| **档位 / variant** | 照片 AI 描述的模型档位（`context` / `context-thinking` / `caption`） |

---

# 13. 给 AI 的「怎么答才有用」

## 13.1 这个项目**不欢迎**的建议

| 不要建议 | 原因 |
| --- | --- |
| 引入 Web 框架（Express/Fastify/Nest）、ORM、迁移框架 | 后端刻意零框架、零 ORM，迁移靠 `PRAGMA table_info` + `ALTER TABLE` |
| 引入前端路由库 / 状态库 / CSS 框架 / UI 组件库 | 前端刻意零路由零状态库、单一全局 CSS；`main.tsx` 大是**已登记**的债，但解决方向是"拆文件"不是"上框架" |
| 引入 FTS5 / Elasticsearch / 向量数据库 / Redis / PostgreSQL 等**常驻服务** | 生产是 **4C4G 且跑着别的项目**；且实测 FTS5 语义命中 0%。任何新常驻服务都要先算内存与 CPU |
| 改动"原文不可覆盖 / 软删除 / revision 乐观锁 / 隐私不进 AI / 关联不悬空" | 这些是产品契约，不是实现细节 |
| 让 AI 成为核心链路依赖 | 硬要求：**无 key 也要完整可用** |
| 建议截图比对来做视觉验收 | 本项目用 CDP 客观断言（计算样式/尺寸/元素计数）；主人明确不要主动出截图 |
| 建议大规模重构 / 一次性推倒重来 | 主人反感过度工程化；且仓库常压着多轮 AI 未提交的成果 |
| 建议 `git push` / 强推 / 清理工作区 | push 必须先问；禁止会抹掉 working tree 的命令 |

## 13.2 这个项目**喜欢**的回答形态

1. **先分清"已实现 / 未实现 / 未验证"** —— 不要把规划当现状，也不要把没跑过的当已验证。
2. **给方案时带上验证方式**：可执行的命令 + 客观断言（"量什么、期望值是多少、怎么证明它真的失败了"）。
3. **配对照组**：说明"如果这个方案错了，会以什么现象暴露出来"。
4. **算成本**：内存、CPU、磁盘、网络流量、第三方调用次数与费用（4C4G 是硬约束）。
5. **尊重既有取舍**：如果某个"不优雅"的实现是有原因的（比如零依赖、不搬历史文件、卡片不共用照片目录），先问"为什么"再建议改。
6. **回答用中文**，简洁、结构化，避免空泛的"最佳实践"。

## 13.3 一句话总结

LifeOS 是一个**个人自托管、零框架、单 SQLite、内容优先**的时间轴记录工具，
由一个真实用户日常使用，由一个"多 AI 接力 + 强验收纪律"的流程维护。
给它建议时，**约束（4C4G、零依赖、不依赖 AI 也要能用）和不变量（原文不可覆盖、软删除、乐观锁、隐私边界）比"更现代的架构"重要得多。**

---

*本文由 WorkBuddy（DeepSeek-V4）于 2026-10-16 通读代码库后撰写，供对外咨询使用。*
