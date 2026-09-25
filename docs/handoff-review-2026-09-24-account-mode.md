# LifeOS 账户模式收尾 · 交接与复核说明

- **日期**：2026-09-24（Asia/Shanghai），会话时段约 18:00 – 20:35
- **执行 AI（本次）**：在下 / WorkBuddy
- **上一棒**：Codex / GPT-6 Luna Max（账户模式数据层与多租户网关；额度耗尽，未接线）
- **仓库**：`E:\Projects\motion-lab\lifeos`，分支 `main`，远端 `https://github.com/Tsang12140/lifeos.git`
- **本地提交**：`c09a36a`（18 files, +1166 / −51）
- **推送状态**：**未 push**。会话结束时 `main` 比 `origin/main` **ahead 2**（另一条是上一棒的 `6c787f3` MiSans 字体收敛）

> 这份文档是给**另一个 AI 审核**用的。写法约定：**结论 / 证据 / 未验证 / 未做 四块分开**；
> 每条结论都附可复跑的命令或落盘文件，方便逐条抽查、反驳或复现。
> 改动正文在 `docs/changelog.md` **最末尾**（同日同名条目，含完整坑表）；规则在 `AGENTS.md`。
> 本文件不复制它们的全文，只补「怎么查、查哪里、哪里还没证实」。

---

## 1. 她让我做什么（原始要求逐条对照）

| # | 要求（原话要点） | 我做到哪一步 | 可查证据 |
|---|---|---|---|
| 1 | 「**怎么确定谁是管理员**？」 | owner 由**服务端身份库的角色**决定，不看用户名；兑换邀请码一律建成 `member`，**第一个兑换的人也不会变成 owner** | `apps/api/test/api.test.ts` → `an invite code mints exactly one space and never grants owner rights`；`apps/api/src/server.ts` 的 `accountAdminError` → 403 `owner_required` |
| 2 | 「**多租户怎么定天气**？手机要**实时根据定位反映天气**」 | 租户天气相互隔离；设备级跟随：用户同意后才定位 → 坐标交和风 GeoAPI 换成**城市**（坐标四舍五入 2 位，**只存城市、不存轨迹**）→ 打开页面 / 切回前台 / 明显位移时重查，**城市明显变化才更新** | `apps/api/src/weather.ts` 新增 `lookupWeatherLocationByCoordinates`；`apps/api/src/routes-weather.ts` 新增 `/api/weather/device/location`、`/api/weather/device/locate`（60s 限流，超限回当前城市 + `throttled:true`）；前端 `apps/web/src/weather-follow.ts` + `main.tsx` 挂载 |
| 3 | 「**做一个欢迎界面**：首次拿到邀请码 → 登录 → 创建账号 → 选天气」 | `WelcomeGate` 四步（登录 / 邀请码 / 自设账号密码建空间 / 选天气），自动登录，天气可「当前位置 / 手选城市 / 暂时跳过」 | `apps/web/src/WelcomeGate.tsx`（上一棒写，我接线进 `main.tsx`）；`.review/verify-account-welcome-ui.mjs` 全套断言 |
| 4 | 「点**更多**时菜单从左上角展开，不符合常理，应该从更多那里。**做一个小小的上拉菜单**」 | 改成锚在「更多」标签上的小 popover（宽 264px），开口在标签**上方**；旧的左侧抽屉规则已删 | `apps/web/src/styles.css` 的 `.mobile-menu-dialog`；几何数字见 §4.1 |
| 5 | 「**AI 助手默认先隐藏**……不代表功能消失，也不代表 Key 消失」 | `readAssistantVisibility` 默认返回 false；开关、Key、页面全在 | `apps/web/src/app-meta.ts`；`.review/verify-account-welcome-ui.mjs` 有 2 条专门断言；`.review/verify-mobile-layout.mjs` 另加「默认关 → 打开 → 浮钮出现 → 关回 → 浮钮消失」 |
| 6 | 「发出去邀请码都是**自己人**，AI Key 同时给他们用，**不需要他们额外输入**」 | 成员租户的 AI / 天气 Key 由 owner 的**有效配置**下发（`SharedIntegrations`）；**位置与城市不继承** | `apps/api/src/tenant-config.ts` 的 `tenantConfigFor(..., shared?)`；`apps/api/test/api.test.ts` 的 `tenant identity foundation` 用例断言 `shared.deepseekApiKey === "owner-ai-secret"`、位置为 `undefined` |
| 7 | （本回合）把这轮「让我做什么 / 做了什么 / 怎么做的」写出来给另一个 AI 审核 | 就是本文件 | — |

