# AI 管家控制界面 · 执行方案（P0）

> 讨论背景见 `.workbuddy-ai/memory/2026-10-10.md` 的 16:10 / 16:37 / 16:44 三条。
> **状态：已定案，正在施工。** 蛋妞 2026-10-10 16:44 确认了全部 5 条结论与两个硬判断。
> 范围：**P0 = 只读查询 + 界面导航 + 隐私总开关与授权流程。不含任何写操作。**

---

## 0. 一句话结论

蛋妞要的「我说展示我姐姐这 30 天的日记，它自动帮我勾选」**不需要新架构**。
需要的是把「对话」升级成「**服务端编译过的命令**」，再加一层隐私授权。

---

## 1. 现状（带证据，动手前请复核行号）

| 事实 | 证据 |
| --- | --- |
| AI 现在是**明文只读** | `apps/api/src/assistant.ts:111`「你是只读助手…需要操作时请告诉用户去对应页面完成」 |
| **对话的真实载体是辅记** | 前端只调 `/api/ai/backfill/chat`（`apps/web/src/assistant-history-api.ts:95` → `chatBackfill`，`apps/api/src/assistant-conversation.ts:30`） |
| **`/api/ai/assistant` 前端一次都没调过** | 全仓只有 `apps/api/test/api.test.ts` 在用它。**命令必须挂在辅记链路上，不是这里。** |
| 结构化 JSON 已经跑通 | `assistant-backfill.ts:198-207`：模型返回 JSON → 校验 → 前端渲染确认卡 |
| 前端**没有 router** | `apps/web/src/main.tsx:290` `activeView` state；只有 settings 用 hash（`:463`）。跳转 = 调函数 |
| 筛选是**可序列化对象** | `apps/web/src/search-filters.tsx:5` `SearchFilters`；`:14` `searchFilterParams()` |
| 已有硬编码的「AI → 界面」特例 | `main.tsx:1746` `onViewRecords`（设 `assisted` 筛选 + 切 today）、`onOpenEntity` |
| 实体有别名机制 | `packages/core/src/mention.ts:44` `entitySearchTerms` = `name` + `aliases` |
| **没有「姐姐」这类具体称谓** | `packages/core/src/model.ts:88-92` `RelationKind` 只有 colleague/friend/partner/family |
| 草稿已落 localStorage | `apps/web/src/composer-draft.ts:45` ⇒ 切视图不丢输入 |
| **没有全局隐私开关** | 隐私记录今天"进列表但遮住 + 点击显示"：`apps/web/src/timeline.tsx:550-551`；日历**直接排除**：`calendar-view.tsx:848` |
| **没有审计日志基础设施** | 全库 `grep audit` 只命中注释 |
| 记录接口**不支持隐私参数** | `routes-records.ts` / `repository.ts` 无 `privacy`/`includePrivate` |
| AI 上下文三处都过滤隐私 | `assistant.ts:40`、`assistant-conversation.ts:69`、`assistant-backfill.ts:197` |
| AI `baseUrl` 在非共享来源下**不设限** | `ai-config.ts:155-161`：只在 `source === "shared"` 时限制 ⇒ **本地桩服务器可当假模型**（§7.1） |

---

## 2. 架构：一条命令总线

```
你说一句话
  → 模型只输出「意图 JSON」（不碰数据、不碰界面）
  → 服务端编译成 UiCommand[]（白名单 + 参数校验 + 实体解析）
  → 客户端按命令名查执行器并执行
  → 界面真的改变
```

**铁律：前端只接受服务端编译后的命令，绝不执行模型的原始输出。**

### 2.1 传输

挂在**辅记对话**上（`BackfillChatAnswer`，`packages/core/src/assistant-backfill.ts:101`）加一个可选字段：

```ts
{
  reply: string;
  action: "reply" | "draft" | "commit" | "undo";
  mode: "ai" | "rules";
  batch?: BackfillBatch;
  ui?: UiTurnPlan;     // 新增；缺省 = 纯聊天，行为与今天一致
}
```

> 字段叫 `ui` 而不是 `plan`：`plan` 已经被辅记的草稿占用了。`action: "reply"` 时携带 `ui`。
> 不新开端点、不新开聊天框 —— 蛋妞已经在用的那个面板就是入口。

