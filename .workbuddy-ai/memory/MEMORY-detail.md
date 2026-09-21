# LifeOS 记忆详情（按需阅读，不自动注入）

> 本文件是 `MEMORY.md` 的展开版：规则速查在 `MEMORY.md`，这里放「为什么」与实例。
> 规则全文见 `AGENTS.md`，改动记录见 `docs/changelog.md`。

## 环境

- **预览常开**：`.review/accept-serve.mjs` → API 3011 + Web 5199，主人随时开 `http://127.0.0.1:5199/`。
  **收尾不要杀**（曾误杀被纠正）；端口固定。主人的端口（3001）**永不杀**。该收的只有带隔离 data dir 的（`photo-grid-serve.mjs`）和临时 Chrome。
- **沙箱在 turn 结束时回收它**：`nohup`/`detached+unref`/`run_in_background` 都活不过 turn 边界。
  → **开工先探端口**（3011 `/api/health` + 5199），不在就用 `.review/spawn-serve.mjs` 拉起。
- **验收脚本前置失败会覆盖上次结果**（`RESULT: PASS (189)` 被冲成 2 行）→ 跑前先确认预览在线。
- **bash 是残缺 PortableGit**：`ls/cat/head/grep/find` 不存在 → 用 `node -e` 或内置工具。
  npm 用 `"C:/Program Files/nodejs/node.exe" "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js"` 直调。
- **Node 必须用 `C:\Program Files\nodejs`（24.x）**；managed 22.x 不支持 `--test-isolation=none`。
- **`node -e` 写含反引号的文本必炸**（反引号被 shell 先吃）→ 长文本先 `Write` 成 `.md` 再 `fs.appendFileSync`。
- **按天对账**一律 `Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(...)`；UTC `slice(0,10)` 跨午夜归错天（已踩两次）。
- **42 格月历第一格 = 含 1 号那周的周一**，不是 1 号。

## 磁盘：测试失败先 `df -h /c`

- **症状伪装成产品回归**：`database or disk is full` / `ENOSPC`，实际是 C 盘满。
- **根因不是"忘写清理"，是顺序**：`browser.kill()` 异步返回，紧随的 `rmSync` 在 Chrome 还活着时执行 → Windows 句柄被占 → EBUSY → 被裸 `catch {}` 吞掉。
  → **「有清理调用」≠「清理成功」**；只 grep `rmSync` 在不在会得出「0 泄漏」假结论（09-17 误判一次，09-18 又积 92 个 / 2.11GB）。
- **修法必须是同步强杀**（清理块多在 `finish = () => {…}` / `process.on("exit")` 里，`await` 非法）：
  `.review/reap-chrome.mjs` 的 `reapChromeSync`（`taskkill /F /T /PID` → 重试删除）/ `reapChrome` / `sweepStaleProfiles`，**新脚本一律用它**；
  `.review/sweep-profiles.mjs` 随时清扫；`.review/codemod-reap.mjs` 批量改写器（严格匹配 + `node --check` + 失败回滚）。
- **⚠️ 动 `.review/run/data` 前先备份 `weather-config.json`**：天气 key+位置存在 `<dataDirectory>/weather-config.json`（`weather-config.ts:70`），**不在 `.env`、不在 git、无副本**。09-18 误删过一次。

## 演示数据坑

- **`seed-demo.mjs --clean` 只清理、不播种** → 刷新数据要跑**两次**。
- **数据会「过期出今天」**：种子按「相对今天」生成，预览却用**固定 data dir、不重启不重播** → 隔天「今天」没记录，`verify-timeline-card` 崩在 `Cannot read properties of undefined`，**像产品回归**。开工先确认「今天」有记录。
- **`clean()` 删不干净 demo 实体**（只删 `demo-` 前缀、不管关联）→ 残留实体被测试记录引用，重播报 409。彻底重置只能清 data dir（见上条警告）。

## 天气位置下拉：**已集成**（2026-09-18）

- 诉求原话：**「不应该用户输入什么城市，结果搜又搜不到」**。手输城市查不到**不是 bug 是接口性质**（和风 `city/lookup` 只认自己地名库）。
  → 正解 = **离线内置全量表 + 省/市/区三级下拉**：「搜不到」在**结构上**不可能发生，且不耗 API 配额。
- 文件：`apps/web/src/weather-locations.data.json`（**34 省 / 392 市 / 3572 位置**，raw 155KB / gzip 29.5KB）+ `weather-locations.ts` + `weather-location-types.ts` + `WeatherLocationPicker.tsx`；
  `main.tsx` 的 `WeatherSettingsCard` 换掉两个手输框；`styles.css` 加 `.settings-weather-location*`；重编译器 `scripts/compile-weather-locations.mjs`。
- **`save()/test()/saveProfile()` 一字未动**。区县**选填**、市级 ID 恒有效；换上级**清空下级**；境外/旧 ID 有**默认折叠**逃生口，`unplaceable` 时自动展开。
- 守卫：`verify-weather-locations-data.mjs` **33** / `verify-weather-locations.mjs` **30**（3572 全量往返无损）/ `verify-weather-location-picker.mjs` **53**（CDP 端到端）。
- **编译器三坑**（细节见 changelog）：① 城市自身行名 ≠ `adm2`（`哈尔滨` vs `哈尔滨市`）→ 初版 **377 个 ID 两级重复**；② 自治州**没有「全域」行**（延边州第一行是州府延吉）→ 拿 `districts[0]` 凑数会再重复（修法：优先找名字等于州名的行，否则用州府 + 从区级移除 + `seatOnly:true`）；③ CSV 里台湾国家名含逗号 → `split(",")` 整体错位，必须 RFC 4180。
  → **只有「无重复 ID」断言能抓住 ①②，肉眼抽查全会通过。**

## 记录卡片与 grid（2026-09-17 主人裁定，已实现）

- **宽度是规则、只有高度随内容**（原话：「哪怕是一行字，你也是这个宽度，但是高度是可以随机应变的」）。
  `.timeline-content` 用 `width: calc(3*5*1.617rem + 2*6px + 28px)`（428px）**加** `max-width: 100%`。
  **只给 `max-width` 是错的**（只封顶不撑开，没图的卡缩成 188~282px 六种宽）。**别改成撑满正文列**（669px 时六图右侧空 227px，主人否掉）。
- **图标选方案 B**：固定贴卡片右下角（不跟内容走）→ `.timeline-footer` 用 grid `minmax(0,1fr) max-content` + `.timeline-actions { grid-column: 2 }`。
- **grid 自动排布会「只在部分记录上错」**：没胶囊的记录里 `actions` 是唯一子项 → 进第 1 轨，第 2 轨塌成 `0px` → 比卡片角差 8px。
  → **要求几何恒定的元素一律显式定位**；媒体查询改单列时**同步释放** `grid-column`（否则建隐式第三轨）；第二轨用 `max-content` 不用 `auto`。
