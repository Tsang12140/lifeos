# LifeOS 项目长期记忆（硬规则速查）

> 全文 `AGENTS.md` · 改动记录 `docs/changelog.md` · **「为什么」与实例在 `MEMORY-detail.md`**（同标题可搜）。本文件**必须能整份注入**，只留「照做」的句子。

## 0. 三条最容易出人命的

1. **`data/` = 主人的生产库，3011/5199 直接指着它。** 永不重置 / 永不 `seed-demo --clean` / 永不删；造数据另开 `LIFEOS_DATA_DIR`；动手前 `node .review/data-inventory.mjs`（有主人写的记录就 exit 1）。
2. **密钥只写形状与来源，绝不写值**（「文件被 ignore」不是抄值的理由；**凡会被存档的输出都不许回显值**）。推送前 `typecheck` + `npm test` + `node .review/scan-secret-leaks.mjs`。回滚点用 **`refs/backup/`**（`refs/original/` 返回 0 却不建 ref），建完 `show-ref` 验。
3. **搬数据目录 / 改 `LIFEOS_PASSWORD` 会静默废掉已存 API key** → `.env` 里 4 个 `LIFEOS_*_CONFIG_SECRET` **别删别改**。解不开也不丢（密文原样抄回），量尺 `.review/verify-ai-key-persist.mjs`。**手写 config json 无效**（AES-256-GCM）→ 绕开 UI 就写 `.env`（`.review/set-ai-key-env.mjs`）**并重启 API**。**「测试连接」不落盘** ⇒ 成功 ≠ 已保存。

## 环境

- **沙箱在 turn 结束时回收子进程** → **开工先探端口**，不在就 `.review/spawn-serve.mjs`。**「读不了 / 数据不见了」的第一嫌疑永远是服务没在跑。**
- **删文件撞沙箱 `safe-delete` 闸门**：每 turn 累计 **50 个文件**，**在删任何东西之前**就抛 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，四个 fs 字段全 `undefined`。**不是句柄占用**（`renameSync` 能成功即铁证）；**重试无用**。判定走 `.review/lib/delete-guard.mjs`。
- **同一条命令会被跑两趟**（沙箱内一趟 + `Sandbox bypassed` 一趟）⇒ 第一趟的删除必被拒且**输出被丢弃**。**别拿脚本自己的「已清理」当证据**，收尾自己 `readdirSync` 数一遍。
- `node -e` 写含反引号 / `$(…)` / 反斜杠的文本必炸 → 先 `Write` 成文件。
- **收尾口径**：改了什么 / 怎么验证 / 验收数字 / 预览 `http://127.0.0.1:5199/`。**不出截图。**

## 数据与备份

- config json **不在 git、无副本**；照片在 `LIFEOS_ASSET_ROOT`（**不在快照、无备份**）。**恢复三件事**：停 API、删 `-wal`/`-shm`、保留 config json。
- **搬/复制 sqlite 前必须 `PRAGMA wal_checkpoint(TRUNCATE)`**（只复制 `.sqlite` 会静默丢最新记录）；`VACUUM` 后尺寸要在 `close()` 之后再量。
- **读数据前先确认读的是哪个库**（`data/`、`.review/data`、`.review/*-run/` 同名文件表结构可能不同）。
- 示例标记 = **`records.is_demo`**（正文无前缀）；回收站残留用 `.review/purge-trash-junk.mjs`（dry-run 默认，**认不出的行中止整轮**）。
- 回收站条目**没有 `id`** ⇒ 一律传 **`asset.id`**；`contentHash` 挂在 **`storageRefs[*]`**；回填是**单向窗口**（160/161）。
- **删实体前必须先软删记录**（引用检查只算活记录，`repository.ts:1422` → 反序必 409）；**迁移类改动必须显式搜 `.review/`**（被 gitignore）。

## 验收

- 跑前先 `node .review/audit-toolbox-targets.mjs`（有未守卫的写入脚本就 exit 1）。
- **崩溃必须变成 FAIL**：脚本抛错时结果文件会留着上次的 `RESULT: PASS` → **看到 PASS 先确认断言条数**。
- **断言必须自带证据**（数字写进消息）；**点错元素 CDP 不报错** → 用 `elementFromPoint` 命中测试；**判据挂在机制上，不挂在副产物上**。记录正文在 **`body.original`**，**没有 `content` 字段**。
- **图片「加载成功」≠「画出来有东西」**：判据 = **画布采样**（`.review/probe-photo-content.mjs`），三条缺一不可：请求成功 + 滚动后仍成功 + 采样后有内容。
- 瞬态缺陷**过程中**高频采样；日期夹具动态推导；脚手架用异步 `spawn`。
- **贴 3011 的验收需 `LIFEOS_ALLOW_PROD_ACCEPTANCE=1`**，否则被生产守卫拒、看着像脚本坏了。
- **偶发的网络类 FAIL 先重跑一次再怀疑产品**：观影「测试连接」打 TMDb `/configuration`，本机代理抖一下就报「TMDb 暂时无法连接」，而同一刻 `resolve` 是通的（实测 4 连 4 成功）。
- **给实体加字段要同时放行三处**，漏一处「导入」就静默 400：core 的 `movieFieldNames` 校验 + API 的 `MOVIE_FIELD_NAMES`（PATCH 走它）+ `MOVIE_INPUT_KEYS`（`hasOnlyKeys` 白名单）。
- `docs/changelog.md` **被 gitignore、从未提交** —— 照常写，但它不进 commit。

## 磁盘：测试失败先 `df -h /c`

- `ENOSPC` / `database or disk is full` 常是 C 盘满，**伪装成产品回归**；**「有清理调用」≠「清理成功」**。
- 清理必须**同步强杀**（清理块多在 `finish` / `process.on("exit")` 里，`await` 非法）：`.review/reap-chrome.mjs`（**新脚本一律用它**）、`.review/sweep-profiles.mjs`。
- **`child.kill("SIGKILL")` 在 Windows 上不保证已死** → 也要 `taskkill /F /T /PID`。
- **`existsSync` 把任何 `stat` 错误吞成 `false`** ⇒ 别拿它当前置判断（会整段跳过删除却报「已删」）→ 用**父目录 `readdirSync`**。**`try/catch` 里忘 import 的函数，异常被静默吞掉**。

## 其余细则（全文在 `MEMORY-detail.md` 的 `## 细则全文`）

**UI 红线**：卡片 430.08px、**双列已删不要恢复**、界面文字不可选中（白名单只放叶子）、`.settings-switch` 只画药丸、**状态不可读处不许配写盘按钮**。**时光机**（快照绝不原地打开、照片只在「今天还画得出来」时才给）与**日历**（编辑模式只活在月视图、初始为「周」、退出 = 先存后退）细则见 detail。
