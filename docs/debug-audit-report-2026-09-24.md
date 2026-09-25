# LifeOS 三轮递进式 Debug 审计报告 — 2026-09-24

> **本轮只诊断，未修复、未提交、未推送。** 产品源码、测试、配置、数据库、资产、现有验收脚本、部署文件一个字节都没有改动。
> 唯一写入的产物是：本报告、`.review/_audit-*.mjs`（新建的隔离诊断探针）与它们的结果文件，以及按 `AGENTS.md` 要求对 `docs/todo.md` / `docs/changelog.md` 的最小追加。
> 审计依据：`docs/audit-prompt.md`（2026-09-24 版，三轮递进 + 只诊断）。

---

## 1. 执行摘要

| 项 | 值 |
| --- | --- |
| 审计时提交号 | `c361d8a docs: make three-round debug audit report-only`（分支 `main`） |
| 工作树原有改动 | `M apps/api/src/backup.ts`（**stat-only**：`git hash-object` 与 `HEAD:` 的 blob 哈希都是 `9821f5cf…`，内容逐字节相同）；未跟踪 `docs/date-switch-execution-plan.md`、`docs/mobile-layout-execution-plan.md`、`docs/notes-library-execution-plan.md` |
| 不可覆盖清单 | 上述 1 个 stat-dirty 文件 + 3 个未跟踪文档 + `AGENTS.md`、`docs/todo.md`、`docs/changelog.md`（被 gitignore，只在本机） |
| 覆盖范围 | 三轮：模式库扫捕 → 六轴扩张 → 跨层与边界；重点放在 2026-09-24 新落地的账户/多租户代码与 `.review/` 验收基建自身 |
| 问题总数 | **18 项**：P0 **0** · P1 **3** · P2 **5** · P3 **10** |
| 最优先处理 3 项 | ① A-01 生产守卫的判定字段指向备份目录而非数据目录；② A-03 通过 UI 写生产库且被审计工具归为「只读」的验收脚本；③ A-02 端口 3012 上那个对审计工具完全不可见的无守卫写入脚本 |
| 基线 | `npm run typecheck` **PASS**；`npm test` **PASS 98/98**（core 29 + api 59 + web 10） |
| 是否触碰主人数据 | **没有**。全程未对 `data/` 写入、未连 3011/5199、未连任何真实域名或服务器；唯一对生产库的访问是**只读**的 `node:sqlite` `readOnly:true` 查询（`data-inventory.mjs` 与自建探针），且只输出计数与日期键，不输出记录正文 |

**一句话结论**：产品主流程（记录/日历/摘要/天气/观影/导出导入/多租户 API 隔离）在本轮证据下**没有发现 P0**；真正的风险集中在**「保护自己的那套东西」**上 —— 生产守卫的判定依据是错的字段，而验收工具箱自己说「UNGUARDED = 0」时，它的扫描口径看不见两个真会写生产库的脚本。

---

## 2. 基线与环境

### 2.1 环境

