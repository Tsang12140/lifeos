# LifeOS 项目长期记忆（硬规则速查）

> 规则全文 `AGENTS.md` · 改动记录 `docs/changelog.md`
> **「为什么」/根因/实例在 `.workbuddy-ai/memory/MEMORY-detail.md`** —— 需要背景时读它。本文件只留「照做」的部分。

## 0. 三条最容易出人命的

1. **`data/`（仓库根）= 主人的生产库**，不是预览种子目录。**永不重置 / 永不 `seed-demo --clean` / 永不删。**
   3011/5199 **直接指着它** → 跑会写记录的验收就会污染主人数据（清掉的那 105 条就是这么来的）。要造数据**另开 `LIFEOS_DATA_DIR`**（`.review/verify-*.mjs` 本来就这样）。
   动手前先 `node .review/data-inventory.mjs`（只读；有主人写的记录就 exit 1）。目录里还有 `data/DO-NOT-DELETE.md`。
2. **`.workbuddy-ai/memory/` 被 git 跟踪，`.env` 不被。密钥只写形状与来源，绝不写值。**
   **「文件被 ignore」不是可以抄值的理由**（同一错误已在 changelog / 记忆 / 工具日志里各犯一次）。
   推送前：`npm run typecheck` + `npm test` + **按值**扫 —— `node .review/scan-secret-leaks.mjs`（全仓，分 `PUBLISHED` / `local only`，默认只对前者 exit 1）。
   **凡是会被重定向存档或贴进交接文档的输出，一律不许回显密钥值**（改写工具曾把自己要清除的密钥打进 `.txt`）。
   改写历史：`.review/snapshot-git.mjs`（`.git` 字节快照 + restore 脚本）→ `.review/rewrite-history-redact.mjs`（dry-run 默认）。撤销 `git update-ref refs/heads/main <旧 tip>`。
   **`git update-ref` 对 `refs/original/` 返回 0 却不建 ref** → 用 `refs/backup/`；回滚点建完必须 `show-ref` 验。
3. **搬数据目录 / 改 `LIFEOS_PASSWORD` 会静默废掉已存的 API key。**
   种子 = `LIFEOS_<模块>_CONFIG_SECRET || LIFEOS_PASSWORD || \`lifeos-local-<模块>:${dataDirectory}\``。
   → `.env` 里 4 个 `LIFEOS_*_CONFIG_SECRET` **别删别改**（删了 = 换密钥）；动完目录回看 `/api/weather/status` 的 `hasKey`。
   → ★（**2026-09-21 晚已修**）现在**解不开也不会丢**：`saveRuntimeAiConfig` 的 `nextKeyFields` 把盘上密文**原样抄回**
   （只有显式 `clearApiKey:true` 才删），且 `publicAiConfig.keyUnreadable=true` 让界面明说「文件里那把读不出来」，
   状态徽标多一档「密钥读不出来」。守它的两条量尺：`.review/verify-ai-key-persist.mjs`（**25 条**，D 段=回归哨兵）
   + api 测试「a saved key that cannot be decrypted is reported, and a later save never drops it」。
   → **`.env` 的 key 不会被抄进文件**（旧行为已改）：文件里只有主人亲手填过的 key，`.env` 始终是真源 ——
   以前在 UI 里保存一次就把 env key 加密落盘，之后改 `.env` 会被文件里的旧副本压住。
   → 想绕开 UI 就写 `.env` 的 `LIFEOS_DEEPSEEK_API_KEY`（用 `.review/set-ai-key-env.mjs`：key 从 stdin 读、不回显值），**改完必须重启 API**。
   → 「测试连接」**不落盘**（字节与 mtime 都不动）⇒ 「测试成功」≠「已保存」，这是最容易让人误以为设好了的一步。
   → AI 配置的 key 不是明文：`data/ai-config.json` 存 AES-256-GCM 密文，种子 = `.env` 的 `LIFEOS_AI_CONFIG_SECRET`
   （scrypt + salt `lifeos-ai-config-v1`）→ **手写配置文件无效**；想绕开 UI 就写 `.env` 的 `LIFEOS_DEEPSEEK_API_KEY`（要重启 API；
   但文件里一旦有密文，密文优先于 `.env`）。查状态用只读的 `GET /api/ai/status`（`keyConfigured` / `keySource`）。

## 环境

