// 仅解释错误，不改变请求、校验或重试行为。
export function describeTlsHandshakeFailure(error) {
  const chain = [];
  for (let current = error; current && chain.length < 5; current = current.cause) chain.push(current);
  if (chain.some(item => Number(item.httpStatus) >= 100)) return null;
  const message = chain.map(item => String(item.message || "")).join(" ");
  if (!/curl:?\s*\(35\)/i.test(message)) return null;

  const requestInfo = chain.find(item => item.requestInfo)?.requestInfo;
  const connection = requestInfo?.connectionMode === "direct" ? "，未配置账号代理"
    : requestInfo?.connectionMode === "proxy" ? "，已配置账号代理" : "";
  let target = "";
  if (requestInfo) {
    try {
      const host = new URL(requestInfo.origin).host;
      // 保留定位所需的路径，隐藏查询参数、片段以及可能携带令牌的路径段。
      const pathname = String(requestInfo.pathname || "").split(/[?#]/, 1)[0]
        .split("/").map(part => /^[a-z_-]{0,40}$/i.test(part) ? part : "<已隐藏>").join("/");
      const method = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(requestInfo.method)
        ? `${requestInfo.method} ` : "";
      target = `；请求：${method}${host}${pathname}`;
    } catch {}
  }

  return `TLS 握手失败（curl 35${connection}）${target}。加密连接未建立，尚未收到该请求的 HTTP 响应。`
    + "可能是网络连接被中断或 TLS 兼容性问题，当前信息无法确定具体原因。"
    + "可稍后手动重试；持续失败时请检查网络及 Python/curl_cffi 运行环境。";
}