- **卡片皮肤挂无前缀 `.timeline-content`**，铺全部记录（曾只挂 `.review-timeline-grid` 下 → 双列一拆皮肤就没了 = 「卡片化消失」根因）。
- 正文 `.timeline-text` **不自带 `max-width`**（卡即行宽）；关联胶囊在 `.timeline-footer` 内、需 `min-width: 0`。
- **双列已彻底删除，不要恢复**。主人认可的「卡片化+双列」在 commit `0c25baa`；opencode 的**未提交**改动删了整套，changelog 却自称「分列不动」= **自述与交付不符**。要恢复从 `0c25baa` 取 hunk，**别 checkout 整文件**。**判别口诀：看元素计数，不看 changelog 自述。**
- 稳定钩子：时间轴项 `data-record-id`、section `data-view`。**背景数据**：9 条里 7 条没图、正文平均 14 字 —— 428 是「六图」推出的，不代表常态。

## 天气天空

- `WeatherBackground` 两根轴：`category`（来自 `iconDay`）决定**画什么**；`phase`（由真实日出/日落算）只决定**什么色、光在哪** —— 纯 CSS 变量替换，加时段不增节点/动画。
- `WeatherHeader` 用 **`WeatherSky`**（`shown`/`outgoing` 交叉溶解）：**旧层叠最上淡出、新层在下面就位**（两层各 0.8，反向叠会让中段被白底冲淡发灰）。刷新 spinner 由 `manualBusy` 驱动。
- **硬预算**（`verify-weather-art.mjs` 守）：每形态 ≤20 节点；只许动 `transform`/`opacity`；`filter` 只在 `cloud--far`/`fog-band`/`lightning-bolt`；`.weather-header *` 的 `backdrop-filter` 必须 0。
- `.weather-header-summary` 是 `margin-left:auto`，文字右缘在卡宽 **0.917** → 白蒙版在有文字处必须 ≥0.5 alpha。**放松蒙版前先量文字位置，别猜。**
- `cloudy` 分支在真实和风码表下**不可达**（101/102/103/151/152/153→`partly-cloudy`；104/154→`overcast`）。

## 动画铁律：不许有「移动的细周期图案」（主人报障）

- **症状**：雷阵雨表头「很重的摩尔纹，晃眼睛」。根因：雨幕 10px 周期条纹以 226px/s 平移 = **每秒 22.6 周期**，两幕周期还不同（拍频）+ 14° 旋转重采样。
- **「数学上无缝」≠「视觉上没问题」**：像素级无缝只解决接缝跳变，**解决不了 aliasing**。
- **要密度就用非周期或静态的**：雨线位置 `(index*97)%100` 步进互质 → 非周期；或用**静态**纹理。**永不恢复移动的条纹幕布。**
- 同类风险：任何 `repeating-linear-gradient`/细网点/摩尔纹格，只要**在动**且周期小，先量。
- **量像素两前提**：① 只量**无文字带**（文字边缘高频能量远大于任何图层）；② `document.getAnimations().forEach(a=>a.pause())` 确定化。探针 `.review/probe-sheet-moire.mjs`。

## 布局稳定性

1. **`animation-fill-mode` 默认 `none`，正 `animation-delay` 期间按「基准样式」渲染**，不是隐藏等待。
   → 飞入元素的**基准位置本身必须在屏幕外**（只把关键帧起点写外面不够）；更好是**用负延迟**。
2. **文档级滚动条出现/消失会让整页横向抽动**（视口宽 15px → 居中列移 7.5px）→ `html { scrollbar-gutter: stable; }`（已加）。
   **`documentElement.clientWidth` 是误导性指标**（不可滚动时反而报更大，1680 vs 1665）→ 判据用 `scrollWidth` + 元素实际矩形。
   **探针不能传 `--hide-scrollbars`** —— 隐藏滚动条就是隐藏病因。
3. **CSS 高度动画：`auto` 不可插值** → 从 `auto` 过渡会**瞬移**，先读 `getBoundingClientRect().height` 钉一帧再设目标值；结束交还 `auto`。
   **React 两次 setState 会被批处理进同一帧** → 只看到一次变化 → 不触发 transition → 硬切（**竞态，可能碰巧通过**）。
   正解：`useLayoutEffect` + **直接写 `element.style.height`** + 两次写入间 `void el.offsetHeight` 强制回流。
   **编辑器类容器不能长期 `overflow:hidden`**（日期面板、提及列表绝对定位挂在里面，裁切只在过渡期间存在）。

## 验收方法论

- **瞬态缺陷必须在「过程中」高频采样**。「切换前后一致」≠「过程中一致」：位移发生在**中间**、结束时回到原值，**两头采样必然漏掉**。
- **改全局 CSS 要扩大回归面**：`html` 一行影响全应用布局宽度 → 补跑 composer 脚本。
- **`transform` 不改变布局盒宽**：`translateX` 叠压时布局总宽仍是「N 个元素宽」，会溢出容器；而 `documentElement` 横向溢出可能是 0（页面够宽吃掉）→ **光看页面级溢出会漏掉泄漏**。要用负 margin 参与布局 + 逐元素对容器边界断言。旋转/变换元素**画出来比布局盒宽**（`w·|cos|+h·|sin|`）→ 预留 overhang。
- 跑 CDP 切视口，**量不同形态前记得 `Emulation.clearDeviceMetricsOverride`**（曾致 5 项假 FAIL）。
- **日期夹具一律动态推导**（硬编码日期午夜静默失效，失败形态像产品回归）。**已知未修**：`verify-weather-device.mjs`（写死 09-14/09-15）；`verify-weather.mjs`（靠 `snapshot.today` 兜底，绿得侥幸）。
- **崩溃必须变成 FAIL**：脚本抛错退出时结果文件会留着上次的 `RESULT: PASS`（只代表「没跑到失败那步」）。`verify-review-mode.mjs` 已加 `uncaughtException`/`unhandledRejection` → `CRASH` + 退出 1；**其它脚本没这层保护，看到 PASS 先确认断言条数**。
- **CDP 自动化三坑**：① React 受控 `<select>` 必须用 `HTMLSelectElement.prototype` 的**原生 value setter** 再 `dispatchEvent(new Event("change",{bubbles:true}))`（直接 `el.value=` 被 value tracker 吃掉）；② **`Page.navigate` 到完全相同的 URL 不可靠**（SPA 侧栏不改地址）→ 用 `Page.reload {ignoreCache:true}`；③ 改夹具前先确认**没有更高优先级的设备级覆盖**，并加「夹具已生效」前置断言把责任分清。
- **`verify-settings-ai.mjs` 有 8 项长期 FAIL 属已知老问题**：窄控件全归「备份」卡片（`backup-calendar-day` 42 个日期按钮 `min-height:44px` + 两个 64px 紧凑 select），把天气卡片 `display:none` 后计数完全不变。**别当新回归去修。**

## 样式对齐与协作习惯

