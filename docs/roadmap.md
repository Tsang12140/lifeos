# LifeOS 路线图

路线图表达阶段边界。当前 M1 核心记录闭环已在本仓库实现；天气、AI 和备份等可选集成也已提供，后续能力仍会继续演进。

## M0：领域层骨架（已完成）

- 建立 npm workspaces 与 TypeScript project reference。
- 定义 `TimelineRecord`、事件时间、实体、资产、AI 派生数据和语音分层的数据模型。
- 定义 Repository、Asset、照片只读索引、AI 和语音转写端口。
- 实现 JSON v1 和 Markdown 导出函数，并覆盖领域不变量测试。

## M1：记录与时间轴（当前）

- Web/API 已实现日记、任务/日程、知识笔记的创建、编辑、时间轴浏览和基础搜索。
- Node 24 API 使用内置 `node:sqlite` 的 SQLite 持久化；`SqliteRecordRepository` 保持存储边界，未来可替换为其他数据库适配器。
- 保留 `createdAt`、`occurredAt`、任务 `dueAt` 的语义分离，支持 date-only、instant 和 unresolved local 时间。
- 提供 HttpOnly 单用户会话、非回环绑定强制密码、Origin/请求体校验、乐观 revision 冲突保护和软删除。
- 提供 JSON v1 与 Markdown 导出，以及事务校验、重复 ID 拒绝的 JSON 导入；实体与资产引用一并保留。
- Dockerfile、Compose 命名卷、本机 Node 直跑和 SQLite backup API 脚本已经提供。当前环境没有 Docker，因此 NAS/云容器尚未实际执行验证。
- 关联层已打通：记录可以关联人物/项目/地点/主题、其他记录，以及外部照片或音频引用；实体与资产各有读写端点，换存储位置时 `assetId` 不变，删除仍被引用的对象返回 409。
- 关联层已经打通：记录可以关联人物/项目/地点/主题、其他记录和外部资产引用，实体与资产有各自的读写端点，删除仍被引用的对象返回 409。
- 实体支持 `aliases` 别名，正文里的 `@名称` 在写入时解析成 `entityRefs`，展示时渲染为名字胶囊；示例数据可用 `npm run seed:demo` 灌入，并在界面上一键隐藏或删除。
- M1 验收闭环为：创建记录 → 重启后可读 → 编辑仍保留原文 → 按日期/关键词找回 → 更新任务 → 导出并重新解析一致。

M1 初始范围不包含真实 Synology Photos、语音服务或外部日历接入，也不把这些端口伪装成已连接服务。当前版本另提供可选的 DeepSeek 助手、和风天气及 S3-compatible 备份集成；M3 的 AI 分类、检索和可追溯派生数据仍属于后续规划。

## M2：外部照片/文件只读索引

- 评估并实现只读照片/文件索引适配器，优先解决稳定 `assetId`、`sourceId + sourceRef`、路径移动和重复文件处理。
- 不复制完整照片库到 LifeOS 服务器，不把哈希误当作永久身份。
- Synology Photos 的具体私有能力、人脸标签和相册读取要先验证，不能从接口名称推断已支持。

## M3：AI 分类与带出处检索

- 接入用户选择的 AIProvider，支持碎片分类、事件/人物候选关联和历史检索。
- 每个派生结果记录 provider、model、generatedAt 和 sourceRecordId，并可审阅、修改、拒绝或删除。
- 建立数据外发、费用、保留期限和重新生成策略；没有 AI 服务时核心记录与导出继续可用。

## M4：语音 API 与可选日程同步

- 提供用户主动触发的录音上传接口，保存原始音频资产。
- 接入可选的 SpeechToTextProvider，保留原始转写，编辑正文独立保存。
- 评估日历同步、提醒、重复规则和离线记录；只有在部署和隐私策略确定后再实施。
- 不建设持续监听缓存或复杂音频编辑系统。

## 部署决策

M1 采用自托管单体和 SQLite：本机 Node 24 直接运行，NAS/云端使用同一 Docker 镜像，数据放在运行主机的本地持久卷。默认不连接第三方服务；公网上线时由 HTTPS 反向代理、强密码和备份演练承担部署边界。当前没有在真实 NAS/云容器执行 Docker 验证，也没有实现原生 App、离线同步或照片原件复制。
