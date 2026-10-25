# 加密 · 密码 · 验证：LifeOS 的实证与可移植做法

> 本文只写**这个仓库里真实存在、可被代码验证**的做法，以及从中抽出来、能直接搬到别的项目的结论。
> 每条都带代码位置；凡是我判断"这是权衡而不是最优解"的地方，会明说。
> **本文不包含任何密钥值**，只写形状、来源与长度。这是本项目的一条硬规则（见 §13）。

阅读顺序建议：§1 威胁模型 → §2 三处 scrypt → §4 密钥层级 → §6 加密包 → §7 会话 → §8 防爆破 → §14 泄漏面 → §16 清单。

---

## 1. 先定威胁模型：这里的"加密"各自防谁

同一个项目里出现四种完全不同的密码学用法，它们防的东西不一样。混为一谈就会做出错误的安全承诺。

| # | 资产 | 机制 | 防谁 | **不防谁** |
|---|---|---|---|---|
| 1 | 配置文件里的第三方 API Key（AI / 天气 / 观影 / 备份） | AES-256-GCM，密钥由 `scrypt(secret, 固定标签, 32)` 派生 | 拿到 `data/*.json` 副本、但没拿到 `.env` 与机器的人 | 拿到整台机器的人（种子就在同机 `.env` 或路径里）；root；内存转储 |
| 2 | 账号密码 | scrypt 单向哈希 + 随机盐 | 数据库被拖走后直接反推密码；彩虹表 | 弱密码被离线爆破（只能靠慢哈希抬高成本） |
| 3 | 导出包 `.lifeos` | AES-256-GCM，密钥由 `scrypt(用户口令, 每包随机盐, 32)` 派生 | 包在网盘 / U 盘 / 邮件里流转时被读 | 正在运行的服务器（它持有明文与口令） |
| 4 | 分享链接的访问密码 | scrypt 哈希 + HMAC 签名的短期 cookie | 拿到链接但不知道密码的人 | 拿到链接 + 密码的人（这就是授权的定义） |

**通用结论 1：先写清楚"加密保护的是静态副本还是运行中的服务"，再选方案。**
LifeOS 的完整包在 `docs/archive-format.md:17` 里就明确写了这句话：

> 服务器处理口令与明文，此方案保护导出文件，不能隔离正在运行的应用服务器。

这句话本身就是设计产物。没有它，用户会以为"我加密了，所以服务器也看不到我的数据"。

**通用结论 2：加密解决机密性，不等于解决完整性与可用性。**
本项目的做法是把三者绑在同一条链上：GCM tag（完整性）+ SHA-256 逐件校验（原件一致性）+ 先写临时文件后原子替换（可用性）。

---

## 2. 密码 → 密钥：三处 scrypt，参数故意不同

三处都叫 scrypt，但**参数不一样，因为攻击场景不一样**。这是最容易被抄错的地方。

| 用途 | 位置 | N | r | p | dkLen | maxmem | 盐 |
|---|---|---|---|---|---|---|---|
| 账号密码哈希 | `identity-store.ts:10` `:54` | 16384 | 8 | 1 | 64 B | 64 MiB | 每账号 16 B 随机（hex 存储） |
| 分享链接密码 | `routes-note-shares.ts:18` | 16384 | 8 | 1 | 32 B | 64 MiB | 每分享 16 B 随机 |
| 完整加密包 | `encrypted-archive.ts:15` | **131072** | 8 | 1 | 32 B | **256 MiB** | 每包 16 B 随机 |

**为什么完整包用 8 倍 N：** 登录是交互式的，用户等 200ms 是极限；而加密包是**离线资产**——攻击者拿到文件后可以慢慢跑几个月。所以这里该用"让攻击者痛苦"的参数，而不是"让用户不等待"的参数。

**代价必须自己承担：** `maxmem: 256MiB` + `N=131072` 意味着单次派生要占约 128 MiB 内存、几百毫秒 CPU。在 4 核 4G、还跑着别的项目的服务器上（见 `AGENTS.md` 的部署约束），这就是一个必须算进去的容量项。所以完整包导出被限制为**每空间一次、全实例最多 3 个临时任务、2 个并发处理**（`docs/archive-format.md:33`）。

**通用结论 3：慢哈希的参数按"谁在等"来分档。**
交互式验证 → 100–300ms 档（本项目 N=16384）；离线文件加密 → 秒级档（N=131072）；两者不要共用一套常量。

**通用结论 4：密码不做 trim、不做 Unicode 归一化**（`archive-format.md:17`）。
好处是不会出现"我明明输对了"的玄学失败；代价是"密码末尾多打一个空格"会变成另一个密码。这是一个明确的取舍：**宁可拒绝，不要猜测用户的意图**。但要在 UI 上把密码框的可见性切换做出来（本项目 `WelcomeGate.tsx:33` 有 `visible ? "text" : "password"`）。

**通用结论 5：密码长度上下界都要有。**
本项目统一 10–1024 字符（`identity-store.ts:179`、`encrypted-archive.ts:14`、`routes-archive.ts:31`）。上界不是洁癖——scrypt 的输入长度不受限，但超长输入是廉价的 DoS 面（一次请求让你算一个 10MB 字符串的 KDF）。

---

## 3. 密码哈希的存储格式：把版本写进字符串

`identity-store.ts:63-78`：

```ts
export async function hashAccountPassword(value: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${(await scryptKey(value, salt)).toString("hex")}`;
}
```

存下来的是 `scrypt:<32 hex 盐>:<128 hex 哈希>`。

校验时**先做严格的形状校验，再算哈希**：

```ts
const [algorithm, salt, hash, extra] = stored.split(":");
if (algorithm !== "scrypt" || !salt || !hash || extra !== undefined
    || !/^[0-9a-f]{32}$/i.test(salt) || !/^[0-9a-f]{128}$/i.test(hash)) return false;
