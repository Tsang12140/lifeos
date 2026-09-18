# LifeOS 项目长期记忆（硬规则速查）

> 规则全文见 `AGENTS.md`，改动记录见 `docs/changelog.md`。
> **展开说明 / 根因 / 实例在 `.workbuddy-ai/memory/MEMORY-detail.md`** —— 需要「为什么」时读它。

## 环境

- **预览常开**：`.review/accept-serve.mjs` → API 3011 + Web 5199（主人开 `http://127.0.0.1:5199/`）。
  **收尾不要杀**（曾误杀被纠正）；端口固定。主人的端口（3001）**永不杀**。只收带隔离 data dir 的（`photo-grid-serve.mjs`）+ 临时 Chrome。
- **沙箱用 Job Object 收拢子进程**：`nohup`/`detached+unref`/`dangerouslyDisableSandbox` **都留不住预览服务**，命令一结束就被回收。
  → **开工先探端口**（3011 `/api/health` + 5199），不在就用 `.review/spawn-serve.mjs` 拉起；只是本次要看效果时用**后台任务**方式拉（能撑过本次会话）。
- **换数据库文件必须先停 API**（SQLite 被持有句柄）——停整个进程树：`netstat -ano` 找 3011/5199 的 PID → 找父进程 → `taskkill /F /T /PID <launcher>`，再 `.review/spawn-serve.mjs` 拉起。
- **验收脚本前置失败会覆盖上次结果文件** → 跑前先确认预览在线。
- **bash 是残缺 PortableGit**（`ls/cat/head/grep/find` 不存在）→ 用 `node -e` 或内置工具。
  npm 直调：`"C:/Program Files/nodejs/node.exe" "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js"`。
- **Node 必须用 `C:\Program Files\nodejs`（24.x）**；managed 22.x 不支持 `--test-isolation=none`。
- **`node -e` 写含反引号的文本必炸** → 长文本先 `Write` 成 `.md` 再 `fs.appendFileSync`。
- **按天对账**一律 `Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(...)`；UTC `slice(0,10)` 跨午夜归错天（已踩两次）。
- **42 格月历第一格 = 含 1 号那周的周一**，不是 1 号。

## 🔴 密钥与 git：**`.workbuddy-ai/memory/` 是公开的，`.env` 不是**

- **2026-09-18 推送前拦下**：`MEMORY-detail.md` / `2026-09-18.md`（**被 git 跟踪**）里抄了 `LIFEOS_WEATHER_CONFIG_SECRET` 的**真实明文**，已在 3 个未推送提交里，差一步上 GitHub。
  → **根因不是「忘了 ignore」**，是**规则只保护 `.env` 这个文件，没保护「把 `.env` 内容复制到别处」这个动作**。交接文档写得越详细越容易犯。
  → **密钥类内容只写形状与来源，绝不写值**（写 `LIFEOS_WEATHER_CONFIG_SECRET='lifeos-local-weather:<搬迁前的数据目录>'` 这种形状）。
- **被 ignore 的**：`.env`、`data/`、`.review/`、`AGENTS.md`、`docs/changelog.md`。
  **没被 ignore 的**：`.workbuddy-ai/memory/**`、`docs/audit-prompt.md`、源码、`.env.example`（占位符可以，真值不行）。
- **推送前必做**：① `npm run typecheck` + `npm test`；② 按**值**搜一遍 —— `git grep -F -e <密钥值> $(git rev-list origin/main..HEAD)`，**别只按文件名搜**。
- **改写历史**（工具已就绪，均默认 dry-run）：
  ① `.review/snapshot-git.mjs --label pre-rewrite` → `.git` **字节级快照 + 自包含 restore 脚本**（**别用 `git reset --hard`/`stash`**，会连未提交成果一起抹掉）；
  ② `.review/rewrite-history-redact.mjs` → 7 项断言全 PASS 再 `--apply`；
  ③ 回滚三件套 = 字节快照 + `refs/backup/pre-rewrite-main` + reflog。撤销：`git update-ref refs/heads/main <旧 tip>`。
