# DCAR 1.1.0 配置

配置入口是 profile 中 `id: dcar` 插件行的 `config`。字段可以省略，插件填入默认值；数组是整体替换。所有字段在加载时验证，未知字段、错误类型和非法枚举会明确报错。

```yaml
- id: dcar
  name: '@lytharalab/dsh-cons-auto-review'
  config:
    rules:
      includeTempRoots: true
      additionalWritableRoots: ['L:/BuildCache']
    review:
      timeoutMs: 120000
      maxTokens: 8192
      maxTokensLimit: 32768
      tokenLimitRetries: 2
      onError: ask
      onDeny: ask
```

## 总开关

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否允许启用 CAutoR；关闭时不能选择该模式，已选中的调用也不会直接放行 |
| `inheritSubagents` | `true` | 创建子 Agent 时继承 DCAR；加载时选项 |

## 程序规则 `rules`

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 关闭后每个受支持调用都交给 LLM |
| `allowOutsideReads` | `true` | 与 DSH 工作区内修改一致，允许工作区外的普通文件读取；受保护路径仍升级 |
| `includeTempRoots` | `true` | 复用 DSH 的 workspace + `/tmp` + `os.tmpdir()` 可写根；Windows 的 `/tmp` 采用 DSH 原规则 |
| `additionalWritableRoots` | `[]` | 显式增加允许的可写根；相对路径基于会话 cwd |
| `protectedPaths` | 见 defaults.json | 显式目标匹配时升级 LLM，适用于读取及写入；支持 `*`、`**`、`?` |
| `safeEnvironmentFiles` | `.env.example` 等 | 对环境示例文件豁免 `.env` 模式；其他受保护目录仍生效 |
| `readTools` | `read`, `read_image` | 从 `file_path` 检查只读目标 |
| `searchTools` | `glob`, `grep`, `ls` | 检查 `path` / `cwd` 搜索根；glob 中的绝对路径或 `..` 升级 |
| `writeTools` | `write`, `edit` | 从 `file_path` 检查写入目标 |
| `harmlessTools` | `todo_write` | 认为无宿主文件或外部副作用的工具 |
| `alwaysReviewTools` | `[]` | 强制交给 LLM；优先于其他授权配置 |
| `trustedTools` | `[]` | 管理员显式按工具名授权；不会根据 MCP annotation 自动信任 |
| `customTools` | `[]` | 为自定义工具声明 `read/write` 效果和全部路径字段 |
| `maxArgumentBytes` | `2097152` | 程序层处理的参数 JSON 字节上限；超限升级 |

受保护模式默认包括 `.git`、`.dsh`、`.dcar`、`.ssh`、`.aws`、`.gnupg`、`.env`、`.env.*`、`.npmrc` 和 `credentials.json`。这是一组显式目标规则，不会递归检查每个目录读操作中的全部文件。

自定义工具示例：

```yaml
customTools:
  - name: project_move
    effect: write
    pathFields: ['source', 'destination']
  - name: project_read_many
    effect: read
    pathFields: ['files']
```

字段支持对象点路径，例如 `target.path`；值可以是一个字符串或非空字符串数组。所有声明路径必须通过检查；路径缺失或空数组会升级。

自定义工具、可信工具和可信命令是管理员对真实实现的声明；添加会修改快速放行范围。不要把仅凭名称声称只读的未知工具放入这些列表。

## 命令规则 `shell`

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 启用命令语法快速检查 |
| `tools` | `bash`, `pwsh` | 使用命令规则的工具名 |
| `readCommands` | 见 defaults.json | POSIX `pwd/ls/cat/head/tail/wc/rg/grep/echo` 及四种 PowerShell cmdlet |
| `workspaceMutationCommands` | `mkdir`, `touch` | 只批准语法明确且全部目标在允许根内的创建操作 |
| `trustedCommands` | `[]` | 精确的 executable + args 数组，无前缀授权 |
| `maxCommandChars` | `8192` | 命令字符上限 |

例：对你已审查的项目脚本授予精确命令信任：

```yaml
trustedCommands:
  - executable: npm
    args: ['run', 'build']
  - executable: pnpm
    args: ['test']
```