- 两个状态的控件几何一致，**复用同一套 class**，别抄数值。图标宽度也算进按钮宽。
- **同名 class 覆盖必须带父级前缀**：`.kind-switcher` 自带 `margin: 22px 0 12px`，会顶掉后写的同优先级 `margin: 0` → 写 `.review-composer-bar .review-composer-kinds` 才生效。
- **几何对比要在「主人实际看到的状态」下量**：展开态可能改掉 `border-width` → 报 1px 假差异。
- **补记条 = 安慰剂**（主人原话）：**整条是一个点击目标**；kind 标签/草稿预览/「补记」按钮都是 `aria-hidden` 的 span（断言 `barNestedControls === 0`）。「补记」与「保存」是**同一动作的两个阶段**，别加真实行为。
- **回看**：过去日期达 4 条且桌面够宽时，按**预计卡片高度**放下一条到较短列（不严格交替）；真实图片加载后只更新 SVG 回环线、不重新分列，避免卡片跳动。回看输入框默认简约、点击才展开 Composer；今天保持正式 Composer。
- **不出截图**（主人明确要求，已写进 `AGENTS.md`）：不生成截图、不在回复里贴图。收尾只汇报：改了什么 / 怎么验证 / 验收数字 / 预览地址。
- **改动前先勘察、先问**：设计/规则类先出方案等确认；主人说「听你的」才是授权点。只读勘察很有价值（「照片上限 6→9」先查明 6 只存在于 Web 端一个常量，才敢只动一处）。

## 数据安全：`data/` 是生产库（2026-09-18 事故详情）

**事故**：我把它当「预览用的、含种子数据的独立目录」重置了（为修「今天没有记录」），
删掉 **527 条记录 / 149 个 assets / 52 个实体 / 54 天摘要**。主人当晚发现 09-16 起自己发的（含照片）全没了。
当天日志里那 **121 次 `DELETE /api/records`** 就是这次重置。

**为什么我会误判**：`AGENTS.md` 写「预览用独立 data dir（含种子数据）」、`accept-serve.mjs` 的注释也这么说。
**但事实是主人一直把预览 5199 当自己的应用在用。** 文档与事实不符 —— 这是根因。

**怎么救回来的**：`.env` 配了缤纷云 S3（`BACKUP_S3_*`，桶 `cdnb`，前缀 `product-backup/lifeos`），
**应用自己会定时把数据库快照上传**（这就是 `AGENTS.md` 里「对象存储备份」那个模块）。
桶里 09-15 ~ 09-18 共 12 份快照，取 **09-18 08:42（重置前约 9 小时）那份 1.0MB**。
老的快照被保留策略挪到 `product-backup/lifeos-trash/`，**同样可恢复**。

**恢复动作**（`.review/restore-from-backup.mjs` 已把流程固化）：
1. 停 API（SQLite 被进程持有句柄）—— `netstat -ano` 找 PID → 找父 launcher → `taskkill /F /T /PID`；
2. 删 `lifeos.sqlite-wal` / `lifeos.sqlite-shm`（**不删的话旧 WAL 会盖回新库**）；
3. 装快照为 `lifeos.sqlite`；
4. **保留** `weather-config.json`（里面有 QWeather key）与 `ai-config.json`；
5. 重新拉起预览，`GET /api/records` 复验。

**资产文件从未丢**：照片在 `LIFEOS_ASSET_ROOT`（预览 = `pic-test/`），`uploads/2026/09/` 里 09-16 那天有 186 个文件。
被 live 真实记录引用的 **61 个 asset 全部命中磁盘，缺失 0**。**快照只备份数据库，不含资产** —— 所以真正的数据保护必须两样都有。

**怎么区分「示例」和「真实」**：`AGENTS.md` 说的 `isDemo` 字段**根本不存在**（527 条记录里一个都没有，`body_json` 只有 `original`/`edited`）。
可靠判别 = **`entity_refs_json` 是否引用 `demo-` 前缀实体**（52 个实体中 43 个是 `demo-`）。
用它分类：**154 条真实 / 373 条示例**，主人已知内容（「豆干」「霸王别姬」「生椰拿铁」「TIBO」「随寓」）全部落在真实组。
**教训：别信文档，去读数据。**

**另一个误判陷阱**：事故前主库 `lifeos.sqlite` 只有 4096 字节，`-wal` 却有 1.6MB。
**光看 `.sqlite` 大小会得出「里面没东西」的错误结论。**

## 更正：`is_demo` 是存在的（我上一轮写错了）

**上一轮的结论错了**：我写了「`AGENTS.md` 说的 `isDemo` 字段实际不存在，527 条记录里一个都没有」—— **`AGENTS.md` 是对的**。

**错在哪**：我查 schema 时查的是 **`.review/data/lifeos.sqlite`**（一份 09-12 的旧演示库，表结构**早于**该列），又去 `body_json` 里找 `isDemo` 键。**两个都不是目标库。**

**事实**：快照与活库的 `records` 表都有 **`is_demo`**，另有 `is_private` / `is_backfill` / `weather_json`；
`repository.ts:506` 还有自动迁移（缺列时 `ALTER TABLE records ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0`）。

**正确数字**：527 条 = **404 条 `is_demo=1`** + 123 条 `is_demo=0`；清掉测试残留后现存 **139 条 = 121 示例 + 18 条主人写的**。
上一轮「154 条真实 / 373 条示例」是用「是否引用 `demo-` 实体」启发式估的，**不准**。

**教训升级**：上一轮我说「别信文档，去读数据」；真正的教训是「**读数据之前先确认读的是哪个库**」——
`.review/data`、`.review/run/data`、`.review/recovery/`、`.review/*-run/` 下都有同名 `lifeos.sqlite`，**表结构可能不同**。

## 示例 / 真实的分野与「一次性清掉示例」

- **标记**：`records.is_demo`（持久化列，正文里看不到任何前缀 = 隐形）；示例实体/资产的 id 带 `demo-` 前缀。
- **清示例的入口已经有了**：设置页「隐藏预置记录」/「删除预置记录」（`main.tsx:3595`，4 秒内二次确认；只删 `isDemo` 记录 + `demo-` 对象；toast「预置记录已删除，你写的内容不受影响」）。
- `seed-demo.mjs` 的 `clean()` 也只删这些 —— **09-18 毁数据的是「删掉整个数据目录」，不是 `--clean`**。
- **测试残留是 `is_demo=0`**，会混进真实记录里，清示例的按钮**不会**碰它们。只能按内容签名清：`.review/purge-test-junk.mjs`（`--apply` 才动手；先查 `relatedRecordIds` 引用，被引用就停下）。本次清掉 14 条（9 条日期写成 2036-09-15、4 条 `今天想聊电影 <ts>`、1 条同类）。
- `repository.ts:572` 有一段把旧库「`【示例】` 前缀」记录迁移成 `is_demo=1` 的逻辑 —— 以后改示例文本时注意别让迁移正则误伤主人内容。

## 「不可再丢弃」是怎么钉住的

1. `data/DO-NOT-DELETE.md` —— 目录内标记，任何人 ls 就能看到。（原在 `.review/run/data/`，09-18 晚随数据一起搬到 `data/`。）
2. `.review/data-inventory.mjs` —— 只读清点；**有主人写的记录就 `exit 1`**，可做破坏性操作的前置闸门。
3. `AGENTS.md` 项目概览里一整条 ⚠️ 说明 + 写准「预置记录」那条。
4. `.review/accept-serve.mjs` 头部注释 —— 原文「starts a **throwaway** API on 3011 (its own data dir)」**就是本次事故的根源**，已改成明确警告。

---

## 数据目录迁移到 `data/`（2026-09-18 晚，主人批准）

### 为什么搬

`.review/` 是 gitignore 的草稿区，`.review/run/data` 这个名字**本身就长得像临时目录** —— 那是 09-18 事故的一半原因。
而 `data/` 是 **API 自己的默认数据目录**（`apps/api/src/config.ts:108`）：