```

这一段的四个细节都值得抄：

1. **算法名做前缀** —— 将来换 argon2 时可以按前缀分流，老哈希继续能验，用户下次登录时静默升级。
2. **字段数必须恰好 3 个**（`extra !== undefined` 直接 false）—— 防止有人往哈希里塞分隔符做注入式解析。
3. **长度用正则钉死** —— 不是"看起来像 hex 就行"，而是精确 32 / 128 个 hex 字符。长度不对就不进 KDF，省掉一次无意义的 CPU 消耗。
4. **解析失败返回 `false` 而不是抛异常** —— 抛出去会变成 500，而 500 与 401 的差异本身就是信息泄漏（"这个账号的记录坏了"）。

比较用 `timingSafeEqual`，并且**先比长度**：

```ts
return actual.length === expected.length && timingSafeEqual(actual, expected);
```

`timingSafeEqual` 在长度不等时会抛错，所以长度检查是必须的，不是优化。它确实泄漏了"长度不同"，但哈希长度是固定的 64 字节，所以实际泄漏量为零。

---

## 4. 密钥层级：一个主密钥，派生出每租户每模块的密钥

这是本项目最值得抄的一段设计（`identity-store.ts:165-175` + `tenant-config.ts:38-40`）。

### 4.1 主密钥

首次启动时生成，存进 `identity.sqlite` 的 `identity_meta` 表：

```ts
const masterSecret = typeof master?.value === "string" ? master.value : randomBytes(32).toString("base64url");
```

32 字节 CSPRNG，base64url 编码。**它不来自密码，也不来自环境变量** —— 所以它不会因为用户改密码而变，也不会因为 `.env` 丢失而变（只要数据库还在）。

### 4.2 派生

```ts
function deriveConfigSecret(masterSecret: string, tenantId: string, module: string): string {
  return createHmac("sha256", masterSecret).update(`lifeos:tenant-config:v1:${tenantId}:${module}`, "utf8").digest("hex");
}
```

`tenantConfigFor` 为每个成员空间派生 4 把（`ai` / `weather` / `movie` / `backup`，`tenant-config.ts:88-93`）。

**为什么是 HMAC 而不是"截断 master"或"sha256(master+id)"：**

- 域分离：`lifeos:tenant-config:v1:<tenantId>:<module>` 里的每一段都参与输入，**换租户或换模块得到完全无关的密钥**，且不会与"用同一个 master 做别的用途"撞车（版本号 `v1` 让将来换派生方案有地方写）。
- 单向：拿到某个租户的派生密钥，反推不出 master，也就拿不到别人的。
- 无状态：不需要为每个租户存一把密钥；删租户不需要"销毁密钥"这一步（数据库里那行记录删掉，密钥就再也不存在了）。

**通用结论 6：一个主密钥 + HMAC 域分离派生，比"每个用途存一把密钥"更好维护，也比"所有用途共用一把"安全。**
判断标准很简单：**如果两个用途共用一把密钥，那么任何一个用途的密文都能被另一个用途的代码解开** —— 这就是不该共用的理由。

### 4.3 单用户模式的种子回退链（以及它的陷阱）

没有账号模式时，四个 `*-config.ts` 用的是这条链：

```ts
const secret = config.tenantConfigSecrets?.<模块>
  || process.env.LIFEOS_<模块>_CONFIG_SECRET?.trim()
  || process.env.LIFEOS_PASSWORD
  || `lifeos-local-<模块>:${config.dataDirectory}`;