### 2.2 命令契约（**已落盘**）

`packages/core/src/ui-command.ts`，一张表三个用途：

1. **自动生成 AI 的工具说明**（`describeUiCommands()`）→ 新增能力 AI 自动学会，不用手改 prompt。
2. **驱动客户端 dispatch**（`UI_COMMANDS[].scope`）。
3. **当验收断言的入口**（`UI_COMMAND_TYPES` 就是覆盖度清单）。

**P0 没有写命令，并且有测试守着**：`core.test.ts` 断言 `record.create / record.update / record.delete / task.setStatus / settings.open` 都不在表里。

---

## 3. 命令清单（P0，校验已实现）

| 命令 | 参数 | 执行 | 说明 |
| --- | --- | --- | --- |
| `search.records` | `query / kinds / personIds / placeIds / entityIds / statuses / attachments / entityTypes / backfill / assisted / from / to` | 客户端设 state + 服务端查数据 | 字段**一一映射** `SearchFilters`，不新造词汇 |
| `view.goto` | `view`（today/timeline/calendar/tasks/notes/entities/timemachine） | 客户端 | 复用 `navigate()`（`main.tsx:925`）。**`settings` 故意不在内**：那里放着凭据 |
| `date.goto` | `date` | 客户端 | 不能跳未来 |
| `entity.open` | `entityId` | 客户端 | 开人物/地点卡 |
| `record.focus` | `recordId` | 客户端 | 滚到该条并高亮（**只读**） |
| `privacy.requestAccess` | `reason` / `scope` | 客户端渲染确认卡 | 见 §4 |

一次回复的结构（`UiTurnPlan`）：

- `commands` —— 立即执行（祈使句）
- `offers` —— 等用户点的按钮（疑问句）
- `clarify` —— 歧义反问（见 §5）

**`clarify` 与 `commands` 互斥**，有测试守着：词指向多个实体时，既问又猜是最容易造成"筛错了还很自信"的组合。

### 3.1 蛋妞的例子，编译结果

```jsonc
// 输入：「展示我姐姐这 30 天的日记」（今天 2026-10-10）
{ "commands": [
    { "type": "search.records", "params": {
        "personIds": ["<姐姐的 entityId>"], "kinds": ["journal"],
        "from": "2026-09-11", "to": "2026-10-10" } },
    { "type": "view.goto", "params": { "view": "today" } }
] }
```

回话："找到 12 条，已经帮你筛好了。"
界面上：筛选条出现 **「人物：姐姐」** 与 **「09-11 → 10-10」** 两个 chip（可单独移除、可继续叠加）。

---

## 4. 隐私：三层权限

### 4.1 第 1 层：页面上的总开关（**已定案**）

- **位置**：桌面侧边栏**左下角、设置上方**（`apps/web/src/shell-nav.tsx:15` 的 `.sidebar-footer` 内，设置按钮之前），拨钮开关。
- **默认：关 = 不显示隐私记录，AI 也不找。**
- **分工（蛋妞 16:44 定的）**：**开关 UI 蛋妞自己做**；我只做状态与内容层——状态读写、列表过滤、AI 上下文开关，并留好接线点。
- **持久化**：localStorage（照 `AIAssistant.tsx:10` 的 `LAUNCHER_POSITION_KEY` 做法）。
- ⚠️ **这是行为变更**：今天隐私记录默认**出现在时间轴里**（只是遮住）。开关默认关之后，默认就**看不到**了。已获蛋妞确认。

### 4.2 第 2 层：AI 申请授权

- **AI 不能自己开权限。** 它只能产出 `privacy.requestAccess`，由客户端渲染成确认卡
  （复用辅记那套"草稿卡 + 确认"的形态）。
- 按钮：**本次允许** / **本次会话允许** / **不用了**。默认粒度 = **本次查询（一次性）**。
- 授权后：筛选条上出现一个**醒目且可一键移除**的「含隐私」chip —— 授权必须**可见、可撤回**，不许静默。
- ⚠️ **"AI 觉得找不着东西"必须是确定性判断，不能靠模型的主观感觉。** 授权前模型的上下文里
  **根本没有**隐私记录，它无从"觉得"。
  **已实现（比原方案更简单）**：筛选在客户端执行，所以判定也在客户端 —— 结果为空 **且** 有记录
  被开关挡住 ⇒ 由客户端直接出授权条。服务端不需要参与，也不必让模型知道隐私记录存在。
  配套：`privacy.requestAccess` 标为 `modelFacing: false`，**不进 prompt** —— 一个能索要权限的模型，
  也会在自己没找到东西时索要。

