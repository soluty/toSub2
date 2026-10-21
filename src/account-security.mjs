import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const LOGOUT_RESULT_FILENAME = "logout-all-result.json";
const STATES = new Set(["preparing", "requesting", "accepted", "unknown", "failed"]);

export async function writeLogoutResult(filePath, result) {
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function readLogoutResult(filePath, operationId, email) {
  try {
    const result = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (result.version !== 1 || result.operationId !== operationId
      || String(result.email).toLowerCase() !== email.toLowerCase() || !STATES.has(result.state)) return null;
    return result;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function getLogoutSession(client, { chatgptBase, email }) {
  const response = await client.request("GET", `${chatgptBase}/api/auth/session`, {
    referer: `${chatgptBase}/`,
  });
  let session;
  try { session = JSON.parse(response.text); } catch {}
  if (response.res.status !== 200 || typeof session?.accessToken !== "string" || !session.accessToken
    || typeof session?.user?.email !== "string" || !session.user.email) {
    throw Object.assign(new Error("登录会话已失效，需要重新验证账号"), { code: "LOGOUT_LOGIN_REQUIRED" });
  }
  if (session.user.email.toLowerCase() !== email.toLowerCase()) {
    throw new Error("登录会话与所选账号不一致，已停止登出操作");
  }
  return session;
}

// 根据 ChatGPT 前端公开存档中的 logoutAll 调用接入；接口兼容性需随上游变化核实。
// https://github.com/0xdevalias/chatgpt-source-watch/blob/main/unpacked/_next/static/chunks/pages/_app.js
export async function logoutAllDevices(client, { chatgptBase, session, deviceId, saveState }) {
  // 先落盘再发送。进程在请求后中断时，恢复为“待核实”，不能自动重放。
  await saveState("requesting");
  let response;
  try {
    response = await client.request("POST", `${chatgptBase}/backend-api/accounts/logout_all`, {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        "oai-device-id": deviceId,
        "oai-language": "zh-CN",
      },
      origin: chatgptBase,
      referer: `${chatgptBase}/`,
      retryRiskControl: false,
      allowChallengeReplay: false,
    });
  } catch {
    await saveState("unknown", "登出请求未收到可靠响应，结果待核实；系统不会自动重试");
    return;
  }
  const status = response.res.status;
  const contentType = response.res.headers.get("content-type") || "";
  let payload = null;
  let invalidJson = false;
  if (response.text.trim()) {
    try { payload = JSON.parse(response.text); } catch { invalidJson = true; }
  }
  if (status >= 200 && status < 300 && !/text\/html/i.test(contentType) && !invalidJson) {
    if (payload === false || payload?.success === false || payload?.error || payload?.detail?.error) {
      await saveState("failed", "平台未接受登出请求，请检查账号状态后手动重试");
    } else if (payload !== null && (typeof payload !== "object" || Array.isArray(payload))) {
      await saveState("unknown", "登出接口返回无法识别的结果，请先核实设备状态");
    } else {
      await saveState("accepted");
    }
  } else if ([400, 401, 403, 404, 405, 409, 422, 429].includes(status)) {
    await saveState("failed", `平台拒绝登出请求（HTTP ${status}），请重新验证账号或检查接口兼容性`);
  } else {
    await saveState("unknown", `登出接口返回异常响应（HTTP ${status}），结果待核实；系统不会自动重试`);
  }
}