- 预览 = `.review/accept-serve.mjs` → API 3011 + Web 5199（主人开 `http://127.0.0.1:5199/`）。**收尾不要杀**；主人的 3001 **永不杀**。
- **沙箱在 turn 结束时回收子进程**（`nohup`/`detached`/后台任务都活不过）→ **开工先探端口**，不在就 `.review/spawn-serve.mjs` 拉起。
  → **「读不了 / 数据不见了」的第一嫌疑永远是服务没在跑，先探端口再谈数据。**
- 换数据库文件必须先停 API（整棵进程树 `taskkill /F /T`）。验收脚本前置失败会覆盖上次结果 → 跑前确认预览在线。
- **Node 用 `C:\Program Files\nodejs`（24.x）**；managed 22.x 不支持 `--test-isolation=none`。
- bash 是残缺 PortableGit（无 `ls/cat/head/grep/find`）→ 用 `node -e` 或内置工具。
  **`node -e` 写含反引号 / 反斜杠的文本必炸 → 先 `Write` 成文件再读。**
- 按天对账一律 `Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"})`。**42 格月历第一格 = 含 1 号那周的周一。**

## 数据与备份

- 库 `data/lifeos.sqlite`（+ `-wal`/`-shm`）；配置 `data/weather-config.json`、`data/ai-config.json`（**不在 git、无副本**）；
  照片在 `LIFEOS_ASSET_ROOT`（预览 = `pic-test/`，**不在快照里、无备份**）。
- **唯一安全网 = 应用自己的 S3 快照**（桶 `cdnb` / 前缀 `product-backup/lifeos`；老的被挪到 `lifeos-trash/`，同样可恢复）。
  恢复用 `.review/restore-from-backup.mjs`（恢复前强制备份当前目录）。**恢复三件事：停 API、删 `-wal`/`-shm`、保留两个 config json。**
- **搬/复制 sqlite 前必须 `PRAGMA wal_checkpoint(TRUNCATE)`** —— 只复制 `.sqlite` 会**静默丢最新记录**；**光看 `.sqlite` 大小会误判**（事故前主库 4096B / WAL 1.6MB）。`VACUUM` 后尺寸要在 `close()` 之后再量。
- **读数据前先确认读的是哪个库**：`data/`、`.review/data`、`.review/recovery/`、`.review/*-run/` 下都有同名 `lifeos.sqlite`，**表结构可能不同**。
- 示例标记 = **`records.is_demo`**（正文无前缀）。回收站两类：`is_demo=1` 走设置页按钮 / `--demo`；`is_demo=0` 混着验收残留，用 `.review/purge-trash-junk.mjs`（dry-run 默认，**认不出的行中止整轮**）。**别用「是否引用 `demo-` 实体」当替代判据。**
- **照片生命周期（`asset-gc.ts`；界面 `main.tsx:2992` 有原文）**：没人引用的上传 → **原处留 7 天**（`assetOrphanGraceDays`，锚点 = **`lastUsedAt ?? createdAt`**，不是 createdAt）→ 收进 `pic-test/uploads/_orphan-trash/` → **回收站再留 30 天**（`assetTrashDays`，可恢复）→ 才永久删。**总时限 34 天，不是 7 天。**
  → `referencedAssetIds` **包含软删记录**（回收站里的记录还能恢复，它的照片必须留着）→ 「先关联、后删除」**不算**孤儿。
  → **回收站条目没有 `id` 字段**（只有 `asset`/`trashedAt`/`origin`/`daysRemaining`）→ 取内容 / 恢复 / 删除一律传 **`asset.id`**（传条目 id 只会得到 `undefined` 的 404，我因此误报过「93 条不可恢复」）。
- **内容寻址 / `contentHash`（2026-09-19 起）**：hash 挂在 **`storageRef`** 上 —— `asset.storageRefs[*].contentHash = { algorithm:"sha256", value }`，**资产顶层没有这个字段**；判「有没有 hash」必须读 refs，读 `asset.contentHash` 永远是 `undefined`（我为此写过两次「161 张里 0 张有 hash」的假结论）。且 **`GET /api/assets` 不返回 `contentHash`** → 数覆盖率只能读库（把 `.sqlite` + `-wal` + `-shm` 三件套一起复制到 scratch 再 `readOnly` 打开）。
  → **回填是单向窗口**：hash 只在文件还在盘上时算得出（`holiday.jpg` 已永久补不上）。现状 **160 / 161 带 hash**。
  → 上传路由**已**按 hash 复用（`POST /api/assets/uploads` 命中即回 201 + 同一个 asset）；但 **`POST /api/assets`（JSON 自带 `storageRefs`）不算 hash**，永远躲开复用检查（09-19 量到 6 组重复、约 28.1MB）。
  → `findAssetByContentHash` 是**全表线性扫**（`repository.ts:1257`），而上传路由每个请求都走它 —— 表一大就是热路径，要加索引。