### 4.3 第 3 层：数据外发红线（**已定案**）

**授权"AI 搜隐私" ≠ 授权"把私密正文发给模型服务商"。**

`assistant-conversation.ts:69` 会把记录正文拼进 prompt 发给 DeepSeek。一旦包含隐私记录，
**私密日记正文就永久离开了本机**（`docs/roadmap.md:37` 提到的"数据外发策略"）。不可撤回。

| 档 | 做什么 | 数据是否外发 | P0 |
| --- | --- | --- | --- |
| **A 本地检索** | 筛选、计数、日期分布全在服务端本地做；模型只拿到"有 N 条匹配"这类**不含正文的元数据** | ❌ | ✅ **已做** |
| **B 外发分析** | 把隐私正文发给模型 | ✅ | ❌ 单独立项，逐次点头 |

**档 A 已实现（2026-10-10 19:30）**，形状比原文更简单：
- 隐私正文**本来就**被过滤在 `context` 之外（`assistant-conversation.ts`），模型从来没拿到过。
- 缺的是**"有几条"** —— 模型只数自己看得见的，报出来的总数**悄悄偏小**，主人无从察觉。
- 所以客户端把**生效中的开关状态**（`privacyShown`，含会话授权与一次性授权）随消息发给服务端，
  服务端算出 `privateCount`，在 system prompt 末尾补一句**不含正文的通知**：
  「另有 N 条隐私记录：正文不提供给你…（开关开着 ⇒ 主人自己在界面上看得到 / 关着 ⇒ 主人自己也看不到）」。
- **逐条查询的"有 N 条匹配"仍在客户端**：筛选在客户端执行，授权条上的「这次筛选有 N 条隐私记录符合条件」
  就是它。服务端那份是**全局计数**，两者不重复。
- 验收：`.review/verify-ai-control.mjs` 新增 4 项 —— 通知里有数字、开关关/开两种措辞、
  **隐私正文从未出现在任何一条系统提示里**（档 A 红线，端到端）。

---

## 5. 实体消歧：两个人都是「姐姐」怎么办（蛋妞 16:44 的提问）

### 5.1 别名本来就不该是唯一键

`entitySearchTerms` 回答的是"这个词能指向哪些实体"。返回 2 个是**正常结果**，不是数据错误。
「姐姐」是**从说话人角度看的关系**，不是标识符 —— 禁止它多义才是错的。
所以 **王素和王琳都带别名「姐姐」是允许的**，系统不需要"解决"它，只需要**正确地不猜**。

### 5.2 匹配到多个 → 反问，而且必须问得能区分

不能问"你说的是哪个姐姐"（主人没法回答）。要问成 **候选 + 可区分线索**：

> 你说的「姐姐」对应哪一位？
> **王琳** · 上次一起出现在 2 天前
> **王素** · 上次一起出现在 3 个月前

线索全部已在库里：`EntityRelation`（family/…）、`description`、以及**该实体最近的记录日期**（`entityRefs`）。
用"最近一次共同出现"排序，几乎总能一眼认出来。`resolveUiEntity` 先返回结构化候选，线索由服务端补（服务端才有记录）。

### 5.3 三条路里两条是错的

- ❌ **把「姐姐 → 王琳」存成全局映射**：下次说姐姐只给王琳，王素永远被埋掉。
- ❌ **把「姐姐」塞进 `EntityRelation.note`**：`model.ts:94` 明确写了 relation 是**对称的**
  （"The edge is symmetric: both sides store it"）。「姐姐」是**不对称**称谓 ——
  王琳那条边反过来读会变成"王琳是姐姐"，语义就错了。**relation.note 不是它的家。**
- ✅ **正解**：别名允许多实体共享（保持不唯一）；歧义时反问；**会话内**记住本次选择；
  并顺手建议一个更独特的叫法。

