# 搜索框考古与恢复手册

> **用途**：主人的「谷歌式搜索框」在 2026-10-10 被换掉，现在页面上是一个新的筛选面板（`RecordSearch`）。
> 这份文件回答两件事：**① 为什么会丢 ② 东西在哪、要恢复时照着做**。
> **本文件不是变更记录**（那是 `docs/changelog.md`），也**不代表任何改动已发生** —— 截至 2026-10-10 17:30，产品代码**一个字符都没动**。
>
> 调查者：WorkBuddy AI（2026-10-10 17:21~17:30）。全部结论都有 git/文件/线上实证，未验证的会明说。

---

## 0. 一句话结论

老搜索框不是"丢了"，是被**分两批删掉**的：

- **第一批 09-29**：顶栏搜索药丸 + 手机搜索按钮被删。**主人自己要求的**（当时页面上有两个搜索入口，重复）。改动记录在案。
- **第二批 10-10（今天）**：剩下的 `SearchDialog` + 编辑区搜索入口被删，换成新的 `RecordSearch`。**改动记录里查不到**（违反 `AGENTS.md` 铁律 1）。

**最后一个还带完整谷歌式搜索框的提交 = `1535b42`**（= `fcc50db^`，HEAD 往前第 5 个）。

---

## 1. 它是什么（老搜索框完整规格）

参考 `1535b42` 的源码。整套由 **4 个部件**组成：

### 1.1 桌面顶栏药丸（`.search-form`）

`1535b42:apps/web/src/main.tsx:1538`，位于 `<header className="topbar">` 里的 `.topbar-actions`：

```tsx
<div className="topbar-actions">
  <form className="search-form" onSubmit={submitSearch} role="search">
    <Search className="search-leading-icon" size={17} strokeWidth={1.8} aria-hidden="true" />
    <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="搜索记录" aria-label="搜索记录" />
    {searchInput ? <button className="search-clear" type="button" aria-label="清空搜索" onClick={() => { setSearchInput(""); setSearchQuery(""); }}><X size={15} strokeWidth={1.9} aria-hidden="true" /></button> : null}
    <span className="search-divider" aria-hidden="true" />
    <button className="search-submit" type="submit" aria-label="提交搜索"><Search size={16} strokeWidth={2} aria-hidden="true" /></button>
  </form>
  <button className="icon-button mobile-search-button" type="button" onClick={() => setSearchDialogOpen(true)} aria-label="搜索记录"><Search size={17} strokeWidth={1.9} aria-hidden="true" /></button>
</div>
```

外观：**48px 白色长药丸**（`border-radius: 999px`）、细灰边 `#cfd6e1`、轻阴影、左侧放大镜、右侧清空 × 与 1px 分隔线、蓝色提交按钮。聚焦时**药丸自己的描边变 `--primary`**（不给输入框画任何东西）。

相关 state / 处理函数（同文件）：

| 行 | 内容 |
| --- | --- |
| 280 | `const [searchInput, setSearchInput] = useState("");` |
| 348 | `const [searchDialogOpen, setSearchDialogOpen] = useState(false);` |
| 1167 | `const submitSearch = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setSearchQuery(searchInput.trim()); };` |

### 1.2 手机搜索按钮（`.mobile-search-button`）

同一个 `.topbar-actions` 里的 40px 图标按钮，手机上显示、桌面上 `display: none`，点击开搜索弹窗。**这就是主人记得的"移动端上的一个搜索按钮"。**

### 1.3 搜索弹窗（`SearchDialog`）

`1535b42:apps/web/src/dialogs.tsx:182` 起。`1535b42` 那版只有关键词框；
**HEAD 那版功能更全**（带 `SearchFilterFields` 完整筛选），删掉的是 HEAD 那版：

```tsx
// git show HEAD:apps/web/src/dialogs.tsx 第 182 行起
export function SearchDialog({ open, initialQuery, initialFilters, onClose, onSearch }: { open: boolean; initialQuery: string; initialFilters: SearchFilters; onClose: () => void; onSearch: (query: string, filters: SearchFilters) => void }) {
  ...
  <dialog ref={dialogRef} className="modal-dialog search-dialog" aria-labelledby="search-title" ...>
    <div className="dialog-header"><h2 id="search-title">搜索记录</h2><button className="icon-button compact-icon-button" ... aria-label="关闭搜索"><X size={17} aria-hidden="true" /></button></div>
    <form onSubmit={...}>
      <p className="search-dialog-description">可搜所有日期的日记、任务、事件和笔记，包括笔记标题与出处。</p>
      <label className="search-dialog-input"><Search size={17} aria-hidden="true" /><input ref={searchInputRef} autoFocus aria-label="搜索关键词" value={query} onChange={...} placeholder="关键词可留空，只按条件筛选" /></label>
      <SearchFilterFields value={filters} onChange={...} />
      <div className="dialog-footer">...清空 / 搜索...</div>
    </form>
  </dialog>;
}
```