```

（`ai-config.ts:77`、`weather-config.ts:78`、`movie-config.ts:37`、`backup-config.ts:38`，`amap-location.ts:17` 还额外兼容 `LIFEOS_WEATHER_CONFIG_SECRET`。）

**这条链是方便性与稳定性的直接冲突，而且真的出过事。** 最后那个回退项用的是**数据目录的绝对路径**。于是：

- 把数据目录从 `.review/run/data` 搬到 `data/` → 种子变了 → **所有已保存的 API Key 静默解不开**，设置页只显示"未配置"，没有任何报错。
- 改 `LIFEOS_PASSWORD` → 同样的事情再发生一次。

本项目的处置方式是**把种子钉死**：`.env` 里长期保留 4 个 `LIFEOS_*_CONFIG_SECRET`，值写成"搬迁前那个路径"的形状，例如：

```
LIFEOS_WEATHER_CONFIG_SECRET='lifeos-local-weather:<搬迁前的数据目录>'
```

**通用结论 7：任何"从环境或路径推导出来的加密密钥"都必须被显式钉住。**
判据：如果这个值会随部署位置、用户名、工作目录、密码而变化，那它就不能直接当密钥种子。要么写进 `.env` 固定下来，要么存进数据库（像 4.1 那样）。

**通用结论 8：解密失败必须能被看见，不能静默降级成"未配置"。**
`publicAiConfig` 为此单独暴露一个字段（`ai-config.ts:209-213`）：

```ts
const keyUnreadable = existing?.encryptedApiKey !== undefined && ... && decryptApiKey(config, existing) === undefined;
```

界面拿到 `keyUnreadable: true` 才能说"文件里那把现在读不出来，请重新填一次"。否则用户永远不知道自己配过。

### 4.4 反查工具

`.review/find-weather-secret.mjs` 是一个 79 行的脚本：枚举几个候选种子（不同路径形态、大小写、斜杠方向），逐个尝试解密，**命中时只打印候选字符串与明文长度，绝不打印明文**：

```js
console.log(`${name}: DECRYPTED by ${JSON.stringify(found.candidate)}  (len=${found.plain.length})`);
```

**通用结论 9：为"密钥可能被哪个种子加密的"写一个只输出形状的反查工具。**
成本 80 行，收益是把"玄学丢 key"变成 5 分钟能定位的问题。注意它打印的是**种子候选**（这不是密钥本身，是种子来源），但仍然不打印解出来的 key。

---

## 5. 对称加密的具体做法（AES-256-GCM）

四个 `*-config.ts` 是同一个模板，抄一份就够。以 AI 为例（`ai-config.ts:81-97`）：

```ts
const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", encryptionKey(config), iv);
const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
return { encryptedApiKey: encrypted.toString("base64"), apiKeyIv: iv.toString("base64"), apiKeyTag: cipher.getAuthTag().toString("base64") };
```

要点逐条：

1. **IV 每次重新随机，12 字节**（GCM 的推荐长度）。**绝不重用**：GCM 下 IV 重用会同时毁掉机密性和认证性，这是最容易犯的致命错误。
2. **tag 单独存**（16 字节），不要拼在密文后面。分开存让"密文存在但 tag 丢了"这种损坏状态可以被识别成"不完整"，而不是解密出一段垃圾。
3. **三段都是 base64**，放在同一个 JSON 对象里，字段名带模块前缀（`encryptedApiKey` / `apiKeyIv` / `apiKeyTag`）。好处是肉眼可审计：一个配置文件里出现明文 key，一眼就能看出来。
4. **解密失败返回 `undefined`，不抛**（`ai-config.ts:94-96`）：

```ts
} catch { return undefined; }
```

   这一条和 4.3 的 `keyUnreadable` 是一套的：**底层不抛，上层才能区分"没配"与"配了但坏了"**。如果底层抛异常，上层只会在某个请求里 500，而用户看到的是"AI 用不了"，不是"key 坏了"。

5. **明文永远不回前端**。`publicAiConfig` / `publicWeatherConfig` / `publicBackupConfig` 只返回 `keyConfigured` / `hasKey` / `keySource` / `keyUnreadable` 这类布尔与枚举（`ai-config.ts:206`、`weather-config.ts:181`、`backup-config.ts:185`）。**没有"回显前 4 位 + 后 4 位"这种设计** —— 因为那仍然是泄漏，且会诱使前端把它当校验依据。
6. **指纹不含密钥值**。`aiConfigFingerprint` 只把 `apiKey ? "configured" : "empty"` 拼进哈希（`ai-config.ts:271`）。如果把 key 本身拼进去，这个指纹就变成一个可离线校验"某个 key 是不是这个"的判据。

### 5.1 这里的 scrypt 用的是"固定盐"，要理解它是什么

```ts
return scryptSync(secret, "lifeos-ai-config-v1", 32);
```

固定字符串 `"lifeos-ai-config-v1"` 不是随机盐，它在这里充当**域标签**（让四个模块的密钥互不相同）。这在 `secret` 是高熵随机值（4.1 的派生结果）时完全成立；但当 `secret` 回退成 `LIFEOS_PASSWORD` 时，它就退化成"用密码 + 公开固定盐派生密钥"——**同一密码在不同安装上派生出同一把密钥**，无法抵抗跨安装的预计算。

**这是一个已知的、可改进的点**（见 §17）。正确做法是：把随机盐写进文件头（像 `encrypted-archive.ts` 那样），或者干脆用 HKDF 从高熵种子派生。**如果你要抄这段代码，请抄成"随机盐 + 存进文件"。**

---

## 6. 大文件加密包：帧格式、流式处理、以及导入侧的全部校验

这是项目里工程量最大、也最值得抄的一块。协议文档在 `docs/archive-format.md`，实现是 `encrypted-archive.ts`（50 行）+ `archive-service.ts`。

### 6.1 字节布局

```
[ 8B  "LIFEOS01" ][ 16B salt ][ 12B iv ][ ... AES-256-GCM 密文 ... ][ 16B tag ]
 └────────────── 36B header，整段作为 AAD ──────────────┘
