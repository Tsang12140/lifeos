# 地点名称映射与时间轴切日修复执行计划

负责人：主代理规划及审查；Luna max 实现、验证和预览重启。用户已经确认本范围。

## 已确认原因与范围

- WeatherHeader.tsx 的 weatherHeaderLocationLabel 仅硬编码佛山南海区；locationLabel 优先 name，随后直接回退配置 city/locationId，没有接既有 weather-locations.ts 反查。因此 name 本身为 ID 时也会显示代码。
- main.tsx 的记录请求 effect 每次 setRecordsLoading(true)；Timeline 用 !loading 包围实际列表，加载中卸载列表并渲染 LoadingState，导致切日闪动及高度塌陷。已有 AbortController 与 requestId 守卫，必须保留。
- 天气背景渐变、日期翻牌、照片规则不属于本次修改。不要修改 WeatherBackground.tsx。

## 一、地点显示

1. 阅读 weather-locations.ts 的 describeWeatherLocation / resolveWeatherLocation、weather.ts 数据类型及所有天气 city/name 展示调用点。
2. 在已有地点模块提供统一纯函数解析显示名称。复用现有目录，不复制映射，不改生产库或历史快照。
3. 按响应自身 location.id（含 name 为数字 ID 的遗留形式）反查目录并通过原有短名称规则输出市+区县。直辖市不重复市名；佛山南海区显示佛山南海。不能用当前配置替代不同历史地点。
4. 若已有真实非代码名称，保留正确历史名称；没有名称但有可识别 ID 则反查。未知 ID 且没有可靠名称显示“地点未知”；未配置保留原有未配置界面。境外真实名称保留。
5. 同样的天气名称展示复用函数（表头、历史天气/记录天气标签中实际存在的显示入口）；设置中的位置 ID 输入仍保留 ID。明确列出调整的调用点。
6. 如需核对 9 月 13 日，只读 SQLite 档案或现成只读请求；不要发任何生产写请求、force 刷新或验证性 POST。

## 二、时间轴切日

1. 将请求目标与已呈现数据的 query key / 日期明确绑定；不能把旧日期列表标成新日期。切换等待时保留原列表及其日期标题，aria-busy 提示更新，阻止针对旧列表误操作，目标日期仍在顶部导航立即响应。
2. 首次没有数据时可用原 LoadingState；已有展示时后台请求不能卸载列表，也不能以巨大 loading 占位替换。成功后数据和对应日期一次提交；失败保留旧内容但清楚说明目标加载失败并提供重试。无记录是成功空结果，不能无限保留旧列表。
3. 缓存最近日期查询（建议上限 14–30 项，按完整 queryPath 键控，包括日期、搜索和实体筛选）。命中缓存在渲染时或 layout effect 中同步采用，避免 useEffect 才改导致一帧错日。缓存可后台重新验证。
4. 新建、修改、删除、导入、任务状态改变等影响记录的路径应使缓存失效或同步更新；利用 recordsReload 统一失效机制，但审查所有直接 setRecords 的路径。退出登录 / 401 清空缓存，不能跨身份保留内容。
5. 在当前日查询稳定成功后至多预取相邻前后各一天，仅本地 records GET；同条件键控，预取不更新当前界面，不递归、不重复请求；快速切换/失效/登出取消并防止旧响应写回新一代缓存。
6. 保留现有 AbortController 和 requestId，确保 A→B→C 乱序完成只提交 C。注意 queryPath 不变的全量时间轴日期导航不应触发整表刷新。
7. 根据真实 DOM 测量处理加载期间容器高度，避免塌陷；成功后的自然高度允许变化，不要永久锁死巨大的 min-height，也不要隐藏问题的整页 opacity 动画。CSS 修改仅限时间轴加载反馈。
8. 保证今天、全量时间轴、笔记、日历、搜索、人物筛选的现有语义及隐私/demo 过滤不回归。

## 三、验证与交付

- 先读 AGENTS.md / docs/todo.md；主代理已盘点 data：146 live，127 demo / 19 主人，159 assets。生产数据库禁止任何验收写入，空正文也能创建记录，严禁以“应当失败”做生产 POST 探针。
- Node 24 运行 typecheck 和 npm test；只在隔离服务或拦截全部相关请求的浏览器夹具测试，profile 使用 .review/lib/cdp-profile.mjs。
- 地点回归覆盖：已知纯 ID、name=ID、9/13 对应 ID、直辖市、真实境外名称、未知代码、与当前城市不同的历史地点。
- CDP 对切日设置可控 400–800ms 延迟与乱序：等待期间列表连续存在、日期标签准确、容器未塌陷；成功空日正确展示；缓存回切无 loading 替换；A→B→C 最后是 C；失败可重试；修改后返回该日没有过时数据；390px 不溢出。记录实际断言数字，末行 RESULT: PASS/FAIL，不截图。
- 结果与脚本落 .review/；docs/changelog.md 末尾追加 AI: Luna，包含原因、变更、验收与限制。
- 完成实现后先通知主代理审查，主代理可能要求小修；无须重复已绿的整套测试，除非代码又改变。
- 审查完成由 Luna 负责使用已验证 PID 文件的 stop-accept-serve / accept-serve 重启原端口 3011/5199，只读 GET /api/health 与 Web HTTP 200 验证。未明确属于启动器的进程不得终止。允许按工具要求申请最小权限。
- 不 push；本地 commit 由主代理决定。保护现有未跟踪 notes-library-execution-plan.md。
