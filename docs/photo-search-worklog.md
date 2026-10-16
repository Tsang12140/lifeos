# 工作日志：把照片语义描述接进记录搜索

> 用途：万一后面要**审查**这项工作，这里的每一步都留了依据（改了什么、为什么、怎么验证的、原始命令与结果）。
> 接手人：WorkBuddy（本机 AI）｜开始：2026-10-15 20:50（GMT+8）
> 相关前置材料：`docs/handoff-photo-search.md`（交接包）

---

## 0. 本轮范围（先划清楚，避免越界）

**做**：第 ② 层「字面并入」——让 `GET /api/records?q=…`（界面搜索）能命中记录里已存的照片描述文字。

**不做**（留给后续，各需单独拍板）：
- 第 ③ 层「语义向量」（+255.7 MB，见 `docs/handoff-photo-search.md` 第 7 节）
- 把照片描述接进 **AI 管家上下文**（`assistant-conversation.ts:128`）——那是另一条链路，且涉及隐私外发红线

**理由**：② 是 ③ 的前置（语料先齐），且零依赖、可回滚、当天可验；先做它不押注任何大决策。

---

## 1. 侦察结论（20:50–20:55）

### 1.1 只改一处

- 界面搜索 `GET /api/records?q=` → `apps/api/src/routes-records.ts:54-82` 收参数 → `repository.list(query)` 在 `apps/api/src/repository.ts:1689-1716` 里拼 SQL 做匹配 → 路由再按 kind/日期/关联对象过滤（`routes-records.ts:124-142`）。
- **匹配只发生在 `repository.list` 的 `WHERE` 里**，所以改这一处即可覆盖「界面搜索」。
- 前端 `apps/web/src/record-search.tsx` 只负责发请求和渲染，**无需改动**（只要后端能匹配上，前端自然显示）。
- AI 管家那条路（`assistant-conversation.ts:128`）**不经过** `repository.list` 的 q，改这里不会影响它——正好，本轮不动它。

### 1.2 现状匹配表达式（要改的就是它）

`repository.ts:1700-1704`，当前只匹配：

```
body_edited / body_original（正文）
note_json.title / note_json.source（笔记标题、来源）
id（记录 id）
关联对象名（EXISTS 子查询 entity.value_json）
```

**没有 `ai_derived_json`** → 这就是「描述搜不到」的根因。

### 1.3 描述在库里的形态（已在 `photo-description.ts:355-365`、`:365` 核实）

`records.ai_derived_json` 是 JSON 数组，描述条目的文字在 **`value.text`**，类型标记在 **`value.type === "photo-description"`**：

```jsonc
{ "id":"…","kind":"summary","provider":"lifeos-photo","model":"…","generatedAt":…,
  "sourceRecordId":"…","sourceRevision":"sha256:…",
  "value":{ "type":"photo-description","variant":"context","key":"sha256:…",
            "assetId":"…","width":1200,"text":"木桌上放着一杯星巴克纸杯，杯身印有“大/热 馥芮白”等字样…" } }
```

- 读取路径 `repository.ts:344`：`aiDerived: parseJson(row.ai_derived_json, "ai_derived_json")` —— **只 JSON.parse，不做逐条校验**，所以直写 DB 造测试夹具是安全的。
- 库中隐私记录不会被写描述（`photo-description.ts` 里隐私照片永不外发），所以**匹配描述不会引入隐私泄漏**。

### 1.4 测试约定

- 测试在 `apps/api/test/*.test.ts`，用 `startHarness()` / `request()` / `json()` / `equal()` / `deepEqual()`。
- 直接写库造夹具的既有范式：`api.test.ts:549-550`（`new DatabaseSync(h.app.config.databasePath)` 然后 UPDATE）。
- 关键词搜索的既有断言范式：`api.test.ts:514`、`:894-896`、`:966-995`。

---

## 2. 设计决策（含取舍）

