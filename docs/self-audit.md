# LifeOS 自我审计（Self-Audit）

> **这份文件是 AI 的自我审计台账**：记录「最初判断哪里有问题」→「改了什么」→「怎么证明」→「还剩什么」。
> **每次做出修改，必须在本文件最末尾追加一节**（append-only，不改写历史）。
> 改动流水仍写 `docs/changelog.md`；未完成事项仍写 `docs/todo.md`；本文件回答的是「**我当初怎么说、后来怎么做、有没有说谎**」。
>
> 格式见文末「追加模板」。缺验证证据的条目必须标 **未验证**。

---

## 0. 审计范围与身份

| 项 | 值 |
| --- | --- |
| 审计者 | MiMo |
| 工作区 | `E:\Projects\motion-lab\lifeos` |
| 会话时段 | 2026-09-22（本文件建立当轮） |
| 回滚锚点 | git tag **`rollback-2026-09-22-pre-improve`** @ `b968c35` |
| 正向检查点 | **`a14c471`** `fix(round1): 备份清理路径兜底、时光机读 _trash、手机搜索与日期面板防溢出、弹窗任务范围选择器` |
| `.review/` 备份 | `.review/rollback-2026-09-22-pre-improve/`（8 份，因 `.review/` 被 gitignore） |

---

## 1. 最初问题清单（第一轮「你看这项目…可改进的地方」）

> 下面是**动手前**对主人说的话的结构化留档。状态列在后续章节里逐条对账。

### 1.1 产品是什么（判断，非缺陷）

LifeOS = 自托管个人生活时间轴（日记 / 任务 / 事件 / 笔记 + 照片关联 + 周月回看 + 隐私 + 可选 AI/天气/备份）。monorepo：`packages/core` + `apps/api`（Node 24 + `node:sqlite`）+ `apps/web`（React 19）。预览 3011/5199 服务的是**生产库 `data/`**。

### 1.2 工程债 / 正确性（来自 `docs/todo.md` + 我的阅读）

| # | 最初判断 | 最初严重度 |
| --- | --- | --- |
| E1 | `production-guard` 把 401/403/500 当「没服务」→ **静默放行**（todo §9） | **高**（安全闸门） |
| E2 | 验收假绿：`verify-weekclamp` 等不设退出码；6 个连 stdout 都不写（todo §7） | **高** |
| E3 | 设置页两把尺打架：脚本「恰好 40」vs 消息「40–44」vs CSS 故意 44/64（todo §1） | **高**（判据噪音） |
| E4 | 时光机读不到 `_trash` 里的保留策略快照（todo §3） | 中 |
| E5 | 51 条 `keep:false` 快照一直没被清（todo §4） | 中 |
| E6 | 97 个脚本 Chrome profile 写 `%TEMP%`（todo §5） | 中（C 盘事故史） |
| E7 | `run-acceptance` 陈旧注释 + `includes("FAIL")` 计数（todo §6） | 低–中 |
| E8 | 过期验收判据（`verify-composer-shots` / `verify-thumbnails`）+ **≤900px 无搜索入口**（todo §10） | 中（搜索是真产品洞） |
| E9 | 手机 `.date-panel` 右侧溢出（todo §13.1） | 中 |
| E10 | 编辑弹窗任务时间仍是两只单日选择器（todo §14） | 中（交互不等价） |

### 1.3 可维护性 / 结构（我阅读代码体量后的判断）

| # | 最初判断 | 最初严重度 |
| --- | --- | --- |
| M1 | `apps/web/src/main.tsx` ~4500 行 / 368KB 上帝文件；`apps/api/src/server.ts` ~2600 行 / 138KB | **高**（多 AI 并行易互相覆盖；changelog 里多次 `main.tsx` 写坏事故） |
| M2 | Web 层几乎没有单测（仅 core + api） | 中 |
| M3 | 验收脚本缺统一「stdout + 退出码 + `RESULT:`」契约（与 E2 同源） | 高 |
| M4 | `AGENTS.md` / `docs/todo.md` / `docs/changelog.md` / `.review/` 被 gitignore，交接链不在版本库 | 中（策略项，未擅改） |