**上一棒已与我确认过的 V1 口径**（我按它落地）：单次邀请码 + 自设密码 + 自动登录 + 可跳过的定位天气 + 服务器统一持有天气 Key；跟随时「每次打开 / 切回页面自动检查，明显变化才更新」。

---

## 2. 接力关系（**哪部分不是我写的**，审核时请分开看）

| 文件 | 谁写的 | 我做了什么 |
|---|---|---|
| `apps/api/src/identity-store.ts`（+154） | **上一棒** | 只读使用；**没有逐行审阅**，靠 `api.test.ts` 的两个新用例做行为验收 |
| `apps/web/src/WelcomeGate.tsx`（+131）、`weather-follow.ts`（+96）、`welcome.css`（+45） | **上一棒** | **没有逐行审阅**；接线、编译、CDP 全流程验收 |
| `apps/web/src/shell-nav.tsx`（±2，「更多」按钮 `#mobile-more-trigger`）、`app-meta.ts`（AI 默认关）、`dialogs.tsx` 的 `positionMenu()` | **上一棒** | 接线 / 验收；`dialogs.tsx` 我另改了 3 处（见 §3） |
| `apps/api/src/server.ts` 账户网关主体 | **上一棒** | 我在上面加了邀请码路由与错误映射 |
| `apps/api/src/config.ts`、`routes-weather.ts`、`tenant-config.ts`、`weather.ts`、`api.test.ts`、`api.ts`、`main.tsx`、`settings-cards.tsx`、`styles.css`、`README.md` | **我** | 全部改动见 §3 |

> ⚠️ 审核建议：三个「上一棒写、我没逐行审」的文件（`identity-store.ts` / `WelcomeGate.tsx` / `weather-follow.ts`）是**本轮最薄的地方**。我只能证明「按行为能过」，不能证明「实现没有别的洞」。

---

## 3. 我改了什么、怎么改的（逐文件）

### 3.1 后端接线

- **`apps/api/src/server.ts`**（+181）
  - 新增 `POST /api/auth/invite/check`（返回 `{valid}`，不泄露其它信息）
  - 新增 `POST /api/auth/register`：**事务内**消费邀请码 → 建租户 → 直接签发会话（`redeemInvite` 本身保证一次性）
  - 新增 owner 专属 `GET/POST /api/admin/invites`、`POST /api/admin/invites/:id/revoke`
  - `accountAdminError` 补映射：403 `owner_required` / 409 已使用或过期 / 404 不存在
  - `sharedIntegrationsForMembers()`：从 owner 有效配置读 AI / 天气 Key 交给成员租户
- **`apps/api/src/config.ts`**（±24）
  - 账户模式不再借用会回落默认值的 `splitOrigins`，改为**直读** `LIFEOS_ALLOWED_ORIGINS`
  - 允许**全回环 HTTP Origin**（本机预览用）；只要白名单出现任何公网 Origin，仍强制 `LIFEOS_COOKIE_SECURE=true`
- **`apps/api/src/routes-weather.ts`**（+70）
  - `POST /api/weather/device/location`：写设备行，**不依赖 Key、不动空间默认城市**
  - `POST /api/weather/device/locate`：坐标 → 城市；`GEO_MIN_INTERVAL_MS = 60000` 按设备限流，超限时回当前设备城市 + `throttled: true`
- **`apps/api/src/weather.ts`**（+25）：`lookupWeatherLocationByCoordinates`，坐标四舍五入 2 位后查和风 GeoAPI，**只返回城市、不落盘**
- **`apps/api/src/tenant-config.ts`**（+21）：`tenantConfigFor(root, account, masterSecret, shared?)` 新增 `SharedIntegrations { ai?, weather? }`，仅下发 Key / baseUrl / model / host，**不下发位置与城市**

### 3.2 前端接线