`npm run build extra` 不会匹配 `npm run build`。语法检查先于可信命令匹配：含展开、管道、重定向、通配符、反斜杠或复合语法的命令仍升级。Windows 绝对路径命令常会进入 LLM，原生 `read/write/edit` 文件工具正常使用路径规则。

只把命令加入 `readCommands` 并不会给未知可执行文件赋予只读语义；没有内置解析的命令仍升级，需使用精确 `trustedCommands` 声明信任。

## 模型审查 `review`

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider`, `model` | 空 | 都为空时继承当前请求路由；指定时必须同时设置 |
| `reasoningEffort` | 空 | 可选模型推理档位；由所选 provider 决定支持范围 |
| `preferLowReasoning` | `true` | 未显式设置档位时，只有精确模型元数据列出 `low` 才选用它；否则保留 provider 默认。程序批准不查询模型 |
| `timeoutMs` | `120000` | 包含队列、模型能力查询、全部重试和中文翻译的总超时；10–600000 ms |
| `maxTokens` | `8192` | 初始输出预算；64–65536；实际初始值为与 `maxTokensLimit` 的较小者 |
| `maxTokensLimit` | `32768` | 输出预算硬上限；64–65536；应按 provider 能力配置 |
| `tokenLimitRetries` | `2` | 仅 `max-tokens` 截断后的额外扩容尝试；0–5；设为 0 关闭；到达预算上限立即停止 |
| `tokenGrowthFactor` | `2` | 每次扩容倍数；整数 2–4；最后一次不超过硬上限 |
| `chineseReasonRetries` | `1` | 英文/不合格说明的中文翻译尝试次数；0–2；0 时直接使用中文人工核对提示 |
| `maxReasonChars` | `600` | 模型说明与中文翻译的字符预算；100–4000；过长展示标记截断 |
| `showAction` | `true` | 在中文确认说明里附上实际工具与参数；关闭后仍可查看 DSH 原生工具详情 |
| `maxActionChars` | `3000` | 附加操作正文字符上限；200–32768；命令和其他参数原样保留，超限标记截断 |
| `temperature` | `0` | 0–2 |
| `retries` | `0` | 非 token 截断的审查故障额外尝试；0–5；拒绝不重试。与扩容共享有限计数，不相乘 |
| `retryDelayMs` | `300` | 失败后的等待；0–10000 ms |
| `concurrency` | `2` | 同一引擎同时进行的 LLM 审查数量；1–32 |
| `maxQueued` | `128` | 等待队列上限；1–4096 |
| `onError` | `ask` | 审查超时、异常、无效输出、上下文超限：`ask` 或 `deny` |
| `onDeny` | `ask` | LLM 拒绝后的处理：`ask` 或 `deny` |
| `policyAppend` | 空 | 附加管理员策略；追加到基础审查策略之后 |
| `maxInputChars` | `180000` | 审查数据段上限；超限按 onError 处理，不裁掉授权上下文 |
| `allowAsk` | `true` | 允许 LLM 显式请求用户判断；关闭时显式 ask 转为最终拒绝 |

审核输入沿用官方 Auto Review 的来源区分：环境、项目约束、保留的用户/直接父 Agent 指令、历史调用事实和精确待执行动作。检查日志身份与参数一致性。主模型系统提示词和隐藏推理不加入审查输入。模型流必须包含一段最终 JSON 文本和正常 `stop`；可在它之前包含推理块。JSON 重复键、非法字段组合、工具调用、截断和额外文字都属于审查失败。

默认协议：低风险批准；中风险由明确授权决定；高风险拒绝。批准输出只含 `risk` 和 `decision`，拒绝或询问可含 `reason`。拒绝与审查异常在工具错误中分别使用 `DCAR_REVIEW_DENIED` 与 `DCAR_REVIEW_FAILED`，原因也返回主 Agent。用户确认走 DSH 原生审批流程；没有审批通道或策略为 `never` 时不会自动批准。

1.1.0 对 `max-tokens` 使用独立扩容恢复：默认 8192 → 16384 → 32768。每次重新审查同一份完整授权快照，不继续被截断的输出、不删除历史、不复用片段中的批准。即使 JSON 看似完整但终止原因仍是 `max-tokens`，也不接受它。输入 JSON 改用紧凑序列化以减少空白开销，所有字段及字符串内容保留。

中文询问是固定行为，`policyAppend` 不覆盖它。审查提示词要求 `reason` 使用简体中文；展示前检查汉字和连续英文句串，纯英文或混杂长英文说明按需翻译。翻译请求只有原说明，默认最多 2048 输出 tokens，只接受正常结束的单字段中文 `reason` JSON；无法修改已经通过校验的 risk/decision。最终拒绝及 `never` 会话没有询问界面，不额外花费翻译请求。

翻译失败、超时、格式错误或模型未给出说明时，使用中文提示并注明缺少可用说明，不虚构模型问题。批准询问中始终附有程序生成的原审查结论和风险等级，翻译无法改变这些标签。所有语言的 `displayReason` 和原生审批的 `reason` 都是中文，代码和参数保留原样。审查本身失败时，分别说明 token 上限、总超时、队列满、授权输入过长或服务/协议故障；原始错误保留在审查记录中。翻译失败不会改成 `onError`，也不会改变已验证的决策。

普通审查请求最多 `1 + retries + tokenLimitRetries` 次，再加最多 `chineseReasonRetries` 次翻译；总超时可能提前终止。扩容到硬上限仍截断时直接按 `onError` 处理，不在同一预算上无限重试。

## 缓存 `cache`

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `false` | 启用完整快照批准缓存 |
| `ttlMs` | `30000` | 有效期；1–3600000 ms |
| `maxEntries` | `128` | 条目上限；1–10000 |

只缓存 `allow`，不缓存 `ask/deny` 或失败。授权历史通常随调用增长，所以常规会话中的缓存命中可能很少；节省请求主要来自程序层。修改会话配置或 `/dcar clear-cache` 会清空缓存。

## 记录 `audit`

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 内存审查历史；计数器始终保留 |
| `file` | 空 | 空值不写磁盘；相对路径按会话 cwd 定位 |
| `maxBytes` | `5242880` | 单个 JSONL 文件上限，达到后轮转为 `.1` |
| `historyLimit` | `200` | 每会话最大内存条目；1–10000 |
| `includeArguments` | `false` | 写入完整参数正文；默认只记录参数 SHA-256 |
| `includeReasons` | `true` | 记录规则/LLM 原因；每条最多 2000 字符 |

日志包含时间、会话、调用 ID、工具、参数摘要、审查层、DCAR 决策、规则码、耗时与缓存命中。`/dcar stats` 同时给出请求数、失败数和日志 I/O 错误。记录的是 DCAR 的审查结果；后续独立策略仍可拒绝执行。

1.1.0 增加 `reviewAttempts/tokenLimitRetries/translationAttempts/lastMaxTokens/errorCode`，并在启用原因记录时保存原始 `reason` 与中文 `displayReason`。统计中的 `llmRequests` 包括翻译，`translationRequests` 单列翻译数，`tokenLimitRetries` 单列实际发起的扩容重试次数。历史记录只保存说明的前 2000 字符。

## 命令与生命周期

| 字段 | 默认值 | 含义 |
|---|---|---|
| `commands.enabled` | `true` | 注册管理命令 |
| `commands.name` | `dcar` | 小写命令名，可修改以避免冲突 |
| `commands.allowSessionConfig` | `true` | 允许命令修改本会话配置 |
| `lifecycle.fallbackPreset` | `workspace-write` | 关闭/卸载时回退的已配置受限模式；不能是完整访问或 CAutoR |

会话覆盖支持 `enabled/rules/shell/review/cache/audit`；其余为加载时设置。会话覆盖在重启后清除。

从 1.0.2 起，CAutoR 同时出现在「新会话的默认权限模式」列表。在 DSH 原生设置中选择 CAutoR 并保存，默认值由宿主权限服务的 `defaultPreset` 持久化，后续新会话自动进入 CAutoR。此设置独立于 `/dcar on`，保存时保留已有会话的权限选择。应通过原生设置保存，插件会同时写入启动守护预设；无需手动修改权限服务配置。

停用插件后，已加载的 CAutoR 会话按 `lifecycle.fallbackPreset` 回退；默认仍为 CAutoR 的新会话使用只读、`never` 审批，并标记 DCAR 未启用。启用插件后，未开始交互的新会话恢复审查；也可把默认值改回其他模式。