### 1.4 产品边界（roadmap，不当轮缺陷）

M2 照片只读索引 / Synology Photos；自然语言检索（M3）；语音转写（M4）；Docker/NAS 真机未验；AI 派生数据「可追溯/可拒绝/可重建」可更硬。**这些在最初回复里标为「按需启动」，不当作本轮必改缺陷。**

### 1.5 最初建议的动手顺序（原话摘要）

> 「先清假绿 + 守卫洞（§7、§9），再拍板 §1 的尺子；**不要先拆 `main.tsx`**——拆文件收益大但会动全量 UI。」

主人随后要求：先定回滚点 → 改；再要求「第一轮找出来的所有问题按步骤全改好」。

---

## 2. 改动轮次对账

### 轮 A · 回滚点 + 守卫洞 + 假绿（todo §9 / §7 前半）

**授权**：主人「先定一个可以回滚的节点，然后才帮我动手改」。

| 最初问题 | 实际改动 | 验证 | 状态 |
| --- | --- | --- | --- |
| （新增要求）可回滚节点 | tag `rollback-2026-09-22-pre-improve`；`.review/rollback-2026-09-22-pre-improve/` 8 份备份 | tag 指向 `b968c35` | ✅ |
| E1 静默放行 | `.review/lib/production-guard.mjs`：`fetchStatus` → `{answered, body}`；**任何 HTTP 响应算 answered**；`localDirectory` 缺失/生产 → fail-closed | `verify-production-guard` **22/22**；**反向用例**（改回旧洞 + 摘掉 3011 兜底）→ 401/500 断言立刻红 | ✅ 已反向验证 |
| E2/M3 假绿（6 静默） | `verify-weekclamp` / `verify-calendar` / `verify-font-settings` / `verify-maple-font` / `verify-settings-ai` / `verify-sidebar` 补 stdout + `process.exitCode` | `verify-weekclamp` 首次出声 **PASS** exit=0 | ✅ |
| E2 验收空绿 | `verify-production-guard`：`RESULT: SKIP` + **exit 2**（不再 `RESULT: PASS`） | 同上 22/22 | ✅ |

**说过的坑（已写入 changelog）**：反向用例必须隔离 3011 兜底，否则 401 仍被生产拦住、看不出洞。

---

### 轮 B · 主人「第一轮问题全改好」

**授权**：主人「你第一轮找出来的所有问题，你都要按步骤把它全都改好」。产品口径处按更稳妥一侧直接定（不再空等拍板）。

#### B1 工程债