- **备份退路要实测**：`POST /api/backup/dual`（`.review/verify-backup-path.mjs`）。`enabled=1` ≠ 能用。
- **迁移类改动必须显式搜 `.review/`**（它被 gitignore，`grep`/`rg` 默认不进 → 会漏掉整个工具箱）。

## 验收工具箱

- **`.review/lib/production-guard.mjs` = 生产守卫**：副作用式 import，**必须是第一条 import**。读 `/api/backup/status` 的 `localDirectory`，落在 `data/` 里就 `exit 1`。
  放行 `LIFEOS_ALLOW_PROD_ACCEPTANCE=1`。回归 `node .review/verify-production-guard.mjs`（14 项，夹具在 `.review/guard-fixtures/`）。
- **跑验收前先看清单 `node .review/audit-toolbox-targets.mjs`**（有未守卫的写入脚本就 exit 1）。豁免要显式写 `@unguarded-on-purpose`（**目前三个**：`retract-record.mjs` 撤回污染记录、`seed-timemachine-demo.mjs` 往 3011 灌时光机样片、`prune-duplicate-period-ends.mjs` 清同段重复的经期结束日 —— 都是「职责就是生产」；前两个自带 `--clean` 出口，第三个靠 **`--apply` 前 `VACUUM INTO` 一致性快照 + `deleted-events.json` 还原清单**，且**只走 API（GET/DELETE）不直接开库写**，免得和正在跑的 API 抢 WAL）。
- **守卫铁律：只采信它能验证的东西。** 判定用「**包含**」不用「相等」（`localDirectory` 是 `<数据目录>/backups` 子目录）；报不出目录 → **fail-closed 当生产**；显式目标变量只有**入口脚本源码真的读它**（`argv[1]` 取入口、**剥掉注释再 grep**）才采信。
- 真污染了生产库：`node .review/retract-record.mjs <id> --apply` → `node .review/purge-trash-junk.mjs --apply`。
- **崩溃必须变成 FAIL**：脚本抛错时结果文件会留着上次的 `RESULT: PASS` → **看到 PASS 先确认断言条数**。
- **图片「加载成功」≠「画出来有东西」**：`loading="lazy"` 未进视口会伪装成「坏了」（假阳性）；1×1/24×24 空图照样 `complete`、`naturalWidth>0`（假阴性）。
  → 判据 = **画布采样**：缩到 8×8 画到 `<canvas>`，数不透明像素与颜色数（`.review/probe-photo-content.mjs`）。**三条断言缺一不可**：请求成功 + 滚动后仍成功 + 采样后有内容。
- 瞬态缺陷要在**过程中**高频采样；日期夹具一律动态推导；`verify-settings-ai.mjs` 的 8 项 FAIL 是已知老问题，别当新回归修。
- 测试脚手架：`spawnSync` **阻塞父进程事件循环** → 父进程内的假服务器永远答不上，断言会**因错误的原因失败**；用异步 `spawn`。

## 磁盘：测试失败先 `df -h /c`

- `database or disk is full` / `ENOSPC` 常是 C 盘满，**伪装成产品回归**。
- 根因是 kill/rm 顺序（`browser.kill()` 异步 → 紧随的 `rmSync` 撞 Windows 句柄 → EBUSY → 被裸 `catch {}` 吞）。
  → **「有清理调用」≠「清理成功」**；只 grep `rmSync` 在不在会得出「0 泄漏」假结论。
- 修法必须**同步强杀**（清理块多在 `finish = () => {}` / `process.on("exit")` 里，`await` 非法）：
  `.review/reap-chrome.mjs`（**新脚本一律用它**）、`.review/sweep-profiles.mjs`、`.review/codemod-reap.mjs`。

## 时光机（只读穿越；第一期只读）

- **快照绝不能原地打开**：`DatabaseSync({ readOnly: true })` **照样**会在被打开文件旁边生成 `-wal` / `-shm`（哪怕只是读）。
  → 先复制到 `<dataDirectory>/derived/snapshots/`，再 `readOnly` 打开，用完**连 sidecar 一起删**。
  → 「只读」的三条硬证据（缺一不算）：快照**逐字节** sha256 不变、`backups/` 里不冒出 `-wal`/`-shm`、跑完 scratch 目录为空。**只写「我用了 readOnly」不是证据。**
