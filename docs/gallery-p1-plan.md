# 图库省流量 P1：前置调查与方案（2026-10-28）

> 结论先行：**原定的「图库按月独立分页接口」已经不值得做。**
> 真正的大头不是正文、也不是分页，而是列表接口把**每张照片的 AI 描述与 OCR 全文**一并下发，
> 它占了整份响应的 **72%**，而前端一个字段都没用。
> 把它从列表读取里剥掉，等于用一处改动拿到比「拆接口」更大的收益。

---

## 1. 三个界面各自要什么

`/api/records` 是全站唯一的记录读取口。当前各界面拿到的都是**同一份完整记录**：

| 界面 | 请求 | 实际需要的字段 | 是否分页渲染 |
|---|---|---|---|
| 今日页 / `RecordFeed` | `?timeZone=…&to=<今天>` | 全部（正文、实体、任务状态） | **否**，一次性渲染全部 |
| 图库 | 同上（与今日页共用缓存） | `id / occurredAt / createdAt / isPrivate / isDemo / assetRefs[role=photo]` | 是，客户端 24 张一页 |
| 月历 | `?calendar=1&from=…&to=…` | 日期 + 180 字摘要 | 是（6 周网格） |

两个关键事实：

- **图库已经在带 `to=<今天>`**（`apps/web/src/main.tsx:741`），所以它拉的是「全部历史」而不是「全部未来+历史」。
- **今日页不分页**（`timeline.tsx` 里没有任何 `slice` 截断渲染），所以它确实依赖全量下发。
  这意味着「把接口拆开」只能帮到图库一家，今日页照样要全量。

## 2. 钱花在哪：字段级体积（84 条真实记录，identity 239,123 B）

| 字段 | 字节 | 占比 |
|---|---|---|
| `aiDerived` | **173,078** | **72.4%** |
| `body` | 28,346 | 11.9% |
| `assetRefs` | 6,712 | 2.8% |
| `occurredAt` / `createdAt` / `id` / `updatedAt` | 15,507 | 6.5% |
| 其余（`entityRefs` / `task` / …） | 15,480 | 6.5% |

`aiDerived` 内部拆开（235 条）：

| 类型 | 字节 | 前端是否读取 |
|---|---|---|
| `lifeos-photo / summary / photo-description` | 108,760 | **否** |
| `lifeos-photo / summary / photo-ocr` | 63,409 | **否** |
| `lifeos-assistant / classification / ai-assisted` | 539 | 是（「辅记」标签） |

也就是说：**172KB 里只有 539 字节是 UI 用得上的。**

## 2.5 冷启动实测（浏览器里量的，不是推算）

用 `.review/probe-cold-load.mjs` 打开今日页，读 `performance.getEntriesByType("resource")`。
**一个页面冷启动会发 3 个不同的 `/api/records` 请求**：

| 请求 | 条数 | identity | gzip | 用途 |
|---|---|---|---|---|
| `?nature=real&to=<今天>` | 84 | 239,123 | 56,632 | 今日页/图库主列表 |
| `?kind=task` | 61 | 62,544 | 17,004 | 右侧待办栏 |
| `?timeZone=…`（无 `to`） | 85 | 242,570 | 57,836 | **只为算 `demoCount` 一个整数** |
| **合计** | | **544,237** | **130,572** | |

> 开发模式下每条会被 StrictMode 重跑一次、首轮被 abort，所以网络面板里能看到 6 条（其中 3 条 0 字节）。
> 上表是那 3 条真正完成的。

剥离照片派生数据后：

| 请求 | 剥离前 | 剥离后 | gzip 前后 |
|---|---|---|---|
| 主列表 | 239,123 | 66,752 | 56,632 → 19,196 |
| 待办列表 | 62,544 | 38,244 | 17,004 → 10,782 |
| `demoCount` 那条 | 242,570 | 70,199 | 57,836 → 20,344 |
| **合计** | **544,237** | **175,195（32.2%）** | **130,572 → 50,322（38.5%）** |

两个附带发现：

- **待办记录里也有 31 条照片派生数据**（照片可以挂在任务上），所以剥离不只对图库有效。
- **`demoCount` 那条是纯浪费**：整份全量记录只为数出「示例数据有几条」。
  而且 `refresh()` 会 bump `relationReload`，**每保存/删除一条记录都会重发一次**（57.8KB gzip）。
  这条与图库无关，但成本比图库整页还高，建议单独处理（见 §7）。

## 3. 四种响应形态实测

| 形态 | identity | gzip | 相对现状 |
|---|---|---|---|
| 现状（全量） | 239,123 | 56,332 | — |
| 剥掉 `lifeos-photo` 条目 | 66,752 | **19,196** | **−66%** |
| 只留 classification（等价于上一行） | 66,752 | 19,196 | −66% |
| 图库专用精简（只留 19 条带照片的 journal） | 8,056 | 2,070 | −96% |

服务端代价（同一台机、20 次采样）：

| | p50 |
|---|---|
| `identity` | 27.2 ms |
| `gzip` | 31.5 ms |
| `JSON.stringify + gzipSync`（全量） | 5.25 ms |
| `JSON.stringify + gzipSync`（剥离后） | **1.17 ms** |

## 4. 为什么原 P1 不值得做