- **`apps/web/src/main.tsx`**（+17）：未认证且 `accountMode === true` 时渲染 `<WelcomeGate>`；挂 `useWeatherAutoFollow(tenantId, retryWeatherProfiles)`
- **`apps/web/src/settings-cards.tsx`**（+113）：owner 专属「邀请码管理」卡（生成 / 列表 / 撤销 / 复制 + 有效期档位）；天气卡内「跟随当前位置」开关
- **`apps/web/src/api.ts`**（+17）：`InviteSummary`（列表用，**无 `code`**）/ `CreatedInviteSummary`（仅创建响应带 `code`）
- **`apps/web/src/styles.css`**（+117）：菜单 popover 重写（§4.1）+ 与 `.modal-dialog` 拆规则（§4.2）；邀请卡与跟随开关样式；`.invite-fresh code` 加入 `user-select` 白名单（**只放叶子节点**，遵守项目「界面文字不可选中」的规则）
- **`apps/web/src/dialogs.tsx`**（+4/-2 量级，3 处）：
  1. 定位 effect 改 `useLayoutEffect`（避免先闪在静态位置）
  2. `onClose` 存进 `closeRef`，避免父组件每次渲染都拆装 effect、导致焦点被反复抢走
  3. 删掉多余的一次 `requestAnimationFrame`，直接同步 `positionMenu()`

### 3.3 测试与文档

- **`apps/api/test/api.test.ts`**（+132）：新增 2 个用例（邀请码一次性 + 不授予 owner；HTTP 层兑换建空间并登录）；补共享集成 Key 断言；**改了 2 处旧断言**（见 §11 自评第 3 条）；修 1 处类型（`listInvites()[0] as unknown as Record<string, unknown>`，`noUncheckedIndexedAccess` 下 `PublicInvite | undefined` 不能直转）
- **`README.md`**（±4）：`LIFEOS_ALLOWED_ORIGINS` 必须显式提供、回环 HTTP 仅限本机预览；`LIFEOS_COOKIE_SECURE` 仅全回环时可为 false

---

## 4. 两个根因（**重点看这里**）

### 4.1 「更多」菜单为什么从左上角展开

`apps/web/src/styles.css` 里有**两条** `.mobile-menu-dialog`。后一条是旧的「左侧抽屉」，同特异性下**后写的赢**，把新的 popover 宽度覆盖掉了：

```css
/* 旧（已删） */
.mobile-menu-dialog { inset: 0 auto 0 0; width: min(86vw, 340px); max-width: none; max-height: none; ... }
```

**实测对得上**：视口 390px → `86vw = 335.4px`，CDP 量到的菜单宽度正是 **335.4**（预期 264）。

改后的 popover 规则：

```css
.mobile-menu-dialog {
  position: fixed; z-index: 62; inset: auto; margin: 0;
  width: min(calc(100vw - 20px), 264px);
  max-width: none; max-height: min(70vh, 420px);
  padding: 0; overflow-y: auto; overscroll-behavior: contain;
  border: 1px solid var(--line); border-radius: 16px;
  color: var(--ink); background: var(--surface);
  box-shadow: 0 18px 44px rgb(24 36 61 / 0.24);
}
```

**几何实测（390×844 视口）**：`menuWidth=264`、`triggerCenterX=347.8`、`menuLeft=116.0`、
`menuBottom=772.0 ≤ triggerTop=780.0`（开口在标签**上方**，是上拉）。

### 4.2 顺手挖出的**更严重**问题：模态框被一起改坏了

上一棒把 popover 样式写进了 **`.modal-dialog, .mobile-menu-dialog` 共用**的规则里。
`<dialog>` 是靠浏览器默认的 `inset: 0; margin: auto` 居中的，而那条共享规则写了：

```
position: fixed; inset: auto; margin: 0; width: min(calc(100vw - 20px), 264px);
```

⇒ **所有模态框**（搜索、导入备份、确认框、人物卡…）都会被拽到左上角、并被压成 264px 宽。
我已把规则拆成两条独立规则，`.modal-dialog` 的宽度 / 圆角 / 阴影还原成原值。

