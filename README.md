# Con's 自动审查 — DCAR 1.2.0

[![npm version](https://img.shields.io/npm/v/@lytharalab/dsh-cons-auto-review.svg)](https://www.npmjs.com/package/@lytharalab/dsh-cons-auto-review)
[![CI](https://github.com/LytharaLab/DSH-Cons-Auto-Review/actions/workflows/ci.yml/badge.svg)](https://github.com/LytharaLab/DSH-Cons-Auto-Review/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **English.** DCAR (`@lytharalab/dsh-cons-auto-review`) adds a **CAutoR** preset to the DeepSeek Harness permission menu. Deterministic rules approve safe operations first — workspace writes, declared temp/external roots, literal read-only shell commands — and only what a program cannot approve is escalated to the LLM auto-review. The deterministic layer returns `allow` or `escalate`, never a silent denial. Install with `dsh plugin --profile desktop add @lytharalab/dsh-cons-auto-review`; Node.js 22.19+ or 24+, tested against DSH `0.1.7-rc.2` and `0.2.0-rc.2`. The detailed documentation below is in Chinese.

**`@lytharalab/dsh-cons-auto-review`** 为 DeepSeek Harness 的「权限」菜单添加 **CAutoR** 模式：先用 DSH「工作区内修改」的确定性路径规则自动放行安全操作，仅将无法由程序自动批准的操作交给 LLM Auto Review。第一层只返回 `allow` 或 `escalate`。

## 安装与启用

包已发布到 npm：[`@lytharalab/dsh-cons-auto-review`](https://www.npmjs.com/package/@lytharalab/dsh-cons-auto-review)。要求 Node.js 22.19+ 或 24+；兼容并测试 DSH **0.1.7-rc.2**、**0.2.0-rc.2**。DSH 的插件 API 仍在变化，其他版本不作为 1.2.0 的兼容承诺。

```powershell
dsh plugin --profile desktop add @lytharalab/dsh-cons-auto-review
```

Web 使用 `--profile web`。也可以离线安装解压的项目目录或仓库随附的 `.tgz`（不需要编译）：

```powershell
dsh plugin --profile desktop add "L:\Projects\DSH-Cons-Auto-Review"
dsh plugin --profile desktop add "L:\Projects\DSH-Cons-Auto-Review\lytharalab-dsh-cons-auto-review-1.2.0.tgz"
```

**从旧包名升级：**包在首次公开发布时由 `dsh-cons-auto-review` 改名为 `@lytharalab/dsh-cons-auto-review`。关闭 Desktop，先移除旧包再装新包，然后重新打开：

```powershell
dsh plugin --profile desktop remove dsh-cons-auto-review
dsh plugin --profile desktop add @lytharalab/dsh-cons-auto-review
```

profile 配置里若残留 `name: dsh-cons-auto-review` 的插件行或覆盖片段（含 `dsh-cons-auto-review/permission-presets` 写法），同步改成 `@lytharalab/dsh-cons-auto-review`，写法见 [examples/](examples/)。升级不需要手动替换权限插件或编辑安装补丁：主插件会直接接入已有权限服务。

重新启动 DSH，在聊天输入区「权限」栏选择 **CAutoR**。也可以执行：

```text
/permission CAutoR
/dcar on
```

**默认用于新会话：**打开 DSH 设置，在「新会话的默认权限模式」列表选择 **CAutoR** 并保存。后续新建会话自动使用 CAutoR，重启后仍有效；保存默认值不会改掉现有会话的权限选择。

如果停用 DCAR 而默认值仍为 CAutoR，新会话会使用只读权限，并显示「CAutoR（DCAR 未启用）」；重新启用插件即可恢复，也可以在设置中选择其他默认模式。

在同时安装官方 Auto Review 时，原 `Auto review` 和 `CAutoR` 是两个独立选项；只有选中 CAutoR 才走 DCAR。卸载命令为 `dsh plugin --profile desktop remove @lytharalab/dsh-cons-auto-review`，建议先在所有正在使用的会话执行 `/dcar off`。

## 功能

- 当前会话与新会话默认权限列表均提供 CAutoR；默认选择使用 DSH 原生设置保存，并自动为新会话安装审查。
- 程序优先审查：工作区读写、DSH 平台临时目录、可选额外根目录、真实路径与符号链接检查；受保护路径和未知操作交给 LLM。
- Shell 快速检查：支持一组明确的只读命令及 `mkdir` / `touch`；未知命令、脚本、管道、重定向、变量展开、通配符和复合命令升级审查。`npm run`、Python、Node 和 Git 默认升级，因为脱离沙箱后它们可以产生工作区外的效果。
- 可配置工具分类、强制审查工具、显式信任工具、自定义路径字段，以及严格匹配完整 argv 的信任命令。
- LLM 默认使用当前 Agent 的 provider / model；可指定单独的审查模型、推理档位、输出额度、温度、策略补充、并发上限、超时与重试。
- 长会话上下文预算：历史与项目指令各自裁剪并留下显式的 `omitted-context` 说明，**待执行动作永不裁剪**；避免会话变长后每个操作都退回人工授权。
- 修复 `reviewer ended with max-tokens`：默认预算 8192，截断后最多扩容两次到 32768；只接受完整 JSON 和正常结束，不批准截断输出。
- 审批问题始终使用中文，包含模型的具体确认问题和本次操作。英文说明按需翻译且保持原决策；翻译失败时显示中文人工核对提示。界面设为英文时也询问中文。
- 优先选择模型明确支持的 `low` 推理档位；显式配置的档位优先。全部尝试共用总超时，默认 120 秒。
- `allow` / `ask` / `deny` 决策；模型失败不会自动放行。默认把拒绝或失败交给用户，亦可配置为最终拒绝；子 Agent 的 `never` 策略会把询问转换为拒绝。
- 普通工具与 PTC 内部工具统一审查；外层 `run_code` 由各内部调用分别接受审查。
- 子 Agent 默认继承 DCAR，创建时固定继承状态；父 Agent 后续切换模式不会解除已经委派的子 Agent 的审查。
- 会话统计、规则命中率、程序避免的审查请求数、有限历史、可选 JSONL 日志及轮转；默认不记录工具参数正文。
- 可选审查缓存，默认关闭；缓存键绑定实际送给审查模型的文本、会话、模型路由与策略，只缓存批准结果。
- 长会话上下文预算：历史与项目指令各自裁剪并留下显式的 `omitted-context` 说明，**待执行动作永不裁剪**；避免会话变长后每个操作都退回人工授权。
- 动态权限策略：审查入口激活后才提供 CAutoR 审查；停用时取消等待中的审查并回退已加载会话。已保存的默认设置保留只读守护项。直接复用 Desktop 已有权限服务，无需替换 `permission` 配置行。

CAutoR 的执行策略是 `danger-full-access`。它复用原模式的路径审查逻辑，并以程序检查及 LLM 作为授权入口；不使用原执行沙箱隔离进程。

## 1.2.0 长会话上下文预算

会话变长后，审查输入里的历史事实会持续增长。1.1.0 及更早版本一旦整体超过 `maxInputChars`（默认 180000）就放弃本次审查并退回人工授权——于是**每个**需要审查的操作都要手动确认，而模型根本没有被调用。1.2.0 把长上下文拆成两段独立预算来处理：

```yaml
review:
  maxInputChars: 180000            # 总上限（保持）
  maxHistoryChars: 60000           # FILTERED_HISTORY 段预算，0 = 不设该段上限
  maxProjectInstructionChars: 30000 # PROJECT_INSTRUCTIONS 段预算，0 = 不设该段上限
```

- 超预算时**只从最旧的条目开始省略**，并在该段开头插入一条 `omitted-context` 说明（含省略条数、字符数和原因），因此模型知道上下文被缩略过，而不是被静默改写。
- 省略顺序：先丢 `fact`（工具调用、图片、附件元数据——这些按策略永远不能授权），再丢 `human-instruction` / `direct-parent-instruction` / `checkpoint`。省略只会移除可能存在的授权与约束，不会凭空产生授权，所以结果只会更保守。
- 审查策略同时明确：被省略的内容不能作为授权，也不能假定被省略的授权、范围或限制存在；若待执行动作的授权只能来自被省略的部分，模型必须询问或拒绝。
- **待执行动作永不裁剪。** 如果操作自身就超过总上限，审查仍然失败并按 `onError` 处理（绝不批准一份没看全的操作），此时中文说明会指出是动作过大，并建议调大 `maxInputChars` 或减小操作内容。

## 1.1.0 升级配置

直接升级会使用新的默认值。如果旧 profile 中显式保留了 `maxTokens: 1024/2048` 或 `timeoutMs: 45000`，这些自定义值仍会生效；建议改用随包提供的配置示例：

```yaml
review:
  maxTokens: 8192
  maxTokensLimit: 32768
  tokenLimitRetries: 2
  preferLowReasoning: true
  timeoutMs: 120000
```

上限需按审查 provider 的输出能力配置；扩容不是无限续写。token 预算可能包含模型推理，LLM 在截断前未给出完整问题时，插件会明确说明未取得结论，并让你核对真实操作。不会把推理片段当作询问或批准。

参数和命令中的代码、路径及 URL 保持原样；中文化针对说明与询问。默认完整展示最多 3000 字符的操作内容，超过时标明截断，可调整 `review.maxActionChars`。

## 命令

| 命令 | 作用 |
|---|---|
| `/dcar` 或 `/dcar status` | 版本、当前权限和启用状态 |
| `/dcar on` / `/dcar off` | 启用 CAutoR / 切回回退模式 |
| `/dcar stats` | 本会话计数和程序命中率 |
| `/dcar history 20` | 最近 20 条审查记录 |
| `/dcar config` | 查看生效配置 |
| `/dcar config {"review":{"timeoutMs":30000}}` | 修改本会话审查设置 |
| `/dcar check write {"file_path":"src/a.js","content":"x"}` | 只检查程序规则，不执行工具、不调用模型 |
| `/dcar clear-cache` | 清空审查缓存 |
| `/dcar reset` | 重置本会话配置、统计及缓存 |

会话配置覆盖只影响当前进程中的该会话，重启后恢复 profile 配置。命令名、子 Agent 继承及卸载回退模式属于加载时设置，请在 profile 配置中修改并重启。

## 配置与开发

完整配置说明见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)，默认值见 [examples/defaults.json](examples/defaults.json)。[examples/desktop-config.patch.yml](examples/desktop-config.patch.yml) 是可叠加到 profile 的配置示例。

接口适配、测试范围及平台限制见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

从源码开发：

```bash
git clone https://github.com/LytharaLab/DSH-Cons-Auto-Review.git
cd DSH-Cons-Auto-Review
npm ci --legacy-peer-deps
npm run verify          # 语法与 Cordis schema 检查 + 全部回归测试
npm pack --ignore-scripts
```

源码使用原生 ESM JavaScript，发布包无需构建步骤。仓库含源码、声明文件、自动测试、配置示例、测试记录与 `.github/workflows` 中的 CI 矩阵；发布到 npm 的包只包含运行所需文件（`src`、`locale`、安装补丁、文档、示例与许可证）。

维护者发布流程见 [docs/RELEASING.md](docs/RELEASING.md)。

## 安全

DCAR 放宽的是「哪些操作还需要人工确认」，不是隔离边界：被批准的操作仍以宿主进程权限执行。路径检查与执行之间、以及程序无法识别的命令语义仍存在时间窗口和判断盲区，完整说明见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。发现安全问题时请通过 [SECURITY.md](SECURITY.md) 给出的私下渠道报告，不要在公开 issue 中贴出可利用细节。

## 许可

[MIT](LICENSE)。复制和改编的 DeepSeek MIT 代码见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [THIRD_PARTY_LICENSE.txt](THIRD_PARTY_LICENSE.txt)。