```

- 前 8 字节是**格式版本**（`LIFEOS01`）。读到不认识的 magic 就报"不支持的完整加密包格式"（`encrypted-archive.ts:42`），而不是试图猜。
- **AAD = 前 36 字节全部**（`cipher.setAAD(header)`）。这带来一个很实在的性质：攻击者改版本号、改盐、改 IV，GCM 认证都会失败。**盐和 IV 因此不能被静默替换**——否则可以做"降级到弱参数"或"IV 重用"攻击。
- 解密时先从文件尾部读 16 字节 tag，再从头部读 36 字节 header（`encrypted-archive.ts:38-40`），**中间不读**。所以校验一个 20GB 的包，不需要把它读进内存。

### 6.2 流式加解密

```ts
await pipeline((async function* () {
  yield header;
  for await (const part of parts) yield cipher.update(part);
  yield cipher.final();
  yield cipher.getAuthTag();
})(), output, { signal });
```

- 用 `pipeline` + 异步生成器，**整包不进内存**。20 GiB 上限下这是唯一可行的做法。
- `signal` 一路传下去，取消时整条链一起断。
- 输出文件 `{ flags: "wx", mode: 0o600 }`（`encrypted-archive.ts:25`）：**`wx` 表示"已存在就失败"**，防止覆盖同名的旧包；`0o600` 是"只有属主可读写"。
- **失败即删**：`catch { await unlink(destination).catch(() => {}); throw error; }`。半个加密包留在磁盘上比没有更糟——它会被误认为完整包，而解密时才发现 tag 不对。

### 6.3 解密的顺序：先认证，再解析

```ts
// All decrypted bytes remain private staging until the final authentication tag succeeds.
```

`decryptArchive` 把明文写进一个**私有暂存路径**，只有 `pipeline` 完整跑通（GCM tag 验证通过）才返回。之后 `archive-service.ts:186` 才打开这个文件解析清单。

**通用结论 10：对"加密 + 结构化内容"的格式，认证失败前不要解析任何一个字节。**
反例是先解压/先 parse 再验签——那等于让攻击者用你的解析器当攻击面。

### 6.4 口令与内存

```ts
secret.fill(0);           // 派生出的 32B 密钥用完立刻清零
password = "";            // 闭包里的口令变量用完置空
```

同时 `archive-format.md:17` 诚实地写了边界：

> 口令未落盘，派生 buffer 用后清零，但 JavaScript 字符串不能承诺安全擦除。

**通用结论 11：内存擦除要写到"能做到什么程度"，不要写成"已安全擦除"。**
Buffer 可以 `fill(0)`；JS 字符串不可变、GC 会复制，做不到。声称做到了，就是在给审计埋雷。

### 6.5 导入侧的校验清单（这部分比加密更重要）

`archive-service.ts:180-215` 对一个**已经解密成功**的包仍然做了一长串检查。因为"能解密"只证明"知道密码"，不证明"内容可信"——密码可能是从别处拿到的，文件也可能是被替换过的。

| 顺序 | 检查 | 防什么 |
|---|---|---|
| 1 | 文件总大小在 `[36+16+4, 20GiB]` | 空文件 / 超大文件 DoS |
| 2 | magic 匹配 | 格式混淆 |
| 3 | 清单长度 ≤ 32 MiB 且 ≥ 2 | 长度字段被改成天文数字 |
| 4 | `manifest.format === "lifeos.space"` 且 `version === 1` | 未知版本静默降级 |
| 5 | `exportedAt` 可解析 | 结构完整性 |
| 6 | 文件数 ≤ 100000 | 资源耗尽 |
| 7 | **在一次性 `validate.sqlite` 里完整演练一遍表替换**（`:194-195`） | 坏数据污染目标库 |
| 8 | 清单里的资产数 === 文件数（`:197`） | 少给文件 / 多塞文件 |
| 9 | 每个 `assetId` 与期望资产**按顺序**一一对应（`:202`） | 张冠李戴 |
| 10 | `bytes` 是非负安全整数、`sha256` 是 64 位小写 hex（`:202`） | 类型混淆 |
| 11 | 偏移量不越界（`:203`） | 截断读取 |
| 12 | 每个原件**实算 SHA-256** 与清单比对（`:207`） | 内容被替换 |
| 13 | 读完后偏移量 **精确等于**文件长度（`:210`） | 尾部夹带未声明的数据 |

第 7 条是这里最有价值的设计：**用产品自己的仓储层，在一个临时数据库里把整个导入流程跑一遍**，跑通了才算校验通过。这比手写一堆字段断言可靠得多，因为它复用的就是真实代码路径。

第 13 条也值得单独说：`offset !== size` 就报"完整包包含未声明的数据"。**只校验"声明的都读到了"是不够的，还要校验"没有多余的东西"**。

### 6.6 提交阶段：先备份，再原子替换

`archive-format.md:29-31` 记录了提交顺序：

1. 先建 `lifeos-before-import-<UUID>.sqlite` 一致性快照，写进备份历史；
2. 新原件写到 `uploads/archive-<UUID>/`，**不覆盖旧原件**；
3. 业务表在**单个 `BEGIN IMMEDIATE`** 里**再次比对目标指纹**，不一致就拒绝（预览之后有人改过数据 → 409，不覆盖）；
4. 失败只撤销本次新增的文件与对象。

**通用结论 12：破坏性导入 = 快照 + 指纹 + 单事务 + 只增不覆盖。**
四件事缺一不可。特别是"预览时记指纹、提交时再比一次"，它解决的是"用户看了预览、点了确认，中间隔了几分钟"这个真实窗口。

---

## 7. 会话与令牌：数据库里只存哈希

`server.ts:563-565`：

```ts
const token = randomBytes(32).toString("base64url");
repository.createSession(sessionHash(token), Date.now() + SESSION_TTL_MS);
```

`sessionHash` = `sha256(token)`（`server.ts:247`）。**数据库里存的是哈希，不是 token 本身。**

这一条的意义：**数据库被拖走，攻击者不能直接拿里面的值去登录**（他得先做一次原像攻击）。代价是"服务端无法反查某个 token 属于谁"——但服务端本来也不需要，它只需要"这个 token 有效吗"。

**通用结论 13：所有" bearer 型凭据"（会话 token、邀请码、API token）在服务端一律存哈希。**
本项目的邀请码同样处理：`inviteCodeHash(code) = sha256(code)`（`identity-store.ts:112-114`），数据库里只有 `code_hash`，`code` 只在创建时返回一次（`identity-store.ts:252-274`）。

### 7.1 Cookie 属性

`server.ts:229-232`：

```
lifeos_session=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<TTL>; Secure?
```

- `HttpOnly`：JS 读不到 → XSS 偷不走会话。
- `SameSite=Lax`：跨站 POST 不带 cookie → 挡住绝大多数 CSRF；同时保留"从外部链接点进来仍是登录态"的体验。**没有用 `Strict`**，因为那会让"从书签/微信里点链接"变成未登录。
- `Secure`：由 `LIFEOS_COOKIE_SECURE` 控制（`config.ts:168-169`），**不是无条件的** —— 因为本机 `http://127.0.0.1` 预览时必须能工作。
- `Max-Age` = 30 天（`SESSION_TTL_MS`，`server.ts:186`）。

### 7.2 过期与吊销

- 每次 `authenticated()` 调用都 `purgeExpiredSessions()`（`server.ts:469`）—— 用"读时顺手清"代替后台定时任务，简单且不会漏。
- 登出：删那一行 + 下发 `Max-Age=0` 的同名 cookie（`server.ts:568-572`）。
- **停用账号 / 重置密码时删掉该账号的全部会话**（`identity-store.ts:390`、`:407`）。这一条经常被漏：只改密码不踢会话，等于"改密码"对已经登录的设备无效。
- 会话查询本身就带 `expires_at > ? AND a.disabled_at IS NULL`（`identity-store.ts:227`），所以即使清理没跑到，停用账号也进不来。

**通用结论 14：吊销要落在查询条件里，不能只靠"记得删"。**
`WHERE ... AND disabled_at IS NULL` 这种写法，让"忘记吊销"不再可能。

---

## 8. 验证的边界：限流、并发闸门、以及"不要泄漏哪一半错了"

### 8.1 单密码模式（`server.ts:535-566`）

- 失败桶按 **来源 IP** 计（`req.socket.remoteAddress`）。
- 窗口 15 分钟（`LOGIN_FAILURE_TTL_MS`），**累计 5 次 → 封 60 秒**（`recordLoginFailure` 默认 `limit = 5`）。
- 桶总数上限 **4096**；满了以后**对新 key 直接 429，不做密码计算**（`server.ts:552-555`）。这是 fail-closed：宁可拒绝新来源，也不让内存被撑爆。
- **不驱逐活跃桶**（`server.ts:199-207` 的注释）：

> Never evict an active bucket to admit a new username/IP: that would let a rotating attacker reset somebody else's throttle.

  这条很细但很重要：如果"满了就删最旧的"，攻击者只要用 4096 个不同 IP 轮询，就能把受害者那条封禁记录挤掉。
- 失败响应统一 `401 invalid_credentials`，**不区分"密码错"与"用户不存在"**。
- 成功时 `loginFailures.delete(loginKey)` —— 成功即清零，避免"正常用户偶尔错两次被越攒越久"。