| 最初问题 | 宣称修法 | 实际改动位置 | 验证 | 状态 |
| --- | --- | --- | --- | --- |
| E3 两把尺 | 路线 A：尺改成 40–44 + 故意窄白名单 | `.review/verify-settings-ai.mjs` | **未对生产跑**（脚本会写 AI 配置，守卫拦下是正确行为）；尺子改动以代码审查为准 | 🟡 逻辑已改，隔离实例全量未跑 |
| E4 时光机 `_trash` | 本地 `_trash` → 远端 trashed | `apps/api/src/backup-timeline.ts` `materializeSnapshot` | `typecheck` 绿；**专门的时光机验收未在本轮重跑** | 🟡 代码在，E2E 未复跑 |
| E5 51 条不清理 | 根因：搬迁后 `rename(旧 location)` 被 catch 吞掉 → 改双候选路径 | `apps/api/src/backup.ts` `pruneBackups` | `npm test` 57/57 含 retention 用例；**历史 51 条未对账** | 🟡 根因已修 |
| E6 %TEMP% | codemod → `createProfile()` | `.review/_migrate-profiles.mjs` 迁 **96** 文件 | `node --check` **219** 个 `.review/*.mjs` 全过 | ✅ |
| E7 run-acceptance | 注释改生产库；FAIL 只计行首 `^FAIL`；SKIP≠PASS | `.review/run-acceptance.mjs` | `node --check`；**全量批跑未执行** | 🟡 |
| E2 假绿（22 个） | 补 `process.exitCode` | 22 个 probe/verify/_audit | 子代理改完，父侧 `node --check` 全过 | ✅ |
| E8 过期判据 | thumbnails 先进 `#settings/data/photos`；composer-shots 手机段改 flex 不变量 | 两个 verify 脚本 | **未在隔离实例重跑这两条** | 🟡 |
| E8 手机无搜索 | 顶栏补真实 `.mobile-search-button` + 最窄断点不再藏 | `main.tsx` + `styles.css` | `verify-search-ui` **PASS**（含 390px 可点） | ✅ |
| E9 面板溢出 | `panelShiftX` 右顶左移 | `date-field.tsx` + `task-schedule.tsx` | `verify-composer-date` **114/114**（原 113/114，唯一红即 fits phone） | ✅ |
| E10 弹窗任务时间 | 弹窗改 `TaskScheduleField`；滚动祖先内 `position:fixed` | `main.tsx` RecordEditor + `task-schedule.tsx` | typecheck 绿；弹窗专项 E2E **未单独跑**（原 `verify-task-schedule` 8b 测的是旧双字段） | 🟡 |

#### B2 可维护性

| 最初问题 | 实际改动 | 验证 | 状态 |
| --- | --- | --- | --- |
| M2 无 Web 单测 | 新增 `apps/web/test/pure.test.ts` **10** 项；`npm test` 串 `test:web` | **10/10** 绿；并入 `npm test` = **95/95** | ✅ |
| M1 上帝文件 | **仅**拆出 `apps/web/src/date-field.tsx`（`main.tsx` −~250 行） | typecheck 绿 | 🟡 部分（明确未宣称拆完） |
| M3 验收契约 | 与 E2 同轮完成退出码/可见性 | 见上 | ✅（工具箱内） |
| M4 交接链不在 git | **未改** `.gitignore`（策略，不擅动） | — | ⬜ 未做（有意） |

#### B3 最初清单里的「产品边界」（1.4）

| 项 | 本轮是否动 | 说明 |
| --- | --- | --- |
| Synology / M2 索引 | ❌ | 最初就标为后续里程碑，不在「问题」必改集 |
| 语义检索 / 语音 | ❌ | 同上 |
| Docker/NAS 验收 | ❌ | 环境不具备；仍标未验证 |
| AI 派生可追溯硬化 | ❌ | 未纳入本轮 |

> **审计自问**：主人说「第一轮找出来的**所有**问题」。1.2/1.3 是我明确当作「问题/改进点」列的；1.4 我当时写的是「按需启动」。若主人本意包含 1.4，则 **Synology/语音/检索/Docker 仍欠**——已在此明示，不装完成。

---

## 3. 验证总表（本轮实测数字）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | core / api / web **全绿** |
| `npm test` | **95 / 95**（core 28 + api 57 + web 10） |
| `node .review/verify-production-guard.mjs` | **22/22 PASS** |
| `node .review/verify-search-ui.mjs` | **PASS** |
| `node .review/verify-composer-date.mjs` | **114/114** |
| `node .review/verify-weekclamp.mjs` | **PASS** + exit=0 |
| `node --check` × `.review/*.mjs` | **219 / 0 fail** |

**反向用例（唯一做过的产品闸门反向）**：production-guard 旧洞复现 → 401/500 放行断言变红。

**明确没跑 / 不能当绿的**：

- 全量 `run-acceptance`（A 组会写生产库）
- `verify-settings-ai` 全量（会写 AI 配置）
- `verify-thumbnails` / `verify-composer-shots` / `verify-task-schedule`（弹窗新交互）/ 时光机 E2E
- Docker / NAS

---

