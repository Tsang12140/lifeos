# 交接：把「照片语义描述」接进搜索

AI: WorkBuddy（交接方）
更新：2026-10-15
状态：**未动手，等主人拍板做哪一层。** 本文件是给下一个 AI 的完整交接包——背景、已核实的事实、代码锚点、可复用的实验数据、红线，一次给全，不要重新调研。

---

## 0. 一句话任务

照片已经**全部**被 AI 看过了、每张都写了一句中文描述存进库（150 条：三档各 50）。但**现在的搜索完全不读这些描述**——所以「馥芮白」「9排13号」这类只写在描述里的词，一个都搜不到。

这一次要做的，就是**让搜索也能命中这些描述**。

---

## 1. 为什么做（动机，不是可选项）

- 主人做这件事的原始动机就是「**让 AI / 搜索能搜到照片里的东西**」。描述现在在库里躺着，却搜不到——**卡在最后一米**。
- 项目规划里**早就写了「照片可搜索」**：`docs/phase2-memory-plan.md` 的「再下一步：照片可搜索」一段（第 34–38 行），原文要点：缩略图一次分析、contentHash 去重、增量处理、存短描述/OCR/模型版本/向量、检索后只读取相关媒体。这次的工作就是在兑现这段。

---

## 2. 已建成的东西（现状，全部已核实）

### 2.1 照片描述本身：已完工

- 核心模块 `apps/api/src/photo-description.ts`（~400 行）
- 接口 `apps/api/src/routes-photo-description.ts`
  - `GET /api/ai/photo-description` → 只读统计（photos/described/alreadyDescribed/remaining/skippedPrivate/variant）
  - `POST /api/ai/photo-description` → 跑描述。白名单参数：`limit`(0=只清点不干活, cap 500) / `dryRun` / `recordId` / `kinds`(如 `["journal"]`) / `variant` / `force`
- 测试 `apps/api/test/photo-description.test.ts`（12 项，注入替身、零网络）
- 三个档位（`PhotoDescriptionVariant`，`photo-description.ts:59`）：
  - `plain` = 缩略图 + 一句「描述这张照片。」，**不带正文背景**
  - `context` = 上面 + 该记录正文前 200 字作背景（`PHOTO_DESCRIPTION_BACKGROUND_CHARS = 200`），背景包在 `<背景>…</背景>` 里
  - `context-thinking` = `context` 逐字相同，唯一区别是**开思考**（`thinking: {type:"enabled"}` + `reasoning_effort`）
- 图片用的是 **`?w=1200` 缩略图**（`PHOTO_DESCRIPTION_WIDTH = 1200`），不是原图；**隐私记录永不外发**；`contentHash` 去重；只写 `ai_derived`，**正文一个字不改**。

### 2.2 描述在库里的形态（关键，搜索要读的就是它）

存在记录表的 `ai_derived_json` 字段里，每条长这样（`photo-description.ts:355-365`）：

```jsonc
{
  "id": "<uuid>",
  "kind": "summary",                       // 枚举内的合法值
  "provider": "lifeos-photo",              // PHOTO_DESCRIPTION_PROVIDER
  "model": "<当前模型名>",
  "generatedAt": "<ISO>",
  "sourceRecordId": "<记录id>",
  "sourceRevision": "<item.key>",          // = 图片内容哈希，换文件即失效
  "value": {
    "type": "photo-description",           // ← 认这个字段
    "variant": "context",                  // plain | context | context-thinking
    "key": "sha256:....",                  // 图片内容哈希
    "assetId": "<资产id>",
    "width": 1200,
    "text": "木桌上放着一杯星巴克纸杯，杯身印有“STARBUCKS”、“大/热 馥芮白”等字样…"
  }
}
```

**给搜索用的只有 `value.text`。** 认条目用 `value.type === "photo-description"`。

### 2.3 库里的真实状态（2026-10-15 实测）

| 档位 | 条数 | 说明 |
|---|---|---|
| `plain` | 50 | 低谷半价时段跑 |
| `context` | 51 | 高峰全价跑，后又在低谷**强制重跑**过一次（替换旧的） |
| `context-thinking` | 51 | 高峰全价，已跑完 |

> 「51 vs 50」的 1 条差是**设计内的**：同一张主板照片被**两条记录**引用，各落一份描述。不是重复扣费。
>
> **任务截图 10 张按主人明令永不跑**（只跑 `kind: "journal"`）。

---

## 3. 关键代码锚点（直接跳）

