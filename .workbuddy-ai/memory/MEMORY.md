# LifeOS 项目长期记忆（硬规则速查）

> 规则全文 `AGENTS.md` · 改动记录 `docs/changelog.md` · **「为什么」/根因/事故经过在 `MEMORY-detail.md`**。
> 本文件只写**照做**，不重复 `AGENTS.md` 已有的条目，也不重复 detail 里已经讲过的理由。按闯祸代价排序。

## 0. 三条最容易出人命的

1. **`data/`（仓库根）= 主人的生产库。永不重置 / 永不 `seed-demo --clean` / 永不删。** 3011/5199 直接指着它 → 会写记录的验收就污染主人数据。造数据**另开 `LIFEOS_DATA_DIR`**。动手前 `node .review/data-inventory.mjs`（只读；有主人写的记录就 exit 1）。
2. **密钥只写形状与来源，绝不写值。** `.workbuddy-ai/memory/` 被 git 跟踪、`.env` 不被 —— 「文件被 ignore」不是抄值的理由；**凡会被存档或贴进交接文档的输出，一律不许回显密钥值**。推送前 `npm run typecheck` + `npm test` + **按值**扫 `node .review/scan-secret-leaks.mjs`。
   改写历史：`.review/snapshot-git.mjs` → `.review/rewrite-history-redact.mjs`（dry-run 默认）。**回滚点用 `refs/backup/`**（`refs/original/` 返回 0 却不建 ref），建完必须 `show-ref` 验。
3. **搬数据目录 / 改 `LIFEOS_PASSWORD` 会静默废掉已存 API key** → `.env` 里 4 个 `LIFEOS_*_CONFIG_SECRET` **别删别改**；动完目录回看 `/api/weather/status` 的 `hasKey`。
   - 解不开也不会丢（密文原样抄回）。量尺 `.review/verify-ai-key-persist.mjs`（25 条）。
   - **手写 `data/ai-config.json` 无效**（AES-256-GCM）→ 绕开 UI 就写 `.env` 的 `LIFEOS_DEEPSEEK_API_KEY`（`.review/set-ai-key-env.mjs`，key 走 stdin），**改完必须重启 API**。`.env` 是真源；文件里有密文时密文优先。
   - 「测试连接」**不落盘** ⇒ 「测试成功」≠「已保存」。查状态用只读 `GET /api/ai/status`。

## 环境

- **沙箱在 turn 结束时回收子进程** → **开工先探端口**，不在就 `.review/spawn-serve.mjs`。**「读不了 / 数据不见了」的第一嫌疑永远是服务没在跑。**
- `node -e` 写含反引号 / `$(…)` / 反斜杠的文本必炸 → 先 `Write` 成文件再读。
- **收尾口径**：改了什么 / 怎么验证 / 验收数字 / 预览地址 `http://127.0.0.1:5199/`。**不出截图。**

## 数据与备份

- `data/weather-config.json`、`data/ai-config.json` **不在 git、无副本**；照片在 `LIFEOS_ASSET_ROOT`（预览 `pic-test/`，**不在快照、无备份**）。**恢复三件事**：停 API、删 `-wal`/`-shm`、保留两个 config json。
- **搬/复制 sqlite 前必须 `PRAGMA wal_checkpoint(TRUNCATE)`**；只复制 `.sqlite` 会静默丢最新记录。`VACUUM` 后尺寸要在 `close()` 之后再量。
- **读数据前先确认读的是哪个库**：`data/`、`.review/data`、`.review/recovery/`、`.review/*-run/` 下的同名 `lifeos.sqlite` 表结构可能不同。
- 示例标记 = **`records.is_demo`**（正文无前缀）。`is_demo=0` 的回收站残留用 `.review/purge-trash-junk.mjs`（dry-run 默认，**认不出的行中止整轮**）。**别用「是否引用 `demo-` 实体」当判据。**
- **照片生命周期**（`asset-gc.ts`）：无人引用 → 原处留 7 天（锚点 `lastUsedAt ?? createdAt`）→ 收进 `uploads/_orphan-trash/` → 回收站再留 30 天 → 才永久删。**总时限 34 天。** `referencedAssetIds` **含软删记录** → 「先关联、后删除」不算孤儿。
  - **回收站条目没有 `id`** → 取内容 / 恢复 / 删除一律传 **`asset.id`**（传条目 id 只得 `undefined` 的 404）。