**可查证据**：构建产物里 `grep` 两条规则互不相关 ——
`.modal-dialog{width:min(100% - 32px,560px);max-height:min(760px,calc(100vh - 32px));...border-radius:22px;box-shadow:0 24px 70px ...}`，
`.mobile-menu-dialog{...width:min(calc(100vw - 20px),264px)...border-radius:16px...}`。

---

## 5. 我顺手修的**既有缺陷**（不属于本次需求，但不修就没法验收）

被修的是 `.review/verify-mobile-layout.mjs`（只读验收脚本，对着 3011/5199 跑）。
**它在这次改动之前就已经是坏的 —— 第一项就超时**，下面 5 条都与我改的产品代码无关：

| # | 症状 | 根因 | 我的修法 |
|---|---|---|---|
| 1 | 脚本**第 1 项**就超时，页面显示「天气未配置」 | 脚本用 `*api/weather*` 把浏览器里**所有**天气请求都换成硬编码快照夹具，把 `/api/weather/profiles`（早就在 `routes-ai-movie.ts:208`）也换掉了 | 只替换 `pathname === "/api/weather"` 这一个快照端点，其余一律 `Fetch.continueRequest` |
| 2 | 夹具日期 | 硬编码 `2026-09-20`，第二天就不再是「今天」 | 改按 `Asia/Shanghai` 动态推导 today / tomorrow / +2 |
| 3 | 点到空气上 | `.calendar-mode-button` **在这个仓库里从未存在过**（真正的类是 `.mode-option`，见 `calendar-view.tsx:463`） | 改点 `.mode-option`（文案「周」） |
| 4 | 等「7 张周卡」永远等不到 | 周模式下 DOM 里其实有 **14** 张 `.week-card`（7 本周 + 7 上一周预览） | 选择器改 `.week-grid:not(.week-grid-prev) .week-card:not(.is-prev)` |
| 5 | 时间轴段抛 `Uncaught` | 日期选择器只在非日历视图渲染（`WeatherHeader.tsx:159` 的 `showDateNavigation`），脚本却在日历页往它写值 → `null` | 把「回今天」提到写值之前 |
| 6 | 关菜单点到空气上 | popover 没有 header，`[aria-label=关闭菜单]` 已不存在 | 改用组件支持的 **Esc** 关闭 |

**结果**：该脚本由「第一项就死」变成 **`RESULT: PASS`（43 条 PASS / 0 FAIL，exit 0）**。

---

## 6. 验收证据（数字 + 落盘）

### 6.1 单元 / 集成测试（分工作区串行跑）

| 工作区 | 命令要点 | 结果 |
|---|---|---|
| core | `tsc -p tsconfig.json` + `node --test --test-isolation=none dist/test/core.test.js` | **29/29 pass**，exit 0 |
| api | 同上（`dist/test/api.test.js`） | **64/64 pass**，exit 0 |
| web | `node --experimental-strip-types --test apps/web/test/*.test.ts` | **11/11 pass**，exit 0 |
| instance-backup | `node --test --test-isolation=none scripts/test/instance-backup.test.mjs` | **4/4 pass**，exit 0 |

合计 **108**。（上一棒记录基线是 **106**：core 29 / api 62 / web 11 / backup 4；差额只有 api **+2**，就是本轮新增的两个邀请码用例。）
另：`apps/web` 的 `tsc --noEmit` 通过、`vite build` 通过（产物 `index-D9vnFG-H.css` / `index-1vP5mNhk.js`）。

### 6.2 隔离 CDP 验收：`node .review/verify-account-welcome-ui.mjs`

**`RESULT: PASS (39 checks)`，exit 0**，落盘 `.review/verify-account-welcome-ui.txt`。
**它自带独立 API 与独立 `LIFEOS_DATA_DIR`，一个字节不碰 `data/`。** 覆盖的断言（摘要）：