### 5.4 蛋妞说的「问出来以后 AI 帮我补一个别名」

- 主人回答"王琳"后，AI 在**本次会话**里把"姐姐"临时绑定到王琳 —— 只活在这轮追问链里，**不写库**。
- 同时提议："要不要给王琳加个更好区分的叫法，比如「琳姐」？" —— 主人点头才真的加。
- **补别名是写操作 → P1**（同批写命令，走确认卡）。P0 只做**只读的建议 + 跳转**（跳到联系人编辑页，主人自己加）。
- 结果：「姐姐」保持多义、随时可问；「琳姐」成为**唯一**叫法，以后一句话直达。
  **用户自己的用词习惯才是唯一键，AI 不该替他发明映射。**

---

## 6. 交互规则

| 情形 | 行为 |
| --- | --- |
| 祈使句（"打开姐姐的资料"） | **直接执行**（`commands`） |
| 疑问句（"姐姐最近都写了什么"） | 只回话 + `offers` 按钮，不抢界面 |
| 实体歧义 | `clarify` 反问，**不下发任何命令** |
| 单次回复 | 最多 1 个跳转 + 1 个筛选，禁止"连环跳" |
| 执行后 | 移动端自动收起面板（`lifeos:close-ai`，`AIAssistant.tsx:102`）；筛选条出现 chip；toast 说明做了什么并带「撤销」 |

**参照物**：clockin-b 的 `AssistantAction` + `autoNavigate`（`D:\apps\clockin-b\lib\ai\attendanceAssistant.ts:9`；
前端 `components/AIAssistant.tsx:434-435,470`），以及它的 **`AssistantPlan`**（`:96-115`）——
**模型只负责理解，执行是确定性代码**。这一条直接照搬。
**不照搬**它把状态塞 URL 的做法（LifeOS 没有 router，硬上改动面比功能本身大）。

---

## 7. 验收设计

### 7.1 假模型回放（**已确认零改产品代码可行**）

`ai-config.ts:155-161` 只在 `source === "shared"` 时限制 `baseUrl`。隔离实例里用
`LIFEOS_DEEPSEEK_*` 环境变量（`source === "env"`）把 `baseUrl` 指向本地桩服务器即可：

```
起一个 OpenAI 兼容的 stub（返回固定 JSON 的 /v1/chat/completions）
→ 隔离实例（LIFEOS_DATA_DIR=.review/ai-control-run/data）的 AI baseUrl 指向它
→ 注入固定回复 → 断言界面结果
```

**模型输出不稳定，验收不能靠真模型。** 这是能不能开工的前提，**先做**。

### 7.2 断言点（CDP，客观可量）

- 筛选 chip 文案（`SearchFilterChips`，`search-filters.tsx:22`）
- 结果计数：`RecordSearch` 的 `count`（`main.tsx:1734` 已传入）
- 视图：`.app-shell[data-view]`
- 隐私：开关关闭时隐私记录**不在**结果里；`privacy.requestAccess` 卡出现；授权后「含隐私」chip 出现

### 7.3 纪律（照 `AGENTS.md` 验收铁律）

脚本 `.review/verify-ai-control.mjs`，**自带隔离 `LIFEOS_DATA_DIR`**，绝不碰 `data/`。
跑前 `node .review/audit-toolbox-targets.mjs`；崩溃必须变成 FAIL；断言必须自带证据。

---

## 8. 进度

### 已完成（2026-10-10）

**第一块 · 命令契约**
- `packages/core/src/ui-command.ts`：类型、注册表、`describeUiCommands()`、`resolveUiEntity()`
  （含"两个姐姐"的消歧）、`validateUiCommand()`、`validateUiTurnPlan()`
- `modelFacing` 标记：`privacy.requestAccess` **不进 prompt**（见 §4.2 的修正）

**第二块 · 服务端编译**
- `compileUiTurnPlan()`：模型写「姐姐」这样的称呼，服务端翻成 id；翻不出 → **整条命令丢弃**（放宽条件
  会让主人看到所有人的记录）；翻出多个 → `clarify`，**本次跳转与筛选一并取消**