| # | 决策 | 选择 | 依据 / 被否决的选项 |
|---|---|---|---|
| D1 | 改哪一层 | 只改 `repository.list` 的 SQL | 覆盖界面搜索；不碰前端、不碰 AI 管家 |
| D2 | 匹配哪些档位的描述 | **全部 `photo-description`（三档都算）** | 同一张图三档是三句不同的话（46/51 被改写），合并 = 召回最大；搜索是布尔过滤、无相关度排序，重复文本零副作用。被否决：「只认 context 档」——会白丢 plain/高档独有词 |
| D3 | 匹配字段 | `value.text`，且先卡 `value.type='photo-description'` | 避免匹配到其它类型的 aiDerived 内容（如 `ai-assisted`） |
| D4 | 是否要新依赖 | 否 | 纯 SQL 表达式，符合项目「零框架」风格 |
| D5 | 可回滚性 | 改的是单个字符串常量 | 出问题可一行 revert |

---

## 3. 实施记录

### 3.1 改代码（唯一一处）

- 文件：`apps/api/src/repository.ts`，方法 `list()` 的 `WHERE` 拼接（原 1700-1704 行）。
- 改动：在关键词条件里**新增一条 `EXISTS` 子句**，遍历该记录的 `ai_derived_json`，命中任一 `value.type === "photo-description"` 的 `value.text` 即算匹配；同时把参数从 `[q, q]` 改为 `[q, q, q]`。
- 保持原有三段匹配（正文 / 笔记标题来源 / id / 关联对象名）**一字未动**，只是 OR 上第四段。
- 可回滚性：改的是单个模板字符串常量，`git revert` 一行即恢复。

新增子句（可读版）：

```sql
OR EXISTS (
  SELECT 1 FROM json_each(coalesce(ai_derived_json, '[]')) derived
  WHERE json_extract(derived.value, '$.value.type') = 'photo-description'
    AND instr(coalesce(json_extract(derived.value, '$.value.text'), ''), ?) > 0
)
```

设计要点（对应第 2 节决策）：
- `coalesce(ai_derived_json,'[]')` 防 NULL 报错；
- 先卡 `value.type` 再比 `value.text`，避免误伤其它类型的 aiDerived；
- 不区分 `variant`（D2：三档都算，召回最大）。

### 3.2 加测试

- 文件：`apps/api/test/api.test.ts`，新增用例 `record keyword search also matches stored photo descriptions`（紧跟胶囊搜索用例之后）。
- 手法：照既有范式（`api.test.ts:549-550`）用 `new DatabaseSync(h.app.config.databasePath)` 直写 `ai_derived_json` 造夹具。
- 断言 5 条：① 只写在 **context** 档的词（馥芮白）能命中；② 只写在 **plain** 档的词（STARBUCKS）也能命中（证 D2）；③ 正文词搜索不受影响；④ 非 `photo-description` 的 aiDerived 文字**不得**命中；⑤ 无关词零命中。

### 3.3 编译与测试（含一次环境插曲）

**编译**：`apps/api` 用 `tsc -p tsconfig.json --pretty false`。

- **注意**：`tsc` 报出 1 个类型错误，但在 `apps/api/src/routes-notes.ts:11`（`Property 'map' does not exist on type '{}'`）。该文件是**别人未提交的 WIP**（`git status` 显示 `??` 未跟踪），**与本次改动无关**；`tsconfig` 未开 `noEmitOnError`，产物照常生成。已核对 `dist/src/repository.js` 里确实含新条件与三参数。

**插曲：C 盘被占满，导致首轮整跑出现 87 个失败（无效结果）**