> **恢复时用 HEAD 那版**（带筛选），不要用 `1535b42` 那版（功能更少）。

### 1.4 手机「更多」菜单里的「搜索记录」项

`dialogs.tsx` 的 `MobileMenuDialog` 里那个 `.mobile-menu-nav-item--search` 按钮，`onOpenSearch` 回调开搜索弹窗。
**这个按钮现在还在**（`dialogs.tsx:242`），但今天被改成打开筛选面板了。

---

## 2. 为什么不见了

### 2.1 第一批 · 2026-09-29 · **主人自己要求删的**（有记录）

`docs/changelog.md` 第 4230 条，标题「移除页面右上角重复搜索入口」：

> **为什么**：主人指出页面同时显示两个搜索入口，并明确要求移除最右上角那个。

删掉的是 **1.1 的顶栏药丸 + 1.2 的手机搜索按钮**；保留 `SearchDialog` 与编辑区入口。
这批改动**落在 git 里是 `fcc50db`（2026-10-06，commit message "feat: complete calendar weather and photo workflows"）** —— `styles.css` 里 `.search-form` 与 `.mobile-search-button` 的删除都在这个提交。

验证：`git log --all --oneline -S'.search-form' -- apps/web/src/styles.css` → 最后一次出现在 `1535b42`，删除在 `fcc50db`。

### 2.2 第二批 · 2026-10-10 · **无记录**

`.review/` 里躺着一段一次性脚本 `.review/implement-record-search.cjs`（4699 字节），它一口气做了四件事：

| 动作 | 代码证据（脚本原文） | 结果 |
| --- | --- | --- |
| 删掉整个 `SearchDialog` | `.replace(/export function SearchDialog[\s\S]*?(?=export function MobileMenuDialog)/,'')` | 搜索弹窗没了 |
| 删掉编辑器搜索按钮 | `.replace(/\s*<button className="icon-button compact-icon-button composer-search"[^\n]*<\/button>/,'')` | 编辑区入口没了 |
| **全站 `.tsx` 的 `placeholder` 批量剥离** | `if(ts.isJsxAttribute(node)&&node.name.text==='placeholder')ranges.push(...)` | 见 2.3 |
| 换成新的 `RecordSearch` | `import { RecordSearch } from "./record-search";` | 就是现在这个面板 |

配套脚本：`refine-record-search.cjs`、`finish-record-search-ui.cjs`、`add-search-chips.cjs`、`extend-search-qa.cjs`、`fix-search-key.cjs`。
验收产物：`.review/record-search-browser-20261010.txt`、`.review/record-search-*-20261010.txt`。

**关键问题：`docs/changelog.md` 里没有任何一条记录这件事。** 在 changelog 里搜 `record-search` / `RecordSearch` / `记录搜索` 全部无命中（只有第 5610 行一句顺带提到某个探针脚本）。按 `AGENTS.md` 铁律 1，这属于**交接未完成**。

### 2.3 顺带被清掉的 placeholder（**这批是主人要删的，不算事故**）

同一次脚本把全站 `.tsx` 的 `placeholder` 属性剥离干净：

| 版本 | `placeholder=` 出现次数 |
| --- | --- |
| `HEAD`（删除前） | **36+**（分布在 `composer` 4、`record-dialogs` 6、`settings-cards` 5、`calendar-view` 4、`entity-forms` 4、`dialogs` 4、`movie` 3、`WelcomeGate` 2、`habit-panel` 2 等） |
| 现在 | **1**（只剩 `.review` 之后新增的 `assistant-history-dialog.tsx:199`） |

主人 2026-10-10 已确认：**"那些输入框提示文件是我要删的"** ⇒ 恢复搜索框时**不要**把 placeholder 一起还原。

---

## 3. 现在的状态

### 3.1 线上实证（不是推断）

直接取预览服务实际下发的模块：

```bash
node -e "const http=require('http');http.get({host:'127.0.0.1',port:5199,path:'/src/main.tsx'},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>{const c=s=>(b.match(s)||[]).length;console.log('RecordSearch',c(/RecordSearch/g),'search-form',c(/search-form/g),'mobile-search-button',c(/mobile-search-button/g),'SearchDialog',c(/SearchDialog/g))})})"
```

实测输出：`RecordSearch 2  search-form 0  mobile-search-button 0  SearchDialog 0`

