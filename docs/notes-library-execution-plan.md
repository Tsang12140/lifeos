# 笔记资料库 V1：执行计划

> 状态：**主人已授权直接实施**。本文件是给执行 AI 的明确边界，不是开放式设计讨论。
>
> 产品决定：笔记不是日记的另一种排版；它是按内容浏览、检索和续写的个人文字库。首版覆盖 **文章、碎片、摘抄**，不新造第二套记录系统。

## 0. 不可变的产品规则

1. 保留现有记录种类 `kind: "note"`，不增加新的 `RecordKind`，也不迁移/改写已有笔记。
2. 新笔记有三种格式：`article`、`fragment`、`quote`。旧笔记没有格式元数据时，前端按 `fragment` 渲染；它们继续可读可编辑。
3. `article` 必须有标题和正文；`fragment` 只有正文；`quote` 有正文和可选出处。三者都保留现有的 `body.original/body.edited` 语义，不能为新 UI 偷换或丢失原文。
4. 新笔记默认**不写 `occurredAt`**。它按 `updatedAt ?? createdAt` 排序，作为资料库内容而非时间线事件。
5. 笔记不显示在「今天 / 时间轴 / 日历 / 日摘要」里，包括历史上带 `occurredAt` 的旧笔记；笔记只在「笔记」资料库中出现。日记、任务、事件原有行为不能变。
6. 首版只实现三种格式、分类浏览、标题/正文/出处检索、创建、编辑和删除。**不做**富文本、Markdown 渲染、清单、标签/主题管理、文件/照片新交互、自动从日记提炼笔记、复制正文到日记或数据清洗。这些另立需求，不能顺手扩大范围。
7. 保留既有 `relatedRecordIds` 数据，不改变其含义；首版不承诺新增“引用进日记”的快捷入口，避免复制内容或只在笔记页加载局部候选记录时产生错误关联。

## 1. 数据契约与兼容策略

### 1.1 Core 类型

在 `packages/core/src/model.ts`（`NoteRecord` 约第 322 行，`assertValidTimelineRecord` 约第 614 行）新增：

```ts
export type NoteFormat = "article" | "fragment" | "quote";
export interface NoteDetails {
  readonly format: NoteFormat;
  readonly title?: string;   // 只允许 article
  readonly source?: string;  // 只允许 quote；可选
}
```

- `NoteRecord` 增加可选 `note?: NoteDetails`。
- 校验规则：`note` 存在时只允许 `format/title/source`；`format` 必须枚举值；`article.title` 去除首尾空白后不能为空；`fragment`/`quote` 不能带 `title`；非 `quote` 不能带 `source`；`note` 字段只能出现在 `kind === "note"` 的记录上。
- 对缺失 `note` 的旧 `kind: "note"` **不报错、不补写**。UI 的显示默认值在前端 helper 中产生，不能在读取数据库时悄悄改数据。
- 为 API 防御性校验规定上限：标题最多 300 字符、出处最多 1,000 字符；正文沿用既有 `content` 限制和逻辑。拒绝时返回现有的 400 校验错误形式。

### 1.2 SQLite 持久化

在 `apps/api/src/repository.ts`：

- 给 `records` 增加 nullable `note_json TEXT`，与 `task_json` 平级；新库建表 SQL 和旧库 `PRAGMA table_info(records)` 迁移都必须覆盖。
- `RecordRow`、`readRecordRow`、`rowToView`、`recordInsertParams`、`insert`、`update`、`replaceAll/import` 的 SQL 列表和参数顺序全部同步加入 `note_json`。
- `note_json` 只为 `kind: "note"` 且有 `note` 时写入；旧行的 `NULL` 读回为没有 `note` 字段。读回后必须走 core 校验。
- 不为格式建立数据库索引：首版笔记页已经按 `kind=note` 拉取，格式筛选在客户端即可完成；不要为未测的性能问题扩表。

### 1.3 HTTP 和前端 payload

在 `apps/api/src/server.ts`：