- 首轮整跑 `api.test.js`：87 个 `✖`，集中在**上传/缩略图/备份/时间机**等需要临时目录的用例，全部 ~50ms 秒败；**连既有的** `record search intersects…` 也失败 → 判定为环境故障。
- 根因：`C:` 剩余 **2.3 MB**（`Get-PSDrive C`）。测试用 `os.tmpdir()`（= `%TEMP%`，在 C 盘）建临时库，盘满即失败。
- 排查（只读）：`%TEMP%` 的大目录**都不是本项目的**——`uuvwe34r` 3.55 GB（Visual Studio / .NET SDK 安装器缓存）、一批 125 MB 的 8.3 名目录合计 ~1.7 GB（VS 安装器解包的组件，内含 `PrecheckTools`/`ProxyStub`/多语言目录）、`workbuddy-update-x64` 475 MB（WorkBuddy 自更新包）、`scoped_dir*` 543 MB（Chrome 临时目录）。**本项目的 `lifeos-*` 仅 0.2 MB。**
- 处置：**不删任何非项目文件**（遵守项目红线与记忆里的「别自己扩白名单」）。改为把测试进程的 `TEMP`/`TMP` 指到 E 盘（`E:\Projects\motion-lab\lifeos\.review\_tmp`），已实测 `os.tmpdir()` 生效。
- 复跑（定向）：`--test-name-pattern="search"` → **4/4 通过**（我的新用例 ✔，两个既有搜索用例 ✔ 无回归）。证实 87 个失败确系 C 盘满所致。

### 3.4 整跑 api 测试（E 盘临时目录）

命令：`TEMP/TMP=<E盘> node --test --test-isolation=none dist/test/*.test.js`

**过程与曲折（如实记录，供审查）**

| 轮次 | 方式 | 结果 | 判读 |
|---|---|---|---|
| 1 | Bash 工具，TEMP 默认(C盘) | 87 ✖ | C 盘满 → 环境故障 |
| 2 | Bash 工具，TEMP=E盘 | 162 ✖（跑更远） | 仍是级联失败；且 Bash 工具自身要往 C 盘写，随后 ENOSPC |
| 3 | PowerShell，TEMP=E盘，`*>` 重定向 | 9 分钟输出文件仍为空 | 其实是 **PowerShell `*>` 缓冲**，不是没跑 |
| 4 | PowerShell，单跑 `places.test.js` | **12/12 ✔** | 证明测试框架本身在 E 盘临时目录下**工作正常** → 批量失败是「单进程内一个早期失败连累后续」 |
| 5 | PowerShell，整套 + `--test-reporter-destination`（node 直写文件，避开缓冲） | 见下 | 权威结果 |

**关键结论**：`--test-isolation=none` 把所有测试文件放进**同一个进程**，一旦某个用例抛错（C 盘满时很容易），后续用例会**大面积连锁失败**，制造出「87/162 个失败」的假象。**单独跑则通过**。→ 这正是记忆里「判据要看退出码 + FAIL 行 + 断言条数」的又一个实例：批量红不等于真红。

**磁盘现状（2026-10-15 21:30）**：`C:` 剩余 **0 MB**。占用大头**均非本项目**：`C:\Users\Tsang\.workbuddy` 5.2 GB（其中 `workspace` 1.16 GB、`logs` 1.04 GB 且**仍在增长**、`traces` 0.61 GB）、`%TEMP%\uuvwe34r` 3.55 GB（VS/.NET SDK 安装器缓存）、`%TEMP%\workbuddy-update-x64` 475 MB、一组 VS 安装器解包目录 ~1.7 GB、`scoped_dir*` 543 MB。**本项目在 C 盘的东西只有 `%TEMP%\lifeos-*` 共 0.2 MB。** 结论：**C 盘满与本项目无关，且我没有可安全清理的目标**（按红线不删非项目文件）。规避手段：把测试/工具的临时目录指到 E 盘。

**满盘的实际影响**：0 字节时连**文件写入**都会失败（写工具报 `commit_empty: 磁盘空间不足`）。已请主人手动清理（她同意并清出空间）。

### 3.5 批量失败的真正原因：**测试文件顺序**（重要，别被误导）

拿到 `apps/api/package.json` 才发现，项目自己的测试命令是
`node --test --test-isolation=none dist/test/api.test.js dist/test/contact-avatar.test.js …`——
**一份固定的文件顺序，`api.test.js` 排第一**。

而 `--test-isolation=none` 让**所有测试文件跑在同一个进程里**（共享模块级状态）。我用 `dist/test/*.test.js` 通配是**字母序**（`api`、`archive`、`assistant-history`…），与项目顺序不同 → **大面积连锁失败**。
佐证：`places.test.js` **单独跑 12/12 全过**，放进批量却全红。