- **照片只在「今天还画得出来」时才给**：快照里**没有照片字节**（照片在 `LIFEOS_ASSET_ROOT`，不进快照、无备份），读层只能给「图库里现在还在的本地照片」。
  文件没了 → 报 `photosGone` 的**数字**（判定只认快照自己记录为 photo 的 id，附件 / 录音永远不算），**而不是悄悄少画一格**。**私密记录连照片一起蒙住**——否则「什么消失了」就成了看私密照片的路子。
- 差异行里的方图**上限 3 张**（`DIFF_PHOTO_LIMIT`），多的折成「还有 N 张」；`<img onError>` 落成虚线占位。
- **浏览器只看得见轴上「最新」那个快照**（保留策略同天只留最新，更早的当场挪进 `backups/_trash/`）→ **验收脚本的「顺序」本身就是断言的一部分**：「造出差异的那次快照」必须到浏览器那一段跑之前**一直是最新**，**双份备份要排在最后**。否则面板打开的是一个没有任何差异的时间点，所有行断言全报 `实际 undefined`（踩过）。
- 方图是 `loading="lazy"`：断言 `naturalWidth > 0` 之前先 `scrollIntoView` 走一遍再等 `complete`，否则「还没开始下载」会被判成「图坏了」。
- **还没做**：刻度尺读不到已进回收站 / 远端 `lifeos-trash/` 的快照；选择性捞回与**照片备份**未开始（界面「捞回」是 disabled 占位）。见 `docs/todo.md`。

## UI 硬规则

- **卡片宽度是规则（430.08px）、只有高度随内容**；`width` 与 `max-width:100%` **都要**（只给 max-width 会缩成六种宽）。**双列已删，不要恢复**（判别看元素计数，不看 changelog 自述）。
  - **428.08 是错的，已修**（2026-09-19）：全局 `* { box-sizing: border-box }`，所以 `calc(3 * 5 * 1.617rem + 2 * 6px + Npx)` 里的 N 必须含**边框**。旧值 `+28px` 只算了左右内边距 14×2，漏掉上下各 1px 边框 → 内容盒成了 398.08px，而网格需要 400.08px → 浏览器把三条轨道钳到 **128.688px**，「5 行格子」实测 4.975 行。**与视口无关**（1920/1680/1440 数字完全一样）。现在 `+30px`，`verify-photo-grid` 的 `five lines` 断言是它的哨兵。
- **grid 自动排布会「只在部分记录上错」** → 几何恒定的元素一律显式定位；媒体查询改单列时同步释放 `grid-column`。
- **动画：不许有「移动的细周期图案」**（雨幕 10px 周期 × 226px/s = 摩尔纹）。「数学上无缝」≠「视觉上没问题」。**永不恢复移动的条纹幕布。**
- **布局稳定性**：`animation-fill-mode:none` + 正延迟期间按基准样式渲染 → 基准位置本身要在屏幕外（或改用负延迟）；`html{scrollbar-gutter:stable}`；CSS `auto` 高度不可插值（`useLayoutEffect` + 直接写 `style.height` + 强制回流）。
- 天气天空两根轴：`category` 决定**画什么**、`phase` 只决定**色/光**；硬预算由 `verify-weather-art.mjs` 守。
- **补记条 = 安慰剂**（整条一个点击目标，子控件 `aria-hidden`）；**不出截图**（主人明确要求）。
- **界面文字一律不可选中，只有「主人自己写的正文」和表单控件例外**（2026-09-21 定案）。
  - `apps/web/src/styles.css` **顶部一块集中规则**：`body` + `button` 默认 `-webkit-user-select / user-select: none`；白名单**两条** —— ① 表单控件 `input / textarea / select / [contenteditable]:not([contenteditable="false"])`（**必须有** —— 祖先的 `none` 会连输入框一起禁掉，否则整站输入框没法全选替换）；② 正文叶子 `.timeline-text / .original-block / .note-card-excerpt / .week-card-text / .summary-message / .task-summary-copy / .server-current-block / .settings-ai-preset-id / .entity-library-address / .person-card-field`。
  - **白名单只能放「承载文字的叶子」，绝不能放容器** —— 放 `.task-summary`（`<aside>`）会连带 `<h2>接下来要做</h2>` 与计数徽标 `.summary-badge` 一起可选（第一版就是这么错的）。
  - 机制是**默认禁 + 白名单放**，不是列黑名单：以后新加的按钮 / 菜单 / 徽标 / 占位符**天生就选不中**，不用维护。**别为了「某个元素要禁」去加单条 `user-select: none`**（原先那 4 条零散规则已删）。
  - 验收 `.review/verify-selectability.mjs`（**只读贴 5199**，50 项；**不 spawn 隔离实例** —— 「天气卡」要有天气数据才画得出来，隔离实例里没有它，断言会空转成假绿）。三层判据缺一不可：全量扫描（可见文字节点漏网必须 0）/ 点名对账 / **真手势拖蓝**。
