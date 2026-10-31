# AI 管家图标改稿交接包

这是 LifeOS 项目里「AI 管家」标记的全部相关代码。你只需要按你手上的设计规范**重新设计这个标记**，输出可替换的 SVG 路径，不需要理解 LifeOS 的其它业务逻辑。

---

## 1. 它是什么、不是什么

- **不是** LifeOS 品牌 logo。品牌标是 `/favicon.svg`（侧栏左上角 "LifeOS" 旁边），跟本任务无关。
- **是** AI 管家（聊天助手）入口的标记，纯内联 SVG 路径，不是图片文件——这样它能在不同地方分别用渐变、单色、Canvas 导出。
- 现状形状：**一个实心圆盘 + 内部一条折线形丝带/波形**（viewBox `0 0 1024 1024`，一个 `path` 里两段子路径）。

你可以保留这个结构重画，也可以提出更好的方向；但下面第 4 节的硬约束必须满足。

---

## 2. 它在产品里出现的 5 个位置（尺寸与颜色模式都不同）

| # | 位置 | 图标渲染尺寸 | 颜色 | 关键背景 |
|---|---|---|---|---|
| 1 | 桌面端右下角悬浮球 | 44px（按钮本身 56px） | 蓝色对角渐变 | 半透明白色圆形按钮上 |
| 2 | 移动端悬浮球 | 44px（按钮 56px） | 蓝色对角渐变 | **没有白底**，图标裸浮在页面内容上（可能是照片、纸色背景），`opacity: .7` |
| 3 | 助手面板标题栏 | 32px | 蓝色对角渐变 | 白色面板，外层有 0 2px 6px 阴影的 32px 圆 |
| 4 | 移动端底部导航「AI管家」 | **19px** | **单色 `currentColor`**（未选中 `#5d6b82`，选中 `#315dfa`） | 白色导航条 |
| 5 | 聊天记录导出图片（Canvas 绘制） | 20px | **单色 `#68717c`** | 浅色导出图页脚 |

第 4、5 处是真正的难点：**19px 单色仍要认得出**。当前位置的导航图标是把完整路径里的「外圈圆盘」切掉后剩下的内部图形（见第 4 节）。

移动底栏其它图标全部来自 `lucide-react`，19px、`stroke-width: 1.8`；AI 管家是那里唯一一个实心图标，视觉重量要和它们对齐，不能明显更黑、更粗、更挤。

---

## 3. 文件清单

```
handoff-ai-icon/
├─ README.md                       ← 本文件
├─ preview.html                    ← 自包含预览页，双击用浏览器打开即可看四种真实状态
├─ css/
│   └─ styles-excerpt.css          ← 从产品 styles.css 摘出的实际生效规则（含原始行号）
└─ src/
    ├─ assistant-logo-path.ts      ← ★ 路径数据本体（唯一需要你替换的核心文件）
    ├─ assistant-nav-icon.tsx      ← 移动端导航图标（从上面的路径切出内圈图形）
    ├─ AIAssistant.tsx             ← 悬浮球 + 面板标题栏的渲染组件（只看第 41–44 行、第 193 行）
    └─ assistant-launcher-mobile.css ← 移动端悬浮球的样式覆盖（裸图标状态）
```

另外（未复制，但改色/渐变会牵涉）：

- `apps/web/src/assistant-share-image.ts` 第 225–228 行：Canvas 里用 `Path2D(assistantLogoPath)` 以 `#68717c` 平涂，20px。
- `apps/web/src/app-meta.ts` 第 245–250 行：移动导航配置里 `{ id: "assistant", label: "AI管家", icon: AssistantNavIcon }`。

---

## 4. 硬约束（这是全套代码能正常工作的前提）

### 4.1 viewBox 固定

`viewBox="0 0 1024 1024"`，路径坐标全部落在这个画布内，圆盘贴边（0→1024）。

### 4.2 「圆盘 + 内部图形」两段子路径的约定

现状是一个 `d` 字符串里两段子路径：
1. 第一段 = 外圈满圆：`M512 0c282.773333 0 512 229.226667 512 512S794.773333 1024 512 1024 0 794.773333 0 512 229.226667 0 512 0z`
2. 第二段 = 内部图形，紧跟一个 ` m-0.021333 170.666667 …` 起始。

导航图标正是靠字符串切分拿到内圈图形的：

```ts
// assistant-nav-icon.tsx
const glyph = assistantLogoPath.slice(assistantLogoPath.indexOf(" m-0.021333"))
  .replace(/^ m-0\.021333 170\.666667/, "M511.978667 170.666667");
```

**这个切分写死了 `m-0.021333` 这个数字**，很脆弱。所以请你二选一交付：

- **方案 A（推荐）**：把两个状态拆成两个独立常量，交付时明确给出
  ```ts
  export const assistantLogoPath = "M…（含圆盘）";
  export const assistantGlyphPath = "M…（只有内部图形，无圆盘）";
  ```
  我们会把 `assistant-nav-icon.tsx` 改成直接引用 `assistantGlyphPath`。
- **方案 B**：保持「第一段圆盘 + 第二段内部图形」且第二段仍以 ` m-...` 形式紧接，那么请务必在交付里写出新的切分依据（新的起始片段字面量），否则导航图标会画错。

不要两个都给一半——哪种方案都要**成套**。

### 4.3 必须单色可用

第 4、5 处只用 `fill: currentColor` / 单一灰色，**不能依赖渐变、阴影、描边、mask、多色分区**。渐变只能作为可选的「彩色版」附加信息，图形本身在纯单色下必须成立。