→ 教训：**批量红 ≠ 真红**；复现回归必须**照抄项目自己的命令**，别自己拼 glob。

### 3.6 端到端验证：**PASS**

脚本 `.review/verify-photo-description-search.mjs`（新增）：
真实库 `VACUUM INTO` 一致快照 + **真实代码**（同一个 `SqliteRecordRepository.list`）+ 可选打真实 3011 接口；零模型调用、零写生产库。

| 组 | 内容 | 期望 | 实测 |
|---|---|---|---|
| A | 描述独有词（全库正文都没有） | 命中其所属记录 | **12 / 12 ✅**（改动前是 0/12） |
| B | 正文独有词（对照） | 仍命中 | **5 / 5 ✅** |
| C | 无关乱串（否定对照） | 0 命中 | **0 ✅** |
| HTTP | 同上 A 组走真实 3011 接口 | 全部命中 | **12 / 12 ✅** |

- 命中样例：「`木桌上手持映`」（显卡照片描述）、「`圆形猫抓板窝`」（猫）、「`:42”的“`」（音箱上的 23:42）——这些**只存在于照片描述**里的字面信息，现在都能搜到。
- 报告落 `.review/photo-description-search-verify.txt`；**退出码 0**。
- 插曲：快照自清理被 safe-delete shim 拒绝（盘紧张时 trash 会失败），已改为**非致命**（只在报告里提示手动删），不影响判定；残留快照已手动清除。

### 3.7 整跑 api 测试（按项目原样顺序）

命令 = `apps/api/package.json` 里那条（17 个文件、固定顺序），TEMP/TMP 指到 E 盘。

结果：**tests 222 / pass 218 / fail 4**（`ℹ` 汇总行，不是只看 ✔ 计数）。

4 条失败**全部与本次改动无关**，逐条交代：

| 失败用例 | 症状 | 判定 |
|---|---|---|
| archive：full archive imports … | 批量里 500 | **批量上下文假失败**：单独跑 → ✔ |
| archive：full encrypted archive round trip … | 批量里 500 | **批量上下文假失败**：单独跑 → ✔ |
| assistant-history：streamed unsafe actions … | `EPERM` 删临时目录（safe-delete shim） | 环境（沙箱 shim），非代码 |
| assistant-history：chat attachments persist … | 400 `unsafe_ai_action` | 见 §3.8 基线比对 |

### 3.8 基线比对：4 条失败都不是我引入的

为可审查，做了**精确基线**（只把新增的那段子句去掉、其余一字不动 → 重编译 → 跑同一批）：
- `assistant-history.test.js` 在**基线**上同样失败那 2 条（`25 pass / 2 fail`，失败项完全相同）。
- 两个 archive 用例单独跑（有/无我的改动）都 ✔。

结论：**这 4 条失败与「照片描述接入搜索」无关**（分属归档、助手聊天领域），我的改动没有引入任何失败。

### 3.9 复核

恢复改动 → 重编译 → 复核 `--test-name-pattern="search"`：**4 / 4 ✔**（我的新用例 + 两个既有搜索用例）。

---

## 4. 结论

1. **改动**：`apps/api/src/repository.ts` 的 `list()` 里加一条 `EXISTS` 子句（遍历 `ai_derived_json` 命中 `photo-description.text`），参数 `[q,q]`→`[q,q,q]`。**一处字符串，可不留痕回滚。**
2. **效果（实测）**：描述独有词 **0/12 → 12/12**（仓库层与真实 3011 接口都验了）；正文搜索 5/5 不受影响；无关词 0 命中。
3. **测试**：新增 1 条用例（5 断言）；搜索相关 4/4；整套 222 项 218 通过，4 条既有失败与本次无关（已做基线比对坐实）。
4. **未做**：第 ③ 层语义向量；AI 管家上下文接入——都待主人单独拍板。
5. **环境事故留档**：C 盘满（非本项目占用）一度阻塞文件写入与测试；`--test-isolation=none` 必须照抄项目的**固定文件顺序**，否则大面积假失败。