## 4. 自我批评（说过的 vs 做到的）

1. **最初建议「不要先拆 `main.tsx`」**，后来在「全改好」压力下只拆了 `DateField` 就收工——**没有假装拆完**；巨石仍在，M1 只算起步。
2. **E3/E4/E5/E7/E8/E10 标了 🟡**：代码改了，但缺与最初同等力度的端到端复测。禁止把 typecheck 绿说成「功能已验收」。
3. **E5 只修了机制，没清历史 51 条账**——当时原话是「查清之前动清理等于拿主人备份做实验」；本轮修的是「以后会清」，不是「已经清完」。
4. **E8 的网格类断言改成 flex 不变量**时删掉了 2×2/3 宽墙的几何检查：这是判据收缩。若产品将来又变回网格墙，新脚本**不会**自动红——已记风险。
5. **PowerShell 吃正则**导致第一次 codemod 失败——已落盘脚本解决；属环境坑，不是产品缺陷。
6. **未改 `.gitignore` 把交接文档纳入 git**——遵守「不做没被要求的事」；但 M4 风险仍在。

---

## 5. 剩余债务（与 `docs/todo.md` 对齐）

| ID | 内容 | 优先级 |
| --- | --- | --- |
| R1 | `main.tsx` / `server.ts` 按域全量拆分 | 高（结构） |
| R2 | 时光机刻度尺画出 `trashed[]`（后端已能读） | 中 |
| R3 | 对账 §4 历史 51 条是否被下轮 prune 清掉 | 中 |
| R4 | 隔离实例重跑：settings 尺子、thumbnails、composer-shots、task-schedule 弹窗、timemachine | 中 |
| R5 | 全量 `run-acceptance` 在**隔离**工作区跑一轮 | 中 |
| R6 | Docker/NAS 真机部署验收 | 发布前 |
| R7 | 若主人把 1.4 算进「所有问题」：Synology 索引 / 语义检索 / 语音 | 产品决策 |

---

## 6. 文件级改动清单（可回滚映射）

| 文件 | 轮次 | 作用 |
| --- | --- | --- |
| `.review/lib/production-guard.mjs` | A | fail-closed |
| `.review/verify-production-guard.mjs` | A | 401/500/缺目录夹具 + SKIP |
| `.review/verify-weekclamp.mjs` 等 6 个 | A | stdout + exit |
| 22 个 probe/verify/_audit | B | `process.exitCode` |
| 96 个 `.review/*.mjs` | B | `createProfile` |
| `.review/run-acceptance.mjs` | B | 口径 / FAIL / SKIP |
| `.review/verify-settings-ai.mjs` | B | 40–44 + 窄白名单 |
| `.review/verify-thumbnails.mjs` | B | 进 `data/photos` |
| `.review/verify-composer-shots.mjs` | B | flex 不变量 |
| `apps/api/src/backup-timeline.ts` | B | `_trash` / `remote-trashed` |
| `apps/api/src/backup.ts` | B | prune 路径兜底 |
| `apps/web/src/main.tsx` | B | 手机搜索按钮；弹窗 TaskScheduleField；DateField 移出 |
| `apps/web/src/date-field.tsx` | B | **新增**（含 panelShiftX） |
| `apps/web/src/task-schedule.tsx` | B | panelShiftX + fixed 面板 |
| `apps/web/src/styles.css` | B | 手机搜索可见；is-fixed；dialog-field-wide |
| `apps/web/test/pure.test.ts` | B | **新增** 10 项 |
| `package.json` | B | `test:web` |

产品代码对应 git：`a14c471`。`.review/` 与本文档不在 git。

---

## 7. 追加模板（每次修改后必须贴到文末）