| 要改的地方 | 文件:行 | 现状 |
|---|---|---|
| **记录搜索的匹配 SQL** | `apps/api/src/repository.ts:1700-1704` | `instr()` 只匹配 `body_edited/body_original` + 笔记标题/来源 + 记录 id + 关联对象名。**没有 `ai_derived_json`** ← 第②层就加在这里 |
| 搜索接口入口 | `apps/api/src/routes-records.ts:54-82` | `GET /api/records?q=…`，`q` 上限 2000 字符 |
| AI 管家喂给模型的上下文 | `apps/api/src/assistant-conversation.ts:128` | 只喂 `{id, revision, kind, date, content: 正文前 400 字}`，**没有照片描述** |
| 照片描述模块 | `apps/api/src/photo-description.ts` | 已完成 |
| 前端搜索框 | `apps/web/src/record-search.tsx` | `apps/web/src` 全目录**零引用** `aiDerived` / 照片描述 |

**搜索链路的三条路（界面搜索 / AI 管家 / 前端）全都不读描述——已逐一核实。**

---

## 4. 实测证据：确实搜不到（别怀疑，有对照组）

证据文件 `.review/photo-search-probe.txt`（零 API 调用、只读生产库）：

- **A 组**：拿 12 个「只出现在照片描述里」的词搜界面接口 → **命中 0 条**
  - 例：`，杯身印有`（描述认出了「STARBUCKS」「大/热 馥芮白」）、`9排13号` 类座位号、`三碗宠物食`、`一只灰白虎`…
  - 地面真相已核对：这些词**确实存在于库里**的描述中（直接读 `ai_derived_json` 确认 `true`）。
- **B 组对照组**：拿 4 个「只出现在正文里」的词搜 → **命中 4 条** ✅
  - 例：`为期三天的`、`姐姐姐夫从`。**说明搜索接口本身是好的，差就差在它不看描述。**
- **返回体是带描述的**：当某条记录因别的原因命中时，返回体里**带着它全部 6 条描述**（三档各 2 条）。也就是数据已经在结果里了，只是「匹配」这一步没算它。

**结论：搜不到 ≠ 白跑。** 数据在库里、打开记录能看见，缺的只有「让搜索拿它当匹配依据」这一步。

---

## 5. 三档效果评审（已做完，结论直接用）

评审报告 `.review/photo-tier-verdict.txt`，逐张三档并排对比页 `.review/photo-compare.html`。**51 张 × 三档逐条读完**，结论：

| 指标 | ① plain | ② context | ③ context-thinking |
|---|---|---|---|
| 平均字数 | 44 | 45 | **37** |
| 票/书/菜单上的引文 | 64 段 | **73 段** | 47 段 |
| 数字/张（型号·金额·座位号） | 0.66 | **0.88** | **0.37** ← 不到其他档一半 |

**结论：② 中成本档最好，全库就用它。③ 高成本档不推荐。**

**最要紧的一条洞察（决定了这件事该怎么做）**：

> **贵 ≠ 细。** ③ 多付的钱全花在**推理过程**（输出 token 从 1,593 涨到 22,187，×13.9），可**成文那句话反而更短**——「开思考」让模型去理解、概括，把座位号、型号、金额这类**字面细节当冗余丢掉了**。而这些恰恰是搜索时唯一能命中的东西。
>
> 我们建索引的用途是「日后搜图」= **要召回细节**，不是文笔凝练。

**另一条对本任务致命的事实**：

> **照片描述是「不稳定的文本」。** 同一张图前后跑两批，51 张里 **46 张被改写**（逐字相同仅 5 张）。旧批写「星巴克纸杯」、新批写「星巴克杯」——你搜「纸杯」，新批就中不了。
>
> 也就是说：**靠字面匹配去搜描述，天生是脆的。** 这不是实现问题，是"用 AI 生成的句子当索引"这件事本身的性质。**这一条直接指向第 6 节的第 ③ 层。**

---

## 6. 大厂怎么做（已调研）

**行业标准就是「把描述当向量搜」，不是「把描述当文本搜」**：

- **Google Photos**：自动打标 → 照片和标签都变向量 → 查询也变向量 → 挑最近的。所以搜「coast」能命中标「beach」的照片。上面再叠 Gemini = **Ask Photos**（直接问「去年八月海边穿黄裙子那张」）。
- **Apple Photos**：同路线，本机跑。
- Google 公布：多条件语义查询准确率 **92%**，比关键词搜索高 **37 个百分点**。

**关键不是"要不要做"，是每家都做；而且做的是向量、不是字面。**