## 5. 手工验收：主人自己怎么点（2026-10-15 晚补）

自动化证据已 PASS，但主人要看的是**界面上能不能真搜到**。为此补了本节 + 一个只读探针。

### 5.1 先说结论：能测

服务端跑的就是带本次改动的代码，证据有三层，都在 22:4x 现场取的：

| 层 | 动作 | 结果 |
| --- | --- | --- |
| 真实 3011 API | `GET /api/records?q=<描述独有词>` | 15/15 命中 |
| **5199 自己**（浏览器走的就是它） | `GET http://127.0.0.1:5199/api/records?q=...` | STARBUCKS / 馥芮白 / 烧霸烧 / MENU 各 1 条命中 |
| 服务目录 | `GET /api/assets/thumbnails` → `directory` | `E:\Projects\motion-lab\lifeos\data\derived\thumbs`（= 生产库 `data/`） |

因为本次**只改后端**，5199 的前端产物无需重编；只要 3011 加载了新代码即可。上表第 2 行正是「浏览器会发出的那种请求」，所以界面里搜同样会中。

### 5.2 手动步骤（约 30 秒）

1. 打开 `http://127.0.0.1:5199/`，停在 **今天** 或 **时间轴** 视图（设置页不显示搜索框）。
2. 看**书写框的工具栏那一行**（「日记 / 任务 / 笔记」类型标签的右边、一排小图标里），有个**放大镜形状的搜索输入框**（无提示文字，就是个胶囊）。
   - 窄屏（手机宽）会自动收成一个放大镜**按钮**，点一下才展开。
   - 代码位置：`composer.tsx:326` 的 `.composer-toolbar-actions` 里渲染 `searchControl`（即 `record-search.tsx` 的 `RecordSearch`）。
3. 在搜索框里打入下表的词，回车。下方会出现「找到 N 条记录」，列出命中的那条记录。
4. 点开那条记录，就能看到照片 —— 而**这个词只存在于照片描述里，正文里根本没有**，这正是本次改动生效的标志。

### 5.3 建议打的词（都由只读探针核过：正文/实体名里都没有，只存在于描述）

| 打入的词 | 命中记录日期 | 这个词来自照片里的什么 |
| --- | --- | --- |
| `STARBUCKS` | 2026-09-29 | 星巴克纸杯杯身印的字 |
| `馥芮白` | 2026-09-29 | 杯身「大/热 馥芮白」 |
| `守制变法竞圣听` | 2026-09-29 | 摊开的书上的标题 |
| `精品茶具` | 2026-10-02 | 纸箱上印的字 |
| `烧霸烧` | 2026-10-04 | 餐厅小票上的店名 |
| `扫码点餐` | 2026-10-04 | 二维码卡片上的字 |
| `MENU` | 2026-10-06 | 饭店菜单封面 |
| `微信扫码 获取排队进度` | 2026-10-06 | 排队小票上的字 |

**对照体感**：改动前打这些词是 **0 命中**（探针 `.review/search-probe.mjs` / `search-probe2.mjs` 量的就是这批）；改动后打同样的词开始出结果。若想自己复现「改前 vs 改后」，把 `repository.ts` `list()` 里那条 `EXISTS` 删掉重编译即可，无需回滚任何其他东西。

### 5.4 只读探针（可重跑）

`.review/probe-ui-photo-search.mjs` —— 从生产库（**只读打开**）里挑「人打得出、又只在描述里出现的词」，再现场打到 3011 上验证，末行给命中数。零模型调用、不写库。

```
"C:/Program Files/nodejs/node.exe" .review/probe-ui-photo-search.mjs
```

### 5.5 别误读的两点

- **搜到记录 ≠ 搜到照片本身**：搜索命中的是「照片所属的那条记录」，结果里显示的是记录；照片在记录卡片里。这是本次的设计边界（第 ② 层只做字面并入）。
- **`千年一叹` 这类词不要用来演示**：它同时出现在别处（搜它命中的是 2026-10-14 那条），证明不了「只有描述里才有」。