- **改动前先勘察、先问**：设计/规则类先出方案等确认；主人说「**听你的**」才是授权点。

## 日历的两个入口（2026-09-21 定案，动手前先对表）

- **编辑模式只活在月视图**：判据是 `editable = editMode && mode === "month"`，渲染一律用它。**周卡没有小结行**（字段与样式都已删），所以周视图里既没有铅笔、也没有任何小结字段，右键菜单只剩「周期 / 取消」。
- **两种临时模式都不许常驻**（编辑模式 + 周期面板）：**一律不写 localStorage**；「点 `.calendar-section` 之外」「刷新」「离开日历视图」「切到周视图」四条路都要退。**退出编辑模式 = 先存后退**（存失败就留在编辑模式里，不弹框问「要不要丢」）。
- **`hover` 展开的二级菜单，父行 `onClick` 不能再做 toggle** —— 鼠标移到父行时 `mouseenter` 已经展开了，再点一下就是「刚开又收」（真实鼠标路径必现，headless 反而偶尔看不出来）。父行 `onClick` 只负责「展开」。子菜单是父容器的**后代**，所以从父行移进菜单不会触发 `mouseleave`（`mouseleave` 看的是命中目标的祖先链，不是几何位置）。
- **日历初始模式是「周」**：刷新后回到周视图 —— 写验收断言时别假设「刷新完还在月视图」（踩过，误报过一条 FAIL）。
- 右键菜单的「**编辑小结**」= **就地改那一天**（打开编辑模式 + 光标落进右键那天），因此**当月每一天都有字段**，包括完全没有记录的空白天。
- 四种周期只有一份文案：模块级 `CYCLE_EVENT_KINDS`（周期面板与右键二级菜单共用）；二级菜单同样受「周期模块是否启用」管，没启用就是灰的。
- **齿轮面板里没有「编辑模式」开关了**（2026-09-21 删；原话「齿轮面板里面的编辑模式删掉」）。编辑模式入口**只有铅笔那一个**，别再加回面板。
- **右键周期二级菜单每行 = 「方框 + 文字」两个热区**（2026-09-21 定案）：**点方框 = 多选**（切换勾选、**菜单不关**，能连着勾第二件）；**点文字 = 单选**（切换 + **菜单自己关掉**）。判据是 `aria-checked` 与菜单还在不在 —— 这样「自动关菜单」和「同一天连记两件」两个诉求同时成立，不用二选一。
- **「经期结束」一段经期只允许一个**（2026-09-21 起，堵在**模型层**）：`packages/core` 的 `periodEndSpan(events, date)` 给一个结束日算出它属于哪段经期 `[from, until)`；`apps/api` 的 `addCycleIntimacyEvent` 记 `period_end` 时，**在同一个 `BEGIN IMMEDIATE` 事务里**先把同段其它 `period_end` 删掉再插新的。
  - 为什么要堵：日历 `periodRuns()` 每段只取区间里**最早**那个结束日，同段更晚的**被静默丢掉**；而周期面板 / 右键菜单读的是**原始行** → 被日历丢掉的那一天**照样显示「已记录」**（蛋妞 2026-09-21 报的 9/25 就是这么来的）。**是两个读取口径分叉，不是显示 bug** —— 在显示层各自补漏会漏掉每一处读事件的地方。
  - **`assertValidCycleIntimacyModuleData` 故意保持宽松**（不拒绝两条 `period_end`），否则旧备份直接导不进来。不变量只把在**写入口**。
  - 清历史脏行用 `.review/prune-duplicate-period-ends.mjs`（保留谁 = 每段里**最早**的结束日 = 日历本来就显示的那个，所以清完**画面零变化**）；根因与实例见 `MEMORY-detail.md`。