---

## 7. 三层能力阶梯（推荐路线）

```
① 现状        只搜正文 + 关联对象名        → 描述里的词全搜不到（已实测）
② 字面并入    把描述 text 并进现有匹配      → 零依赖、当天可做，措辞一漂就漏
③ 语义向量    查询和描述都编码成向量比距离  → 换说法也能搜到，但 +255.7 MB
```

### ② 字面并入（建议先做）

- **改一处**：`repository.ts:1700-1704` 的匹配表达式里，把每条记录的 `ai_derived_json` 里所有 `value.type === "photo-description"` 的 `value.text` 拼进去。
- **立刻见效**：搜「馥芮白」「BATTLE-AX B760M」「桌名：3」都能命中。
- **零新依赖**（符合本项目「零框架」风格）。
- **局限**：措辞一漂就漏（见第 5 节「不稳定文本」）。

### ③ 语义向量（要主人拍板，但**不用重做实验**）

**项目一年前已实测过这套方案，数据一直挂着「待主人拍板」**，直接复用：

| 文件 | 内容 |
|---|---|
| `.review/semantic-experiment.txt` | 「要不要语义模型」的实测：质量 vs 代价 |
| `.review/semantic-model-decision.txt` | 「要的话用哪个运行时」的实测（B/C/D 四选项） |
| `.review/semantic-experiment/` | 语料 `corpus.json` + 脚本 + 原始结果（`.review` 不进 git） |

**核心数字（40 篇合成中文日记 + 18 条查询，12 语义 / 6 词法）**：

| 方法 | 语义 r@1 | 语义 r@3 | 词法 r@1 |
|---|---|---|---|
| `fts-phrase`（FTS5 trigram） | **0%** | **0%** | 50% |
| `char-overlap`（零依赖，穷人版模糊） | 58% | 67% | 100% |
| `bge-small-zh-v1.5`（ONNX int8） | 58% | **92%** | 100% |

- 语义模型的真正价值：**把 r@3 从 67% → 92%**（擅长「捞进候选」，不擅长「一击命中」，r@1 与零依赖持平）。
- **不要给这个 ONNX 移植版加 BGE 官方查询指令**：加了反而从 58%/92% 掉到 42%/58%。
- **不要用 FTS5 当"轻量语义检索"**：实测对语义查询命中 **0%**，比零依赖字面匹配还差。

**运行时选型（`.review/semantic-model-decision.txt` 的结论）**：

- 推荐 **B+C**：`@huggingface/transformers` + `Xenova/bge-small-zh-v1.5`(ONNX int8)，并剪掉 `onnxruntime-node` 里的 darwin/linux 二进制 → **+255.7 MB**，已验证剪裁后质量逐位一致。
- **明确否决 D 的默认形态**（`node-llama-cpp`，默认装 676 MB）。
- 代价：磁盘 +255.7 MB、API 进程 RSS +~140 MB、冷加载 +145 ms、批量编码 ~5.2 ms/篇、查询编码 ~1.1 ms/条。
- **模型 23 MB 首次要联网下载**，本机 `huggingface.co` 不通，须走 `hf-mirror.com`（`env.remoteHost = "https://hf-mirror.com"`）。
- **待定问题**：模型文件要不要随项目分发（会进 git）？—— 需主人拍板。

**我的建议**（交接方观点）：**先做第 ② 层**——零成本、当天能验证「描述到底有没有用」、不引入任何新依赖。等用起来发现「老是搜不到想搜的」，再上第 ③ 层；那时语料（正文＋描述）也齐了，随时能接。

---

## 8. 红线与硬约束（必须遵守，违反会出事）

1. **生产库 `data/lifeos.sqlite` 是主人的真数据**：永不重置、永不删。要干净数据另开 `LIFEOS_DATA_DIR`。
2. **正文一个字都不能改**。描述只写进 `ai_derived_json`。
3. **隐私记录（`is_private`）永不外发、不参与外发索引**（这条对「接进 AI 管家上下文」尤其要守）。
4. **不调真实 AI API 做无关的事**；任何花钱的批量动作先问主人。
5. **任务截图 10 张永不跑描述**（只跑 `kind: "journal"`）。
6. **不要动 `pic-test/` 与 `data/uploads/` 里的原图**。
7. **改完代码后，3011 上的服务必须重启才生效**（跑的是 `apps/api/dist/src/main.js`）。
8. 项目记忆约定的其他红线（`AGENTS.md` / `.workbuddy-ai/memory/MEMORY.md`）：改同一个文件一次消息只发一处 Edit；含反引号的长文本先落盘再读；写含中文的文件只用 Node `readFileSync/writeFileSync(…,"utf8")`（`Set-Content`/`Out-File` 是乱码源头）。