- **⚠️ `refs/original/…` 写不进去**：`git update-ref` **返回 0 却什么都不建**（那是 `filter-branch` 的命名空间）→ 用 `refs/backup/…`。**回滚点建完必须 `show-ref` 验，别信退出码。**
- **⚠️ 排查脚本先估进程启动次数**：逐文件 `git cat-file` × 46 个提交 = 上千次 spawn，Windows 上直接跑到被杀（**无输出**）→ 用 `git grep -l -F -e <值> <commit>`，一个提交一次。
- **⚠️ 沙箱丢 `refs/remotes/` 的写入**：`git fetch` 报 `* [new branch] main -> origin/main`，但 `.git/refs/remotes/origin/main` 落不了盘。**不影响推送**（推送只依赖远端 URL + 本地 ref）；自己终端 `git fetch` 一次即恢复。

## 磁盘：测试失败先 `df -h /c`

- 症状 `database or disk is full` / `ENOSPC` **伪装成产品回归**，实际是 C 盘满。
- **根因是 kill/rm 顺序**（`browser.kill()` 异步，紧随的 `rmSync` 撞 Windows 句柄 → EBUSY → 被裸 `catch {}` 吞掉）。
  → **「有清理调用」≠「清理成功」**；只 grep `rmSync` 在不在会得出「0 泄漏」假结论（误判过两次）。
- **修法必须同步强杀**（清理块多在 `finish = () => {…}` / `process.on("exit")` 里，`await` 非法）：
  `.review/reap-chrome.mjs` 的 `reapChromeSync` / `reapChrome` / `sweepStaleProfiles`，**新脚本一律用它**；
  `.review/sweep-profiles.mjs` 随时清扫；`.review/codemod-reap.mjs` 批量改写器（严格匹配 + `node --check` + 失败回滚）。
## 🔴 数据安全：**`data/`（仓库根）是主人的生产库**，不是可丢弃的预览目录

> **2026-09-18 晚已从 `.review/run/data` 迁到这里。** 旧路径**不要重建**。见下「沿革」。

- **2026-09-18 出过事故**：有人把它当「预览用的种子数据目录」重置了，**删掉主人 527 条真实记录 + 149 个 assets**，主人当晚发现 09-16 起自己发的（含照片）全没了。
- **`data/` 就是 API 自己的默认数据目录**（`config.ts:108` `resolve(env.LIFEOS_DATA_DIR?.trim() || "data")`，`.gitignore` 已排除 `data/`）。
  → `npm run dev` / `npm start` **什么都不配**读的就是主人的数据；3011 预览也显式指向它。
  → **永远不要对它跑 `seed-demo --clean`、不要重置、不要删。** 要造数据请用**另开 `LIFEOS_DATA_DIR` 的隔离实例**（`verify-*.mjs` 那批脚本本来就是这么做的，用 `.review/<name>-run/`）。
  → **3011/5199 现在直接指向生产库**，**跑会产生记录的验收会污染主人的数据**（09-18 清掉的那 105 条就是这么来的）。
- **⚠️ `.review/` 里 17 个脚本会直接写生产库 —— 已全部装上「生产守卫」**（144 个脚本中：22 个自带隔离 data dir、**17 个连 3011/5199 且会写**、74 个只读）。
  → **守卫 = `.review/lib/production-guard.mjs`**，副作用式 import，**必须是第一条 import**。读 `GET /api/backup/status` 的 `localDirectory`，落在 `data/` 里就 `exit 1`。
  → **跑验收前先看清单：`node .review/audit-toolbox-targets.mjs`**（列出守卫状态；**有未守卫的写入脚本就 exit 1**）。豁免要显式写 `@unguarded-on-purpose`（目前只有 `retract-record.mjs`）。
  → 判断某个预览实例指着哪个库：`GET /api/backup/status` 的 `localDirectory` 字段。
  → 这类脚本「建记录 → 断言 → 删」：正常收尾留**软删墓碑**（不可见），**中途崩了就留活记录**（可见）—— 第一轮清的那 14 条「2036-09-15」就是这么来的。
  → **只读那组也不安全**：读的是主人真实数据，断言会随主人数据漂移（`verify-settings-ai.mjs` 的 8 项长期 FAIL 属此类）。
  → **13/15 个目标脚本都 import `./reap-chrome.mjs`，但只读脚本也 import 它** → 不是干净的单一改动点，别在那儿加硬拦截。
  → 要放行：`LIFEOS_ALLOW_PROD_ACCEPTANCE=1`（仍警告）。守卫自身回归：`node .review/verify-production-guard.mjs`（**14 项**，夹具在 `.review/guard-fixtures/`）。
  → **真写进去了**：`node .review/retract-record.mjs <id> --apply`（走 API 软删 + revision 校验 + 三重断言）→ 再 `node .review/purge-trash-junk.mjs --apply` 清墓碑。