### 8.2 账户模式（`server.ts:1152-1195`）

- 桶的 key 是 `remote + ":" + sha256(username.toLowerCase())`。**用哈希而不是用户名本身**：内存里的桶不会变成一份"谁在尝试登录"的明文清单，日志里也不会。
- 每 peer **30 次 / 分钟**（`ACCOUNT_PEER_FAILURE_LIMIT`）。
- **并发闸门**：全局最多 8 个登录在算 scrypt，每 peer 最多 2 个（`ACCOUNT_LOGIN_MAX_GLOBAL_IN_FLIGHT` / `..._PEER_IN_FLIGHT`）。

**这一条是 scrypt 类系统最容易被忽略的 DoS 面**：每个登录请求要烧几百毫秒 CPU，不限并发的话，几十个请求就能把 4 核机器打满。限流管的是"次数"，并发闸门管的是"同时在算几个"——**两者都要有**。

### 8.3 分享链接密码（`routes-note-shares.ts:39-82`）

- 每 IP **5 次 / 分钟**，桶上限 4096，**全局并发 4**（`work` 这个 WeakMap 就是并发计数）。
- 密码长度上限 128，超了直接 400（不进 KDF）。
- 校验用 `timingSafeEqual`（`equal()`，`:19`）。
- **scrypt 跑完之后重新读一次分享记录**（`:74-76`）：

```ts
// A password change or revoke while scrypt was running invalidates this attempt.
if (ctx.repository.notes.shares.byToken(share.token)?.secret !== share.secret)
  throw new HttpError(401, ...);
```

  这是一个真实的 TOCTOU 窗口：scrypt 要跑几百毫秒，这期间主人可能改了密码或撤销了分享。**校验结论必须对"当前状态"成立，而不是对"开始校验时的状态"成立。**

### 8.4 导出包的密码校验（`archive-service.ts:119-131`）

- **导出前先验当前登录密码**（账号模式走 `archivePasswordVerifier`，单密码模式走 `timingSafeEqual`），证明"是本人要导出"。
- 包密码可以与登录密码不同：单密码模式下如果不传 verifier，则校验 `config.password`；`requiresAccountPassword` 字段（`:117`）告诉前端"这次导出需要输密码"。
- 失败 **5 次 / 分钟**（进程内计数，`:123-124`）。
- 顺序上，**先验密码、再 `estimate()`、再建任务** —— 不要为一个未授权的请求去做磁盘容量与流量估算。

**通用结论 15：验证失败的错误信息只说到"这个动作不行"，不说"哪一半错了"。**
`Invalid credentials` / `访问密码不正确` / `当前账号密码不正确` —— 三种场景，同一种粒度。

---

## 9. CSRF / Origin / Host：没有 CSRF token 的做法

本项目**没有 CSRF token**，靠三层替代：

1. **`SameSite=Lax`** —— 跨站 POST 不带 cookie。
2. **写请求强制 `application/json`**（`http-body.ts:21-27`）：

```ts
if (contentType === undefined || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
  throw new HttpError(415, "unsupported_media_type", "Write requests require application/json");
}
```

   HTML 表单只能发 `application/x-www-form-urlencoded` / `multipart/form-data` / `text/plain`，**发不出 `application/json`**。所以"强制 JSON"本身就是一道 CSRF 防线（跨站 `fetch` 带这个 content-type 会触发预检，而预检过不了 Origin 检查）。

3. **Origin 白名单**（`server.ts:267-273`）：`Origin` 缺失时放行（兼容非浏览器客户端），存在时必须是白名单成员或与 `Host` 同源。

外加：

- **无密码模式只接受 loopback Host**（`server.ts:487-494`）：

```ts
if (config.password === undefined && config.gatewayAuthenticated !== true && !localHostAllowed(req)) {
  throw new HttpError(421, "invalid_host", "Passwordless mode accepts loopback Host headers only");
}
```

  这条防的是 **DNS rebinding**：攻击者把自己的域名解析到 `127.0.0.1`，让受害者浏览器去访问你的本机服务。检查 `Host` 头是不是 loopback，就挡住了这种"浏览器以为是同源"的攻击。

- **账户模式强制显式 `LIFEOS_ALLOWED_ORIGINS`**，且只允许 HTTPS 或 loopback HTTP（`config.ts:179-202`）；非 loopback 时**强制** `LIFEOS_COOKIE_SECURE=true`（`config.ts:199-201`、`server.ts:844`）。启动即失败，不是运行时降级。

**通用结论 16：安全配置要在启动时 fail-fast，不要留"运行时再决定"。**
`throw new Error("账户模式对外发布必须启用 LIFEOS_COOKIE_SECURE=true")` 发生在 `createAccountModeApp` 里 —— 服务起不来，运维立刻知道。如果改成"运行时发现不是 HTTPS 就降级"，那这个错误会安静地活很久。

---

## 10. 分享链接：能力令牌 + HMAC 签名的短期通行证

`note-shares.ts` + `routes-note-shares.ts` 是一套完整的"把一条笔记公开出去，但可能要密码"的实现。

**凭据分两层：**

1. **链接里的 token**：`randomBytes(32).toString("base64url")`（`note-shares.ts:16`），43 个字符，出现在路径里。**它是能力凭据** —— 有链接就有"尝试权"，但没有密码仍然读不到内容。
2. **`secret`**：`randomBytes(32).toString("hex")`（同处），**永不出现在 URL 里**，只用来签 cookie。

**改密码时轮换 `secret`：**

```ts
secret: old && old.passwordHash === passwordHash ? old.secret : randomBytes(32).toString("hex")
```

同一行代码同时做了两件事：密码没变 → 保留 secret（已发出的 cookie 继续有效）；密码变了 → 换 secret（**所有旧 cookie 立刻失效**）。撤销分享 = 删整行，token 与 secret 一起消失。

**cookie 的形状：**

```
lifeos_note_<token 前 12 位> = <13 位毫秒时间戳>.<HMAC-SHA256(secret, token + ":" + expires) 的 base64url>
```

校验（`:86-90`）：

