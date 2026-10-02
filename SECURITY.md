# 安全策略

## 支持范围

只有最新发布版本（当前 1.1.x）接受安全修复。插件依赖的 DSH 插件 API 处于 rc 阶段，兼容承诺限于 `docs/COMPATIBILITY.md` 中列出的 DSH 版本。

## 报告安全问题

请使用 GitHub 的私下渠道报告，不要开公开 issue：

- 仓库 **Security** 标签页 → **Report a vulnerability**（GitHub Security Advisory），地址：<https://github.com/LytharaLab/DSH-Cons-Auto-Review/security/advisories/new>

报告里请尽量包含：

- 受影响的版本（`/dcar status` 的输出）与 DSH 版本；
- 复现用的最小配置、工具调用与命令；
- 实际结果与预期结果，以及它如何绕过或削弱审查；
- 是否需要在 `danger-full-access` 之外的特定权限模式下才能触发。

## 处理方式

维护者会在确认后回复并给出修复或缓解方案，修复发布前请勿公开细节。若 7 天内没有回应，可以在 issue 中只写「已按 SECURITY.md 提交安全问题」并等待，不要附带技术细节。

## 已知边界（不属于漏洞）

以下是设计上接受的限制，已在 `docs/COMPATIBILITY.md` 中说明，无需作为漏洞报告：

- 已批准的操作仍以宿主进程权限执行，DCAR 不是进程隔离层；
- 路径检查与执行之间存在外部进程替换链接的时间窗口；
- 程序 Shell 规则假定宿主命令与已安装插件可信，不识别被替换的可执行文件或 PowerShell 配置覆盖；
- 可选缓存的授权快照不探测外部文件或服务状态变化（因此默认关闭）。