- 隔离实例起在回环 HTTP 上、网关服务的是**生产构建**（不是 dev server）
- 欢迎屏取代裸密码闸门；首屏是登录步骤；登录步骤要账号 + 密码；邀请码步骤可抵达
- 坏邀请码被拒且有可读文案（「邀请码无效或已使用，请向邀请你的人索取新的邀请码。」）
- owner 从同一个欢迎屏登录；owner 写一条记录用于隔离比对
- **默认不渲染 AI 浮钮**，且隐藏后 app shell 不坏
- **只有 owner 看得到邀请卡**；AI 开关默认关，但配置项仍在页面上（「隐藏」不是「删除」）
- 位置跟随**默认关闭**；签发邀请码后展示一次性码；**邀请码本身可选中**（能抄走）
- 登出回到欢迎屏；有效邀请码进入建号步骤；自设并确认密码 → 建空间落到天气步骤
- 天气三步齐备（当前位置 / 手选城市 / 跳过）；**跳过也照样直接登录**；空间名是用户自己起的
- 成员**看不到**邀请卡与账户管理卡；会话 cookie 是 `HttpOnly`
- 成员自己写记录 → **双向**都看不到对方的记录
- 「更多」菜单可测量、开口在标签上方、位置尽量贴合标签、是小 popover、完全在视口内、`position: fixed`、不是从左上角展开、点外部能关

### 6.3 只读验收：`node .review/verify-mobile-layout.mjs`（对着 3011/5199）

**`RESULT: PASS`，exit 0**，落盘 `.review/verify-mobile-layout.txt`。

> **条数口径（我在这里写错过一次，请注意我怎么数的）**：这个脚本的 `RESULT` 行**不带条数**
> （末尾只有 `RESULT: PASS`），所以条数是我数结果文件里的 `PASS` 行得到的：
> **43 条 PASS / 0 FAIL**。我上一轮口述里说成 44，已自查改正（`docs/changelog.md`、`docs/todo.md`、
> `.workbuddy-ai/memory/2026-09-24.md` 三处同步改）。**审核时请以结果文件为准，不要信转述的数字。**
> 退出码是真的设了：脚本末尾 `process.exitCode = passed ? 0 : 1`。

**它是对着蛋妞自己的预览跑的**，所以在跑之前我先核对了它的副作用：
`Fetch.enable` 只拦 `*api/weather*` 且全部由夹具应答（**不会真打天气 API**），其余只有 `GET /api/records` 与合成点击 ⇒ 判定为只读。
覆盖：360/390/430/768 四个宽度的底栏、无水平溢出、三横按钮已移除、天气与日期分区、
无独立刷新按钮、编辑器搜索/保存/加照片几何、**AI 浮钮默认关 → 打开 → 拖拽记忆位置 → 关回消失**、
切日不触发强制刷新 / 点摘要触发一次刷新 + toast、「更多」收纳项、Esc 关闭、
周历 7 张纵向横卡 + 右侧照片预留、时间轴左锚定、1024px 桌面控件回归。

### 6.4 工具箱审计

`node .review/audit-toolbox-targets.mjs` → **`UNGUARDED = 0`**，但整体 `RESULT: INCOMPLETE`（86 个脚本无法自动分类，属**既有状态**，本轮未动这个工具）。

### 6.5 环境状态（会话结束时）

| 端口 | 是什么 | 状态 |
|---|---|---|
| 3011 / 5199 | 蛋妞自己的预览（`.review/accept-serve.mjs`，服务 `data/`） | 200，**保持运行** |
| 3013 | 账户模式预览（`.review/account-preview-serve.mjs`，隔离数据目录） | 200，**保持运行**；确认它服务的就是本次验收过的构建（popover 264px + 模态框已还原） |

---

## 7. 我明确**没做** / **未验证** / **等你拍板**

**没做（刻意）**

1. **没有 push**（项目规则：push 由主人决定）。会话结束时 `main` ahead 2。
2. **没有读写 `data/`**、没碰 `pic-test/`、没杀她的 3011/5199、没跑任何会写生产库的验收。
3. **没有动** `.review/acceptance-summary.txt` 里那 6 条**上一轮就红**的脚本（`verify-asset-trash` / `verify-composer-shots` / `verify-hash-dedup` / `verify-search-ui` / `verify-thumbnails` / `probe-search-click`）。
4. **没有改** `audit-toolbox-targets.mjs`（它把 `verify-mobile-layout.mjs` 归在「未分类」桶 —— 我审阅并判定只读，但没改工具的判定逻辑）。
5. 没有为了「好看」放宽产品行为：唯一被改的判据是把一条**数学上不可能满足**的断言换掉（见 §11 第 3 条）。