```ts
const dataDirectory = resolve(env.LIFEOS_DATA_DIR?.trim() || "data");
```

`.gitignore` 里早就有一行 `data/`。搬到那儿之后：
- `npm run dev` / `npm start` **什么都不配**读的就是主人的数据 —— 语义是「这是应用的数据」，不是「这是某次预览的产物」；
- 位置不再暗示「可丢弃」。

**现状**：3011 预览 API 的 `LIFEOS_DATA_DIR` 显式指向 `data/`，主人的 5199 也就跟着读同一份。

### 迁移步骤（`.review/migrate-data-dir.mjs`，dry-run 默认，`--apply` 才动）

1. **前置**：3011/5199 都不能有监听（API 持有 sqlite 句柄，边跑边搬会半途失败）。
2. **`PRAGMA wal_checkpoint(TRUNCATE)`** —— **这一步不能省**。本次 `-wal` 有 370,832 字节；只复制 `.sqlite` 会**静默丢掉最新记录**。checkpoint 后 `-wal` 归零，主库自洽。
3. **字节级备份**：整目录复制到 `.review/recovery/pre-move-<戳>/`，比文件数 + 总字节数，不一致就中止。
4. **归档陈旧 `data/`**：仓库里那份 4 条记录、**没有 `is_demo` 列**的旧 schema 库，先复制到 `.review/recovery/superseded-data-<戳>/` **再**删。不是直接抹掉。
5. **`renameSync`** 搬迁。
6. **七项对账**：`total / live / demo / mine / trash / assets / entities` 必须逐项与搬迁前一致。

实测：`527 / 139 / 121 / 18 / 388 / 149 / 52` 全一致。

### 迁移时必须一起改的引用

| 文件 | 改什么 |
| --- | --- |
| `.review/accept-serve.mjs` | `LIFEOS_DATA_DIR` → `resolve(root, "data")` |
| `.review/accept-serve.mjs` | **伪桶兜底路径** `<outDir>/data/object-storage` → `<outDir>/object-storage` |
| `.review/data-inventory.mjs` | `DATA_DIR` |
| **`.review/restore-from-backup.mjs`** | **`DATA_DIR` 是硬编码的** —— 不改就恢复到旧位置 |
| `AGENTS.md` | 项目概览里那条 ⚠️ |
| `data/DO-NOT-DELETE.md` | 目录内标记 |

### 踩到的坑

1. **守卫不能一刀切**：我最初写「目标目录已有活库就拒绝」，用 `live > 0` 判断 —— 陈旧 `data/` 没有 `is_demo` 列，4 条未删记录被算成 live，**把自己拦下来了**。正解是**先判 legacy schema**（没有 `is_demo` 列 = 早于应用运行过，可安全归档）。
2. **伪桶兜底路径会复活旧目录**：它原本指向 `<数据目录>/object-storage`。数据目录一改，就会在 `.review/run/` 下新建一个 `data/`，把刚拆掉的误会重新装回去。（`.env` 里配了真 S3，这条分支当前不生效 —— 但谁清空 `.env` 就会踩。）
3. **`.review/` 被 gitignore，`grep` / `rg` 默认不进这个目录**。只搜仓库会漏掉**整个验收工具箱**。本次靠手写 `walk` 才捞出 `restore-from-backup.mjs` 的硬编码路径。**迁移类改动必须显式搜 `.review/`。**

### 回收站清理（`.review/purge-trash-junk.mjs`）

388 条软删 = **283 条 `is_demo=1`**（示例种子，**没动** —— 那是应用的另一个范畴，设置页有专门按钮）+ **105 条 `is_demo=0`**。

105 条逐条看过，**没有一条是主人写的**，全是历次 CDP/验收夹具：
45 `验收：照片和文字一起保存（可删）` / 15 `@测试客户` / 9 `这是一个专门验证月历两行摘要…` / 8 `CDP 补记验收 <ts>` / 8 `验收：最近使用地点排序 半山咖啡（可删）` / 6 `#新咖啡馆` / 4 `隐私验收 privacy-verify-<ts>` / 4 `今天想聊电影|也想聊电影 <ts>` / 5 `#测试顾客`+`##测试客户`+`#测试客户`。

**脚本的核心约束**：这 105 条必须**全部**匹配到已知签名，**有一条认不出来就中止整轮**。
「我认不出它」绝不能等同于「它是垃圾」—— 认不出的行按主人的算，不动。
另外先查 `relatedRecordIds`：0 条被活记录引用。

删前快照 `.review/recovery/pre-purge-2026-09-18T13-47-10-883.sqlite`。
结果：`records 527 → 422`，`live 139`（18 条主人的）**一条没动**，软删 388 → 283。

### 隔离语义变了（重要）

3011/5199 **现在直接指向生产库**。以前它们指向 `.review/run/data`，同样是生产库 —— 但那时至少「看起来像临时目录」会让人多一分犹豫。
现在**跑会产生记录的验收会污染主人的数据**（清掉的那 105 条就是这么来的）。
→ 要验收请**另开 `LIFEOS_DATA_DIR`**，`.review/verify-*.mjs` 本来就是这么做的。

---

## 🔑 搬数据目录会打断密钥解密（09-18 我自己造成的回归）

### 机制

`weather-config.ts:75`（以及 `ai-config.ts:42` / `movie-config.ts:37` / `backup-config.ts:38`，各自盐不同）：

```ts
const secret = process.env.LIFEOS_<模块>_CONFIG_SECRET?.trim()
            || process.env.LIFEOS_PASSWORD
            || `lifeos-local-<模块>:${config.dataDirectory}`;
return scryptSync(secret, "lifeos-<模块>-config-v1", 32);
```

**当两个环境变量都没设时，加密种子就是数据目录路径本身。**
所以把 `.review/run/data` 搬成 `data/` = **换了一把钥匙** → 已存的天气 API key 再也解不开。

### 症状（为什么差点漏掉）

- `/api/weather/status` → `hasKey:false / configured:false / source:"none"`，**没有任何报错、没有日志**。
- 密文还好端端躺在 `weather-config.json` 里，长度也没变 —— 只是 `decrypt()` 里 GCM 校验失败被 `catch { return undefined }` 吞了。
- 唯一的表现是**设置页显示「未配置」**。
- 我是在收尾复验时多打了一眼 `hasKey` 才发现的。

**规则：凡是动了数据目录 / `LIFEOS_PASSWORD`，回头看一眼 `/api/weather/status` 的 `hasKey`。**

### 怎么定位的（方法可复用）

1. **先穷举，别急着下结论**。离线试了 7 个路径候选，全失败 → 差点得出「不是路径派生」的错误结论。
   **失败原因是我用 `node -e` 内联脚本，bash 双引号把 `\\\\` 折成 `\\`，候选串写坏了。** 改成写文件、用 node 自己的 `resolve()` 算候选 → 一次命中。
   → **教训：涉及反斜杠的字符串比较，一律写成脚本文件，别走 `node -e`。**
2. **决定性实验**：`.review/probe-weather-secret.mjs` —— 用 pre-move 快照的副本**把原路径原样重建**，同一份密文跑独立 API（3099）。
   原路径 `hasKey:true`、新路径 `false` → **同一份密文只差路径，证明就是路径派生**。
   探针自带清理；`LIFEOS_ASSET_ROOT` 指向空目录（**第二个 API 实例开机就跑孤儿资源回收，绝不能让它走主人的 `pic-test/`**）、`BACKUP_S3_ENABLED=false`（**别让探针往真桶里写快照**）。
