# LifeOS API

这是 LifeOS 的 Node 24 单体 API。它使用内置 `node:sqlite` 的 `DatabaseSync` 打开参数化 SQLite 数据库，通过 `SqliteRecordRepository` 隔离存储细节；core 只提供领域模型和导出协议。API 不连接 PostgreSQL 或 NAS 专用适配器，但可在显式配置后调用 DeepSeek、和风天气和 S3-compatible 对象存储。

## 本地运行

从仓库根目录运行 `npm run dev` 可同时启动 API 和 Vite。单独构建 API 后可运行 `npm start`，默认地址为 `http://127.0.0.1:3001`。生产单进程会从 `apps/web/dist` 提供同源静态文件。

密码配置后，登录成功会设置 HttpOnly、SameSite=Lax 的 `lifeos_session` cookie。没有密码时只允许回环绑定和回环 Host；任何非回环绑定都要求 `LIFEOS_PASSWORD`。写请求限制为 JSON 并检查 Origin，响应不设置开放 CORS。

记录版本通过 `revision` 实现乐观并发控制。原文始终写在 `body.original`，PATCH 正文进入 `body.edited`。DELETE 是软删除，当前列表和导出只包含活跃记录；数据库备份仍保留已删除行。导入使用 `lifeos.export` v1，经 core 校验后在一个 SQLite 事务内写入记录、实体和资产，重复 ID 返回 409。

测试使用临时目录中的真实 SQLite 文件，覆盖重开持久化、原文不变、CRUD、筛选、日期时区、版本冲突、软删除、导入导出、认证和坏请求。

## 备份与对象存储

设置页支持立即生成一致的 SQLite 本地副本，并显示最近的备份历史。默认目录是 `${LIFEOS_DATA_DIR}/backups`，也可以用 `LIFEOS_BACKUP_DIR`（或 `BACKUP_DIR`）覆盖；本地备份会保留最近 30 天。

可以通过设置页「设置 → 备份 → 对象存储配置」填写 Endpoint、Region、Bucket、Prefix、Access Key、Secret Key 和 Path-style 选项；配置写入 API 数据目录下的 `backup-config.json`，两把密钥使用 AES-256-GCM 加密，状态接口不会回传密钥。也可以使用 `BACKUP_S3_ENABLED`、`BACKUP_S3_ENDPOINT`、`BACKUP_S3_REGION`、`BACKUP_S3_BUCKET`、`BACKUP_S3_PREFIX`、`BACKUP_S3_FORCE_PATH_STYLE`、`BACKUP_S3_ACCESS_KEY_ID` 和 `BACKUP_S3_SECRET_ACCESS_KEY` 作为启动时的环境变量配置。上传使用 AWS Signature V4，兼容 AWS S3、MinIO、Cloudflare R2、七牛等 S3-compatible 服务。设置页保存的配置优先于启动环境变量；配置文件不存在时才回退到环境变量。

Bitiful S4 的 `cdnb` 示例：Endpoint `https://s3.bitiful.net`、Region `cn-east-1`、Bucket `cdnb`、Prefix `product-backup/lifeos`，Path-style 关闭。保存后点击“测试连接”，再点击“备份到对象存储”确认真实写入。

## 天气与表头动画

设置页的「天气」卡片接入和风天气（QWeather）后，表头会显示当前天气动画、地点、温度和天气提示；切换日期时会按所选日期请求预报或历史天气。API Key 只在 API 服务端使用，不会回传到浏览器或写入 SQLite；设置页保存的密钥写入数据目录下的 `weather-config.json`，并使用 AES-256-GCM 加密。

可以直接在设置页填写 API Key、位置 ID（例如 `101280601`）和城市名备用值。也可以通过环境变量配置：`QWEATHER_KEY`、`QWEATHER_LOCATION`、`QWEATHER_CITY`、`QWEATHER_HOST`；默认 API Host 是 `devapi.qweather.com`。如需固定加密口令，可设置 `LIFEOS_WEATHER_CONFIG_SECRET`。未配置有效 Key 时，表头只显示“天气未配置”，不会伪造天气数据。

## 观影模块（TMDb）

观影模块默认关闭。启用后，设置页可通过 `POST /api/movie/config` 保存 `{ "enabled": true, "apiKey": "..." }`；API Key 只以 AES-256-GCM 加密写入数据目录的 `movie-config.json`，`GET /api/movie/status` 永不回传密钥。也可以在启动环境中提供 `LIFEOS_TMDB_API_KEY`（或 `TMDB_API_KEY`），并用 `LIFEOS_MOVIE_CONFIG_SECRET` 指定配置加密口令。`POST /api/movie/resolve` 只调用 TMDb 官方 `/find`、`/search/movie` 或 `/movie` 接口返回候选，不抓取豆瓣页面；`POST /api/movie/import`（或 `/upsert`）在模块启用后保存去重的电影实体。关闭模块只停止识别和录入，不删除已保存的电影或记录引用。

## AI 助手

设置页可以配置 DeepSeek 的服务地址、模型、思考开关、推理强度和 API Key。Key 只在 API 服务端使用，并以 AES-256-GCM 加密写入数据目录下的 `ai-config.json`；状态接口不会回传密钥。助手只读取非隐私记录、任务和实体，未配置 Key 或请求失败时回退到本地规则回答。真实 AI 请求仍会把所选非隐私上下文发送到配置的服务商，请先确认其数据保留和费用策略。