- **Node**：`C:\Program Files\nodejs\node.exe` = **v24.20.0**。
- **踩到的坑（新）**：直接按 `AGENTS.md` 写的「用绝对路径调 `node.exe` + `npm-cli.js`」跑 `npm test` **会失败**，报 `node: bad option: --test-isolation=none`（退出码 9）。
  原因：`npm run test` 内层还会 `node --test …`，而那条 `node` 走 **PATH** 解析 —— 本机 PATH 里 `C:\Users\Tsang\.workbuddy-ai\binaries\node\versions\22.22.2-2` **排在 `C:\Program Files\nodejs\` 前面**（实测 `which node` → 22.22.2）。
  **可行命令**（本轮实际使用）：
  ```bash
  export PATH="/c/Program Files/nodejs:$PATH"
  "C:/Program Files/nodejs/node.exe" "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" test
  ```
  即：**光换 `node.exe` 的绝对路径不够，必须把 PATH 也钉住**。这是 `AGENTS.md`「环境坑」一节的缺口。

### 2.2 基线结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | 0 | core / api / web 三段全绿 |
| `npm test` | 0 | **98 / 98**（core 29、api 59、web 10），0 fail |
| `node .review/data-inventory.mjs` | **1** | 生产数据存在：live 152（demo 127 / **主人手写 25**）、entities 50、assets 95、**软删 12**。**退出码 1 是设计如此，不是审计失败，全程未清理** |
| `node .review/audit-toolbox-targets.mjs` | **0** | 44 个自带隔离实例；21 个连 3011/5199 且会写（17 守卫 + 4 生产工具 + **UNGUARDED 0**）；88 个「只读」—— **这个 0 是本轮的重点质疑对象，见 A-16** |

**基线全绿 ⇒ 本轮所有发现都是「测试没覆盖到的东西」，不是回归。**

### 2.3 因环境或安全边界未跑的检查

- 未启动 `.review/accept-serve.mjs`、`npm run dev`、`npm start`（它们服务的是主人生产库 `data/`）。
- 未运行任何 attach 到 3011/5199 的 `verify-*.mjs`（会被生产守卫拦，且本轮不需要）。
- 未做容器/Compose 实跑（本机无 Docker CLI，与 `0cd0e60` 的记录一致）。
- 未连真实域名、DNS、证书、宝塔反代；未做真实备份恢复演练。

---

## 3. 三轮递进链

### 第 1 轮 · 模式库扫捕

| 模式库类别 | 搜索式（要点） | 命中 | 审查 | 确认 | 排除 |
| --- | --- | --- | --- | --- | --- |
| 1 时间与日期 | `toISOString\(\)\.\s*(slice\|split)`、`getUTC(FullYear\|Month\|Date\|Day)`、`.review` 里近 14 天的硬编码日期 | 4 处源码 + 134 处脚本日期 | 4 + 12 | **1**（A-11 日志按 UTC 日切） | 3 处源码 + 大部分脚本夹具 |
| 2 CSS 布局与动画 | `animation-delay`、`animation-fill-mode`、`@keyframes`、`transition:[^;]*height`、`prefers-reduced-motion` | 3 个延迟 + 17 组 keyframes + 13 处高度/滤镜过渡 | 全部 | **1**（A-04 雾带） | 云的正延迟、两处 `height` 过渡 |
| 3 状态与并发 | `RequestRef`、`requestId`、`AbortController`、`recordsCacheRef`、`queryPath` | 记录/任务两条取数链路 | 2 | 0 | 全部（序号 + Abort 双保险齐备） |
| 4 验收基建自身 | 写 `RESULT` 却不设退出码、缺 stdout、守卫是否首条 import、`.place-toggle` 陈旧选择器 | 296 个顶层脚本 | 全部 | **0 新增**（§7 已修完：`noExit = 0`、`noStdout = 0`） | `verify-places.mjs` 只剩注释 |
| 5 安全闸门与批量清理 | 读 `production-guard.mjs` 全文 + `verify-production-guard.mjs` 的夹具 + `purge-trash-junk.mjs` | 23 个脚本引用守卫 | 全部 | **2**（A-01、A-12） | `purge-trash-junk.mjs` 的中止语义与活计数断言 |
| 6 账户/多租户/部署 | 新模块全文 + `process.env` 全仓 + 网关路由 | 7 处 `process.env`、1 个网关、4 个新模块 | 全部 | **5**（A-05/06/07/13/14） | 租户目录符号链接/路径穿越防护（做得很扎实） |

**第 1 轮最重的三条**：A-01（闸门判定字段错）、A-02/A-03（两个真会写生产库的脚本被审计工具判为「只读」）、A-04（雾带动画跳变）。

### 第 2 轮 · 按轴扩张（先逐张执行第 1 轮搜索卡）

**搜索卡 1（来源 A-01）——「还有哪些闸门用间接字段推断目标？」**
- 搜索式：`rg -n 'LIFEOS_BACKUP_DIR|BACKUP_DIR|localDirectory' apps/api/src .review`
- 命中 6 → 审查 6 → 确认 1（A-01）→ 排除 5。
- 新变体：`compose.yaml:23` 显式设 `LIFEOS_BACKUP_DIR=/data/backups`，**所以容器里两者恰好同源，闸门侥幸成立**；本机任何把备份目录挪到数据目录之外的配置都会让闸门失效。

**搜索卡 2（来源 A-02/A-03）——「把 `method:"POST"` 字面量换成真实写行为的枚举」**
- 自建扫描器 `.review/_audit-r2-writers.mjs`：把「字面量 `method:"POST"`」扩成「CDP 驱动 + `acceptance-cleanup` 注册夹具 + `Input.insertText`」。
- 命中 **69 个可写脚本**（原审计工具只认出 21 个）→ 审查 43 个 attach 型 → 确认 2（A-02、A-03）→ 排除 41（自带隔离实例或只读探针）。
- 命中数 → 人工审查数 → 已确认数 → 排除数 = **69 → 43 → 2 → 41**。

**搜索卡 3（来源 A-04）——「其它正 `animation-delay` / 基准样式与首帧不一致」**
- 命中 3（`.fog-band--2/--3`、`Clouds` 的 `index*1.7 % 6`）→ 审查 3 → 确认 2（雾带两条）→ 排除 1（云：`cloud-drift` 0% = `translate3d(0,0,0)`，与 `.cloud` 基准完全相同）。

**搜索卡 4（来源 A-05）——「还有哪些状态不在任何备份里」**
- 搜索式：`rg -n 'backupTo|createBackupArtifact|readFileSync.*config.json' apps/api/src`
- 命中 8 → 审查 8 → 确认 1 新（A-05 `identity.sqlite`）→ 排除 7（四类 `*-config.json` 与照片属于 §17 已登记项，不重复计数）。

**搜索卡 5（来源 A-06）——「还有哪些无界 Map / 限流可绕」**
- 命中 2（`loginFailures` 两处）→ 审查 2 → 确认 1（A-06，账户模式那份）→ 排除 1（legacy 那份按纯 IP 分桶，不可轮换用户名绕过）。

**轴 A · 时间**：`datesBetween`、`backup-retention`、`weather-archive-scheduler`、`calendarData.nextDate`、`TimeMachine.weekday` 全部按「上海部件 + UTC 数学」实现且注释说明「该时区无 DST」——正确。新变体只有 A-15（客户端按浏览器时区 vs 服务端固定上海）。
**轴 B · 布局与渲染**：16 处 `position: fixed`；两处右键菜单的坐标钳制是**不存在**的（A-08）。响应式断点与 `overflow` 裁剪未做浏览器量测 → 列「未验证」。
**轴 C · 状态与契约**：影片字段三处白名单**逐项一致**（`packages/core/src/model.ts:821` 的 `movieFieldNames` == `apps/api/src/movie-input.ts:36` 的 `MOVIE_FIELD_NAMES`，均为同样 10 项同序；`MOVIE_INPUT_KEYS` 是它的超集并含实体级键）。`hasOnlyKeys` 在 24 处路由入口全部接线。新增变体：A-09（`revision` 不在导出契约里）。
**轴 D · 失败路径**：`http-body.ts` 对 413 做了「声明长度 + 流式长度」双重检查；409 走 `ConflictError` → `revision_conflict` 并回带 `current`；401 有登录门；`assertImportReferences` 把 6 类悬空引用全部拒成 400（由隔离实测确认，见 §5）。**本轴未发现新缺陷。**
**轴 E · 身份与资源归属**：见 §5 的实测。结构性隔离（每租户独立 `dataDirectory` / `assetRoot` / `backupDirectory` + 派生密钥 + 剥离继承的 Key/S3）在代码层面是完整的；`appFor` 全程同步、无竞态；`apps` 上界 = 1 + 64。**本轴未发现新缺陷，但发现 A-05（身份库无备份）。**
**轴 F · 部署契约**：`readConfig` 有 40+ 个环境变量；`compose.yaml` 的显式 `environment:` 只映射 14 个 → **A-07**。

### 第 3 轮 · 跨层与边界

- **导出/导入往返（实测）**：`.review/verify-export-import-integrity.mjs` → `RESULT: PASS (23 checks)`（自带 API 3032/3033 + 独立 data dir）。我另建 `.review/_audit-r3-roundtrip.mjs` 补上它没覆盖的字段：**note 详情、weather 附件、isPrivate、isDemo、isBackfill、task.dueAt、entityRefs、assetRefs 在 JSON 往返里逐字节无损**（29 项断言，2 条 FAIL 全部指向同一件事 → A-09、A-10）。
- **预算与动画（实测）**：`.review/_audit-r3-fog.mjs` 把**真实的 `apps/web/src/styles.css`** 装进一张一次性本地页，用无头 Chrome 量计算样式 → 见 A-04。
- **逆向检查测试本身**：`verify-export-import-integrity.mjs` 的「往返无损」是 `JSON.stringify(再导出) === JSON.stringify(原导出)` —— 一个**相对不变量**，且它的夹具只造 `kind:"journal"` 记录（`mkRecord` 里只有 `body.original`）。因此 `note` / `weather` / `isPrivate` / `isDemo` / `revision` **全在它的覆盖之外**；我用自建探针证伪了这份自信（A-17）。`verify-movie-context-menu.mjs` 用 `getBoundingClientRect` 只为了**定位**目标元素，**没有任何一条断言量菜单自身是否落在视口内**（A-08 因此长期不可见）。
- **空与极值**：`/api/weather?date=` 对 `2026-02-30` / `2026-04-31` / `2026-13-01` / `0000-01-01` 全部 400 `invalid_date`（隔离实测）；0 条/超长/纯 emoji 等由 `npm test` 的 59 条 API 测试覆盖，未另建夹具。

---

## 4. 问题总表

| ID | 严重度 | 证据状态 | 问题 | 首次发现轮次 | 影响范围 | 文件:行 |
| --- | --- | --- | --- | --- | --- | --- |
| A-01 | **P1** | 已复现（对判定函数）+ 静态证实 | 生产守卫用 `localDirectory`（= **备份目录**）判断「是不是主人的库」；`LIFEOS_BACKUP_DIR` 指到数据目录之外时，守卫对着生产库**静默放行** | R1 | `.review/` 全部 attach 型写入脚本 | `.review/lib/production-guard.mjs:60-65,213`；`apps/api/src/routes-backup.ts:106`；`apps/api/src/config.ts:158`；`.review/verify-production-guard.mjs:88` |
| A-02 | **P1** | 静态证实（因果未证实） | `.review/verify-privacy.mjs` 对 2099-01-01 建/改/删记录，目标 `LIFEOS_VERIFY_BASE ?? :3012`，**无守卫**，且因为端口不是 3011/5199 而**完全不在审计工具视野内** | R1 | 生产库（若被指向 3011/5199）；清理只在成功路径 | `.review/verify-privacy.mjs:3,19,27,31`；`.review/audit-toolbox-targets.mjs`（分类逻辑） |
| A-03 | **P1** | 已复现（生产库内实测 5 条墓碑） | `verify-composer-shots.mjs` / `verify-composer-pickers.mjs` **通过 UI 在生产库建记录**，无守卫，却被审计工具归入「只读」；清理是 best-effort | R1 | 主人 3011 时间轴 | `.review/verify-composer-shots.mjs:16,394`；`.review/acceptance-cleanup.mjs:5-9,41-44` |
| A-04 | **P2** | **已复现**（CDP 实测） | `.fog-band--2/--3` 正 `animation-delay` + `animation-fill-mode: none` + 无基准 `opacity` → 延迟期内以 **opacity 1** 渲染，1.4s / 2.6s 后**跳变**到 0.34~0.6 | R1 | 天气卡雾天形态，每次挂载 | `apps/web/src/styles.css:1071-1080` |
| A-05 | **P2** | 静态证实 | 账户模式下 `data/identity.sqlite`（账号 + 租户密钥主种子 `config_master_secret`）**不在任何备份范围内**：`backupTo` 只快照记录库；§17 只讨论了照片 | R1 | 恢复后所有账号与租户集成密钥不可恢复 | `apps/api/src/server.ts:596`；`apps/api/src/backup.ts:368-376`；`apps/api/src/identity-store.ts:120-125` |
| A-06 | **P2** | 静态证实 | 登录限流按 `remote + sha256(username)` 分桶 ⇒ 单 IP 轮换用户名**等于没有限流**；且 `authenticate()` 的 scrypt 在限流判定**之后**、无并发上限 | R1 | 账户模式（默认关闭） | `apps/api/src/server.ts:667-679`；`apps/api/src/identity-store.ts:33-40,156-166` |
| A-07 | **P2** | 静态证实 | `compose.yaml` 的显式 `environment:` 漏传 `BACKUP_S3_*`（以及 `LIFEOS_LOG_DIR` / `LIFEOS_DEEPSEEK_API_KEY` / `QWEATHER_KEY` / `LIFEOS_TMDB_API_KEY` 等）⇒ 按 `.env.example` 配好的对象存储备份在容器里**静默不生效**。`0cd0e60` 只补了四个 `*_CONFIG_SECRET` | R2 | 容器部署 | `compose.yaml:7-23`；`.env.example`（`BACKUP_S3_*` 段）；`apps/api/src/config.ts:159-173` |
| A-08 | **P2** | 静态证实 | 两个右键菜单按**裸鼠标坐标**定位、无任何视口收边：`.mention-context-menu` 的注释声称 `max-width` 解决右缘溢出，但 `max-width` 只限宽度、**不移动菜单**；垂直方向两边都没管 | R2 | 正文右键菜单、日历右键菜单 | `apps/web/src/styles.css:9577-9586,11694`；`apps/web/src/entity-forms.tsx:455`；`apps/web/src/calendar-view.tsx:238,251` |
| A-09 | **P3** | **已复现** | `revision` 不在导出契约内：`GET /api/export` 的每条记录**根本没有该字段**（导入后取新值）。功能上可接受，但契约里没写，且现有「往返无损」断言抓不到 | R3 | 任何把导出当增量/对账依据的工具 | `packages/core/src/model.ts:288-308`（`TimelineRecordBase` 无 `revision`）；`apps/api/src/routes-records.ts:214-217` |
| A-10 | **P3** | **已复现** | Markdown 导出**完全不含 `note`**：`kind: "note"` 的记录里 `format` / `source` 丢失（`export.ts` 里 "note" 出现 **0** 次） | R3 | Markdown 导出（只读格式，不参与导入） | `packages/core/src/export.ts:190-216` |
| A-11 | **P3** | 静态证实 | `requestLog` 有两份**逐字节相同**的实现；日志文件名按 **UTC** 日切（`toISOString().slice(0,10)`），与产品的 Asia/Shanghai 日口径不同 —— 按天对账时文件名与内容会错位 | R1 | 运维读数、按天对账 | `apps/api/src/server.ts:299-324`；`apps/api/src/asset-static.ts:35-60` |
| A-12 | **P3** | 静态证实 | 守卫「脚本真的读了变量」的判据是**剥注释后的文本包含**：源码字符串里提一句 `LIFEOS_API_ORIGIN` 即可满足。回退只探 3011/5199 ⇒ 指向其它端口的脚本会被**误判为生产**并拒绝（假阳性 → 催生「一律加 `LIFEOS_ALLOW_PROD_ACCEPTANCE=1`」的习惯，反过来侵蚀闸门） | R1 | 守卫自身 | `.review/lib/production-guard.mjs:136-186,200-209` |
| A-13 | **P3** | 静态证实 | `accountRow` 用 `row.disabled_at !== null` 判停用 ⇒ 任何**漏选该列**的查询会把账号静默判成「已停用」（`undefined !== null` 为真） | R1 | 账户模式 | `apps/api/src/identity-store.ts:77` |
| A-14 | **P3** | 静态证实 | `publicBackupConfig` 在「未配置」时回显 **owner 真实** 的 bucket/prefix（`cdnb` / `product-backup/lifeos`）作为默认值 | R1 | 任何成员账号的设置页 | `apps/api/src/backup-config.ts:187` |
| A-15 | **P3** | 疑似待验证 | 客户端按浏览器时区分天（`USER_TIME_ZONE`），而天气归档 / 备份保留 / 时光机固定 `Asia/Shanghai` ⇒ 浏览器不在 +08 时，同一记录在「时间轴的天」与「归档/保留的天」会落在不同日期 | R2 | 非 +08 时区的使用者 | `apps/web/src/time.ts:4`；`apps/api/src/weather-archive-scheduler.ts:6`；`apps/api/src/backup-retention.ts:45` |
| A-16 | **P3** | 已复现 | `audit-toolbox-targets.mjs` 的「会写/只读」是**词法启发式**（只认 `3011`/`5199` 字面量与 `method:"POST"` 字面量）⇒ A-02、A-03 被归为「只读」；`acceptance-cleanup.mjs`（真删）、`migrate-data-dir.mjs`（真搬）也在「只读」桶里。**结论行的「UNGUARDED = 0」不构成安全证明** | R2 | 全部验收基建 | `.review/audit-toolbox-targets.mjs` |
| A-17 | **P3** | 已复现（用自建探针证伪） | `verify-export-import-integrity.mjs` 的「往返无损」是**相对不变量**（导出→导入→再导出互比），且夹具只造 `kind:"journal"` ⇒ `note` / `weather` / `isPrivate` / `isDemo` / `revision` 全在覆盖之外 | R3 | 导出导入的验收强度 | `.review/verify-export-import-integrity.mjs:160-161,262-265` |
| A-18 | **P3** | 已复现 | 生产库现存 **12 条软删墓碑**，其中 **5 条**正文是 `验收：照片和文字一起保存（可删）`（= `verify-composer-shots` 的夹具文案）⇒ 清理不是保证 | R1/R3 | 主人生产库（不可见但可累积） | `data/lifeos.sqlite`（只读查询）；`.review/acceptance-cleanup.mjs:42` |

> **合并说明**：A-02 / A-03 / A-16 是同一根因（**验收工具箱用词法线索代替真实写行为**）的三个实例，但处置动作不同（A-02 改目标变量、A-03 接守卫、A-16 修分类器），故分列。
> **重复计数避免**：`2099-01-01` / `2036-09-15` 的 day_summaries 残留、`data/derived` 缩略图、照片不进快照 —— 均已在 `docs/todo.md` §4/§5/§17 登记，不重复计入。

---

## 5. 逐项详情

### A-01 · 生产守卫用「备份目录」判断「是不是主人的库」（P1）

**预期**：守卫只有在确认目标 API 打开的是**隔离数据目录**时才放行。
**实际**：它确认的是**备份目录**不在 `data/` 里。

- `apps/api/src/routes-backup.ts:106`：`localDirectory: config.backupDirectory ?? null` —— 这是 `/api/backup/status` 给守卫看的唯一线索。
- `apps/api/src/config.ts:158`：`backupDirectory = resolve(LIFEOS_BACKUP_DIR || BACKUP_DIR || \`${dataDirectory}/backups\`)` —— **可以被独立指定**，与数据目录无关。
- `.review/lib/production-guard.mjs:213`：`isProduction = answered && (dataDirectory === null || insideProductionData(dataDirectory))`。
- **自证**：`.review/verify-production-guard.mjs:88` 的「放行」夹具正是 `{ localDirectory: <repo>/.review/guard-fixtures/fake-instance/backups }` —— 一个**在 `data/` 之外**的备份路径，被断言为「已验证的隔离 origin」（`:105` `honours a verified isolated origin`，exit 0）。**回归测试本身把这个不成立的推断钉成了期望行为**，所以它永远不会红。

**最短安全复现**（不需要真实生产服务）：
```bash
# 1) 起一个假服务，只答 /api/backup/status，报一个 data/ 之外的 localDirectory
#    （这就是 verify-production-guard.mjs 已有的夹具形态）
# 2) 让一个真的读了 LIFEOS_API_ORIGIN 的小脚本去连它
# 3) 观察守卫：不打 REFUSING、不退出 1 —— 它认为这是隔离实例
```
**受影响路径**：`.review/` 里所有 attach 型写入脚本（21 个「会写」+ A-02/A-03 那两个漏网的）。
**不受影响**：`compose.yaml` 的默认部署（`:23` 把 `LIFEOS_BACKUP_DIR` 钉在 `/data/backups`，恰好同源）；本机 `data/` 与 `LIFEOS_BACKUP_DIR` 都没设时（默认值 `${dataDirectory}/backups`）。
**建议修复方向（只写在这里，未实施）**：让 `/api/backup/status`（或一个新的只读端点）显式报出**数据目录本身**，守卫只认那一个字段；同时给 `verify-production-guard.mjs` 补一档对抗性夹具 ——「服务报了非生产的 `localDirectory`，但数据目录是生产」必须**拒绝**。
**建议回归测试**：上述夹具 + 一条「`LIFEOS_BACKUP_DIR` 指向别处时守卫仍拦得住」的断言。

### A-02 · 端口 3012 上的无守卫写入脚本（P1）

`.review/verify-privacy.mjs` 全文 42 行，第 3 行 `const base = process.env.LIFEOS_VERIFY_BASE ?? "http://127.0.0.1:3012";`，然后 POST 一条 `occurredAt = 2099-01-01` 的记录、PATCH 它的 `isPrivate`、DELETE 它（软删）。
- **没有** `import "./lib/production-guard.mjs"`。
- **不在** `audit-toolbox-targets.mjs` 的扫描范围里 —— 那个工具只认 `3011` / `5199` 字面量，这里写的是 `3012`，目标变量名也是它不认识的 `LIFEOS_VERIFY_BASE`。
- 清理（第 31 行）只在**成功路径**上；抛异常就直接进 catch 写 FAIL，记录留在库里。
- **软删**意味着：记录从时间轴消失，但**那天会留下一行孤儿 `day_summaries`**。

**因果未证实但值得记的旁证**：`docs/todo.md:80` 记着 2026-09-21 用 `prune-day-summaries.mjs` 清掉了生产库里的 `2036-09-15` 与 **`2099-01-01`** 两行孤儿小结 —— `2099-01-01` 正是这个脚本的夹具日期（`2036-09-15` 来自 `verify-calendar.mjs` / `retract-record.mjs`）。本轮**只读**复核：现在库里 `2099-01-01` 与 `2036-09-15` 的记录都是 **0 行**，`day_summaries` 60 行里也没有这两天。**所以残留已不在，但「它是怎么来的」没有直接日志证据，我不写成结论。**
**建议修复方向**：给它接上生产守卫（它会立刻在 3012 上正常工作）；或者把 `audit-toolbox-targets.mjs` 的目标识别从「端口字面量」改成「真实请求目标」。

### A-03 · 通过 UI 写生产库、却被归为「只读」的验收脚本（P1）

`.review/acceptance-cleanup.mjs` 的文件头自己写着这条历史：

> `verify-composer-shots` saved a record plus an uploaded photo on every run and never removed either. A dozen runs later the owner's 3011 timeline held a pile of `"验收：照片和文字一起保存（可删）"` rows…

本轮**只读实测**：生产库 12 条软删记录里，**5 条**的正文就是 `验收：照片和文字一起保存（可删）`（id 见 `.review/_audit-prod-residue.mjs` 输出；正文此处不复录）。⇒ **清理机制存在，但不是保证**。
`verify-composer-shots.mjs` 与 `verify-composer-pickers.mjs` 都：
- 引用 `acceptance-cleanup.mjs`（即注册了夹具 ⇒ 确实会造记录），
- 没有守卫，
- 在 `audit-toolbox-targets.mjs` 的输出里位于 **「attach to 3011/5199 — read-only」** 那一栏。

**根因**：审计工具判「会不会写」用的是 `method: "POST"` 这个**字面量**；这两个脚本的写是通过 CDP 打字 + 点保存完成的，源码里根本没有那个字面量。
**建议修复方向**：把「引用 `acceptance-cleanup.mjs`」当作**会写**的强信号（那模块的存在本身就是「我造了东西」的声明）；并给这两个脚本接守卫。

### A-04 · 雾带的正延迟让两段雾先以满强度出现再跳变（P2，已复现）

`apps/web/src/styles.css:1071-1080`：
```css
@keyframes fog-drift { 0%, 100% { transform: translate3d(0,0,0); opacity: .34; } 50% { … opacity: .6; } }
.fog-band      { … animation: fog-drift 9s ease-in-out infinite; }   /* 没有 opacity */
.fog-band--2   { … animation-delay: 1.4s; }
.fog-band--3   { … animation-delay: 2.6s; }
```
`animation-fill-mode` 默认 `none` ⇒ **延迟期内元素按基准样式渲染**，而基准样式没有 `opacity` ⇒ 用初始值 `1`。

**实测**（`.review/_audit-r3-fog.mjs`，把真实 `styles.css` 装进一次性本地页 + 无头 Chrome 量计算样式，`prefers-reduced-motion: no-preference`）：

| 元素 | 延迟 | fill | 刚加载（延迟期内） | 3.4s 后 | 落差 |
| --- | --- | --- | --- | --- | --- |
| `.fog-band--1` | `0s` | `none` | **0.348** | — | 对照：正确 |
| `.fog-band--2` | `1.4s` | `none` | **1** | 0.503 | **0.50** |
| `.fog-band--3` | `2.6s` | `none` | **1** | 0.391 | **0.61** |

对照组：`prefers-reduced-motion: reduce` 下被 `styles.css:7546` 显式钉在 `opacity: .5` 且 `animation: none` —— **这条是对的**。

**同族已修好的先例（说明这不是「不知道」而是「漏了一处」）**：
- `apps/web/src/styles.css:979-983`：`.rain-drop` 的注释明确写了「base position matters: before the animation begins (a positive `animation-delay`, up to 1.3s) the element sits at its base style」；
- `apps/web/src/WeatherBackground.tsx:113-116` 与 `:158-160`：雨滴与雪花都改成**负延迟**并写明理由。
- `.cloud` 的正延迟（`WeatherBackground.tsx:88`）**是良性的**：`cloud-drift` 的 0% 与 `.cloud` 基准完全相同（都无 transform）⇒ 无跳变。**已排除。**
**建议修复方向**：给 `.fog-band` 补 `opacity: .34`（基准即首帧），或给这两条加 `animation-fill-mode: backwards`。
**建议回归测试**：挂载后立即（< 延迟）与延迟后各取一次 `getComputedStyle(el).opacity`，断言两者都落在 `[.34, .6]`。

### A-05 · `identity.sqlite` 不在任何备份里（P2）

- `apps/api/src/server.ts:596`：`new IdentityStore(resolve(config.dataDirectory, "identity.sqlite"))` —— 账号、密码 scrypt 哈希、会话、以及 `identity_meta.config_master_secret` 都在这里。
- `apps/api/src/identity-store.ts:120-125`：`config_master_secret` 首次启动**随机生成**并落库；`tenant-config.ts:38-40` 用它 HMAC 派生**四个租户配置密钥**。
- `apps/api/src/backup.ts:368-376`：`createBackupArtifact` 只做 `repository.backupTo(path)` —— 那是 `lifeos.sqlite` 的快照，**不含** identity 库、也不含四类 `*-config.json`。
- 于是：从快照恢复到新机器 ⇒ 所有成员账号消失，且**所有成员的集成密钥（AI/天气/观影/对象存储）永久解不开**（没有任何可恢复的种子）。
- `docs/todo.md` §17 只讨论了「照片是否进备份」，**没有提到身份库**；`README.md:147` 只是要求「所有配置与随机租户目录也必须随 `/data` 一起持久化」，那是卷级要求，不是备份要求。
**建议修复方向**：把 identity 库与四类 `*-config.json` 纳入 §17 的 manifest；至少先把它写进 §17 的「已知缺口」。
**未验证**：本轮没有做任何恢复演练，也没有复制生产库。

### A-06 · 登录限流可被用户名轮换绕过，且 scrypt 无并发闸（P2）

`apps/api/src/server.ts:667`：`loginKey = \`${remote}:${sha256(username.toLowerCase())}\``，`:670-674` 按该键判 `blockedUntil`。⇒ **同一个 IP 换一个用户名就是一条全新的桶**，`recordLoginFailure` 的 5 次封锁完全绕开。`pruneLoginFailures` 有 15 分钟 TTL + 4096 上限（`:168-180`），所以内存不会被无界撑爆 —— **但上限的达成方式是「淘汰最老的桶」**，也就是**攻击者自己可以持续刷新自己的桶**。
另外 `identity.authenticate()`（`identity-store.ts:156-166`）会在**限流判定之后**执行 scrypt（`N=16384, r=8`，约 16 MB / 次，跑在 libuv 线程池默认 4 个线程上），**没有任何并发上限**。⇒ 未认证请求即可持续占用 scrypt 线程池，与正常业务（同一进程内的摘要/缩略图）抢资源。
**受影响**：仅账户模式（`LIFEOS_ACCOUNT_MODE=1`，默认关闭；生产从未启用，`data/identity.sqlite` 目前不存在）。
**建议修复方向**：加一条按 IP 的桶（与按账号的并存），或在 `authenticate` 之前加一个进程级并发信号量。
**未验证**：没有做压力测试（不做，避免对任何实例造成负载）。

### A-07 · Compose 漏传 `BACKUP_S3_*`（P2）

`compose.yaml` 用的是**显式 `environment:` 映射**（不是 `env_file`），所以只有列出来的变量会进容器；`${VAR}` 只是拿宿主机/`.env` 做插值。映射里现在有 14 个变量，`0cd0e60` 补进去的是四个 `*_CONFIG_SECRET`。
**仍然漏掉的**（对照 `apps/api/src/config.ts` 真实读取的键名）：`BACKUP_S3_ENABLED` / `ENDPOINT` / `REGION` / `BUCKET` / `PREFIX` / `FORCE_PATH_STYLE` / `ACCESS_KEY_ID` / `SECRET_ACCESS_KEY`、`LIFEOS_LOG_DIR`、`LIFEOS_DB_PATH`、`LIFEOS_WEB_DIR`、`LIFEOS_BODY_LIMIT_BYTES`、`LIFEOS_ASSET_UPLOAD_LIMIT_BYTES`、`LIFEOS_ASSET_ORPHAN_GRACE_DAYS`、`LIFEOS_ASSET_TRASH_DAYS`、`LIFEOS_ALLOW_FILE_BACKUP`、`LIFEOS_DEEPSEEK_API_KEY` / `MODEL` / `BASE_URL`、`QWEATHER_KEY` / `LOCATION` / `CITY` / `HOST`、`LIFEOS_TMDB_API_KEY` / `TMDB_API_KEY`。
**后果**：`.env.example` 与 `README.md:118` 都把 `BACKUP_S3_*` 写成受支持的环境配置；照做之后容器里 `config.backupS3 === undefined` ⇒ `readRuntimeBackupConfig` 返回 `undefined` ⇒ 备份页显示「未配置」。**全程零报错**。（集成 Key 走设置页 UI 写进卷内 `*-config.json`，所以那些是安全的；S3 凭据**只能**走环境变量或 UI，而 UI 那条路是通的 —— 所以这是「文档承诺的一半失效」。）
**建议修复方向**：把 `BACKUP_S3_*` 补进映射；或改用 `env_file:` 并显式列白名单。
**未验证**：本机无 Docker CLI，**没有实际跑 `docker compose config` 或容器**（与 `0cd0e60` 记录的限制相同）。

### A-08 · 两个右键菜单不贴边（P2）

- `apps/web/src/entity-forms.tsx:455`：`style={{ left: contextMenu.x, top: contextMenu.y }}`，坐标来自 `:318` 的 `openContextMenu(element, clientX, clientY)`。
- `apps/web/src/styles.css:9586`：`max-width: min(280px, calc(100vw - 16px));` —— 注释（`:9577-9579`）说这是为了「贴着窗口右缘右键时菜单会整个跑到屏幕外」。
  **但 `max-width` 只限制宽度、不移动菜单**：`left = clientX` 可以取到 `100vw - 4`，此时菜单仍有 `min-width: 172px`，右侧照样溢出。**注释给的因果是错的。**
- `apps/web/src/calendar-view.tsx:251`：同一个形状（`left: x, top: y`），而 `:238` 的 `flip = x > window.innerWidth - 380` **只决定周期二级菜单往左还是往右开**，不影响主菜单本身。`.calendar-summary-menu`（`styles.css:11694`）连 `max-width` 都没有。
- 垂直方向两边都**完全没管**（无 `max-height`、无 `min(top, innerHeight - h)`）。
**为什么长期没被发现**：`.review/verify-movie-context-menu.mjs` 里 `getBoundingClientRect` 只用来**定位**点击目标（`:264`），**没有任何一条断言量菜单自身是否在视口内**（`innerWidth` / `innerHeight` 全文 0 次）。
**最短安全复现步骤**：在正文里选中一段文字 → 把鼠标移到窗口**右下角**再右键 → 菜单有一部分在视口外。（本轮只做静态证实，未在真实浏览器里量矩形。）
**建议修复方向**：把定位收成一个 `placeFixedMenu(x, y, width, height)`，两轴都做 `min(x, innerWidth - w - 8)` 之类的收边。

### A-09 / A-10 · 导出契约的两处缺字段（P3，均已复现）

实测来源：`.review/_audit-r3-roundtrip.mjs`（隔离实例 A 3085 / B 3086，独立 data + asset root；**未触碰生产**），`RESULT: 2 FAIL (29 checks)`，两条 FAIL 就是这两项。

- **A-09 `revision`**：导出的记录键集实测为
  `aiDerived, assetRefs, body, createdAt, entityRefs, id, isDemo, isPrivate, kind, occurredAt, relatedRecordIds, weather`
  —— **没有 `revision`**。根因在模型层：`TimelineRecordBase`（`model.ts:288-308`）不含 `revision`，`revision` 只存在于 API 的 `RecordView`；`repository.exportData()` 返回的是 `TimelineRecord[]`。导入后记录拿到新 revision（乐观锁用「最后一次读到的值」，功能上自洽）。
  **结论**：这是**设计选择**，不是 bug；但契约里没写，且现有「往返无损」断言**在原理上抓不到它**（见 A-17）。
- **A-10 `note`**：`packages/core/src/export.ts` 全文出现 `note` **0 次**。实测一条 `kind: "note"` 记录的 Markdown frontmatter 逐行是：`lifeosFormat / lifeosVersion / recordId / kind / createdAt / updatedAt / occurredAt / isPrivate / isDemo / isBackfill / weather / task / entityRefs / relatedRecordIds / assetRefs / assetStorageRefs / aiDerived / knownEntities` —— 正文只有 `## Original`，**`format: "quote"` 与 `source: "某本书"` 一个字都没出现**。
  **好消息**：同一份夹具证明 **JSON 往返对 `note` 是无损的**（`note 详情保留 {"format":"quote","source":"某本书"}`，且记录逐字节一致）。

### A-11 ~ A-15 · 其余 P3（静态证实，逐条给到文件行）

- **A-11**：`server.ts:299-324` 与 `asset-static.ts:35-60` 的 `requestLog` **逐字节相同**（两份独立维护 ⇒ 迟早分叉）；两处的 `const day = new Date().toISOString().slice(0, 10)` 按 **UTC** 切日志文件名，而产品其余部分按 `Asia/Shanghai` 切天。这正是模式库里「按天对账一律用 `Intl.DateTimeFormat("en-CA", {timeZone})`」那条的同族实例 —— 影响面限于运维读数，故 P3。
- **A-12**：`.review/lib/production-guard.mjs:171-174` `originIsHonored = … && entryCode.includes(originVar)` —— 剥掉注释后仍保留**字符串字面量**，所以 `console.log("set LIFEOS_API_ORIGIN to…")` 就能满足它；`:200-209` 的回退只探 `[3011, 5199]`，指向别的端口的脚本会被判成生产并拒绝（`note: ignoring …` 只对「变量没被读」打印，对「端口不在 3011/5199」不打印）。
- **A-13**：`identity-store.ts:77` `disabled: row.disabled_at !== null`。目前 4 处查询都选了该列，**今天不会错**；但任何将来漏选的查询会把账号静默判成已停用（`accountRow` 是唯一的构造入口，风险集中在它身上）。建议改成 `row.disabled_at !== null && row.disabled_at !== undefined`。
- **A-14**：`backup-config.ts:187` 的「未配置」默认值里写死了 `bucket: "cdnb"` / `prefix: "product-backup/lifeos"` —— 那是主人真实桶的前缀（见 `AGENTS.md`）。成员账号在未配置时会在设置页看到它。
- **A-15**：`apps/web/src/time.ts:4` `USER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone`，`main.tsx:486,805` 把它当 `timeZone` 传给 `/api/records` 与摘要；而 `weather-archive-scheduler.ts:6`、`backup-retention.ts:45`、`TimeMachine.tsx`/`BackupCalendar.tsx` 都硬编码 `Asia/Shanghai`。**未验证**（需要把浏览器时区改到别处才能实测），故只记为「疑似」。

### A-16 · 「UNGUARDED = 0」不是安全证明（P3）

`node .review/audit-toolbox-targets.mjs` 结论行是：

> `Every writer that attaches to 3011/5199 either refuses to touch the owner's data or is marked @unguarded-on-purpose.`

本轮实测它的两个前提都不成立：
1. **「attach 到 3011/5199」不是「会写生产」的完整集合**：`verify-privacy.mjs` 走 3012 + 私有变量（A-02）。
2. **「writer」是用 `method: "POST"` 字面量认的**：CDP 驱动的写入看不见（A-03）。

另外，88 个「read-only」桶里至少有两个名不副实：`acceptance-cleanup.mjs`（职责就是**删**记录/资产/清回收站）、`migrate-data-dir.mjs`（职责就是**搬**数据目录）。
**建议修复方向**：分类信号改成「引用 `acceptance-cleanup.mjs` / `migrate-*` / 出现 `Input.insertText` + 保存按钮 / 目标不是 3011/5199」的组合，并对**没有守卫的 attach 型写入**一律 exit 1。

### A-17 · 「往返无损」断言的结构性盲区（P3）

`.review/verify-export-import-integrity.mjs:262-265`：
```js
const same = JSON.stringify(back.records) === JSON.stringify(bundle.records) && …;
ok(same, "导出 → 导入 → 再导出，记录/实体/资产逐字节一致（往返无损）");
```
这是一个**相对不变量**：只要「导出漏掉字段」与「导入漏掉字段」同时成立，它就永远绿。而它的夹具（`:160-161` 的 `mkRecord`）只有 `{id, kind:"journal", body:{original}, createdAt, entityRefs, [], relatedRecordIds, assetRefs, aiDerived, …over}` —— **`note` / `weather` / `isPrivate` / `isDemo` 一个都没造**。
**证据**：我用自建探针把这四个字段加进夹具后，立刻在 Markdown 侧抓到 A-10（JSON 侧则确认无损）。
**建议修复方向**：夹具覆盖「每个可选字段各一条」；断言从「两次导出一致」升级为「逐字段对照**模型定义**的键集」。

### A-18 · 生产库里的验收墓碑（P3）

只读实测（`.review/_audit-prod-residue.mjs`）：12 条软删记录，按天分布 `2026-09-15×1 / 09-16×3 / 09-17×3 / 09-19×3 / 09-21×2`；其中 **5 条**正文为 `验收：照片和文字一起保存（可删）`。
**性质**：软删 ⇒ 主人在界面上看不见；但它们是**累积的**，且 `docs/todo.md` §2 的 500 日志排查、§4 的保留策略对账都会把它们算进去。**本轮未清理**（不在授权内）。
**建议**：用现成的 `node .review/purge-trash-junk.mjs`（默认 dry-run）过一遍，确认 12 条全部命中已知签名后再决定。

---

## 6. 未证实与已排除

### 6.1 未证实（不得写成已通过）

| 项 | 下一步验证条件 |
| --- | --- |
| A-02 与生产库 `2099-01-01` 残留的**因果** | 需要当时的运行日志或 git 历史里的调用记录；现存日志扫描（`docs/todo.md` §2 的口径）里没有它。**目前只是日期吻合。** |
| A-08 菜单溢出的**真实**矩形 | 在隔离实例里开 CDP，把鼠标移到窗口右下角右键，量 `.mention-context-menu` / `.calendar-summary-menu` 的 `getBoundingClientRect()` 是否越出 `innerWidth/innerHeight`。本轮只做静态证实。 |
| A-15 跨时区分歧 | 需要把浏览器时区改成非 +08（例如 UTC）后，比较时间轴的天与天气归档/备份保留的天。 |
| 移动端断点（≤390 / ≤560 / ≤720）的布局回归 | 需要在隔离实例里跑 `verify-mobile-layout.mjs` 一类的几何断言；本轮只做了静态扫描（16 处 `position: fixed`），没有量任何一处的实际矩形。 |
| 真实部署链路：DNS、证书、宝塔反代、空 `/data` 卷启动、容器内环境注入、真实备份恢复、旧单用户库迁移 | **全部未验证**。本轮未连接任何真实域名或服务器，也未运行 Docker。 |
| 多租户真实上线 | 账户模式在生产**从未启用**（`data/identity.sqlite` 不存在）。所有多租户结论都来自代码阅读 + 仓库自带的隔离测试（`npm test` 的 59 条 API 测试已包含双租户反向隔离）。 |

### 6.2 已排除（高相似误报，附排除证据）

| 看起来像问题 | 为什么不是 |
| --- | --- |
| `timeline-query.ts:74` 用 `toISOString().slice(0,10)` 生成日期序列 | `datesBetween` 的两端都是 `Date.parse("…T00:00:00Z")`（UTC 午夜），步长恰为 86 400 000 ms，UTC 无 DST ⇒ 输出序列精确等于 `from…to`。**是安全的用法，不是「UTC 切片」那个坑。** |
| `backup-retention.ts:66,80` 用 `getUTCFullYear/Month/Date/Day` | 输入是 `calendarParts()` 从 `Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"})` 取出的**上海部件**，再放进 `Date.UTC` 做纯日历数学；文件头 `:52-53` 明确写了「该时区无 DST，所以 UTC 数学是精确的」。 |
| `weather-archive-scheduler.ts:34` 用 `getUTC*` | 同上一类：`shiftDate` 先 `Date.UTC(year, month-1, day+amount)` 再取 UTC 部件，全程不碰本地时区。 |
| `calendarData.ts:64-67` 的 `nextDate` 用 `toISOString().slice(0,10)` | 锚点是 `${date}T12:00:00+08:00`（= 04:00Z），`setUTCDate(+1)` 后仍是 04:00Z ⇒ 切片给出正确的**次日上海日期**。 |
| `TimeMachine.tsx:135` 的 `new Date(Date.UTC(y,m-1,d)).getUTCDay()` | 用 UTC 构造 + UTC 取值求**纯日期**的星期，正是避开时区漂移的正确写法。 |
| `.rain-drop` / `.snow-flake` 的 `animation-delay` | 都是**负**值，且 `styles.css:979-983` / `WeatherBackground.tsx:113-116,158-160` 都写明了理由。**这个坑他们踩过并修好了。** |
| `Clouds` 的正延迟（`WeatherBackground.tsx:88`） | `cloud-drift` 的 0% 是 `translate3d(0,0,0)`，`.cloud` 基准没有任何 transform ⇒ 基准 == 首帧，**无跳变**。 |
| `.review-composer-slot` / `.composer-input` 的 `transition: height` | 两处高度都由 JS 写成**像素值**（`styles.css:1443-1446` 与 `:8170-8171` 的注释明说），不是 `auto` ⇒ 可插值。 |
| `.review/verify-places.mjs` 找 `.place-toggle` | 全文只剩**一条说明注释**（`:16` 写着「a class that has not existed since HEAD 3764b5b」），已不引用；且已接守卫。 |
| 「`apps/api/dist` 是陈旧构建，验收在测旧代码」 | 实测 `dist` **新于** `src`（api：src 03:53:49Z / dist 03:54:10Z；web：src 03:44:46Z / dist 04:05:18Z）。 |
| `.review/purge-trash-junk.mjs` 会误删主人记录 | 文件头 `:19-23` 明确「认不出的行中止整轮」，`:106` 有活记录引用就 fail，`:135-139` 断言活记录计数不变。**是范本级的写法。** |
| 影片字段三处白名单不一致 | `packages/core/src/model.ts:821` 与 `apps/api/src/movie-input.ts:36` **逐项同序相同**（10 项）；`MOVIE_INPUT_KEYS`（21 项）是它的超集。 |
| 导出/导入会丢 note / 天气 / 隐私标记 | **JSON 侧实测无损**（见 §5 A-09/A-10 的实测输出）。只有 Markdown 侧丢 `note`。 |

---

## 7. 交接顺序（按风险与依赖排序，**未实施**）

1. **A-01**（守卫判定字段）—— 它是所有其它 `.review/` 结论的地基；先修它，否则「已守卫」这句话本身不可信。**不需要主人决策。**
2. **A-02 / A-03 / A-16**（两个漏网写入脚本 + 分类器）—— 与 1 同源，建议一次做完：改分类信号 → 给两个脚本接守卫 → 用 `audit-toolbox-targets.mjs` 的退出码验证。
3. **A-04**（雾带）—— 一行 CSS（`.fog-band { opacity: .34 }` 或 `animation-fill-mode: backwards`），但**属视觉口径**，建议先给主人看一眼两段雾的差别。**需要主人点头。**
4. **A-05**（身份库不进备份）—— 是 §17「完整恢复方案」的**新增必需项**，应在主人决定 §17 的三项口径时一并决定。**需要主人决策。**
5. **A-07**（Compose 漏传）—— 与 `0cd0e60` 同一条线，改 `compose.yaml` 即可；本机无 Docker，**改完必须由主人或有 Docker 的环境验证**。
6. **A-06**（登录限流）—— 仅在账户模式生效，可在 A-05 之后排。
7. **A-08**（菜单贴边）—— 独立的小 UI 修复；顺手补一条视口内断言。
8. **A-09 / A-10 / A-17**（导出契约与验收强度）—— 一起做：先补夹具与逐字段断言，再决定 Markdown 是否补 `note`。**A-10 是否要补属产品口径。**
9. **A-11 ~ A-15、A-18**（P3 清单）—— 随手清：去重 `requestLog`、收紧 `accountRow`、去掉 owner 桶的默认回显、统一日志日口径、决定要不要清那 12 条墓碑。

**本轮未实施任何一条。** 上面所有「建议修复方向」都只是建议。

---

## 8. 审计过程中新增的隔离诊断产物（都在 `.review/`，不进 git）

| 文件 | 用途 | 会不会写生产库 |
| --- | --- | --- |
| `.review/_audit-inspect.mjs` | 只读检查器：`grep` / `count` / `top-level-review-scripts` / `file-meta` | 否 |
| `.review/_audit-prod-residue.mjs` | 以 `readOnly:true` 打开 `data/lifeos.sqlite`，只输出**计数与日期键**（不输出记录正文） | 否（只读） |
| `.review/_audit-r2-writers.mjs` | 枚举「含 UI 驱动写入」的 `.review` 脚本及其目标端口 / 守卫状态（A-16 的证据） | 否 |
| `.review/_audit-r3-roundtrip.mjs` | 两个一次性实例（API 3085 / 3086 + 独立 data/asset root）的导出→导入→再导出逐字段对比（A-09/A-10 的证据） | 否（自己的实例） |
| `.review/_audit-r3-fog.mjs` | 把**真实** `styles.css` 装进一次性本地页，用无头 Chrome 量雾带计算样式（A-04 的证据） | 否（无服务、无数据） |
| `.review/_audit-r3-roundtrip.txt` / `_audit-r3-fog.txt` | 上面两个探针的结论（末行 `RESULT:`） | 否 |

收尾复核：本次跑完后 `.review/profiles/` 里**本次产生的那 1 个**已删除（现存 9 个是更早会话的残留，未动）；`.review/_audit-rt-run/` 与一次性页面 `.review/_audit-fog-page.html` 已删除。`data/`、`.env`、`pic-test/`、`deepseek-v1/`、`deepseek-v2/`、`.workbuddy-ai/` **一个字节未动**。

---

*报告生成：2026-09-24（Asia/Shanghai）· 审计 AI：WorkBuddy（Claude）· 只诊断，未修复、未提交、未推送。*