```ts
if (!expires || !mac || !/^\d{13}$/.test(expires) || Number(expires) <= Date.now() || !equal(signature(share, expires), mac))
  throw new HttpError(401, "share_password_required", "请输入访问密码");
```

- **时间戳在签名覆盖范围内** → 改过期时间会导致签名失效，不能靠改 cookie 续期。
- **cookie 名带 token 前缀** → 同一个浏览器访问多个分享，cookie 不互相覆盖。
- **`Path` 限定到那一个分享路径** → cookie 不会被带到站点其它接口。
- TTL 7 天（`routes-note-shares.ts:10`），`HttpOnly; SameSite=Lax`，`Secure` 跟随全局配置。
- 响应头：`cache-control: no-store`、`referrer-policy: no-referrer`、`x-robots-tag: noindex, nofollow`（`:35-37`）。**公开链接必须阻止被搜索引擎收录与通过 Referer 外泄。**

**通用结论 17：给"公开出去的东西"设计两层凭据——链接是能力，密码是授权，签名 cookie 是短期凭证。**
只有一层（链接即权限）无法收回；只有密码（无 token）无法定位是哪条分享。

---

## 11. 凭据的"来源"与"所有权"建模（成员借用主人的 key）

账号模式里，成员空间可以借用主人的 AI / 天气 key。这里的安全问题不是"怎么加密"，而是**"借来的钥匙能开哪扇门"**。

`RuntimeAiConfig.source` 有四个值：`env` / `file` / `shared` / `none`（`ai-config.ts:39`）。`shared` 的语义被两条规则钉死：

1. **只能发往管理员批准的目标**（`ai-config.ts:174-180`）：

```ts
export function assertAiCredentialTarget(config, runtime): void {
  if (runtime.source !== "shared") return;
  const shared = config.sharedIntegrations?.ai?.();
  if (shared === undefined || runtime.apiKey !== shared.apiKey || normalizeBaseUrl(runtime.baseUrl) !== normalizeBaseUrl(shared.baseUrl)) {
    throw new Error("共享 AI Key 仅能用于管理员批准的服务地址");
  }
}
```

   防的是：成员把 baseUrl 改成自己的服务器，让主人的 key 打到自己那里。天气侧同理（`weather-config.ts:155-164`），并且额外允许一个固定的 `geoapi.qweather.com`（城市查询用）。

2. **不能把共享 key 存进自己的配置**（`ai-config.ts:225`、`weather-config.ts:211`、`:292`）：

```ts
if (typedApiKey && typedApiKey === sharedNow?.apiKey) throw new Error("管理员共享 AI Key 不能保存到个人配置");
```

   防的是：成员把主人的 key 落盘成自己的密文，从此脱离"共享"的约束（改了 baseUrl 也不再受检查）。

3. **旧版本里没有 `ownApiKey` 标记的密文一律视为不可信**（`ai-config.ts:153-157`）：

```ts
// Older account-mode builds could persist an inherited key without source metadata.
const trustedStoredKey = config.sharedIntegrations === undefined || stored.ownApiKey === true;
```

   这是一次**保守降级**：宁可让成员重填一次自己的 key，也不把一个来历不明的密文发到自定义端点。`.review/verify-shared-key-boundary.txt:15` 记录了这个兼容性决定。

**通用结论 18：凭据要带"来源"元数据，并且"借用"必须绑定用途。**
`source` 字段的成本是一个枚举，收益是"审计时能回答这把钥匙从哪来、允许去哪"。

**通用结论 19：不把环境变量里的 key 抄进配置文件。**
`nextKeyFields` 的注释（`ai-config.ts:192-194`）说得很清楚：`.env` 里的 key 如果被复制进 `ai-config.json`，那么以后改 `.env` 就会被旧副本遮蔽 —— 用户改了环境变量却不生效，是极难排查的故障。

---

## 12. 写盘策略："留空 = 保留"，只有显式清除才删

这是本项目踩过的最痛的坑，也是最有价值的一条经验。`ai-config.ts:182-204`：

```ts
function nextKeyFields(config, input, existing) {
  if (input.clearApiKey === true) return {};                                    // ① 显式清除才删
  const typed = input.apiKey?.trim();
  if (typed !== undefined && typed !== "") return encryptApiKey(config, typed); // ② 新输入覆盖
  if (existing?.encryptedApiKey && existing.apiKeyIv && existing.apiKeyTag) {
    return { ...原样回写三段密文... };                                          // ③ 否则逐字节保留
  }
  return {};
}
```

第 ③ 条的关键在于：**即使这把密文当前解不开，也要原样写回去。**

> Re-encrypting from the decrypted value is impossible then, and simply omitting the fields would destroy the owner's key without a word — that is exactly the "I set it once, why is it gone again" report.

场景复盘：用户配好了 key → 后来种子变了（搬目录 / 改密码）→ 用户打开设置页，看到"未配置"，什么都没改就点了保存 → **旧逻辑把三段密文从文件里删掉了**，零报错。把种子改回来也救不回，因为密文已经没了。

**通用结论 20：任何"表单保存"都必须区分三种意图：改值 / 保持 / 清除。**
"字段为空"绝不等于"删除"。删除必须是显式的、独立的、且在 UI 上有二次确认的动作。
这条不只适用于密钥：任何"部分更新"的 API 都有这个陷阱。

**配套的量尺** `.review/verify-ai-key-persist.mjs` 把这条写成了回归哨兵（文件头注释）：

- A. 带 key 保存 → 文件里有密文三件套，且能解回原值（回环）；
- B. 留空再保存 → key 被保留；
- C. 换种子 → 解不开、`keyConfigured:false`、`keySource:none`，**但密文三件套仍在文件里**，且 `keyUnreadable:true`；
- **D. 在种子不匹配的状态下再保存一次（留空）→ 三段密文必须逐字节相同**（不是重新加密出来的）；
- D2. 只有 `clearApiKey: true` 才允许删；
- E. 对照组：`测试连接` 不落盘（文件字节不变）。

**通用结论 21：把"数据丢失类 bug"写成逐字节比对的回归测试。**
"密文还在、且没被重新加密"这件事，只有比对字节才能证明。断言 `encryptedApiKey !== undefined` 是不够的。