**未验证**

1. **真机定位**：天气跟随需要 HTTPS + 浏览器定位授权；「城市变化多明显才算明显」的口径在 `weather-follow.ts`，只在隔离实例里验过接口与开关，**没有真机数据**。
2. **上一棒写的三个文件我没逐行审**（§2）。
3. **3013 预览我没有人工点过一遍**欢迎流程（只探了 `/api/auth` 返回 `accountMode: true` 与构建产物）。完整的四步流程是在隔离实例里由 CDP 跑的。
4. **生产部署链路**（DNS、证书、宝塔反代、Compose 空卷启动、真实备份恢复、旧单用户库迁移）**全部未验证**，也不在本次范围。
5. 只跑了**针对性**验收，**没有**跑完整 `run-acceptance.mjs`。

**等主人拍板**

1. 邀请码目前**只能创建时选有效期**，不能编辑、不能续期（要改就撤销重发）。若想要「第二个管理员 / owner 转让」，V1 没做。
2. `verify-mobile-layout.mjs` 里取记录用的日期窗口仍**硬编码 `2026-09-01 ~ 2026-09-30`**。9 月能跑，**10 月 1 日起会量到过期日期**。当时没顺手改成「当前月」，是因为月初可能查不到记录而直接抛错，口径想先问。
3. 是否把 4 份未跟踪的 docs（`date-switch-execution-plan` / `debug-audit-report-2026-09-24` / `mobile-layout-execution-plan` / `notes-library-execution-plan`）也纳入版本管理。

---

## 8. 复核入口：你可以这样抽查

```powershell
# 0. 状态：应该看到 main ahead 2、18 文件的提交 c09a36a
git -C E:\Projects\motion-lab\lifeos status -sb
git -C E:\Projects\motion-lab\lifeos show --stat c09a36a

# 1. 单元 / 集成测试（注意：本机 npm 走不通，见 §10）
cd E:\Projects\motion-lab\lifeos\packages\core
& "C:\Program Files\nodejs\node.exe" "E:\Projects\motion-lab\lifeos\node_modules\typescript\bin\tsc" -p tsconfig.json --pretty false
& "C:\Program Files\nodejs\node.exe" --test --test-isolation=none dist/test/core.test.js

cd E:\Projects\motion-lab\lifeos\apps\api
& "C:\Program Files\nodejs\node.exe" "E:\Projects\motion-lab\lifeos\node_modules\typescript\bin\tsc" -p tsconfig.json --pretty false
& "C:\Program Files\nodejs\node.exe" --test --test-isolation=none dist/test/api.test.js

# 2. 隔离账户模式验收（自带实例，不碰 data/；约 1–2 分钟）
cd E:\Projects\motion-lab\lifeos
& "C:\Program Files\nodejs\node.exe" .review\verify-account-welcome-ui.mjs
# 期望 RESULT: PASS (39 checks)，exit 0

# 3. 只读移动端验收（需要 3011/5199 在跑；不在就 node .review\accept-serve.mjs）
& "C:\Program Files\nodejs\node.exe" .review\verify-mobile-layout.mjs
# 期望 RESULT: PASS（43 checks），exit 0

# 4. 工具箱审计
& "C:\Program Files\nodejs\node.exe" .review\audit-toolbox-targets.mjs
```

**建议重点反驳的三个点**

1. §4.2 的模态框回归：把 `.modal-dialog` 单独拿出来看，确认它**不再**被 `inset: auto / margin: 0 / width: 264px` 影响（可以真开一次搜索框量中心点是否在视口中央）。
2. §5 的脚本修改：确认那 6 条都是**在我动手之前就存在**的陈旧判据，而不是我为了让测试变绿而放宽。
3. §6.2 的 39 条断言里，「只有 owner 看得到邀请卡」「成员看不到 owner 的记录」这类隔离断言是否足够 —— 我认为**不够取代**上一棒的 `verify-multitenant-v1` 那套双租户反向测试。

---

## 9. 我自己认为最可能被质疑的地方（先说在前面）