- **🔒 守卫设计铁律：只采信它能验证的东西**（两次踩坑换来，09-18 我因此污染过生产库一条）。
  → 判定用「**包含**」不用「相等」：`localDirectory` 是 `<数据目录>/backups`（**子目录**），相等判定**永不成立** → 守卫形同虚设。报不出数据目录 → **fail-closed 当生产**。
  → 显式目标变量（`LIFEOS_API_ORIGIN`/`LIFEOS_BASE_URL`）**只有入口脚本源码真的读它**才采信（`process.argv[1]` 取入口、**剥掉注释再 grep**）。`verify-calendar.mjs` 走 `argv[2]`、`verify-weekart.mjs` 硬编码 3011 → 对它们这变量就是谎话。
  → **必须留唯一豁免口**，否则唯一合法用例永远报红 → 所有人学会忽略这个检查。
  → **测试脚手架**：`spawnSync` **阻塞父进程事件循环** → 父进程内的假服务器永远答不上，断言会**因错误的原因失败**（看着像被测代码坏了）；用异步 `spawn` + Promise。`node -e` 没有 `argv[1]` → 显式目标豁免在 `-e` 下永不生效（**安全的失败方向，别去修**）。
- **唯一的安全网 = 应用自己的 S3 定时快照**（`.env` 的 `BACKUP_S3_*`，桶 `cdnb`，前缀 `product-backup/lifeos`；老的被保留策略挪到 `lifeos-trash/`，**同样可恢复**）。
  → **恢复用 `.review/restore-from-backup.mjs`**（`--list` / `--latest` / `--key`；**恢复前强制备份当前 data dir**）。资产文件不在快照里，但存在 `LIFEOS_ASSET_ROOT`（预览 = `pic-test/`），通常还在。
  → **恢复三件事**：① 先停 API（SQLite 被持有句柄）；② **同时删 `-wal`/`-shm`**，否则旧 WAL 会盖回新库；③ 保留 `weather-config.json` 与 `ai-config.json`。
- **⚠️ `weather-config.json`**（`<dataDirectory>/weather-config.json`，`weather-config.ts:70`）存天气 key+位置，**不在 `.env`、不在 git、无副本**。
- **动手前先跑 `node .review/data-inventory.mjs`**（只读；**有主人写的记录就 exit 1**）；目录里也放了 `data/DO-NOT-DELETE.md`。
- **示例 vs 真实的隐形标记 = `records.is_demo`**（持久化列，正文无任何前缀；示例实体/资产 id 带 `demo-`）。
  设置页已有「隐藏预置记录」/「删除预置记录」（二次确认，只删 `is_demo=1` + `demo-` 对象）；`seed-demo --clean` 同样只删这些，**从来不会删主人写的内容**。
  → **别用「是否引用 `demo-` 实体」这个启发式替代字段**（会把真实记录误判成示例，反之亦然）。
- **⚠️ 读数据前先确认读的是哪个库**：`data/`、`.review/data`、`.review/recovery/`、`.review/*-run/` 下都有同名 `lifeos.sqlite`，**表结构可能不同**（老的没有 `is_demo` 列）。我曾因此把「`is_demo` 不存在」这个错误结论写进交接记录。
- **回收站（软删）分两类**，别混：
  - `is_demo=1` → 示例种子，走设置页按钮；要硬清用 `purge-trash-junk.mjs --demo`（**默认关闭**）。
  - `is_demo=0` → **混着历次 CDP/验收残留**，按内容签名清：`.review/purge-trash-junk.mjs`（dry-run 默认，`--apply` 才删；**认不出的行一律中止整轮**，且会先查 `relatedRecordIds` 引用）。
  - 09-18 两轮清完：105 条测试残留 + 283 条示例 → **软删 0**，`records 139`（121 示例 + 18 条主人的）始终没动。