---

## 13. 泄漏面治理：只写形状，不写值

### 13.1 规则

**任何会被存档、被提交、被交接的输出，都不许出现密钥值。** 包括：日志、文档、changelog、交接说明、测试夹具、报错信息。

需要指代某个密钥时，写形状：

```
LIFEOS_WEATHER_CONFIG_SECRET='lifeos-local-weather:<搬迁前的数据目录>'
```

### 13.2 扫描器（`.review/scan-secret-leaks.mjs`）

这个 120 行的脚本值得整个抄走。它的设计决策比代码本身更重要：

1. **按"值"扫描，不按文件名扫描。**

   > Grepping by *value* rather than by filename is the only check that catches the mistake that actually happened: a handoff note quoting `.env` verbatim.

   事故形态是"有人在交接文档里贴了 `.env` 原文"。按文件名扫（`*.env`、`secrets.*`）完全抓不到。

2. **只从 `.env` 里取 `SECRET|KEY|PASSWORD|TOKEN` 且长度 ≥ 12 的值**（`:38-41`）。短值会误伤整个仓库。

3. **按爆炸半径分组**（`:92-107`）：

   - `PUBLISHED` —— git 跟踪的 → **一定失败**（推送即公开）；
   - `local only` —— 被 gitignore 的 → 只报告，不失败。

   > The file being gitignored is not protection — the rule is "never copy a value out of .env", full stop.

4. **只打印 `file:line` 与变量名，绝不打印值**（`:16`、`:100`）。

5. **打印值的长度而不是值**（`:57`）：`loaded N secret value(s) (lengths only: ...)`。长度足以让人确认"扫的是哪一把"，又不泄漏。

6. **把 `.env` 自己排除**（`:83`）—— 它是源头，不是泄漏。

**通用结论 22：密钥泄漏检查必须是"值匹配 + 分级 + 只报位置"，并且能进 CI 退出码。**
`RESULT: CLEAN` / 退出码 0/1 的设计，让它可以挂在提交前钩子上。

### 13.3 为什么"gitignore 就够了"是错的

本项目有 4 个 `LIFEOS_*_CONFIG_SECRET` 是**故意钉成历史路径**的（见 4.3）。它们不是"临时文件里的东西"，而是**解密已有数据所必需的种子**。丢了它们，用户的 API key 就永久解不开。所以它们必须长期存在于 `.env`，而 `.env` 一旦被谁复制进某份文档，就等于把"能解开所有密文的种子"公开了。

**通用结论 23：区分"凭据"与"种子"。**
凭据（API key）丢了可以重新申请；种子（加密根）丢了，所有用它的密文都变砖。种子的保护级别应该更高，且**永远不要出现在任何会被复制的文本里**。

---

## 14. 文件与目录：权限位、符号链接、逃逸检查

- 配置文件 `writeFileSync(..., { mode: 0o600 })`（四个 config 模块、`photo-text-config.ts:149`）。
- 加密包 `createWriteStream(..., { flags: "wx", mode: 0o600 })`。
- 临时目录 `mkdirSync(..., { mode: 0o700 })`（`pool-transition.ts:63`）。
- **拒绝符号链接**（`tenant-config.ts:22-34`）：

```ts
if (lstatSync(tenantsRoot).isSymbolicLink()) throw new Error("Tenant storage root must not be a symbolic link");
...
if (!isWithin(realRoot, realTenant) || realTenant === realRoot) throw new Error("Tenant storage escaped its storage root");
```

  注意用的是 `lstatSync` 而不是 `existsSync` + `statSync`：`statSync` 会跟随链接，等于没检查。

- **`realpath` 之后再做包含判断**（`isWithin`，`:9-12`）。只比较字符串前缀会被 `..` 和大小写绕过。
- **租户目录名必须是合法 UUID**（`tenant-config.ts:15`），不接受客户端传来的任何路径片段。

**通用结论 24：`0o600` 只是第一层；真正防的是"路径逃逸"与"符号链接替换"。**
判断顺序永远是：校验标识符格式 → `lstat` 拒链接 → `mkdir` → `realpath` → 包含性检查。

---

## 15. 凭据之外的访问控制：私密内容与"设备"维度

两个不属于密码学、但常被一起问到的点：

1. **私密记录**：靠的是服务端的可见性过滤，不是逐条加密。也就是说，**它防的是"别人翻你手机"，不防"拿到数据库文件的人"**。这个区别必须在产品文案里说清楚，否则用户会误以为"私密 = 加密"。
2. **天气位置按设备 cookie 区分**（`lifeos_weather_device`，`server.ts:234-245`）：`HttpOnly; SameSite=Lax; Max-Age=365 天`，值必须是 `^[0-9a-f-]{20,80}$`（`:241`）—— **cookie 里的值在被回显/使用前必须做格式校验**，否则它会变成注入点或超长值攻击面。

**通用结论 25：把"隐私"和"加密"在产品语言里分开说。**
本项目的措辞是"私密"（可见性），而不是"加密"。

---

## 16. 直接可抄的清单

给下一个项目用，按优先级排：

**密码存储与验证**

1. 用 scrypt / argon2id，**不要用 sha256(md5) 存密码**。
2. 每用户随机盐 ≥ 16 字节；哈希格式带算法前缀（`scrypt:<salt>:<hash>`）。
3. 校验前先做**严格形状校验**（字段数、hex 长度），失败返回 `false` 不抛异常。
4. 比较一律 `timingSafeEqual`，**先比长度**。
5. 失败响应统一措辞，不区分"用户不存在 / 密码错 / 账号停用"。
6. 用户不存在时也跑一次 KDF（本项目用 `#dummyPasswordHash`，`identity-store.ts:171-172`），消除时序差。
7. 密码长度上下界都要有（本项目 10–1024）。
8. 改密码 / 停用账号时**删除该用户全部会话**。
9. 吊销条件写进查询语句（`AND disabled_at IS NULL`），不只靠"记得删"。

**会话与令牌**

10. token 用 32 字节 CSPRNG，数据库只存 `sha256(token)`。
11. Cookie：`HttpOnly; SameSite=Lax; Path=/`；HTTPS 环境强制 `Secure`。
12. 过期清扫放在读路径上（读时顺手删）。
13. 邀请码 / 一次性链接同样只存哈希，明文只返回一次。