3. **反查种子**：`.review/find-weather-secret.mjs` —— 拿密文反推种子串，只打印长度不打印明文。三个密文全部命中同一个串。

### 修复

在 `.env` 里把 4 个种子**钉成搬迁前那个目录派生出来的值**（形状如下，**真实值只在 `.env` 里，不要抄进本文件**）：

```
LIFEOS_WEATHER_CONFIG_SECRET='lifeos-local-weather:<搬迁前的数据目录>'
LIFEOS_AI_CONFIG_SECRET='lifeos-local-ai:<搬迁前的数据目录>'
LIFEOS_MOVIE_CONFIG_SECRET='lifeos-local-movie:<搬迁前的数据目录>'
LIFEOS_BACKUP_CONFIG_SECRET='lifeos-local-backup:<搬迁前的数据目录>'
```

> **⚠️ 2026-09-18 22:58 补记**：这一节原先**写的是天气那个种子的真实明文**，而 `.workbuddy-ai/memory/` 是**被 git 跟踪的** —— 差点随 45 个提交推上 GitHub。
> 已改成占位符。**记忆文件是公开的，`.env` 不是。凡是「密钥」类内容，这里只写形状与来源，绝不写值。**

- 选「钉历史路径」而不是「换新密钥 + 重新加密」：**零写入数据文件、零风险弄坏密文**，且种子仍可由那个串**推导**出来（`.env` 万一丢了还能救）。
- 影响面其实只有天气一个（`ai-config.json` 没有密文字段，movie/backup 配置文件不存在），但**四个一起钉**，因为下一个给它们存 key 的人会踩同一个坑。
- **`.env` 里带反斜杠和冒号的值**：实测 node `--env-file` 对不加引号 / 单引号 / 双引号三种写法解析一致，本文件用单引号。

### 守卫

`migrate-data-dir.mjs` 加了前置检查：**4 个种子没钉住就拒绝搬迁**。
顺序上放在**端口检查之前** —— 配置问题该先暴露，不该先让人白停一次服务。
**双向验证过**：`.env` 在位 → 放行；临时藏起 `.env` → 拒绝并列出变量名。

### 附带教训

`.env` 第 19-21 行**早就写了这个坑**（「一旦改了数据目录或密码，已保存的密钥就会静默解不开，建议显式设一个」），但那行是**注释状态**，谁都没设。
→ **项目里那些「建议显式设一个」的注释，是前人踩过的坑，不是可选装饰。**

---

## 生产守卫：两次踩坑的完整过程（2026-09-18 晚）

### 为什么要加

上一轮只做了「看得见」的改动（审计清单 + 启动横幅 + AGENTS.md 规则），理由是「15 个目标里 13 个 import `reap-chrome.mjs`，只读脚本也 import 它 → 不是干净改动点」。
主人回「请继续执行任务」→ 我把守卫加上（改用**逐个文件插 import**，不动 `reap-chrome.mjs`）。
**「有清理调用」≠「清理成功」的同类：有规则 ≠ 有拦截。文档拦不住已经决定要跑脚本的人。**

### 第一版守卫的洞（`verify-production-guard.mjs` 自己抓出来的）

`/api/backup/status` 的 `localDirectory` 返回的是 **`<dataDirectory>/backups`**，是数据目录的**子目录**，不是数据目录本身。
我最初写 `normalized === PRODUCTION_NORMALIZED` → **永不成立** → 守卫形同虚设。
→ 改成 `insideProductionData()`：等于自身 **或** 以 `生产路径 + sep` 开头。
→ 而且「应答了但报不出数据目录」要 **fail-closed 当生产**。

### 🔴 我自己污染了生产库（139 → 140）

给守卫加了「显式目标端口」优化后，我用
`LIFEOS_BASE_URL="http://127.0.0.1:3999" node .review/verify-calendar.mjs`
验证「指向隔离实例时应该放行」。

**结果放行了，而且写进了一条真实记录。** 因为：

```js
// verify-calendar.mjs 第 6 行
const BASE = (process.argv[2] ?? "http://127.0.0.1:3011").replace(/\/$/, "");
```

**它根本不读 `LIFEOS_BASE_URL`。** 守卫以为目标是 3999（隔离），脚本实际连的是 3011（生产）。
污染记录：`bc0717b9-…`，正文「这是一个专门验证月历两行摘要最后需要使用两个英文句点截断的长文本内容」，`occurred 2036-09-15`。

**教训：安全闸门不能相信它验证不了的线索。** 「环境变量声称目标是隔离实例」不是证据。

### 第二版：显式目标必须被「入口脚本源码真的读它」佐证

```js
const entrySource = entryScriptSource();          // process.argv[1]
const entryCode = stripComments(entrySource);     // 先剥注释
const originIsHonored = originVar !== null && originValue !== ""
  && entryCode !== null && entryCode.includes(originVar);
```

两条同时成立才采信：① 该端口真应答且报出非生产数据目录；② 入口脚本源码里真的读了这个变量。
不成立 → 拒绝，并打印 `note: ignoring <变量> — <脚本> never reads it.`（**静默拒绝会让人以为是别的问题**）。

哪些脚本对不上：`verify-calendar.mjs` 走 `argv[2]`、`verify-weekart.mjs` **硬编码 3011**、`verify-backup-live-bucket.mjs` 先 `argv[2]` 再 env。

### 测试脚手架自己的两个坑

1. **`spawnSync` 阻塞父进程事件循环。** 测试里我用一个**进程内的假 HTTP 监听器**冒充隔离实例（守卫只读 `localDirectory` 这一个字段），但 `spawnSync` 一跑，父进程事件循环被占住 → 假服务器**永远答不上** → `fetchStatus` 超时 → 回落到 3011 → 被判生产 → **三条断言全部失败，原因却是假的**（看起来像守卫坏了）。改成异步 `spawn` + Promise。
2. **「源码包含变量名」会被注释骗过。** 我夹具的头注释里写了 `LIFEOS_BASE_URL` → 「不读变量」的夹具被判成「读变量」。修法：`stripComments()` 先剥 `//` 与 `/* */`（带引号状态机，避免误伤字符串里的 `//`）再 grep。真实脚本侥幸没暴露（它们的注释里没提），但判据本身不诚实。

### 豁免口

`retract-record.mjs` 的职责就是操作生产，**给它标 `@unguarded-on-purpose`**，`audit-toolbox-targets.mjs` 识别这个标记并单独归为 `prod-tool`。
**没有豁免口的检查会永远报红，然后所有人学会忽略它。**

### 撤回污染记录的两步

记录**没有硬删 API**，所以：
1. `node .review/retract-record.mjs bc0717b9-… --apply` → 走 `DELETE /api/records/:id` + `{revision}`（软删）。删前断言：必须活着、不能是 `is_demo=1`、不能被活记录引用，**并把正文打出来给人看**。
2. `node .review/purge-trash-junk.mjs --apply` → 收墓碑（签名已覆盖，`matched 1 / UNMATCHED 0`）。