1. **我改了验收脚本，而不是只改产品。** §5 那 6 条里，第 3/4/5/6 条改的是**判据本身**（选择器 / 计数 / 操作顺序）。我的理由是「选择器指向的类在这个仓库从未存在过，脚本本来就没在测真东西」；但请第三方确认：**我没有把一条真实的失败改写成通过**。
2. **我把一条「居中」断言换成了「贴标签或贴边」。** 原断言 `|menuCenterX − triggerCenterX| ≤ 40` 在几何上不可能满足：菜单 264px、标签中心 347.8、视口 390 ⇒ 居中需要右边界到 479.8。新断言 = 「落在最近的合法位置（±2px）」+「宽度 ≤ 300px」。**这是我降低/改写验收标准的地方，最需要被审。**
3. **我改了 2 处既有测试断言**：`/HTTPS origins only/` → `/without paths/`（因为我把账户模式的 Origin 校验从 `splitOrigins` 改为直读 `LIFEOS_ALLOWED_ORIGINS`），并补了回环预览用例。请确认新断言**没有削弱**「公网必须 HTTPS」这条。
4. **测试数 108 vs 上一棒 106**：差额只在 api +2，是新增用例，不是我在别的文件里删了什么。
5. **`verify-mobile-layout.mjs` 的「修好了」没有第三方确认**，我只跑了两次都是 PASS；它本身的通道（CDP + 合成点击）存在假绿的可能（项目历史上出现过「脚本只把结论写进自己的 txt、不设退出码」的假绿，这个脚本的退出码是设了的：`process.exitCode` 见文件末尾）。
6. **验收没有覆盖真机 / 真服务器**，所有结论都是本机隔离环境。

---

## 10. 复现时的环境坑（别踩，会浪费你半小时）

1. **`npm test` 在本机走不通**：直接 `npm` 撞沙箱的 `wsl.exe` 黑名单；绕 shim 直调 `npm-cli.js` 又会因为 PATH 里 managed 的 **Node 22.x 不支持 `--test-isolation=none`** 报 `node: bad option`。
   → 绕开 npm：`cd` 进各 workspace，用**绝对路径**的 Node 24 跑 `tsc` / `node --test`（见 §8）。**bash 里 node 路径不能用 shell 变量**（含空格的路径会被拆开，退出码 127），写字面量。
2. **bash 是残缺 PortableGit**：`ls / cat / head / tail / grep / find` 全不存在 → 用 `node -e` 或内置工具。
3. **写含中文的文件只用 Node 的 `readFileSync / writeFileSync(..., "utf8")`**；`Set-Content` / `Out-File` 是历次乱码源头。
4. **CDP 的 `--user-data-dir` 只放项目 `.review/`**，绝不放 `%TEMP%`（曾堆到 9.3GB 把 C 盘撑爆，所有 shell 报 `ENOSPC`）。
5. **`git status` 会留 `.git/index.lock`**：本次就撞到一个 5 分钟前的空锁（`git add` 直接被拒）。确认没有 `git.exe` 在跑后删掉即可。
6. **验收脚本的清理约定**：`verify-account-welcome-ui.mjs` **PASS 才自清**，失败会**故意留下** `.review/account-welcome-run-*` 供取证。收尾记得数一遍 `.review/`，别留垃圾。
7. `data/` 是**蛋妞的生产库**（`apps/api/src/config.ts` 的默认数据目录），**永不重置、不删、不跑 `seed-demo --clean`**；动手前先 `node .review/data-inventory.mjs`（有主人写的记录 → exit 1）。

---

## 11. 附：本文件的落盘位置与配套记录

| 文件 | 内容 |
|---|---|
| `docs/handoff-review-2026-09-24-account-mode.md` | **本文件**（给审核 AI） |
| `docs/changelog.md`（末尾同名条目） | 改动正文 + 坑表（**被 gitignore，不进 git**） |
| `docs/todo.md` §23 末尾 | 「欢迎流程与邀请码收尾」+ 剩余待办（**同上，不进 git**） |
| `.workbuddy-ai/memory/2026-09-24.md` | 当日工作笔记（含「两个提交未推送」的收尾状态） |
| `.review/verify-account-welcome-ui.txt` | 39 checks 的逐条结论 |
| `.review/verify-mobile-layout.txt` | 43 checks 的逐条结论 |
