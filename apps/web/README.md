# LifeOS Web

LifeOS 的 React 19 + Vite 7 浏览器客户端，面向桌面和移动屏幕提供时间轴、周/月日历、记录编辑、关联选择器、设置和可选 AI/天气模块。

开发时请从仓库根目录运行 `npm run dev`；生产构建由根目录的 `npm run build` 生成 `dist/`，再由 LifeOS API 同源提供静态文件。客户端不直接保存 API Key，数据请求统一走 `/api`。