**清墓碑前先 `PRAGMA wal_checkpoint(TRUNCATE)`**，否则 `copyFileSync` 的快照**不含 `-wal` 里的最新内容**（本次 `-wal` 有 90,672 字节）。

结果：`live 140 → 139`、`2036-09-15` 归零、**18 条主人写的始终没动**、软删 0。

### 一条附带的干净结论

本轮所有改动**全部落在 gitignore 内**（`.review/`、`AGENTS.md`、`docs/changelog.md`、`data/`、`.env`）→ `git status` 干净。
**接力依赖链（规则 + 改动记录 + 交接文档）不在 git 里**，所以「有 git 检查点」不等于「成果被保住了」。

---

## 🔴 密钥与 git：`.workbuddy-ai/memory/` 是公开的，`.env` 不是（2026-09-18 推送前拦下）

### 事故

46 个待推送提交里，`MEMORY-detail.md` 与 `2026-09-18.md` **抄了 `LIFEOS_WEATHER_CONFIG_SECRET` 的真实明文**（与 `.env` 逐字符相同），
由 `a70b4f1` 引入（距 HEAD 仅 3 个提交），之后每个提交都带着它。

**根因不是「忘了 ignore」** —— `.env` 早就被 ignore 了。
是**规则只保护了 `.env` 这个文件，没保护「把 `.env` 的内容复制到别处」这个动作**。
**交接文档写得越详细越容易犯**：写「我把它钉成了 `lifeos-local-weather:<路径>`」很自然，把值抄进去也很自然。

### 处置（主人选「改写历史」）

1. `.review/snapshot-git.mjs --label pre-rewrite` → `.git` **字节级快照 + 自包含 restore 脚本**（336 文件 / 45,714,967 字节，逐项比对一致）。
   **别用 `git reset --hard` / `git stash`** —— 会连未提交的成果一起抹掉。
2. 明文换成形状占位符 `lifeos-local-weather:<搬迁前的数据目录>`，各加补记防止再抄回去。
3. `.review/rewrite-history-redact.mjs`（默认 dry-run）用 `git commit-tree` 重写 `origin/main..HEAD`；**7 项断言全 PASS 才 `--apply`**。
   断言里特意留一条「**改前确实存在**」—— 否则「改完没有」什么也证明不了。
4. 推送前门禁：`npm run typecheck` 三 workspace 全绿 + `npm test` 47/47。

**验证数字**：tip 的 tree `210f029a51` → `210f029a51`（**未变**，只换历史）；提交信息/作者/时间戳**逐字节相同**；
独立复核（不复用脚本判断）`git grep -F` 扫全历史 → **NONE**；推送 `63ddc57..fc622e5`、`fc622e5..f7b93ef` **快进、未用 `--force`**；远端旧提交 4 个全 0 命中。

### 三个坑

1. **`refs/original/…` 写不进去**：`git update-ref refs/original/heads/main <sha>` **返回 0 却什么都没建**（那是 `filter-branch` 的命名空间）。
   → 用 `refs/backup/pre-rewrite-main`。**回滚点建完必须 `show-ref` 验，别信退出码。**
   → 它让那 3 个含密钥的旧提交在本地仍可达：`git push --all` 安全，但 **`git push --mirror` 会把它们推上去**。确认不用回滚后 `git update-ref -d refs/backup/pre-rewrite-main`。
2. **排查脚本先估进程启动次数**：逐文件 `git cat-file` × 46 个提交 = 上千次 spawn，Windows 上直接跑到被杀（**无输出**）。
   → 用 `git grep -l -F -e <值> <commit>`，一个提交一次。
3. **提交信息取 `git cat-file commit` 的原始字节**，别用 `%B`（可能多/少一个换行，「信息已保留」就成了假断言）。

### 沙箱行为（不影响推送）

**沙箱会丢 `refs/remotes/` 的写入**：`git fetch` 报 `* [new branch] main -> origin/main`，但 `.git/refs/remotes/origin/main` 落不了盘，`git rev-parse origin/main` 随即失败。
**推送只依赖远端 URL + 本地 ref**，所以推送正常；自己终端跑一次 `git fetch` 即恢复。`refs/heads/*` 与 `refs/backup/*` 的写入正常。

### 推送前必做清单

① `npm run typecheck` + `npm test`；
② **按值**搜一遍：`git grep -F -e <密钥值> $(git rev-list origin/main..HEAD)` —— **别只按文件名搜**；
③ 常规敏感路径：`.env` / `*.sqlite` / `data/` / `pic-test/` / `*config.json` / `.env.example`（占位符可以，真值不行）。

**被 ignore 的**：`.env`、`data/`、`.review/`、`AGENTS.md`、`docs/changelog.md`。
**没被 ignore 的**：`.workbuddy-ai/memory/**`、`docs/audit-prompt.md`、源码、`.env.example`。

### 同一动作共犯 3 回（2026-09-19 按值全仓扫描）

把「按**值**搜」做成常驻工具 **`.review/scan-secret-leaks.mjs`**（只读，3541 个文本文件）后，**第一次跑又抓到 3 处**：

| 位置 | 性质 | 处置 |
| --- | --- | --- |
| `.workbuddy-ai/memory/`（09-18） | **被 git 跟踪** → 差一步推送 | 改占位符 + **改写历史** |
| `docs/changelog.md:2167` | 上一轮交接记录抄了天气种子明文 | 换占位符 + 补记（**文件被 ignore，纯属运气**） |
| `.review/rewrite-{dryrun,apply}.txt:3` | **改写工具自己打印的**（`console.log(\`  secret : ${SECRET}\`)`），输出被重定向存档，**还 `present_files` 展示过** | 脱敏 + 修工具 |

→ **「我修好了密钥」的那行日志，本身就是下一个泄漏点。** 凡是被重定向存档 / 贴进交接文档的输出，一律只打印**形状与长度**（`${SECRET.slice(0, idx)}:<redacted, N chars>`）。
→ **「文件被 ignore」不能当成「可以抄值」的理由** —— 它只改变了后果的严重程度，没改变动作的性质。

**扫描器按爆炸半径分类**（这才是真问题）：`PUBLISHED`（git 跟踪 → 一定 exit 1）vs `local only`（gitignored → 列出但不判失败）；默认只对前者失败，`--all` 才连后者一起失败。
→ 否则 `.review/recovery/env-backup-….env`（**有意保留的 `.env` 备份**：4 个种子就是解密密钥，`.env` 一丢天气 key 永久解不开）会让检查永远报红 —— **而永远报红的检查等于没有检查**（与生产守卫的豁免口同一条道理）。

---

## 照片回收站：全都没有预览图（2026-09-19，主人报障）

### 主人问的是「为什么咱们的图片全都变成了连预览图都没有的东西？是版本乱了吗？」

**不是版本问题。** 唯一「全都没有预览图」的地方是 **`设置 → 照片回收站`（`settings-asset-trash-card`）：180 个格子，158 个是空的**。
时间轴 87 张、日历 12 张**全部正常**。

### 健康的那部分（逐层实测）