⇒ **线上（`http://127.0.0.1:5199/`）确实只剩新面板，老搜索框的三个部件全没了。**

### 3.2 代码现状

| 文件 | 状态 |
| --- | --- |
| `apps/web/src/record-search.tsx` | **新增、未提交**（新面板本体） |
| `apps/web/src/record-search.css` | **新增、未提交** |
| `apps/web/src/main.tsx:1734` | 挂载 `<RecordSearch .../>`（在内容列里，不在顶栏） |
| `apps/web/src/main.tsx:1746` | 手机「更多」的 `onOpenSearch` 现在执行 `setActiveView("today"); setSearchFiltersOpen(true);` |
| `apps/web/src/dialogs.tsx` | `SearchDialog` 已不存在；`MobileMenuDialog` 的 `onOpenSearch` prop 仍在 |
| `apps/web/src/composer.tsx` | `.composer-search` 按钮已不存在 |
| `apps/web/src/styles.css:7100~7149` | **`.search-dialog*` 一串样式成了死 CSS**（弹窗已删，样式还在） |
| `apps/web/src/styles.css:1263`、`7393` | `.search-context` 仍在 |

### 3.3 老搜索框的 CSS 现在在哪

`1535b42:apps/web/src/styles.css` 里，共 **18 处** `search-form` 命中。主要区块：

| 行 | 内容 |
| --- | --- |
| 984 | `.mobile-search-button { display: none; }`（桌面隐藏） |
| 1073 | `.icon-button.mobile-search-button { display: none; }` |
| **1103~1220** | **主样式块**：`.search-form` 药丸本体 + `:hover` + `:focus-within` + `.search-leading-icon` + `input` + `input:focus(-visible)` + `::placeholder` + `.search-clear` / `.search-submit` + `.search-divider` |
| 7054, 7073, 7077, 7090, 7096, 7101, 7106 | 媒体查询：窄桌面下药丸收成 42px、悬停展开 |
| 7354, 7415, 7422, 7431 | 媒体查询：手机顶栏定位 + 40px 搜索按钮 |
| 11027, 11032, 11040, 11039 | 媒体查询（`@media (max-width:900px)`）：`.mobile-search-button { display: inline-grid !important; }` |

---

## 4. 恢复坐标表（东西在哪）

| 要恢复的东西 | 从哪取 | 取法 |
| --- | --- | --- |
| 顶栏药丸 + 手机按钮 JSX | `1535b42:apps/web/src/main.tsx:1538` | `git show 1535b42:apps/web/src/main.tsx` |
| `searchInput` / `searchDialogOpen` / `submitSearch` | `1535b42:apps/web/src/main.tsx:280 / 348 / 1167` | 同上 |
| `SearchDialog`（**带筛选那版**） | **`HEAD:apps/web/src/dialogs.tsx:182`** | `git show HEAD:apps/web/src/dialogs.tsx` |
| 老搜索框 CSS 全量 | `1535b42:apps/web/src/styles.css`（见 3.3 行号） | `git show 1535b42:apps/web/src/styles.css` |
| 改动前整份 `main.tsx` 快照 | `.review/search-main-before-20261010.txt` | 直接读（约 27k token，别整份灌进上下文） |
| 改动前 `search-filters.tsx` 快照 | `.review/search-filters-before-20261010.txt` | 直接读 |
| 老搜索框的验收脚本 | `.review/verify-search-ui.mjs` + `.review/verify-search-ui.txt` | 仍在，可复用（判据可能要更新） |
| 焦点方框的专用探针 | `.review/probe-search-click.mjs` | 仍在 |

一键导出三份源码到临时目录：

```bash
git show 1535b42:apps/web/src/styles.css > /tmp/old-styles.css
git show 1535b42:apps/web/src/main.tsx  > /tmp/old-main.tsx
git show HEAD:apps/web/src/dialogs.tsx   > /tmp/old-dialogs.tsx
```

---

## 5. 恢复方案（三选一，等主人点头）

### 方案 A · 整套还原成谷歌式（**推荐**）

把 1.1 + 1.2 + 1.3 全部装回来，撤掉新的 `RecordSearch`。

1. `dialogs.tsx`：把 `HEAD:apps/web/src/dialogs.tsx:182` 的 `SearchDialog` 整段加回并导出。
2. `main.tsx`：
   - 重新 `import { SearchDialog }`；
   - 加回 `searchInput` / `searchDialogOpen` / `submitSearch`（§1.1 表）；
   - 顶栏 `.topbar-actions` 加回 `.search-form` 与 `.mobile-search-button`（§1.1 原码）；
   - 挂回 `<SearchDialog open={searchDialogOpen} initialQuery={searchInput} initialFilters={searchFilters} onClose={...} onSearch={(q, f) => { setSearchInput(q); setSearchQuery(q); setSearchFilters(f); }} />`。
