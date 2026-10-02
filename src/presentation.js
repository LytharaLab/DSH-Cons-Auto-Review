/** Chinese human-facing prompts; raw diagnostics stay in the audit/agent error. */
function visible(value) {
  return String(value).replace(
    /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
}
export function bounded(text, limit) {
  const value = visible(text);
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n（内容过长，展示已截断）`;
}
export function actionText(exec, c) {
  if (!c.review.showAction) return "";
  const args = exec.arguments;
  let body;
  if (args && typeof args === "object" && typeof args.command === "string") {
    const { command, ...rest } = args;
    body =
      `命令：${command}` +
      (Object.keys(rest).length ? `\n其他参数：${JSON.stringify(rest)}` : "");
  } else {
    try {
      body = `参数：${JSON.stringify(args) ?? "（无）"}`;
    } catch {
      body = "参数无法展示，请查看原生工具详情。";
    }
  }
  return `\n\n待执行工具：${visible(exec.name)}\n${bounded(body, c.review.maxActionChars)}`;
}
export function reviewFailureMessage(error, c, trace) {
  const message = String(error.message ?? error);
  if (error.code === "DCAR_MAX_TOKENS")
    return `自动审查达到输出 token 上限，未取得完整结论（最后一次预算 ${trace.lastMaxTokens}，配置上限 ${c.review.maxTokensLimit}，已扩容重试 ${trace.tokenRetries} 次）。`;
  if (error.code === "DCAR_REVIEW_TIMEOUT")
    return `自动审查超时（总时限 ${c.review.timeoutMs} 毫秒，包含排队、重试和中文翻译），未取得完整结论。`;
  if (error.code === "DCAR_REVIEW_INPUT")
    return `授权上下文超过 ${c.review.maxInputChars} 字符的配置上限，自动审查未完成。`;
  if (message === "DCAR review queue is full")
    return "自动审查等待队列已满，未取得审查结论。";
  if (["DCAR_REVIEW_INVALID", "DCAR_REVIEW_STREAM"].includes(error.code))
    return "自动审查返回的结论格式无效或响应不完整，无法据此批准。";
  return "自动审查服务请求失败，未取得有效结论。";
}
export function approvalText(exec, c, explanation) {
  return `Con's 自动审查：是否允许本次操作？\n${visible(explanation)}${actionText(exec, c)}\n\n允许仅针对这一次调用；拒绝则不执行。`;
}