### 4.4 19px 可辨识

- 任何视觉特征（笔画宽度、两笔间隙）在 1024 画布里建议 **≥ 60 units**（19px 下约 1.1px）；**< 40 units** 在 19px + 缩放屏上会糊成一团。
- 不要依赖细线、渐变过渡、透明度层次来表达结构；只用实心几何。
- 内部图形的外轮廓不要贴近圆盘边缘（留白至少 ~60 units），否则小尺寸和圆盘糊在一起。

### 4.5 不能依赖背景色

- 移动端悬浮球是**无白底的裸图标**，会浮在任意页面内容上（浅灰纸面、照片、半透明层）。图形要自带边界感（现状靠实心圆盘）。
- 桌面悬浮球自带 56px 半透明白圆底 + `backdrop-filter: blur(9px)`，图标 44px 居中，所以图标与按钮同心、留 6px 内边距。
- 面板标题栏是 32px 圆，图标满铺。

### 4.6 审美与产品基调

- 产品整体是克制、中性的浅色纸面风格（白底、细灰边、`#315dfa` 作唯一强调色）。主人明确反感「通用 AI 生成感」：不要紫蓝星空、闪烁四角星、发光球、机器人脸、emoji、字母 "AI" 直接摆在图形里。
- 图标本身**不含任何文字**；语义由外层按钮的 `aria-label` 承担（`aria-hidden="true"`）。
- 允许的渐变现状：`#60A5FA` → `#3370FF`，方向左上→右下（`x1=0 y1=0 x2=1 y2=1`）。改渐变可以，但请把两个色值单独列出。

### 4.7 不要顺手改的东西

- 不改任何尺寸：44 / 32 / 19 / 20 px，以及 56px 按钮、6px 内边距。
- 不改组件结构、不加 `<img>`、不引入字体/外部文件/新依赖。
- 不改面板布局、悬浮球拖拽逻辑、导出图排版。
- 不要为 19px 单独做一套「完全不同的图形」——如果需要简化版，请明确说明并给出两套路径的对应关系。

---

## 5. 请按这个格式交付

1. `assistantLogoPath` 完整路径（含圆盘）
2. `assistantGlyphPath` 无圆盘路径（或按 4.2 方案 B 说明切分依据）
3. 渐变（若改）：`#起点 → #终点`
4. 一个自检预览：至少在 **19px、32px、44px、128px** 四个尺寸看形状是否成立（可以给我一张对照图或一个 SVG/HTML）
5. 一句话设计意图
6. 不需要输出整份 React 组件代码

---

## 6. 自查清单（交付前过一遍）

- [ ] 19px 单色灰下，图形还认得出、不糊、不脏
- [ ] 19px 下视觉重量与 lucide `stroke-width: 1.8` 的线性图标接近
- [ ] 单色版没有渐变/透明度/描边依赖
- [ ] 图形在 1024 画布中视觉重心居中（不偏上、不偏下、不偏左）
- [ ] 内部图形与圆盘边界有足够留白
- [ ] 圆盘仍是满圆（若保留圆盘方案），边缘干净无缺口
- [ ] 路径只用 `fill`，没有 `stroke` 主体、没有 `filter`、没有 `mask`
- [ ] 不含文字、星星、闪光、机器人等通用 AI 符号

---

## 7. 当前实现的真实数值（便于你判断视觉重量）

```css
/* 桌面悬浮球：styles.css 7031–7058 */
.ai-assistant-launcher {
  width: 56px; height: 56px; border-radius: 50%;
  background: rgb(255 255 255 / 0.86);
  border: 1px solid #d6dfeb;          /* var(--line) */
  box-shadow: 0 4px 14px rgb(24 36 61 / 0.10), 0 1px 3px rgb(24 36 61 / 0.06);
  backdrop-filter: blur(9px);
}
.ai-assistant-launcher .ai-logo-svg { width: 44px; height: 44px; }

/* 移动端悬浮球：assistant-launcher-mobile.css */
@media (max-width: 900px) {
  .ai-assistant-launcher {
    border: 0; background: transparent; box-shadow: none; backdrop-filter: none;
    opacity: .7;
  }
}

/* 面板标题栏：styles.css 6705–6718 */
.ai-assistant-logo { width: 32px; height: 32px; border-radius: 50%; box-shadow: 0 2px 6px rgb(24 36 61 / 0.10); }
.ai-logo-svg { display: block; width: 100%; height: 100%; }

/* 移动底栏：styles.css 11663–11675 */
.mobile-nav-item { color: #5d6b82; font-size: 0.68rem; }
.mobile-nav-item.is-active { color: #315dfa; }
```

颜色变量：`--muted #5d6b82`、`--primary #315dfa`、`--line #d6dfeb`、`--ink-soft #364661`。

---

## 8. 怎么预览

直接双击打开 `preview.html`（无依赖、无构建）：

- A 区：桌面悬浮球（白底 56 / 图标 44，含 hover 态）
- B 区：面板标题栏 32
- C 区：移动端裸图标 44（`opacity .7`，放在照片色块上）
- D 区：移动底栏 19px 单色（未选中灰 / 选中蓝）
- E 区：导出图页脚 20px 单色 `#68717c`
- F 区：128px 放大，用来看形状细节

你可以把自己的新路径替换进 `preview.html` 顶部的两个常量，先在浏览器里对照，再交给我。