原 P1 的收益假设是「图库被迫下载 233KB 无关正文」。P0 的 gzip 把 233KB 压到 56KB 之后，
再剥离派生数据降到 19KB。此时：

- 图库首屏总流量 ≈ **19KB(记录) + 9.5KB(资产) + 6~9 张缩略图 ≈ 100KB**，
  JSON 只剩 **~22%**，缩略图（WebP q80）占了绝大部分。
- 为再省这 17KB 去新建 `/api/gallery`，代价是：服务端复制一份「记录→照片出现位置」的推导逻辑、
  前端多一套数据类型、**并且和今日页失去共用缓存**（现在两者 query 完全相同，切页零请求）。
  收益 17KB / 代价一次重构 + 一处新的不一致来源 —— 不划算。

**结论：P1 重新定义为「列表读取剥离照片派生数据」，而不是「新开图库接口」。**

## 5. 建议改动（一处，约 10 行）

`apps/api/src/routes-records.ts` 里，列表读取有两个出口（`near` 分支 167 行、主出口 178 行），
在出口前统一过一层「列表视图」：

```ts
// 照片描述与 OCR 全文只服务于服务端检索索引，任何列表界面都不渲染它们。
// 整份响应里它们占 72%，因此列表读取一律不发；单条读取（/api/records/:id）仍发全量。
const forList = (record: RecordView): RecordView =>
  record.aiDerived.some(item => item.provider === "lifeos-photo")
    ? { ...record, aiDerived: record.aiDerived.filter(item => item.provider !== "lifeos-photo") }
    : record;
```

`calendar=1` 分支已经在做同类事情（截断正文 + `aiDerived: []`），这是既有先例，不是新发明。

### 为什么安全（四条证据）

1. **前端没有任何代码读这些字段。** 全仓库 `apps/web/src/**` 里 `.aiDerived` 只出现在
   `notes-transfer.tsx:411`，而它的 `original` 来自**用户上传的导入包**（`plan.native.records`），
   不是列表响应；列表响应在那里只被用来取 `id`。
2. **「辅记」标签不受影响。** `isAiAssisted` / `isBackfilled` 只认
   `provider === "lifeos-assistant" && kind === "classification"`，这 539 字节保留。
3. **写不回去。** `patchRecord` 的 `hasOnlyKeys` 白名单（`record-builders.ts:128`）**不含 `aiDerived`**，
   且 PATCH 走 `repository.findById()` 拿服务端副本再合并 —— 客户端拿到剥离版也永远覆盖不了库里的数据。
4. **服务端检索不受影响。** 关键词命中在 `repository.list(query)` 内部完成，`q` 的匹配发生在
   出网之前；测试 `api.test.ts:401`（OCR 里的词能命中）走的是 `.items.map(r => r.id)`，只看 id。

### 测试计划

- 新增：列表接口对带 OCR 的记录返回的 `aiDerived` 里**不含** `lifeos-photo`，但**含** classification；
  同一记录的 `/api/records/:id` 仍返回全部条目。
- 回归：`api.test.ts` 里 OCR 关键词命中那条（只看 id）、`photo-description.test.ts:140`（走单条 GET）、
  `notes-transfer` 相关 web 测试。
- 验收：图库 48 条断言（`verify-gallery-page.mjs`）+ 今日页滚动加载不变。

### 风险与回退

- 唯一风险：将来想在列表里显示「照片一句话描述」。届时加 `?derived=1` 开关即可，不需要回退数据。
- 回退成本：删掉 `forList` 一处调用。

## 6. 做完这条之后还剩什么

图库流量将变成 **~90% 是图片字节**（WebP q80：240px ≈ 13.7KB、400px ≈ 35.3KB）。
下一步的杠杆在图片侧，不在 JSON 侧：

- 降 `THUMBNAIL_QUALITY`（80 → 72）或补一档 320px；
- 用 `sharp` 出 AVIF，`<picture>` 里排在 WebP 前面（同一张图通常再省 25~35%）；
- 两者都要重新量「画质能不能接受」，不能只看体积。

这三条都还没做，也都不该在没有样本对比的情况下动。

## 7. 顺带发现的浪费：`demoCount` 拉全量记录

`apps/web/src/main.tsx:1096` 把 `/api/records`（**不带 `to`，连未来记录一起**）和
`/api/entities`、`/api/assets` 放在同一个 `Promise.all` 里，结果只用了：

```ts
setDemoCount(demoPayload.items.filter(isDemoRecord).length);
```

代价：每次冷启动 **57.8KB gzip**，每次 `refresh()`（保存/删除记录后触发 `relationReload`）再来一遍。

三个选项，按代价从低到高：

1. **让列表接口顺带回一个计数**：主列表响应里加 `demoCount`（服务端 `repository.list()` 已经有了，
   多算一次过滤几乎免费）。缺点：`demoCount` 是「全部记录」口径，主列表是 `to=<今天>` 口径，两者不一致，
   得在服务端对**全量**算一次 —— 仍然比下发 242KB 便宜得多。
2. **加 `?fields=count` 之类的轻量口径**：只回 `{items:[{id,isDemo}]}` 或直接回计数。
   干净，但引入新参数约定。
3. 维持现状，只吃 §5 剥离带来的 242KB → 70KB。

倾向 1（不改前端请求数、不新增参数）。**但这条不属于图库，需单独拍板。**