- **备份退路要实测，别靠推断**：`backup_schedule.enabled=1` **不等于**备份能用。实跑 `POST /api/backup/dual`（脚本 `.review/verify-backup-path.mjs`）→ 本地 `data/backups/` + 上传桶 `cdnb`。
  「`backup_runs` 里没有今天的记录」也不说明坏了 —— 看 `last_run_key` / `nextRunAt`（每天 02:00）。
- **`VACUUM` / 大批量写之后，文件尺寸要在 `close()` 之后再量** —— WAL 模式里新内容还在 `-wal`，之前读到的还是旧值（踩过，差 24 万字节）。
- **搬 sqlite 必须先 `PRAGMA wal_checkpoint(TRUNCATE)`**。只复制 `.sqlite` 会**静默丢最新记录**（事故前主库 4096B、WAL 1.6MB；09-18 迁移时 WAL 370,832B）。**光看 `.sqlite` 大小会误判。**
- **迁移类改动必须全局搜路径引用** —— 而 **`.review/` 被 gitignore，`grep`/`rg` 默认不进这个目录**，只搜仓库会漏掉整个验收工具箱（09-18 就漏掉了 `restore-from-backup.mjs` 里的硬编码路径）。
- **沿革**：原名 `.review/run/data`，名字长得像临时目录，是它被误删的一半原因。09-18 晚迁到 `data/`（一次性脚本 `.review/migrate-data-dir.mjs`，默认 dry-run）。**别再在 `.review/` 下放生产数据。**
- **🔑 搬数据目录会打断密钥解密（09-18 踩过，我造成的）**：`weather/ai/movie/backup-config.ts` 的 AES 种子是
  `LIFEOS_<模块>_CONFIG_SECRET || LIFEOS_PASSWORD || \`lifeos-local-<模块>:${dataDirectory}\``。
  后两者都没设时**种子就是数据目录路径** → 一搬目录就换密钥 → **已存的 API key 静默解不开**（设置页只显示「未配置」，无任何报错）。当时天气 key 就这么丢了。
  → **`.env` 里 4 个 `LIFEOS_*_CONFIG_SECRET` 是故意钉成历史路径的，别删别改**（删了等于换密钥）。反查工具 `.review/find-weather-secret.mjs`；决定性探针 `.review/probe-weather-secret.mjs`。
  → `migrate-data-dir.mjs` 已有前置守卫：**种子没钉住就拒绝搬迁**（双向已验证）。**凡是动了数据目录 / `LIFEOS_PASSWORD`，回头看一眼 `/api/weather/status` 的 `hasKey`。**

## 演示数据坑

- **`seed-demo.mjs --clean` 只清理、不播种** → 刷新数据要跑**两次**。
- **数据会「过期出今天」**（种子按「相对今天」生成，预览用固定 data dir 不重播）→ 隔天「今天」没记录，`verify-timeline-card` 崩在 `Cannot read properties of undefined`，**像产品回归**。开工先确认「今天」有记录。
- **`clean()` 删不干净 demo 实体**（只删 `demo-` 前缀、不管关联）→ 残留被测试记录引用，重播报 409。彻底重置只能清 data dir（见上条警告）。

## 天气位置下拉：**已集成**（2026-09-18）

- 诉求原话：**「不应该用户输入什么城市，结果搜又搜不到」**。手输查不到**不是 bug 是接口性质**。
  → 正解 = **离线内置全量表 + 省/市/区三级下拉**：「搜不到」在**结构上**不可能发生，且不耗 API 配额。
- 文件：`apps/web/src/weather-locations.data.json`（**34 省 / 392 市 / 3572 位置**，155KB / gzip 29.5KB）+ `weather-locations.ts` + `weather-location-types.ts` + `WeatherLocationPicker.tsx`；
  `main.tsx` 的 `WeatherSettingsCard` 换掉两个手输框；`styles.css` 加 `.settings-weather-location*`；重编译器 `scripts/compile-weather-locations.mjs`。