```markdown
## [轮次名] · YYYY-MM-DD

- **AI**：<名字/模型>
- **触发**：<主人原话或任务授权>
- **对应最初问题**：<E1/E2/M1/… 或「新发现」>
- **改了什么**：<文件 + 行为；没有改产品就写「仅验收/文档」>
- **怎么验证**：<命令 + 数字；没跑就写「未验证」>
- **反向用例**：<做了什么、红了什么；没做写「无」>
- **与最初判断的偏差**：<说错/做少/做多的地方；无则写「无」>
- **新增剩余债务**：<R# 或「无」>
```

---

## 8. 日志

### [轮 A+B] · 2026-09-22

- **AI**：MiMo
- **触发**：主人要求回滚点后修复；随后要求第一轮问题全改好；本文件由主人点名要求建立
- **对应最初问题**：E1–E10、M2、M3、M1（部分）
- **改了什么**：见 §2、§6
- **怎么验证**：见 §3（95/95、114/114、22/22、search-ui PASS）
- **反向用例**：production-guard 旧洞 → 401/500 断言红
- **与最初判断的偏差**：M1 只完成 DateField 拆分；E3/E4/E5/E7/E8/E10 缺完整 E2E 复测；1.4 产品边界未做（若算「所有问题」则欠 R7）
- **新增剩余债务**：R1–R7（见 §5）

### [轮 C · 专拆 main.tsx] · 2026-09-22

- **AI**：MiMo
- **触发**：主人「接下来 专拆 main.tsx」
- **对应最初问题**：**M1**（`main.tsx` 上帝文件）；顺带把 R1 做掉大半
- **改了什么**：
  - **新增模块**：`app-types.ts`、`app-meta.ts`、`mention.tsx`、`shell-nav.tsx`、`timeline-states.tsx`、`shot-drop-zone.tsx`、`composer.tsx`、`entity-forms.tsx`、`timeline.tsx`、`calendar-view.tsx`、`task-summary.tsx`、`record-dialogs.tsx`、`dialogs.tsx`、`settings-cards.tsx`（+ 此前 `date-field.tsx`）
  - **`main.tsx`：4516 行 → 1294 行**（约 −72%），只留 App 壳、cacheRecords、root 挂载
  - **去重**：`timeline.tsx` 里的日历/周期大块删除（与 `calendar-view.tsx` 重复），timeline 现约 454 行
- **怎么验证**：
  - `npm run typecheck` → core / api / web **全绿**
  - `npm test` → **95 / 95**（core 28 + api 57 + web 10）
- **反向用例**：无（纯结构搬迁，未改行为）
- **与最初判断的偏差**：
  1. **中途踩了「裁掉未落盘」**：抽取脚本先写模块、后改 main，其中一步抛错导致 `TaskSummary` / `RecordEditorDialog` / `CalendarView` / `Timeline` 被从 main 删掉却没进模块。**已用 `git show HEAD:apps/web/src/main.tsx` 找回并拆好**——教训是**必须「先写模块、验证存在，再改 main」**，且改 main 前先落盘。
  2. **曾过度合并**：`shot-drop-zone` / `timeline` 一度吸入相邻大块；已截断/去重。
  3. **`server.ts` 仍未拆**（M1 的 API 半边）。
  4. **未跑浏览器 UI 验收**（结构搬迁后应用是否仍可点，只有 typecheck + 单测背书）。
- **新增剩余债务**：
  - **R8**：`apps/api/src/server.ts` 同样按路由域拆分
  - **R9**：拆分后跑一轮浏览器验收（`verify-selectability` / `verify-calendar-edit-ui` 等）证明 UI 行为未漂
  - **R10**：`settings-cards.tsx` 仍 769 行，可再按 AI/备份/天气/照片拆

### [轮 D · R9 UI 验收 + R8 起步] · 2026-09-22

- **AI**：MiMo
- **触发**：主人「听你的 继续」→ 按建议先 R9 再 R8
- **对应最初问题**：**M1** 收尾证据（R9）；**R8** `server.ts`
- **改了什么**：
  - **R9（验证，非改产品）**：拆分后 UI 全绿
  - **R8 起步**：新增 `apps/api/src/http-kit.ts`（HttpError / setJson / setEmpty / backupHttpError）与 `apps/api/src/asset-static.ts`（扩展名、媒体类型、上传、本地原件解析）；`server.ts` 2748 → 约 2560 行。**`createApp` 路由壳未拆**。