---

## 9. 环境事实（省得重新踩坑）

- **端口**：3011(API) / 5199(Web) 是主人的预览端口，只有 `.review/accept-serve.mjs` 有权占用（它服务的正是 `data/`）。
- **起服务**：`spawn-serve.mjs` 的 detached 子进程**会被沙箱回收**——正确姿势是把 `accept-serve.mjs` 当**常驻后台任务**跑。
- **别杀主人的 3001**。
- **curl 探本地端口要加 `--noproxy '*'`**，否则走系统代理会得到假的 502。
- **Node 用 `C:\Program Files\nodejs`（24.x）**。`npm run check` 在本机走不通 → 绕开 npm：
  - 编译：`cd apps/api && "C:/Program Files/nodejs/node.exe" "E:/Projects/motion-lab/lifeos/node_modules/typescript/bin/tsc" -p tsconfig.json --pretty false`
  - 测试：`"C:/Program Files/nodejs/node.exe" --test --test-isolation=none dist/test/xxx.test.js`
  - web 类型检查：`tsc --noEmit`
- **bash 是残缺 PortableGit**（无 `ls/cat/grep/find`）→ 用 `node -e` 或专用工具。
- **CDP/无头浏览器的 `--user-data-dir` 只放项目 `.review/`，绝不放 `%TEMP%`**（曾把 C 盘塞满 → 所有工具报 ENOSPC；API 会因此报 `readonly database` 起不来）。

---

## 10. 接线后建议加的验收（供接手者参考）

- **A/B 对照**：拿第 4 节那 12 个「描述独有词」重搜 → 应命中；再拿 4 个「正文独有词」搜 → 仍应命中（证明没破坏原有搜索）。
- **不破坏既有搜索**：重跑记录搜索的回归（工具箱里已有 `verify-record-search-20261010.mjs`、`verify-search-*` 系列）。
- **隐私**：构造一条私有日记带照片描述，确认它不出现在搜索命中里。
- **去重/多档**：同一张图有三档描述时，只要有一档 text 命中就应算命中（或按你的设计明确只认 `context` 档——**建议只认 `context` 档**，理由见第 5 节：它是效果最好的那档，避免三份 text 重复污染匹配）。

---

## 11. 现成产物清单（都在 `.review/`，不进 git）

| 文件 | 用途 |
|---|---|
| `photo-search-probe.txt` | 本任务的实测证据（A/B/C 三组） |
| `search-probe.mjs` / `search-probe2.mjs` | 生成上面证据的探针（可重跑，零 API） |
| `photo-tier-verdict.txt` | 三档效果评审报告 |
| `photo-compare.html` | 三档逐张并排对比页（`photo-compare-data.cjs` + `photo-compare-page.cjs` 生成） |
| `photo-usage.json` / `photo-high-usage.json` | 三档 token 与成本 sidecar |
| `photo-context-rerun.txt` | ② 档低谷重跑清单（新旧逐张对照） |
| `photo-context-baseline.json` | 强制重跑前的描述全量备份 |
| `audit-photo-payload.mjs` | 「发给模型的东西到底装了什么」审计脚本（零 API） |
| `semantic-experiment.txt` / `semantic-model-decision.txt` / `semantic-experiment/` | 语义检索与运行时选型的全部实验数据 |

---

## 12. 待主人拍板的开放问题

1. **做第 ② 层（字面并入）还是直接上第 ③ 层（语义向量 +255.7 MB）？** 交接方建议先 ②。
2. （若上 ③）**模型 23 MB 要不要随项目分发进 git**，以脱离网络可用？
3. 匹配时**是否三档都读**，还是只认 `context` 档？（交接方建议只认 `context`。）
4. 是否要把照片描述**也接进 AI 管家上下文**（`assistant-conversation.ts:128`）——这样问 AI「我上次那杯咖啡」时能靠描述召回。（注意隐私红线。）

---

## 13. 交接方的一句话总结

**描述已经全跑完、存好了、效果最好的那档（context）已确定；差的只有最后一米——把 `ai_derived_json` 里 `type:"photo-description"` 的 `text` 接进 `repository.ts:1700` 的匹配表达式（第②层，改一处、零依赖、当天可验），或按已实测好的方案上语义向量（第③层）。别重新调研、别重新跑描述、别动正文和生产库。**
