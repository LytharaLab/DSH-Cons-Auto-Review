# 兼容与验证

## 支持版本

DCAR 1.2.0 固定支持 DSH **0.1.7-rc.2** 与 **0.2.0-rc.2**。关键路径使用官方扩展点 `tools/pre-execute`、权限 Session 投影、命令注册表、文件系统解析和 `ctx.llm.stream`。

源码基线：DeepSeek Harness `639ed015397290b3745d163aafe02ffee4aa3f84`（`dsh-v0.2.0-rc.2`）；旧版本基线为 `477b4f420553e8a52c2fbccc464d7561b239c443`（`dsh-v0.1.7-rc.2`）。两版使用的 reviewer、permission service、containment 与文件路径解析源码一致。

## CAutoR 集成方式

官方权限服务只提供固定 `registerAuto()` 动态接口，通用自定义模式依赖静态预设表。1.0.2 由主插件在激活时给已存在的权限服务实例附加动态模式注册能力；安装补丁只插入 `dcar`，不替换宿主的权限服务行。

运行时适配覆盖该服务实例的 `names/specOf/derive/apply`，复用原始 Session 事件、沙箱和审批 setter、`/permission`、Remote `catalog()`、投影及官方 Auto 注册。审查入口安装后注册 CAutoR；停用时取消审查、回退已加载会话，再撤销审查注册并还原服务原始属性；已保存的默认设置保留只读守护项。它需要官方类中 `specOf/derive/apply/emitCatalogChanged` 的运行时方法；这些不是通用稳定第三方扩展接口，因此依赖版本明确固定为以上两个版本，并在加载时检查方法可用性。插件不修改 DSH 安装目录中的源码，也不注册第二个权限服务。

DSH Web/desktop 的权限 UI 从该 `catalog()` 读取选项，自定义标签按服务端 `name` 显示，CAutoR 无需修改前端 bundle。

1.0.2 在原生预设表中发布 CAutoR 的只读守护项，因此原始 `defaultOptions` 与 `defaultSettings()` 均接受这个选项。审查活跃时，`specOf()` 返回完整访问加 `ask` 的 CAutoR 规则；原始沙箱与审批 setter 负责写入新会话。保存原生默认设置时，插件在配置编辑器的正常写入流程中同时保留守护项，避免重启时宿主不认识 CAutoR 或在审查未加载时直接授予完整访问。只读守护项不被推导为活跃审查模式。

设置保存触发权限服务重载时，旧审查监听器及时撤销，当前 CAutoR 会话在新审查入口就绪后恢复；委派会话的 `never` 保留。恢复只接受同一插件 Fiber 保存的确切 Session 游标，后续用户改动会使恢复记录失效。

权限服务配置行的 ID 可以不同，也允许用户配置继续使用官方权限服务；无需修改随插件安装的 patch。包在首次公开发布时改名为 `@lytharalab/dsh-cons-auto-review`，导出映射中的 `./permission-presets` 适配类保留兼容，旧本地安装的 `dsh-cons-auto-review/permission-presets` 写法在升级到 scoped 包后应替换为新包名。没有权限服务、文件系统、工具注册表或 LLM 服务的纯自定义 profile 不属于该默认安装布局。

1.0.0 的测试预先安装了权限适配器，漏掉了主插件在原版权限服务下单独激活的场景。用户报告的 `DCAR requires its permission service adapter` 已在真实 Cordis/DSH 服务中复现。1.0.2 的主要集成测试全部改用原版权限服务，并覆盖已有会话中启用插件、菜单目录通知、权限投影、停用和再次启用。

## 已运行的检查

见 `TEST_REPORT.md` 与 `test-results/`：两个发布版本分别安装对应的真实 DSH npm 包，运行相同的完整插件测试。测试使用真实 Cordis、权限目录、Session、Session 投影、工具执行管线、原生文件读写工具、原生审批和命令服务；模型响应由本地测试 Adapter 提供。

覆盖本地零模型写入、按需升级、拒绝不执行、询问只在批准后执行、符号链接和目录前缀、Shell 混合语法、PTC 内部调用、子 Agent 与创建竞态、卸载回退、缺失审查提供者、配置验证、模型路由、重试、超时、并发、缓存和默认日志参数省略。

1.1.0 同时覆盖推理耗尽输出预算、真实 LLM 服务的截断结束事件、有限扩容、预算硬上限、总超时和取消、中文原生审批、英文说明翻译、翻译不改变授权结论及配置边界。自动低推理使用官方 `resolveModelInfo()`，只选模型明确列出的 `low`，不猜测 provider 的推理档位名。

1.2.0 覆盖长会话上下文预算：超预算的历史被省略时仍能完成审查、`omitted-context` 标记出现在审查输入中、最新的授权条目与项目约束保留、`fact` 早于授权条目被省略、待执行动作超过总上限时仍然失败关闭（不批准未看全的操作）。

## 验证范围

验证环境是 Linux、Node.js 24.19.0。未实际运行 Windows/macOS desktop 窗口、真实 API 或 OS 级沙箱进程；平台临时目录和 Windows 路径行为沿用 DSH/Node 实现，需要在目标机器验证。这里的 PTC 检查使用真实工具管线的 nested dispatch 输入，未启动 PTC VM。

默认设置测试使用真实 Settings、Loader 和权限服务，并将配置保存到测试 JSON 文件后重新加载。测试存储替代 DSH 的完整多层 YAML 配置编辑器；未启动实际 Desktop 设置页面。

DCAR 不隔离已经批准的宿主进程。路径检查与执行之间仍存在外部进程换链接的时间窗口；这是官方文件系统规则本身接受的限制。程序 Shell 规则假定宿主命令和已安装插件可信，不会识别被替换的系统可执行文件或 PowerShell 配置中的恶意覆盖。

可选缓存的完整授权快照不会探测外部文件或服务状态变化；因此默认关闭。动态文件/系统状态对风险判断有影响时，应保持关闭。

同一进程中停用会移除 CAutoR 并回退已加载会话。卸载整个 package 后，若另一个未加载的历史会话仍记录 CAutoR，请在恢复它时明确选择 `workspace-write`；原始 DSH 权限服务不认识自定义动态 CAutoR 身份。保留 DCAR 权限适配类时，残留的 CAutoR 会话会由缺失提供者检查拦截。
