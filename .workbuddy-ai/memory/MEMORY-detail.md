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