- `chatBackfill` 接 `describeUiCommands()` 进 prompt；`envelope.ui` 编译后挂到 `BackfillChatAnswer.ui`
- 丢弃的命令走 `console.error("[assistant-ui] …")`，不静默

**第三块 · 客户端执行与渲染**
- `main.tsx` `runUiCommand` / `runUiPlan`：**先导航、再筛选、最后聚焦**（`navigate` 会清筛选）
- `assistant-backfill.tsx`：`offers` 按钮、`clarify` 候选卡（点了回一句「「姐姐」是王琳」，
  由同一条链路再解析，**不写库**）
- **隐私总开关**：`privacy-visibility.ts`（localStorage，默认关）+ `loadedVisibleRecords` 过滤
  + 侧边栏事件契约 `lifeos:privacy-visibility`
- **授权询问由客户端发起**：筛选结果为空 **且** 有记录被开关挡住 → 面板底部出授权条
  （本次 / 本次会话 / 不用了）。**这是对 §4.2 的修正**：模型看不到隐私记录，无从"觉得"；
  服务端也不执行筛选，所以判定只能落在客户端

**验收**：core **44/44**、api 135/135、web 62/62、instance-backup 7/7、ui-policy 3/3；
全仓 `npm run typecheck` 全绿。**没起服务、没碰 `data/`。**

**第四块 · 假模型回放验收（唯一还没做的前提，已补上）**
- `.review/verify-ai-control.mjs` —— **40 项断言，40/40 PASS**，8 个阶段（隔离与写保护 / 歧义先问不猜 /
  筛选落地 / 跳页面与日期 / 滚到记录并高亮 / offers 只呈现不自动执行 / 隐私三档授权 /
  认不出的词与未来日期与设置页一律拒绝且留痕 / **全程只读**）
- 桩：本地 OpenAI 兼容 server 回放固定信封；**零改产品代码**（`source = env` 不锁 `baseUrl`）
- 它当场抓出并修掉的三个真缺陷（详见 `docs/changelog.md` 2026-10-10 18:40）：
  1. **追问卡刷新即消失** → `assistant_messages.ui_json` 持久化（含回归测试）
  2. **AI 一筛选面板就自己收起** → `lifeos:open-ai` 让面板保持在前
  3. **`record.focus` 高亮环从没亮过** → 高亮改为由 React 渲染 `className`，不再手工 `classList.add`

**第五块 · 档 A 的「有几条」（见 §4.3）**
- 客户端把生效中的开关状态随消息发出；服务端在 system prompt 末尾补一句**不含正文**的隐私通知
- `privacyVisible` 要**同时放行两处白名单**：`routes-assistant-backfill.ts` 的 `hasOnlyKeys`
  与 `assistant-chat-history.ts:validateRequest` 的 `hasOnlyKeys`，并经 `runTurn` 透传给 `chatBackfill`
  （漏一处 = 静默 400）。**不进请求指纹**：开关是环境上下文，不是这轮请求的身份

### P0 剩余

1. 侧边栏开关 UI（**蛋妞自己做**；接线点已备好）
2. 档 B（隐私正文外发分析）—— 单独立项
3. **真实模型未验证**：本轮只证明「编译 → 执行」管线对，没证明真实模型肯不肯这么答

### P1

- 打开详情（记录/人物卡/某天日历）、时光机跳日期、设置页跳转
- **补别名**写命令（§5.4）+ 隐私授权审计表
- 档 B（隐私正文外发分析），逐次确认

### P2

- 写入命令（新建记录、改任务状态），走辅记的"预演卡 + 确认"
- 全站覆盖度自检：注册表 vs 页面可交互元素清单

---

## 9. 已定案（原"未决问题"）

| # | 结论 |
| --- | --- |
| 1 | 总开关**默认关 = 不显示隐私**；UI 蛋妞自己做，我只做状态与内容层 |
| 2 | 「姐姐」走**别名 + 反问兜底**；补别名由 AI 建议、主人点头（P1 写命令） |
| 3 | 开关放**桌面侧边栏左下角、设置上方** |
| 4 | `record.focus` **保留**（"找到了"到"我看见那一条"的闭环，成本低） |
| 5 | **档 B 不做**，P0 只做本地检索、不外发隐私正文 |