| 层 | 结果 |
| --- | --- |
| 磁盘 | `pic-test/` 241 文件，PNG magic 正确、后缀正确 |
| `/api/assets/:id/content` | 200，真 PNG 4–6 MB |
| `/api/assets/:id/thumbnail?w=400\|1200` | 200，webp 24 KB / 163 KB |
| Vite 代理（5199→3011） | 200 |
| 真实浏览器 | 时间轴 87/87、日历 12/12 渲染出真实画面；0 失败请求、0 报错 |
| 构建 | `apps/api/dist`、`apps/web/dist` 均比 `src` 新；5199 走 Vite 源码，无 dist 参与 |

### 坏的那部分：180 = 待清理 87 + 回收站 93

1. **回收站 93 条（`origin: asset-delete`）→ 接口 404**。文件在 `pic-test/uploads/_orphan-trash/2026/09/`，而路由仍按原路径 `uploads/2026/09/...` 找。
   **`/api/assets/trash/:id/content` 也 404** → 这 93 条**既看不到也恢复不了**，回收站「可以拿回来」目前是空承诺。
2. **待清理 87 条 → 源文件本身就是空图**。54 条名字就是验收夹具（`r3-9-1.png`、`gap-probe-2.png`、`m-9-4.png`、`phone-4-2.png`、`验收房间-甲.png`…），**136 字节**的 1×1 / 24×24 PNG。
   另外 20 张 5–8 MB 真照片（`Zenny0XXBlessing.jpg`，约 130 MB）**无任何记录引用、4 天后自动收走**（上传于 09-15 19:01–20:33）。

### 🔑 方法论：「加载成功」≠「画出来有东西」

同一个问题，我连续得到两个**相反的错误结论**：

1. **假阳性**：第一版探针报「75 张 broken」—— 那只是 `loading="lazy"` 的图还没进视口。
2. **假阴性**：滚动之后 87/87 全绿 —— 但 **1×1 透明 PNG 照样 `complete === true`、`naturalWidth > 0`**，画出来什么都没有。

**正解 = 画布采样**：把每张图缩到 8×8 画到 `<canvas>` 上，数**不透明像素数**与**不同颜色数**；
`opaque < 8`（几乎全透明）或 `colors < 3`（纯色）即空图，**与请求是否成功无关**。
→ 新增 `.review/probe-photo-content.mjs`（画布采样）、`.review/probe-photo-render.mjs`（失败请求 / 控制台 / 懒加载滚动）、`.review/probe-settings-images.mjs`（按卡片分组定位）。

**三条断言缺一不可**：① 请求成功 ② 滚动后仍成功 ③ 采样后有内容。少任何一条都会得出相反的错误结论。
（这与「崩溃必须变成 FAIL」「有清理调用 ≠ 清理成功」是同一条：**只证明你能证明的那一半。**）

---

## 日历的编辑模式为什么只留在月历、为什么「先存后退」（2026-09-21）

### 主人要的是「两个临时的工具」，不是一套常驻模式

原话：*「我决定在日历的那个齿轮旁边再加一个编辑的 icon…无论是什么模式，什么周期模式，还是编辑模式，只要一刷新或者一点别的地方就退出掉，这两种模式不应该常驻」*。
所以判据不是「有没有退出按钮」，而是**四条路都得退**：刷新 / 点日历外 / 离开日历视图 / 切到周视图。`localStorage` 里一个模式键都没有——验收里直接断言了这件事，**「不常驻」不靠清除来假装**。

### 周卡的小结字段是**删掉**，不是藏起来

第一轮（commit `2435360`）给周卡也做了可编辑小结字段。第二轮蛋妞明确「**周历不留小结**」，于是字段与 `.week-card-summary-field` 样式**一起删**，`CalendarView` 里加了 `editable = editMode && mode === "month"`。
**为什么不只是把渲染 `if` 一下：** 「周视图 + editMode」若能共存（先开编辑模式再切到周视图），画面上就会出现一条**没有内容的编辑条** + 一堆**没得改的格子**。把判据收进一个 `editable` 并让渲染全部走它，这个非法组合就根本不存在了。

### 「先存后退」而不是「弹框问」

第一轮是 `window.confirm('还有 N 处改动没有保存，确定要退出吗？')`。蛋妞选的是「**先自动保存再退出**」——打字的地方是日历，而退出动作（点别处 / 刷新）常常是顺手做的，弹框会把「随手点一下」变成「要不要丢东西」的决策。
实现：`changeEditMode(false)` 变异步 —— 有草稿就 `await saveSummaryDrafts()`，**返回 false（存失败）就直接留在编辑模式里**、草稿也留着。`saveSummaryDrafts` 的返回类型因此从 `void` 改成 `boolean`。**存失败还退出去，等于让网络故障伪装成一次干净的退出。**

### hover 展开的菜单，不能让点击做 toggle（这条是想出来的，不是试出来的）

需求原文是「**指到**那个周期那里，就会再展开一个二级菜单」——是 hover。最初父行 `onClick` 写的是 `setCycleOpen(o => !o)`，看着没问题，但真实鼠标路径是「移到父行 → `mouseenter` 展开 → 按下 → 收起」：**用户想点开，结果点关了**。改成 `onClick` 只 `setCycleOpen(true)`、收起只交给 `mouseleave` 就自洽了。
headless CDP 为什么不一定暴露它：`Input.dispatchMouseEvent` 只在派发时更新 hover 状态，不保证先补一次 `mouseenter`。**「headless 绿了」不能当作交互没问题的证据** —— 这条只能靠把鼠标路径想一遍。

### 周视图的右键菜单只该有两项

同一个菜单组件，`monthMode = mode === "month"`；周视图里那三项小结动作整块不渲染。**这是有意的**：周历没有小结，把「编辑小结」摆出来只会让人点了发现没反应。验收专门断言周视图菜单就是 `["周期","取消"]`。

## 「一段经期两个结束日」：两个读取口径分叉（2026-09-21 第二轮）

### 主人报的现场

「我把目前经期结束调到 24 号，它的确 24 号之后的都空白了。但是我在 25 号再点周期呢，发现它已经勾选了…25 号目前是没有经期的，他不应该勾选了经期结束的状态」。
只读拉库（`GET /api/modules/cycle-intimacy`，无副作用）确认：`period_start` 只有 `2026-09-20`，`period_end` **两条并存** —— `2026-09-24`（`de5b5905…`）与 `2026-09-25`（`23e67dca…`）。配置 `cycleLength=28 / periodLength=7`。

### 两个现象一次对上（同一份数据，两种读法）

- **日历**（`periodRuns()`，`main.tsx` 1925–1941）：`ends.sort()` 之后 `find(end >= start)` → 取到 **9/24**，**9/25 被静默丢掉** → run = 9/20–9/24；`periodMoonForDate` 里 `date > last.end` 就转预测，预测 = 24+28 = **10/22** → 整个 9 月下旬空白。**演算本身没错。**
- **右键菜单 / 周期面板**：勾选判据是 `module.events.some((e) => e.date === d && e.kind === k)` —— 读**原始行**，所以 9/25 真的会勾上。**不是右键菜单特有的**，周期面板同样勾。

**结论：这不是显示 bug，是两个读取口径分叉。** 在显示层各补各的漏，等于要求「每一处读事件的地方」都记得去重 —— 迟早漏一个。所以修在**模型层**：一段经期只允许一个结束日。

### 修法

