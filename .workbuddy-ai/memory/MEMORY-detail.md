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