- `buildRecord` 的白名单加入 `note`；用一个独立、可测试的解析函数将 JSON 解析成 `NoteDetails`。
- 创建时：`note` 只能随 `kind: "note"` 发送；新 UI 始终发送它，但兼容 API 客户端继续允许省略。
- `patchRecord` 的白名单加入 `note`；仅 `kind: "note"` 能更新。允许 `note: null` 仅用于恢复旧式无格式笔记；其它情况保持格式字段完整且合法。更新 metadata 必须更新时间与 revision。
- `apps/web/src/api.ts` 的 `RecordWritePayload` 对齐加入 `note?: NoteDetails | null`；不要用 `any` 绕过类型。
- 记录搜索必须覆盖文章标题和摘抄出处：在 repository 的 `q` 查询谓词中把 `note_json` 一并纳入，仍使用参数化查询，且不改变已有正文搜索命中。

## 2. 前端信息架构

### 2.1 页面分流

`apps/web/src/main.tsx` 已有 `activeView === "notes"`（约第 3210、3813 行），但当前仍把 note 喂给时间轴组件。改为专用 `NotesLibrary`：

- `/api/records?kind=note&timeZone=Asia/Shanghai` 的加载路径保留，笔记页只取 note；请求中仍能带全局搜索词 `q`。
- `activeView === "notes"` 时渲染 `NotesLibrary`，不渲染 `Timeline`，也不显示通用 `Composer`。
- 页面顶部为“笔记”和一个“新建笔记”按钮；不要使用“某日记录”“发生时间”或日记时间轴标题。
- `NotesLibrary` 自己维护编辑器开关和格式筛选：`全部 / 文章 / 碎片 / 摘抄`。切换只过滤已加载笔记，不发额外请求。
- 列表排序在客户端明确按 `updatedAt ?? createdAt` 倒序；不能沿用 timeline 的 `occurredAt` 排序。

### 2.2 卡片与阅读层级

保持项目既有克制、文字优先的风格，不引入彩色笔记墙、拟物便签或照片底纹。

| 格式 | 卡片必须显示 | 不应显示 |
| --- | --- | --- |
| 文章 | “文章”类型标识、标题、正文两行摘要、最近更新 | 发生日期、时间轴点、照片栏 |
| 碎片 | “碎片”标识、正文（首句就是视觉重心）、最近更新 | 标题输入的占位、日记元数据 |
| 摘抄 | “摘抄”标识、引文正文、可选出处、最近更新 | 伪造书名或强制来源 |

- 卡片使用可定位的 `data-note-card` 与 `data-note-format` 属性；筛选 tabs 和“新建笔记”也提供稳定 data 属性，供 CDP 验收。
- 点击卡片或明确的编辑按钮均可打开编辑器。删除仍走现有二次确认与软删除，不另造危险路径。
- 空状态用“还没有笔记。先记下一点想法或摘抄。”；不得展示/写入 demo 数据。

### 2.3 专用编辑器

在同一个 `main.tsx` 中以小而清晰的 `NoteComposer`/`NoteEditor` 组件实现，避免把通用日记 `Composer` 的时间、天气、任务和照片逻辑硬塞进笔记。

- 新建前先有三个等权格式选项：文章、碎片、摘抄；默认碎片，便于随手记录。
- 文章：标题输入 + 正文 `MentionBox`；标题和正文均为空时禁用保存。
- 碎片：只有正文 `MentionBox`；不渲染标题、日期、天气、补记、照片、任务字段。
- 摘抄：引文正文 `MentionBox` + “出处（可选）”文本输入；出处不强制，但输入后要随保存/编辑/导出完整保留。
- 可以继续使用现有 mentions / entity refs，因为正文仍是普通记录正文；不要为笔记另造一套实体协议。
- 编辑已有 note 时，编辑器应根据 `note?.format ?? "fragment"` 恢复相应字段。旧 note 在首次仅改正文时**不得**被无意补上 `note` metadata；只有用户明确选格式或编辑新字段才写入它。
- 通用 `RecordEditorDialog` 对 note 应显示专用标题/出处字段并隐藏“发生时间”“补记”控件；非 note 的编辑器保持原样。关联面板保持数据不丢失，但本轮不加新的关联交互承诺。

### 2.4 从日记视图彻底隔离

- `Timeline` 在 `today` / `timeline` 模式下先排除 `record.kind === "note"`；不能只靠 API 查询，因为这些视图目前会取全量记录。
- `CalendarView` 的输入记录也排除 note；月历/周历卡片、每日计数和图片选取都不能把笔记算进去。
- `/api/summaries` 在构建 `byDate` 时排除 note，保证 AI/规则摘要不吸收笔记正文。
- 笔记仍保留在导入、导出、搜索、时光机和软删除中；这些是数据完整性功能，不属于“日记视图”。