- **`save()/test()/saveProfile()` 一字未动**。区县**选填**、市级 ID 恒有效；换上级**清空下级**；境外/旧 ID 有**默认折叠**逃生口（`unplaceable` 时自动展开）。
- 守卫：`verify-weather-locations-data.mjs` **33** / `verify-weather-locations.mjs` **30**（3572 全量往返无损）/ `verify-weather-location-picker.mjs` **53**（CDP 端到端）。
- **编译器三坑**（细节见 changelog）：① 城市自身行名 ≠ `adm2`（`哈尔滨` vs `哈尔滨市`）→ 初版 **377 个 ID 两级重复**；② 自治州**没有「全域」行**（延边州第一行是州府延吉）→ 拿 `districts[0]` 凑数会再重复；③ CSV 里台湾国家名含逗号 → 必须 RFC 4180。**只有「无重复 ID」断言能抓住 ①②。**

## 记录卡片与 grid（2026-09-17 主人裁定，已实现）

- **宽度是规则、只有高度随内容**。`.timeline-content` 用 `width: calc(3*5*1.617rem + 2*6px + 28px)`（428px）**加** `max-width: 100%`。
  **只给 `max-width` 是错的**（只封顶不撑开，没图的卡缩成 188~282px 六种宽）。**别改成撑满正文列**（主人否掉）。
- **图标选方案 B**：固定贴卡片右下角 → `.timeline-footer` 用 grid `minmax(0,1fr) max-content` + `.timeline-actions { grid-column: 2 }`。
- **grid 自动排布会「只在部分记录上错」**（没胶囊的记录里 `actions` 是唯一子项 → 进第 1 轨，第 2 轨塌成 `0px`）。
  → **要求几何恒定的元素一律显式定位**；媒体查询改单列时**同步释放** `grid-column`；第二轨用 `max-content` 不用 `auto`。
- **卡片皮肤挂无前缀 `.timeline-content`**，铺全部记录（曾只挂 `.review-timeline-grid` 下 = 「卡片化消失」根因）。
- 正文 `.timeline-text` **不自带 `max-width`**；关联胶囊在 `.timeline-footer` 内、需 `min-width: 0`。
- **双列已彻底删除，不要恢复**（认可版在 commit `0c25baa`；要恢复取 hunk，**别 checkout 整文件**）。**判别口诀：看元素计数，不看 changelog 自述。**
- 稳定钩子：`data-record-id` / `data-view`。背景数据：9 条里 7 条没图、正文平均 14 字 —— 428 是「六图」推出的。

## 天气天空

- 两根轴：`category`（来自 `iconDay`）决定**画什么**；`phase`（由真实日出/日落算）只决定**什么色、光在哪**（纯 CSS 变量替换，加时段不增节点/动画）。
- `WeatherHeader` 用 **`WeatherSky`** 交叉溶解：**旧层叠最上淡出、新层在下面就位**（两层各 0.8，反向叠会让中段被白底冲淡发灰）。spinner 由 `manualBusy` 驱动。
- **硬预算**（`verify-weather-art.mjs` 守）：每形态 ≤20 节点；只许动 `transform`/`opacity`；`filter` 只在 `cloud--far`/`fog-band`/`lightning-bolt`；`.weather-header *` 的 `backdrop-filter` 必须 0。
- `.weather-header-summary` 文字右缘在卡宽 **0.917** → 白蒙版在有文字处必须 ≥0.5 alpha。**放松蒙版前先量文字位置，别猜。**
- `cloudy` 分支在真实和风码表下**不可达**。

## 动画铁律：不许有「移动的细周期图案」（主人报障）

- 根因：雨幕 10px 周期条纹以 226px/s 平移 = **每秒 22.6 周期** + 两幕周期不同（拍频）+ 旋转重采样 → 摩尔纹。
- **「数学上无缝」≠「视觉上没问题」**：像素级无缝只解决接缝跳变，**解决不了 aliasing**。
- **要密度就用非周期或静态的**（雨线位置 `(index*97)%100` 步进互质）。**永不恢复移动的条纹幕布。**
- 同类风险：任何 `repeating-linear-gradient`/细网点/摩尔纹格，只要**在动**且周期小，先量。
- **量像素两前提**：① 只量**无文字带**；② `document.getAnimations().forEach(a=>a.pause())` 确定化。探针 `.review/probe-sheet-moire.mjs`。