3. `styles.css`：把 §3.3 那几段（1103~1220 主块 + 984/1073 + 各媒体查询）从 `1535b42` 搬回。
4. `main.tsx:1734` 撤掉 `<RecordSearch .../>`；`record-search.tsx` / `.css` 可留可删。
5. **不要**恢复编辑区的 `.composer-search` 入口 —— 09-29 删它就是因为"两个入口重复"。

结果：桌面一个入口（顶栏药丸），手机一个入口（顶栏按钮 + 「更多」里的搜索项），筛选能力由弹窗提供。

### 方案 B · 保留新面板，只换成谷歌式外观

留下今天新做的筛选面板功能，把 `record-search.tsx` 的外观改成药丸风格（`border-radius: 999px`、48px、白底细灰边轻阴影），并补回手机端搜索按钮。工作量比 A 大，但筛选能力不丢。

### 方案 C · 先只补手机入口（最小改动）

顶栏与外观先不动，只把 `.mobile-search-button`（1.2）加回手机顶栏，让手机上能搜。解燃眉之急用。

---

## 6. 雷区（动手前必读）

1. **禁止 `git checkout .` / `git reset --hard` / `git stash` / `git clean -fd`。**
   `main.tsx` 与 `styles.css` 上压着**今天别的 AI 一堆未提交改动**（日历天气、回到顶部、AI 管家、视频、月历未来日…）。硬回退会连它们一起抹掉。只能**定点 Edit 加回来**。
2. **`styles.css` 是共享文件，多个 AI 在并行写** ⇒ 只许定点 `Edit`，**永不整份 `Write`**。
3. **`.search-form input:focus, .search-form input:focus-visible { box-shadow: none; }` 这条必须一起搬。**
   它就是 09-16 修"点击冒方框"的那一行；漏了它，方框立刻复发（全局 `:focus-visible` 的 3px ring 会落在裸输入框上）。
4. **媒体查询要整套搬，不能只搬一半。** 手机端 40px 搜索按钮曾与天气卡重叠（`docs/todo.md` §28 有完整复现数据：320px 时 `x=262..302` 与天气摘要 `x=174..301` 相交）。修法是顶栏改纵向 flex，相关规则散在 `styles.css` 多处。
5. **不要恢复 `placeholder`**（§2.3，主人明确说是他要删的）。
6. **入口不要重复。** 恢复顶栏后要检查：顶栏药丸 / 手机按钮 / 「更多」菜单搜索项 / 编辑区按钮，最多各留一个。
7. **`docs/changelog.md` 被 gitignore、从未提交** —— 改动照常写进去，但不进 commit。
8. **`data/` 是主人的生产库**，本任务全程只读，不涉及写库。

---

## 7. 验收建议（恢复之后）

- `.review/verify-search-ui.mjs` 是**为这套 UI 写的**老脚本（当年 10/10 PASS），可直接复用；但它的判据停在 2026-09-29 之前，**先看一遍再跑**，可能已过期。
- `.review/probe-search-click.mjs` 守"点击不出方框"，恢复后必跑。
- 手机端要覆盖 **320 / 360 / 390 / 430px**：搜索按钮与天气卡不重叠、无横向溢出、点得开弹窗（`docs/todo.md` §28 的量尺）。
- `npm run typecheck` + `npm test` + 浏览器 CDP 客观断言，结论落盘 `.review/*.txt`，末行 `RESULT: PASS/FAIL`。
- **不要拿 3011/5199 跑会产生记录的验收**（那是生产库）。

---

## 8. 复现命令汇总

```bash
# 老搜索框最后存在的提交
git rev-parse fcc50db^                      # → 1535b42
git show 1535b42:apps/web/src/styles.css | grep -c "search-form"   # → 18

# 删除发生在哪个提交
git log --all --oneline -S'.search-form' -- apps/web/src/styles.css
git log --all --oneline -S'mobile-search-button' -- apps/web/src

# 线上现状（需 5199 在跑）
node -e "const http=require('http');http.get({host:'127.0.0.1',port:5199,path:'/src/main.tsx'},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>{const c=s=>(b.match(s)||[]).length;console.log('RecordSearch',c(/RecordSearch/g),'search-form',c(/search-form/g),'mobile-search-button',c(/mobile-search-button/g),'SearchDialog',c(/SearchDialog/g))})})"

# 那次无记录的删除脚本
ls .review/*record-search*.cjs
```