## 3. 需要改动的文件与顺序

1. `packages/core/src/model.ts` + `packages/core/test/core.test.ts`：先完成 NoteDetails 类型与合法/非法/旧格式兼容测试。
2. `apps/api/src/repository.ts` + `apps/api/src/server.ts` + `apps/api/test/api.test.ts`：完成 schema migration、创建/读取/更新、搜索、错误分支、导入导出 round-trip。
3. `apps/web/src/api.ts`：传递强类型 `note` 字段。
4. `apps/web/src/main.tsx`：新增格式 helpers、NotesLibrary、专用编辑器；接入 App 状态、创建、编辑和视图隔离。
5. `apps/web/src/styles.css`：仅新增笔记页、三种卡片和窄屏样式。复用现有字体、按钮、弹窗 token；桌面和 390px 下不得水平溢出。
6. `.review/verify-notes-library.mjs`：自带隔离 API/Web/数据目录，绝不连接 3011/5199 的生产库；产出 `.review/verify-notes-library.txt`，最后一行严格为 `RESULT: PASS` 或 `RESULT: FAIL`。
7. `docs/changelog.md`：在最末尾追加本轮记录，含 `AI: Luna`、改动/原因/验证/踩坑。不要改写历史。

## 4. 必须通过的验收

### 4.1 单元/API

- core：合法 article/fragment/quote 通过；article 无标题、quote 外带 title、非 note 带 note、未知字段、过长 title/source 均拒绝；旧 note 无 `note` 仍通过。
- API：创建三种格式后 GET 内容完全一致；PATCH 更新 article 标题、quote 出处与正文时 revision 递增；PATCH 非 note 的 `note` 得 400；搜索标题和出处可命中；导出后导入隔离库不丢格式字段；旧 `note_json = NULL` 安全读回。
- 现有记录、任务、事件、导入导出和时光机测试不得因新增可选字段回归。

### 4.2 浏览器 CDP（隔离环境）

验收脚本必须实际创建 1 篇文章、1 条碎片、1 条摘抄，随后读 API 和页面双向对账：

1. 笔记页面只画 3 张 `data-note-card`，且各格式各 1；文章有标题，碎片没有标题 DOM，摘抄有且仅有填写的出处。
2. 切换三个格式筛选，每次仅显示匹配格式；“全部”恢复 3 张。
3. 新建/编辑后 API 读回 `note.format/title/source` 与页面对应，且 note 没有 `occurredAt`。
4. 今天、时间轴、周历/月历的记录/卡片计数不包含这 3 条 note；摘要接口的当天输入也不包含 note。
5. 文章、碎片、摘抄编辑器都不存在 `input[type=datetime-local]`、天气控件、补记开关和照片上传区。
6. 390px：可见笔记卡、筛选、主按钮、输入框宽度均大于 0；`document.documentElement.scrollWidth <= window.innerWidth`；控件可点击。
7. 所有验证使用 CDP 的文字/元素数/`getBoundingClientRect`/computed style 断言；不生成或提交截图。

### 4.3 命令与安全

- 动手前已运行 `node .review/data-inventory.mjs`：生产库有 18 条主人记录，故整个实施与验收**不得写 `data/`**。
- 使用 Node 24：`C:\Program Files\nodejs\node.exe`。完成时运行 `npm run typecheck`、`npm test`，再运行隔离的 `verify-notes-library.mjs`。
- 任何验收服务使用独立 `LIFEOS_DATA_DIR` 和资产目录；不杀 3011/5199、不使用 `seed-demo --clean`、不执行清库命令。
- 不 push。验证全绿、changelog 已追加后可创建本地 commit；如果工作树出现非本轮改动，保留它们并只提交本轮文件。

## 5. 完成定义

用户打开“笔记”后看到的是可按格式浏览的文字资料库，而不是按某天分组的日记；能创建、编辑和搜索文章、碎片与摘抄；任何笔记都不会污染日记时间轴、日历或日摘要；旧笔记、导入导出、软删除和历史快照继续安全工作。