- **怎么验证**：
  - `verify-selectability.mjs` → **PASS (59 checks)**（含「浏览器控制台没有报错」）
  - `verify-weekclamp.mjs` → **PASS**
  - `verify-search-ui.mjs` → **PASS**（zero console errors）
  - `verify-composer-date.mjs` → **114/114**
  - `npm run typecheck` 全绿；`npm test` → **95 / 95**
- **反向用例**：无
- **与最初判断的偏差**：
  1. **R8 第一次抽取又切串**（http-kit 吸进 buildRecord、movie 吸进 place 字段）→ **`git restore --source=HEAD -- apps/api/src/server.ts` 后改为一次一块**。与轮 C 同一课，这次恢复更快。
  2. **R8 只完成约 8% 体量**（两块纯工具层）；**不是「server 已拆完」**。电影字段 / 字段校验 / `createApp` 路由仍挤在 `server.ts`。
- **新增剩余债务**：
  - **R8b**：继续拆 `server.ts`（字段校验 → 电影输入 → `createApp` 按 `/api/*` 路由域）
  - **R9b**（可选）：隔离实例再跑 `verify-calendar-edit-ui` 等重型浏览器套件

### [轮 E · R8b/c 服务器工具层拆完] · 2026-09-22

- **AI**：MiMo
- **触发**：主人「按你的 推荐」→ 继续 R8b
- **对应最初问题**：**M1 / R8b**
- **改了什么**：
  - 新增 `field-validate.ts`（JSON/字段/周期校验、`parseNoteDetails`）、`record-builders.ts`（`buildRecord` / `patchRecord` / 引用校验 / `withMentionRefs`）、`movie-input.ts`（电影与地点字段、实体合并）
  - **`server.ts`：2748 → 1858 行**（约 −32%）；工具层合计约 1166 行在外
- **怎么验证**：`npm run typecheck` 全绿；`npm test` **95 / 95**
- **反向用例**：无（纯搬迁）
- **与最初判断的偏差**：
  1. **`createApp` 路由壳（约 1300 行）本轮未拆**（R8d 保留）——server **没有拆完**，只是工具层出清。
  2. 抽取过程中多次「import 没写全 / 替换命中调用点」；用落盘脚本 + typecheck 逐条清掉。
- **新增剩余债务**：
  - **R8d**：`createApp` 按 `/api/records|entities|assets|backup|weather|ai|modules` 拆路由
  - **R10**：`settings-cards.tsx` 再切

### [轮 F · R8d 路由域拆分（backup + records）] · 2026-09-22

- **AI**：MiMo
- **触发**：主人「继续」
- **对应最初问题**：**R8d**
- **改了什么**：
  - 新增 `route-context.ts`（`RouteContext` / `RouteHandler`）、`http-body.ts`（`readBody` / `requireJsonContentType` / `readRawBody`）、`timeline-query.ts`（日期过滤/排序）、`summary-routes.ts`、`routes-backup.ts`、`routes-records.ts`
  - **`server.ts`：1858 → 1293 行**（相对最初 2748 约 **−53%**）
  - `handleApi` 里 backup / records+summaries+export-import 变成两行委托
- **怎么验证**：`npm run typecheck` 全绿；`npm test` **95 / 95**
- **反向用例**：无（纯搬迁）
- **与最初判断的偏差**：
  1. **自动大段 splice 又伤过 server**（`return;` 未转 `return true`、async 被剥、import 切串）→ **`git restore` 后改为「按行号切 + 手写 import 头」**才绿。同一课第三次。
  2. **weather / ai / movie / modules / entities / assets 路由仍在 `server.ts`**——R8d **未做完**，不是「路由拆完了」。