- **`contentHash`**：挂在 `asset.storageRefs[*].contentHash`，**顶层没有**，`GET /api/assets` 也不返回 → 数覆盖率只能读库。**回填是单向窗口**（文件没了永远补不上）。现状 **160 / 161**。
  - 上传路由已按 hash 复用（`POST /api/assets/uploads`）；**`POST /api/assets`（自带 `storageRefs`）不算 hash**。`findAssetByContentHash` 是**全表线性扫**（`repository.ts:1257`）→ 要加索引。
- **备份退路要实测**：`POST /api/backup/dual`（`.review/verify-backup-path.mjs`）。`enabled=1` ≠ 能用。
- **迁移类改动必须显式搜 `.review/`**（被 gitignore，`grep`/`rg` 默认不进）。
- **删实体前必须先软删记录**：`DELETE /api/entities/:id` 的引用检查只算**活记录**（`repository.ts:1422`）→ 反序必 409。

## 验收

- **`audit-toolbox-targets.mjs` 靠 `/method:\s*["'](POST|PATCH|PUT|DELETE)["']/` 认「会写的脚本」**（盲区：直接开库写的不在视野内）→ 新工具的写入要写成 `{ method: "DELETE", … }` 这种**字面量形状**。
- **崩溃必须变成 FAIL**：脚本抛错时结果文件会留着上次的 `RESULT: PASS` → **看到 PASS 先确认断言条数**。
- **图片「加载成功」≠「画出来有东西」**：判据 = **画布采样**（缩 8×8 画到 `<canvas>` 数不透明像素与颜色数，`.review/probe-photo-content.mjs`）。**三条缺一不可**：请求成功 + 滚动后仍成功 + 采样后有内容。
- **React 的 DOM 嵌套警告**：栈里**不带 props 的裸标签是兄弟节点，不是祖先**（链上节点一律带 props）→ 别把兄弟当祖先读。React 按 `parentInfo|childTag|ancestorTag` **去重** ⇒ 条数 = 组合数 × 2。诊断捕获**别设 200 这种上限**。
- 瞬态缺陷要在**过程中**高频采样；日期夹具一律动态推导；`verify-settings-ai.mjs` 的 8 项 FAIL 是已知老问题。
- 测试脚手架：`spawnSync` **阻塞父进程事件循环** → 用异步 `spawn`。

## 磁盘：测试失败先 `df -h /c`

- `database or disk is full` / `ENOSPC` 常是 C 盘满，**伪装成产品回归**。
- 根因是 kill/rm 顺序 → **「有清理调用」≠「清理成功」**。
- 修法必须**同步强杀**（清理块多在 `finish` / `process.on("exit")` 里，`await` 非法）：`.review/reap-chrome.mjs`（**新脚本一律用它**）、`.review/sweep-profiles.mjs`。
- **`child.kill("SIGKILL")` 在 Windows 上不保证进程已经死了** → 对子进程也要 `taskkill /F /T /PID`（它等到整棵树没了才返回），否则紧随的 `rmSync` 撞 EBUSY。
- **`reapChromeSync` 返回 true ≠ 目录真没了**：09-22 复现出**每轮必现** —— 删除确实成功（2.75s 采样全 false），几秒后目录**又完整长回来**，而事后 `chrome.exe` = 0；3 秒的「盯住再删」抓不到。**每轮漏约 50MB**，根因未查清（`docs/todo.md` §12）→ 新脚本收尾要**自己列一遍 profile 目录**再报数。

## 时光机（只读穿越；第一期只读）

- **快照绝不能原地打开**（`readOnly` 照样生成 `-wal`/`-shm`）→ 先复制到 `<dataDirectory>/derived/snapshots/` 再 `readOnly` 打开，用完连 sidecar 一起删。三条硬证据（缺一不算）：快照**逐字节** sha256 不变、`backups/` 里不冒出 `-wal`/`-shm`、跑完 scratch 为空。
- **照片只在「今天还画得出来」时才给**；文件没了 → 报 `photosGone` 的**数字**（只认快照记录为 photo 的 id），**不悄悄少画一格**。**私密记录连照片一起蒙住。**
- 差异行方图**上限 3 张**（`DIFF_PHOTO_LIMIT`），多的折成「还有 N 张」；`<img onError>` 落虚线占位。
- **浏览器只看得见轴上「最新」那个快照** → **验收脚本的「顺序」本身就是断言**：「造出差异的那次快照」必须到浏览器那段之前**一直是最新**，**双份备份排最后**。
- 方图 `loading="lazy"`：断言 `naturalWidth > 0` 前先 `scrollIntoView` 再等 `complete`。
- **还没做**：刻度尺读不到已进回收站 / 远端 `lifeos-trash/` 的快照；选择性捞回与**照片备份**未开始。见 `docs/todo.md`。