- `packages/core` 新增纯函数 `periodEndSpan(events, date)`：给一个结束日，返回它所属经期区间 `{ from?, until? }`（`from` = 不晚于它的最近开始日，`until` = 它之后最近开始日）。
- `apps/api` 的 `addCycleIntimacyEvent`：记 `period_end` 时先算区间，**在同一个 `BEGIN IMMEDIATE` 事务里**先 `DELETE` 掉同区间其它 `period_end`、再 `INSERT` 新的。语义 = **记新的结束日是把旧的位置「挪过去」，不是叠加**（同一天同一 kind 仍是 409）。
- **`assertValidCycleIntimacyModuleData` 故意保持宽松**（不拒绝两条 `period_end`）：它是**导入路径的校验器**，收紧它就等于宣布所有旧备份非法。**不变量只把在写入口。**

### 清历史脏行：保留谁？

`.review/prune-duplicate-period-ends.mjs`（默认 dry-run；`--apply` 前 `VACUUM INTO` 一致性快照 + `deleted-events.json` 还原清单；**只走 API 不直接开库写**，免得和正在跑的 API 抢 WAL）。
**保留 = 每段经期里「最早」的那个结束日**，不是「最后记录的那个」。理由是判据要**肉眼可验证**：日历现在显示的就是它，所以清完**画面上不会有任何变化**，只是把「日历看不见、菜单却勾着」的幽灵行去掉。她的现场恰好两种口径重合（9/24 既是要的、也是更早的），不重合时要认「日历口径」。
顺带：想保留「最后记录的那个」在历史数据上根本没法判 —— 脚本是走 API 删的，拿不到插入序（rowid 在库里，但 API 不暴露）。
**落不进任何一段经期的「孤儿结束日」（前面没有开始日）不碰**，只报告 —— 那种行怎么处置要人来定，脚本不该替她决定。
自检 `.review/verify-period-end-prune.mjs`（隔离 API 3078）：夹具**直接往隔离库写行**造脏数据，因为**新版 API 已经造不出来了**（记新的会自动挪走旧的）—— 「验能不能收拾历史脏数据」这件事，夹具就只能自己去伪造历史。


## 全站不可选中：为什么是「默认禁 + 白名单放」而不是黑名单（2026-09-21）

### 主人要的

「把页面里不该能选中的全都设成不可选中，比如说天气卡的时候东西啊，那些菜单按钮啊之类的各种东西占位符啊，基本上都不应该被能选中复制」。方案问答里她拍的是「**界面禁选，内容保留**」—— 正文仍要能选中复制（她自己写的字，复制是正当用途）。

### 为什么是白名单，不是黑名单

黑名单（「天气卡禁、菜单禁、按钮禁…」）每加一个按钮 / 菜单 / 徽标 / 占位符都得记得补一条，**迟早漏，而且漏了没人发现**（漏的默认就是「能选中」，只是看起来略怪，不会报错）。
改成 `body { user-select: none }` 之后，**以后新加的界面元素天生就选不中**，不需要维护 —— 代价是必须把「本来就该能选」的那两类显式放回来，而这两类是**有限且稳定**的（表单控件 + 正文叶子），所以维护成本反过来落在更小的一侧。

**唯一必须记住的例外：表单控件。** 祖先的 `user-select: none` 会**一路继承到后代**，包括 `<input>`/`<textarea>`。漏掉这一条，整站输入框都选不中字、没法全选替换 —— 这是「默认禁」最容易踩的坑，且只在自己要改一个字的时候才会发现。

### 白名单里绝不能放「容器」（第一版就是这么错的）

第一版把 `.task-summary`（一个 `<aside>`）：……放进了白名单，想着「小结整块要能选」。结果它内部的 `<h2>接下来要做</h2>`（标题）和计数徽标 `.summary-badge`（一个数字）**跟着变成可选中**，全量扫描当场抓出 4 条泄漏。
正确的粒度是**承载文字的那个叶子** `.task-summary-copy`。教训：**白名单的作用域 = 它在 DOM 里的子树**，所以只能点「文字本身」，不能点「装文字的盒子」。这两个选择器现在留在脚本的 `CHROME_SELECTORS` 里当**回归哨兵**（它们哪天又能选中了，就是有人把容器加回去了）。

### 全量扫描的判据必须是「四条并列」

「自己直接带文字且可见」的节点，每一个都要落在四条之一：
1. 计算样式 `user-select === "none"`；
2. 它是表单控件（`input / textarea / select / contenteditable`）；
3. 它自己在白名单里；
4. **它的某个祖先在白名单里**。

第 4 条不是妥协，是必需：记录正文里的 `#地点` 提示 chip 是**内联在句子里的 `<span>`**（`.mention-chip`），它继承 `text` 是**对的** —— 强行把它摁成 `none`，用户拖蓝时会在每个提及处断掉，一整个句子再也选不全。**判据漏了这一类，就会把正确的实现判成错的。**

### 「真手势拖蓝」怎么量才不被污染（两层）

只读 `getComputedStyle` **不算证据**：CSS 对不对，和「真的拖得出字吗」是两回事（`::selection`、后续规则、JS 都可能推翻）。所以第三层用 `Input.dispatchMouseEvent` 走真实 mousePressed → 若干 moved → **在松手之前**读 `window.getSelection()`：

- **读在松手前**：`click` 是在**松手**时才派给「按下点与松手点的最近公共祖先」的。
- **松手要挪走**（挪到一个惰性点再放）：探测点里有天气卡（`.weather-header` 是 `role=button`，点开会弹天气预览）和日期区（`.weather-date-picker` 是个 label，点开日期选择器）—— **就地松手等于顺手把弹层打开，后面的断言全被挡在门外**。

### 反向用例（量尺必须能红）

把 `body` 的默认从 `none` 改回 `text` → **23 条 FAIL**：全量扫描报 **16 个漏网节点**，并且 5 处界面**真拖出了字**（`LifeOS` / `137 条` / `26~33°` / `佛山南海` / `周一`）；而正文那两条断言**两个方向都绿**（它本来就该是 `text`）⇒ 说明红的是禁选那一侧，不是量尺坏了。撤销破坏重跑 → **50/50**。

### 两个环境细节

1. **`.composer-input` 只在「今天」视图上**：实测时间轴 / 日历 / 任务 / 笔记上都没有写作框（那里只有 `.ai-assistant-composer`）。脚本里查它之前必须**先切回「今天」**，否则空跑成假 FAIL（已踩）。
2. **日历默认开在「周」视图**（`calendarMode` 默认 `"week"`），而右键菜单的月格在月视图里 —— 测菜单之前要先点「月」（已踩）。

### 为什么这个脚本「只读贴主人预览」，不 spawn 隔离实例

大多数 CDP 验收脚本都自起隔离实例（更干净、不碰生产）。**这个不行**：判据里点名要测「天气卡」和「日历上的真实记录」，而天气卡**只有在有天气数据时才画得出来** —— 隔离实例是空库、没有天气配置，天气卡根本不渲染，那几条断言会变成**空转的假绿**（找不到元素 → 跳过 → 照样 PASS）。
→ 本脚本**只读**贴主人预览 5199：不 spawn、不造夹具、不发任何写请求，只读 DOM + 发鼠标事件。先例 `probe-timemachine-live.mjs` 同样是「只读贴主人预览」。**代价是它依赖预览在线，且不能进全隔离的回归批次。**