**限流与并发**

14. 登录失败按来源限流（本项目 5 次 → 封 60 秒 / 15 分钟窗口）。
15. 桶数量设上限，满了 fail-closed；**不要驱逐活跃桶**。
16. 慢哈希必须加**并发闸门**（全局 + 每来源），否则是 CPU DoS 面。
17. 失败响应带 `Retry-After`。

**对称加密**

18. AES-256-GCM，**每次随机 12 字节 IV**，16 字节 tag 单独存。
19. 文件格式：`magic(8) + salt(16) + iv(12) + ciphertext + tag(16)`，**头整段做 AAD**。
20. 大文件走 `pipeline` 流式；输出用 `wx` + `0o600`；失败即 `unlink`。
21. **认证通过前不解析任何明文**。
22. 密钥派生：高熵主密钥 + HMAC 域分离（`模块:v1:租户:用途`），不要多用途共用一把。
23. 解密失败返回 `undefined`，并**向上暴露一个"解不开"的状态**，不要伪装成"未配置"。
24. 派生 buffer 用后 `fill(0)`；文档里诚实写"JS 字符串擦不掉"。

**配置写入**

25. 表单保存区分"改值 / 保持 / 清除"三态；**空值 ≠ 删除**。
26. 解不开的密文也要**原样回写**。
27. 环境变量里的凭据**不抄进配置文件**。
28. 凭据带 `source` 元数据（env / file / shared / none）；"借用"的凭据绑定目标地址。
29. 明文凭据**永不回前端**，只回 `hasKey` / `keyUnreadable` / `source`。

**HTTP 面**

30. 写请求强制 `application/json`（天然 CSRF 防线）。
31. Origin 白名单；无密码模式只接受 loopback `Host`（防 DNS rebinding）。
32. 安全相关配置**启动时 fail-fast**（如"对外发布必须 Secure cookie"）。
33. 公开分享响应带 `no-store` / `no-referrer` / `noindex`。

**工程与流程**

34. 密钥泄漏扫描：**按值扫**，分 `PUBLISHED` / `local only`，只打印 `file:line` + 变量名。
35. 数据丢失类 bug 写成**逐字节比对**的回归测试。
36. 为"密文是用哪个种子加密的"写反查工具，只输出形状与长度。
37. 破坏性导入 = 快照 + 指纹 + 单事务 + 只增不覆盖。
38. 密码相关验收全部用**假值**（`sk-probe-...`），不碰真实凭据。

---

## 17. 已知不足（诚实清单）

写下来是为了下一个接手的人不要以为这里是完美的。

1. **配置文件加密用的是固定盐 scrypt**（§5.1）。当种子回退到 `LIFEOS_PASSWORD` 时，同密码跨安装派生出同一把密钥。改进方向：把随机盐写进 JSON（或文件头），或改用 HKDF。
2. **单密码模式下，密码以明文存在环境变量里**，登录时直接 `timingSafeEqual(Buffer(env), Buffer(input))`（`server.ts:556-558`），没有哈希、没有 KDF。这是"单用户本机工具"的合理简化，但**不适合多用户**。多用户场景请走账号模式。
3. **没有 CSP / HSTS / X-Frame-Options**（`apps/api/src/server.ts` 与 `apps/web` 里都搜不到）。对一个可能被反代到公网的应用，这是一块空白。缓解因素是：会话 cookie 是 `HttpOnly` + `SameSite=Lax`，且前端不 `eval`。
4. **限流状态在进程内存里**。PM2 起多实例时，每个实例各算一份 → 实际阈值变成 N 倍。要么单实例，要么把桶放到共享存储（Redis / SQLite）。
5. **备份上传的 SQLite 没有加密**（`backup.ts` 只做 S3 SigV4 签名，不加密载荷）。对象存储里的数据库是明文，安全性完全依赖桶权限。**"有加密导出包"不等于"备份是加密的"** —— 这是两个独立的东西。
6. **分享 cookie 的 `Secure` 跟随全局 `LIFEOS_COOKIE_SECURE`**，没有单独强制。公开分享场景下，如果部署忘了开这个开关，cookie 会走明文 HTTP。
7. **内存擦除只做到 Buffer 层**（§6.4）。口令字符串在 V8 里可能被复制多次。
8. **`ensureOwner` 只在"没有 owner 但已有其它账号"时拒绝启动**（`identity-store.ts:182-183`），这是一个一致性守卫，不是完整性校验 —— 数据库被改坏时它不一定能发现。

---

## 18. 附：本文引用到的代码位置

| 主题 | 文件 |
|---|---|
| 完整包加解密 | `apps/api/src/encrypted-archive.ts` |
| 完整包流程与校验 | `apps/api/src/archive-service.ts`、`docs/archive-format.md` |
| 账号 / 密码 / 会话 / 邀请码 | `apps/api/src/identity-store.ts` |
| 登录限流、cookie、Origin、Host | `apps/api/src/server.ts`（184–274、467–574、837–912、1000–1200） |
| 请求体与 content-type | `apps/api/src/http-body.ts` |
| AI 配置加密与"留空保留" | `apps/api/src/ai-config.ts` |
| 天气配置加密、共享 key 目标绑定 | `apps/api/src/weather-config.ts`、`apps/api/src/amap-location.ts` |
| 观影 / 备份配置加密 | `apps/api/src/movie-config.ts`、`apps/api/src/backup-config.ts` |
| 每租户密钥派生、目录安全 | `apps/api/src/tenant-config.ts` |
| 存储池快照加密 | `apps/api/src/pool-transition.ts`（35–44、216–217） |
| 分享链接与 HMAC cookie | `apps/api/src/note-shares.ts`、`apps/api/src/routes-note-shares.ts` |
| 泄漏扫描 | `.review/scan-secret-leaks.mjs` |
| 密钥持久化量尺 | `.review/verify-ai-key-persist.mjs` |
| 种子反查 | `.review/find-weather-secret.mjs` |
| 共享 key 边界验收 | `.review/verify-shared-key-boundary.txt` |