## UI 硬规则

- **卡片宽度 430.08px、只有高度随内容**；`width` 与 `max-width:100%` **都要**；**双列已删不要恢复**；公式里的 `+30px` 必须含**边框**。哨兵 = `verify-photo-grid` 的 `five lines`。
- **grid 自动排布会「只在部分记录上错」** → 几何恒定的元素一律显式定位；改单列时同步释放 `grid-column`。
- **不许有「移动的细周期图案」**（摩尔纹）。**永不恢复移动的条纹幕布。**
- **布局稳定性**：`animation-fill-mode:none` + 正延迟期间按基准样式渲染 → 基准位置要在屏幕外（或改负延迟）；`html{scrollbar-gutter:stable}`；CSS `auto` 高度不可插值（`useLayoutEffect` + 直接写 `style.height` + 强制回流）。
- 天气天空两根轴：`category` 决定**画什么**、`phase` 只决定**色/光**；硬预算由 `verify-weather-art.mjs` 守。
- **补记条 = 安慰剂**（整条一个点击目标，子控件 `aria-hidden`）。
- **界面文字一律不可选中**（09-21 定案）：`styles.css` **顶部一块集中规则** —— `body` + `button` 默认 `user-select:none`；白名单只有两条：① 表单控件；② 正文叶子（**清单只看 `styles.css` 顶部那块，共 10 个 —— 本文件不抄，抄了会漂**）。
  - **白名单只能放「承载文字的叶子」，绝不能放容器**（放 `.task-summary` 会连带 `<h2>` 与徽标一起可选）。
  - **默认禁 + 白名单放** → 新加的按钮 / 菜单 / 徽标**天生选不中**，不用维护；**别为单个元素加 `user-select:none`**。
  - **例外**：只读**配置回显值** `.settings-ai-effective-item strong` 算内容，**只放值那一层**。
  - 验收 `.review/verify-selectability.mjs`（**只读贴 5199**，50 项；**不 spawn 隔离实例**，会假绿）。三层判据：全量扫描 / 点名对账 / **真手势拖蓝**。
- **改动前先勘察、先问**：设计/规则类先出方案等确认；主人说「**听你的**」才是授权点。

## 日历的两个入口（09-21 定案，动手前先对表）

- **编辑模式只活在月视图**：`editable = editMode && mode === "month"`。**周卡没有小结行** → 周视图无铅笔、无小结字段，右键菜单只剩「周期 / 取消」。
- **两种临时模式都不许常驻**：**不写 localStorage**；「点 `.calendar-section` 之外」「刷新」「离开日历视图」「切周视图」四条路都要退。**退出编辑模式 = 先存后退**（存失败就留在编辑模式，不弹框问）。
- **`hover` 展开的二级菜单，父行 `onClick` 不能再 toggle**（`mouseenter` 已展开）。父行 `onClick` 只负责展开；子菜单是父容器的后代，移进去不触发 `mouseleave`。
- **日历初始模式是「周」**（刷新后回周视图）—— 别假设「刷新完还在月视图」。
- 右键「**编辑小结**」= **就地改那一天**（打开编辑模式 + 光标落进那天）→ **当月每一天都有字段**，包括空白天。
- 四种周期只有一份文案：模块级 `CYCLE_EVENT_KINDS`（周期面板与右键二级菜单共用）；二级菜单同样受「周期模块是否启用」管。
- **齿轮面板里没有「编辑模式」开关**（已删）。入口**只有铅笔那一个**，别加回面板。
- **右键周期二级菜单每行 = 「方框 + 文字」两个热区**：**点方框 = 多选**（切换勾选、菜单不关）；**点文字 = 单选**（切换 + 菜单自关）。判据 = `aria-checked` + 菜单还在不在。
- **「经期结束」一段经期只允许一个**（堵在**模型层**：同一 `BEGIN IMMEDIATE` 事务里先删同段其它 `period_end` 再插）。`assertValidCycleIntimacyModuleData` **故意宽松**，否则旧备份导不进来 —— 不变量只堵**写入口**。
  - 清历史脏行：`.review/prune-duplicate-period-ends.mjs`（保留每段**最早**的 = 日历本来就显示的 → 清完画面零变化）。
