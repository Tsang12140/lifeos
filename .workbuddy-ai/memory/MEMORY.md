# LifeOS 项目长期记忆（硬规则速查）

> 规则全文 `AGENTS.md` · 改动记录 `docs/changelog.md` · **「为什么」与细则全文在 `MEMORY-detail.md`**。
> 本文件**必须能整份注入**，所以只留最贵的那几条；被截断的尾巴等于没有。

## 0. 三条最容易出人命的

1. **`data/` = 主人的生产库，3011/5199 直接指着它。** 永不重置 / 永不 `seed-demo --clean` / 永不删；造数据另开 `LIFEOS_DATA_DIR`；动手前 `node .review/data-inventory.mjs`（有主人写的记录就 exit 1）。
2. **密钥只写形状与来源，绝不写值。** `.workbuddy-ai/memory/` 被 git 跟踪、`.env` 不被 —— 「文件被 ignore」不是抄值的理由；**凡会被存档或贴进交接文档的输出，一律不许回显密钥值**。推送前 `typecheck` + `npm test` + **按值**扫 `node .review/scan-secret-leaks.mjs`。改写历史：`.review/snapshot-git.mjs` → `.review/rewrite-history-redact.mjs`；**回滚点用 `refs/backup/`**（`refs/original/` 返回 0 却不建 ref），建完 `show-ref` 验。
3. **搬数据目录 / 改 `LIFEOS_PASSWORD` 会静默废掉已存 API key** → `.env` 里 4 个 `LIFEOS_*_CONFIG_SECRET` **别删别改**；动完目录看 `/api/weather/status` 的 `hasKey`。解不开也不丢（密文原样抄回），量尺 `.review/verify-ai-key-persist.mjs`（25 条）。**手写 `data/ai-config.json` 无效**（AES-256-GCM）→ 绕开 UI 就写 `.env` 的 `LIFEOS_DEEPSEEK_API_KEY`（`.review/set-ai-key-env.mjs`，key 走 stdin）**并重启 API**；有密文时密文优先。**「测试连接」不落盘** ⇒ 测试成功 ≠ 已保存；查状态用只读 `GET /api/ai/status`。

## 环境

- **沙箱在 turn 结束时回收子进程** → **开工先探端口**，不在就 `.review/spawn-serve.mjs`。**「读不了 / 数据不见了」的第一嫌疑永远是服务没在跑。**
- `node -e` 写含反引号 / `$(…)` / 反斜杠的文本必炸 → 先 `Write` 成文件再读。
- **收尾口径**：改了什么 / 怎么验证 / 验收数字 / 预览地址 `http://127.0.0.1:5199/`。**不出截图。**

## 数据与备份

- `data/weather-config.json`、`data/ai-config.json` **不在 git、无副本**；照片在 `LIFEOS_ASSET_ROOT`（预览 `pic-test/`，**不在快照、无备份**）。**恢复三件事**：停 API、删 `-wal`/`-shm`、保留两个 config json。
- **搬/复制 sqlite 前必须 `PRAGMA wal_checkpoint(TRUNCATE)`**；只复制 `.sqlite` 会静默丢最新记录。`VACUUM` 后尺寸要在 `close()` 之后再量。
- **读数据前先确认读的是哪个库**：`data/`、`.review/data`、`.review/recovery/`、`.review/*-run/` 下的同名 `lifeos.sqlite` 表结构可能不同。
- 示例标记 = **`records.is_demo`**（正文无前缀）；`is_demo=0` 的回收站残留用 `.review/purge-trash-junk.mjs`（dry-run 默认，**认不出的行中止整轮**）。**别用「是否引用 `demo-` 实体」当判据。**
- **照片生命周期**（`asset-gc.ts`）：无人引用 → 原处留 7 天（锚点 `lastUsedAt ?? createdAt`）→ `uploads/_orphan-trash/` → 再留 30 天 → 才永久删，**总时限 34 天**。`referencedAssetIds` **含软删记录** ⇒「先关联、后删除」不算孤儿。**回收站条目没有 `id`** ⇒ 取内容 / 恢复 / 删除一律传 **`asset.id`**（传条目 id 只得 `undefined` 的 404）。
- **`contentHash`** 挂在 `asset.storageRefs[*].contentHash`（**顶层没有**，`GET /api/assets` 也不返回）→ 数覆盖率只能读库；**回填是单向窗口**，现状 **160 / 161**。上传路由已按 hash 复用（`POST /api/assets/uploads`）；**`POST /api/assets`（自带 `storageRefs`）不算 hash**。`findAssetByContentHash` 是**全表线性扫**（`repository.ts:1257`）→ 要加索引。
- **备份退路要实测**：`POST /api/backup/dual`（`.review/verify-backup-path.mjs`）。`enabled=1` ≠ 能用。
- **迁移类改动必须显式搜 `.review/`**（被 gitignore，`grep`/`rg` 默认不进）。
- **删实体前必须先软删记录**：`DELETE /api/entities/:id` 的引用检查只算**活记录**（`repository.ts:1422`）→ 反序必 409。

## 验收

