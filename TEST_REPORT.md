# DCAR 测试记录

## 1.2.0

| 检查 | 结果 |
|---|---|
| `npm ci --legacy-peer-deps --ignore-scripts` + `npm run verify`（Windows，Node.js v24.13.0） | 114 / 114 通过，见 `test-results/1.2.0-verify-windows.txt` |
| 新增回归场景 | 长历史被省略后审查仍完成、`omitted-context` 标记出现在审查输入、最新授权与项目约束保留、`fact` 先于授权条目被省略、待执行动作超上限时仍然失败关闭 |
| 上一版本（1.1.0）既有场景 | 全部保留并通过（112 项） |

1.2.0 的修复针对真实故障：长会话中授权上下文整体超过 `maxInputChars` 时，1.1.0 会放弃审查并退回人工授权，导致每个需要审查的操作都要手动确认。现在历史与项目指令各自有独立预算、只从最旧条目省略并显式标记，待执行动作仍永不裁剪。

## 1.1.0

验证环境：Linux，Node.js v24.19.0。LLM 使用本地测试 Adapter，不调用真实模型 API。

| 检查 | 结果 |
|---|---|
| DSH 0.2.0-rc.2 的真实 npm 服务 + `npm run verify` | 112 / 112 通过 |
| DSH 0.1.7-rc.2 的真实 npm 服务 + `npm run verify` | 112 / 112 通过 |
| 干净 `npm ci --legacy-peer-deps --ignore-scripts` | 39 个依赖安装成功 |
| 入口 ESM 导入、全部 JS 语法、Cordis 配置 schema、安装 patch | 通过 |
| 解包 .tgz 后的公共导出、默认配置与关键场景检查 | 8 / 8 通过 |
| TypeScript 5.9.3 严格消费端声明检查 | 通过 |
| 改名为 `@lytharalab/dsh-cons-auto-review` 后复验（Windows，Node.js v24.13.0） | 112 / 112 通过，见 `test-results/post-rename-windows.txt` |

1.1.0 新增 30 项回归场景，保留之前的 82 项测试。完整输出位于 `test-results/`。

包名说明：`test-results/dsh-0.1.7-rc.2.txt`、`test-results/dsh-0.2.0-rc.2.txt`、`test-results/clean-install.txt` 与 `test-results/package-smoke.txt` 采集于改名前，其中的 npm 输出仍显示旧包名 `dsh-cons-auto-review`；改名只涉及包名、安装 patch 的条目名与插件导出名，上述测试在改名后于 `test-results/post-rename-windows.txt` 中重新完整通过。

本次修复验证：

- 推理块耗尽预算、没有最终文本：8192 → 16384 → 32768，全部尝试使用同一完整授权快照。
- 即使截断时已有完整 allow JSON，仍不接受批准；达到硬上限后不重复相同预算。
- 扩容次数、增长倍数和初始预算硬上限；普通故障重试与扩容共享有限计数。
- 重试中取消、总超时和队列释放；只统计实际发起的扩容请求。
- 复现截图中的 PowerShell 请求和 max-tokens 结束，通过真实 DSH LLM/Tools/Approval 服务验证：中文问题可见，原始命令保留，拒绝不执行，允许一次后只执行一次。
- 中文问句直接显示；英文问题独立翻译并保留目标、否定和授权范围；翻译不接收整个授权历史。
- 英文翻译、额外字段、重复字段、格式错误和翻译截断被拒绝；中文兜底不会把部分回答当作模型问题。
- 翻译不能插入 allow 决策；原审查结论与风险等级使用程序生成的中文标签。
- 翻译超时不改变已验证的原决策；最终拒绝和 never 会话不发起无界面的翻译。
- 模型明确支持时优先 low，显式设置优先；安全文件操作不查询模型能力且零模型请求。
- 中文说明与实际操作的展示上限、截断标记、控制字符过滤、配置验证及缓存参数隔离；程序结论标签不会占用模型问句的展示预算。

既有功能验证：

- CAutoR 当前权限菜单、新会话默认设置、保存、重启恢复、服务重载与停用守护。
- 连续工作区写入零模型请求；未知操作仅按需升级。
- 精确路径与符号链接、保护路径、Shell 语法、自定义工具、完整 argv 信任规则。
- 原生工具及 PTC 内部调用、子 Agent 继承、never 策略、创建与切换模式竞态。
- 真实审批和工具执行管线；审查失败、用户拒绝或审批不可用时不执行工具主体。
- 审查超时、队列、并发、缓存、统计和可选日志。

范围限制：没有运行用户的 Windows/macOS Desktop 窗口、真实 LLM API 或 OS 级沙箱进程。模型 provider 的实际输出上限和推理档位需要按其配置设置，测试不承诺模型永远不会耗尽 token。

默认设置测试使用真实 Settings、Loader 和权限服务，并将配置保存到测试 JSON 文件后重新加载。测试存储替代 DSH 的完整多层 YAML 配置编辑器；未启动实际 Desktop 设置页面。PTC 使用真实工具管线的 nested dispatch，未启动 PTC VM。随附的 GitHub Actions matrix 尚未在远程仓库执行。