## 布局稳定性

1. **`animation-fill-mode` 默认 `none`，正 `animation-delay` 期间按「基准样式」渲染**，不是隐藏等待。
   → 飞入元素的**基准位置本身必须在屏幕外**（只把关键帧起点写外面不够）；更好是**用负延迟**。
2. **滚动条出现/消失会让整页横向抽动** → `html { scrollbar-gutter: stable; }`（已加）。
   **`documentElement.clientWidth` 是误导性指标** → 判据用 `scrollWidth` + 元素实际矩形。**探针不能传 `--hide-scrollbars`**。
3. **CSS 高度动画：`auto` 不可插值** → 从 `auto` 过渡会**瞬移**，先读 `getBoundingClientRect().height` 钉一帧；结束交还 `auto`。
   **React 两次 setState 会被批处理进同一帧** → 不触发 transition → 硬切（**竞态，可能碰巧通过**）。
   正解：`useLayoutEffect` + **直接写 `element.style.height`** + 两次写入间 `void el.offsetHeight` 强制回流。
   **编辑器类容器不能长期 `overflow:hidden`**（日期面板、提及列表绝对定位挂在里面）。

## 验收方法论

- **瞬态缺陷必须在「过程中」高频采样**。「切换前后一致」≠「过程中一致」：位移发生在**中间**、结束时回到原值，**两头采样必然漏掉**。
- **改全局 CSS 要扩大回归面**（`html` 一行影响全应用布局宽度 → 补跑 composer 脚本）。
- **`transform` 不改变布局盒宽** → **光看页面级溢出会漏掉泄漏**；要逐元素对容器边界断言。旋转/变换元素**画出来比布局盒宽** → 预留 overhang。
- 跑 CDP 切视口，**量不同形态前记得 `Emulation.clearDeviceMetricsOverride`**（曾致 5 项假 FAIL）。
- **日期夹具一律动态推导**（硬编码日期午夜静默失效，失败形态像产品回归）。**已知未修**：`verify-weather-device.mjs`、`verify-weather.mjs`。
- **崩溃必须变成 FAIL**：脚本抛错退出时结果文件会留着上次的 `RESULT: PASS`（只代表「没跑到失败那步」）。**看到 PASS 先确认断言条数是否符合预期。**
- **CDP 自动化三坑**：① React 受控 `<select>` 必须用 `HTMLSelectElement.prototype` 的**原生 value setter** 再 `dispatchEvent(new Event("change",{bubbles:true}))`（直接 `el.value=` 被 value tracker 吃掉）；② **`Page.navigate` 到完全相同的 URL 不可靠**（SPA）→ 用 `Page.reload {ignoreCache:true}`；③ 改夹具前先确认**没有更高优先级的设备级覆盖**，并加「夹具已生效」前置断言。
- **`verify-settings-ai.mjs` 有 8 项长期 FAIL 属已知老问题**（窄控件全归「备份」卡片；把天气卡片 `display:none` 后计数完全不变）。**别当新回归去修。**

## 样式对齐与协作习惯

- 两个状态的控件几何一致，**复用同一套 class**，别抄数值。图标宽度也算进按钮宽。
- **同名 class 覆盖必须带父级前缀**（`.kind-switcher` 自带 margin，会顶掉同优先级 `margin: 0`）。
- **几何对比要在「主人实际看到的状态」下量**（展开态可能改掉 `border-width` → 报 1px 假差异）。
- **补记条 = 安慰剂**（主人原话）：**整条是一个点击目标**；子控件都是 `aria-hidden` 的 span（断言 `barNestedControls === 0`）。「补记」与「保存」是**同一动作的两个阶段**，别加真实行为。
- **回看**：过去日期达 4 条且桌面够宽时，按**预计卡片高度**放下一条到较短列；真实图片加载后只更新 SVG 回环线、不重新分列。回看输入框默认简约、点击才展开 Composer；今天保持正式 Composer。
- **不出截图**（主人明确要求，已写进 `AGENTS.md`）：不生成截图、不在回复里贴图。收尾只汇报：改了什么 / 怎么验证 / 验收数字 / 预览地址。
- **改动前先勘察、先问**：设计/规则类先出方案等确认；主人说「听你的」才是授权点。