- **`audit-toolbox-targets.mjs` 靠 `/method:\s*["'](POST|PATCH|PUT|DELETE)["']/` 认「会写的脚本」**（盲区：直接开库写的不在视野内）→ 新工具的写入要写成 `{ method: "DELETE", … }` 这种**字面量形状**。
- **崩溃必须变成 FAIL**：脚本抛错时结果文件会留着上次的 `RESULT: PASS` → **看到 PASS 先确认断言条数**。
- **图片「加载成功」≠「画出来有东西」**：判据 = **画布采样**（缩 8×8 画到 `<canvas>` 数不透明像素与颜色数，`.review/probe-photo-content.mjs`）。**三条缺一不可**：请求成功 + 滚动后仍成功 + 采样后有内容。
- **React DOM 嵌套警告**：栈里**不带 props 的裸标签是兄弟节点，不是祖先**；React 按 `parentInfo|childTag|ancestorTag` **去重** ⇒ 条数 = 组合数 × 2；诊断捕获**别设上限**。
- 瞬态缺陷要在**过程中**高频采样；日期夹具一律动态推导；`verify-settings-ai.mjs` 的 8 项 FAIL 是已知老问题。测试脚手架用异步 `spawn`（`spawnSync` **阻塞父进程事件循环**）。
- **断言必须自带证据**（把量到的数字写进消息，否则红了等于没测）；**点错元素 CDP 不报错** → 用 `elementFromPoint` 做命中测试。记录正文在 **`body.original`**（`recordText = body.edited ?? body.original`），**没有 `content` 字段**。

## 磁盘：测试失败先 `df -h /c`

- `database or disk is full` / `ENOSPC` 常是 C 盘满，**伪装成产品回归**；根因是 kill/rm 顺序 → **「有清理调用」≠「清理成功」**。
- 修法必须**同步强杀**（清理块多在 `finish` / `process.on("exit")` 里，`await` 非法）：`.review/reap-chrome.mjs`（**新脚本一律用它**）、`.review/sweep-profiles.mjs`。
- **`child.kill("SIGKILL")` 在 Windows 上不保证进程已经死了** → 子进程也要 `taskkill /F /T /PID`，否则紧随的 `rmSync` 撞 EBUSY。
- **`reapChromeSync` 返回 true ≠ 目录真没了**（09-22 每轮必现：删成功、几秒后又完整长回来，`chrome.exe` = 0；每轮漏约 50MB，根因未查清 → `docs/todo.md` §12）→ 收尾要**自己列一遍 profile 目录**再报数。
- **`existsSync` 把任何 `stat` 错误都吞成 `false`** ⇒ **别拿它当「要不要删」的前置判断**（会整段跳过删除，脚本却报「已删」）→ 判定用**父目录 `readdirSync`**（也是事后人工核对走的同一条路径）。同理 **`try/catch` 里调用的函数忘了 import，异常会被静默吞掉**，清理 / 强杀等于从没发生。

## 其余细则：全文在 `MEMORY-detail.md`（同一标题，动手前先搜它）

- **时光机**（detail `## 时光机（只读穿越…）`）：快照**绝不原地打开**（`readOnly` 也生成 `-wal`/`-shm`）→ 复制到 `<dataDirectory>/derived/snapshots/` 再开，用完连 sidecar 删；三条硬证据缺一不算。**照片只在「今天还画得出来」时才给**，没了报 `photosGone` 的**数字**（**不悄悄少画一格**；**私密记录连照片一起蒙住**）。差异行方图上限 3 张（`DIFF_PHOTO_LIMIT`）；方图 `loading="lazy"` ⇒ 断言 `naturalWidth` 前先 `scrollIntoView`。**验收脚本的「顺序」本身就是断言**：造差异那次快照要一直是最新，**双份备份排最后**。
- **UI 硬规则**（detail `## 记录卡片与 grid` / `## 天气天空` / `## 动画铁律` / `## 布局稳定性` / `## 全站不可选中`）：卡片宽 **430.08px**、只有高度随内容（`width` 与 `max-width:100%` 都要）；**双列已删不要恢复**；哨兵 = `verify-photo-grid` 的 `five lines`。几何恒定的元素一律显式定位（grid 自动排布会「只在部分记录上错」）。**不许移动的细周期图案**（摩尔纹）。`animation-fill-mode:none` + 正延迟要配屏幕外基准位；`html{scrollbar-gutter:stable}`；CSS `auto` 高度不可插值。**界面文字一律不可选中**（`body`/`button` 默认禁 + 白名单**只放承载文字的叶子**，清单看 `styles.css` 顶部那块；例外只有 `.settings-ai-effective-item strong`），验收 `.review/verify-selectability.mjs`（**只读贴 5199**，三层判据）。**浮层先量两侧余量、往大的那边开**（向上开会被 `max-height` 压成两行）；**别对浮层内容 `scrollIntoView`**（会滚动页面、把面板从锚点上拽走）。
- **日历**（detail `## 日历的编辑模式…` / `## 「一段经期两个结束日」`）：**编辑模式只活在月视图**（`editable = editMode && mode === "month"`），周卡无小结行；**初始模式是「周」**。临时模式**不写 localStorage**，四条路都要退；**退出 = 先存后退**。`hover` 二级菜单的父行 `onClick` 不能再 toggle。齿轮面板里没有编辑模式开关（入口只有铅笔）。**一段经期只允许一个 `period_end`**（堵在模型层事务；清脏行 `.review/prune-duplicate-period-ends.mjs` 保留每段最早的）。四种周期文案只有一份 `CYCLE_EVENT_KINDS`。