- **新增剩余债务**：
  - **R8d2**：继续拆 weather / ai+movie / modules / entities / assets 路由（照 `routes-backup` 样板）
  - **R10**：`settings-cards.tsx` 再切

### [轮 H · 产品功能：时光机灰点] · 2026-09-22

- **AI**：MiMo
- **触发**：主人选 **B（做功能）**，用人话解释后拍板
- **对应最初问题**：R2（时光机看不到已清理快照）
- **改了什么**：
  - 后端 `TrashedBackupEntry` 增加 **`startedAt`**（按拍摄日归轴，不是清理日）
  - 前端 `TimeMachine` 把回收站快照**画上同一根刻度尺**（灰点 / 「已清理」），仍可点开回看（后端早已支持读 `_trash`）
  - 文案：「另有 N 条清理记录在回收站（轴上灰点，30 天内仍可回看）」
  - CSS `.tm-point.is-trashed` 半透明 + 灰点
- **怎么验证**：`npm run typecheck` 全绿；`npm test` **95 / 95**
- **反向用例**：无（未做浏览器 E2E；建议你打开时光机看一眼灰点）
- **与最初判断的偏差**：无重大偏差；`startedAt` 是补上的字段（原先只有 `prunedAt`，会把清理日当拍摄日）。
- **新增剩余债务**：R3（历史 51 条账未对账）仍留；浏览器验收可选补。

### [轮 I · 产品：PC 周历上一周预览] · 2026-09-22

- **AI**：MiMo
- **触发**：主人「周历 PC 空间足，下边显示上一周；弱化但不能看不清」
- **对应最初问题**：新需求（非第一轮清单）
- **改了什么**：`calendar-view.tsx` 周模式下在本周 7 卡下方加一排「上一周」（`week-grid-prev`）；`styles.css` 在 ≥901px 显示，**opacity 0.78 + 字号小半档**（不用浅灰字），hover 恢复清晰；手机不显示。
- **怎么验证**：`typecheck` 绿；`npm test` **95 / 95**
- **反向用例**：无
- **与最初判断的偏差**：弱化用「整卡略淡 + 字略小」而不是降低文字对比度——主人强调「不能看都看不清」。
- **新增剩余债务**：可选——上一周要不要照片底。

- **AI**：MiMo
- **触发**：主人「继续」
- **对应最初问题**：**R8d2**
- **改了什么**：
  - 新增 `routes-entities.ts`、`routes-assets.ts`、`routes-weather.ts`、`routes-ai-movie.ts`、`routes-modules.ts`、`http-cookies.ts`；`http-kit.ts` 补 cookie/session 小助手
  - **`server.ts`：1293 → 约 540 行**（相对最初 2748 约 **−80%**），只留 auth/health、`createApp` 装配、`serveStatic`
- **怎么验证**：`npm run typecheck` 全绿；`npm test` **95 / 95**
- **反向用例**：无（纯搬迁）
- **与最初判断的偏差 / 踩坑（重要）**：
  1. **`handleRecordsRoutes` 调用链丢了**：后续抽取把 `if (await handleRecordsRoutes…)` 从 `handleApi` 里吃掉，typecheck 仍绿（只是 import 还在），**npm test 立刻 18 红（`404 !== 201`）**。修法是把调用塞回 chain。**教训：每次抽路由后必须 grep `if (await handle\w+Routes` 数一遍，确认每个域 handler 都还在链上——typecheck 不会抓「少了一次调用」。**
  2. `weatherLocationOverride` 曾被我用错误假想实现覆盖 → 从 `git show HEAD` 抄回原函数。
  3. `routes-assets` 吸进了实体关系路由（end marker 过宽）；目前一并放在 assets 模块里，能跑，**边界不纯**。
- **新增剩余债务**：
  - **R8d3（可选）**：把实体关系从 `routes-assets` 挪回 `routes-entities`；给每个域 handler 加「调用链在场」的冒烟断言
  - **R10**：`settings-cards.tsx` 再切

