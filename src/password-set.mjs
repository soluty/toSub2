import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { validateAccountPassword } from "./password-policy.mjs";

export const PASSWORD_SET_STATE_FILENAME = "password-set-state.json";

export async function writePasswordJson(file, data) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(temporary, file);
    if (process.platform === "linux") {
      const directory = await fs.open(path.dirname(file), "r");
      try { await directory.sync(); }
      finally { await directory.close(); }
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function readPasswordState(file, operationId, email) {
  try {
    const data = JSON.parse(await fs.readFile(file, "utf8"));
    return data.version === 1 && data.operationId === operationId && data.email?.toLowerCase() === email.toLowerCase() ? data : null;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function flowError(code, message) {
  return Object.assign(new Error(message), { code, passwordSetPublicMessage: message });
}

function errorFacts(error) {
  const chain = [];
  for (let item = error; item && chain.length < 5; item = item.cause) chain.push(item);
  const text = chain.map(item => String(item.message || "")).join(" ");
  const codes = new Set(chain.map(item => item.code));
  const curlCode = /curl:?\s*\((\d{1,3})\)/i.exec(text)?.[1];
  const status = error.httpStatus || Number(/HTTP\s+(\d{3})/i.exec(text)?.[1]) || null;
  const timeout = !status && (codes.has("ETIMEDOUT") || codes.has("UND_ERR_CONNECT_TIMEOUT") || curlCode === "28" || /timed?\s*out|timeout/i.test(text));
  const disconnected = !status && (["ECONNRESET", "ECONNREFUSED", "UND_ERR_SOCKET"].some(code => codes.has(code)) || ["7", "52", "56"].includes(curlCode));
  const tls = !status && (codes.has("EPROTO") || ["35", "60"].includes(curlCode) || /SSL|TLS|certificate/i.test(text));
  return { status, timeout, disconnected, tls, curlCode, codes };
}

export function formatPasswordSetError(error, phase = "设置统一密码") {
  if (error.passwordSetPublicMessage) return error.passwordSetPublicMessage;
  const facts = errorFacts(error);
  let reason = error.code === "INVALID_JSON_RESPONSE" ? "返回内容不是有效 JSON"
    : facts.timeout ? "网络请求超时"
    : facts.disconnected ? "网络连接中断或被拒绝"
    : facts.tls ? "TLS 连接失败"
    : facts.codes.has("ENOTFOUND") || facts.codes.has("EAI_AGAIN") ? "域名解析失败"
    : facts.status ? `HTTP ${facts.status}`
    : /不一致/.test(error.message || "") ? "账号身份与所选账号不一致"
    : "当前验证步骤未完成";
  if (facts.status && !reason.includes(`HTTP ${facts.status}`)) reason += `（HTTP ${facts.status}）`;
  if (facts.curlCode) reason += `（curl ${facts.curlCode}）`;
  let target = "";
  if (error.requestInfo) {
    const { method, origin, pathname } = error.requestInfo;
    try {
      const host = new URL(origin).host;
      const safePath = String(pathname || "").split("/").map(part => /^[a-z_-]{0,40}$/i.test(part) ? part : "<已隐藏>").join("/");
      target = `；${["GET", "POST", "PUT", "DELETE"].includes(method) ? `${method} ` : ""}${host}${safePath}`;
    } catch {}
  }
  return `${phase}失败：${reason}${target}`;
}

async function followVerificationPage(client, url, referer) {
  try { return await client.follow(url, { referer }); }
  catch (error) {
    const facts = errorFacts(error);
    if (error.requestInfo?.method !== "GET" || !(facts.timeout || facts.disconnected || [502, 503, 504].includes(facts.status))) throw error;
    console.log("[password-set] 验证页面请求遇到网络波动，保持当前会话重试一次。");
    return client.follow(url, { referer });
  }
}

async function openPasswordPage(client, options, mode, markPhase) {
  const { chatgptBase, authBase, email, deviceId, verifyEmail, completeMfa, verifyCurrentPassword, ensureAccount } = options;
  for (let round = 0; round < 2; round += 1) {
    markPhase("获取密码设置校验信息");
    const { data: csrf } = await client.getJson("GET", `${chatgptBase}/api/auth/csrf`, { referer: `${chatgptBase}/` });
    if (!csrf.csrfToken) throw flowError("PASSWORD_SET_VALIDATION", "无法取得密码设置校验信息，请重新验证账号");
    const query = new URLSearchParams({
      connection: "password", login_hint: email, reauth: "password", max_age: "0", "ext-oai-did": deviceId,
      [mode === "add" ? "post_login_add_password" : "post_login_password_reset"]: "true",
    });
    markPhase("发起密码设置验证");
    const { data: signin } = await client.getJson("POST", `${chatgptBase}/api/auth/signin/openai?${query}`, {
      origin: chatgptBase, referer: `${chatgptBase}/`,
      form: { callbackUrl: `${chatgptBase}/`, csrfToken: csrf.csrfToken, json: "true" },
    });
    if (!signin.url || ![new URL(authBase).origin, new URL(chatgptBase).origin].includes(new URL(signin.url).origin)) {
      throw flowError("PASSWORD_SET_VALIDATION", "密码设置返回了无法识别的验证地址");
    }
    markPhase("打开密码验证页面");
    let requestedAt = new Date().toISOString();
    let page = await followVerificationPage(client, signin.url, `${chatgptBase}/`);
    for (let step = 0; step < 6; step += 1) {
      const current = new URL(page.finalUrl);
      if (current.origin === new URL(authBase).origin && current.pathname === "/reset-password/new-password") return page.finalUrl;
      if (current.origin === new URL(chatgptBase).origin && !["/log-in/password", "/email-verification"].includes(current.pathname)) {
        markPhase("核对登录账号");
        await ensureAccount?.(client);
        break;
      }
      if (current.origin !== new URL(authBase).origin) throw flowError("PASSWORD_SET_VALIDATION", "验证跳转离开了账号认证服务，已停止操作");
      let verified;
      if (current.pathname === "/log-in/password") {
        markPhase("验证账号原密码");
        verified = await verifyCurrentPassword?.(client, page.finalUrl);
        if (!verified) {
          const html = page.last?.text || "";
          const offered = /passwordless_login_send_otp|\/passwordless\/send-otp|passwordless_disabled[\\"'\s,:]*false|Use a one.time code|使用一次性验证码/i.test(html);
          if (!offered) throw flowError("PASSWORD_SET_OLD_PASSWORD_REQUIRED", "平台要求验证账号原密码，但本机没有可用原密码，且页面未提供邮箱验证码方式。请重新导入原账号密码后再试；不要在这里填写统一新密码");
          markPhase("发送邮箱验证码");
          requestedAt = new Date().toISOString();
          console.log("[password-set] 使用平台提供的一次性邮箱验证码验证账号原身份。");
          const response = await client.request("POST", `${authBase}/api/accounts/passwordless/send-otp`, {
            origin: authBase, referer: page.finalUrl,
          });
          let payload;
          try { payload = JSON.parse(response.text); } catch {}
          const next = payload?.continue_url || payload?.redirect_url || response.location;
          if (response.res.status < 200 || response.res.status >= 400 || !next
            || new URL(next).origin !== new URL(authBase).origin || new URL(next).pathname !== "/email-verification") {
            throw flowError("PASSWORD_SET_OLD_PASSWORD_REQUIRED", `平台未接受邮箱验证方式（HTTP ${response.res.status}），请重新导入账号原密码后再试`);
          }
          page = await followVerificationPage(client, next, page.finalUrl);
          continue;
        }
      } else if (current.pathname === "/email-verification") {
        markPhase("验证邮箱验证码");
        console.log(`[email-otp-requested-at] ${requestedAt}`);
        console.log("[password-set] 请完成设置新密码所需的邮箱验证。");
        verified = await verifyEmail(client, page.finalUrl);
      } else {
        throw flowError("PASSWORD_SET_VALIDATION", "平台要求额外身份验证，当前流程尚未进入新密码页面，请先在官方页面完成验证");
      }
      markPhase("验证账号 2FA");
      verified = await completeMfa(client, verified, page.finalUrl);
      const next = verified?.continue_url || verified?.redirect_url;
      if (!next || ![new URL(authBase).origin, new URL(chatgptBase).origin].includes(new URL(next).origin)) {
        throw flowError("PASSWORD_SET_VALIDATION", "身份验证未返回可继续的密码设置页面");
      }
      markPhase("打开验证后的页面");
      page = await followVerificationPage(client, next, page.finalUrl);
    }
  }
  throw flowError("PASSWORD_SET_VALIDATION", "身份验证仍未进入新密码页面，请检查账号状态后重试");
}

export async function setAccountPassword(client, options) {
  const { authBase, email, resultPath, operationId, sentinelHeaders } = options;
  const password = validateAccountPassword(options.password);
  const statePath = path.join(path.dirname(resultPath), PASSWORD_SET_STATE_FILENAME);
  const prior = await readPasswordState(statePath, operationId, email);
  if (prior && prior.state !== "preparing") throw new Error("这次密码设置已提交或结束，请先核实结果");
  let state = { version: 1, operationId, email, state: "preparing", startedAt: new Date().toISOString() };
  async function saveState(next, error = null) {
    state = { ...state, state: next, error, updatedAt: new Date().toISOString() };
    await writePasswordJson(statePath, state);
  }
  await saveState("preparing");
  let phase = "准备密码设置";
  try {
    // 修改密码的重新认证参数来自公开客户端实现；添加流程沿用本项目已有协议。
    // https://github.com/xiaodingmao-xx/turb-gpt-free-register/blob/main/core/roxy_registration.py
    // https://github.com/zoyassisoe/openai-reg-20260720/blob/main/X9-Free/_credential_toolcore/chatgpt_register_http.py
    let mode = options.hasPassword ? "reset" : "add";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const passwordPageUrl = await openPasswordPage(client, options, mode, value => { phase = value; });
      phase = "获取新密码提交校验信息";
      const headers = await sentinelHeaders(client);
      await saveState("submitted");
      console.log("[password-set-submitted] 正在提交新密码。");
      let response;
      try {
        response = await client.request("POST", `${authBase}/api/accounts/password/${mode}`, {
          json: { password }, headers, origin: authBase, referer: passwordPageUrl,
          retryRiskControl: false, allowChallengeReplay: false,
        });
      } catch {
        throw flowError("PASSWORD_SET_RESULT_UNKNOWN", "新密码提交后连接中断，结果待核实，系统不会自动重试");
      }
      let data;
      try { data = JSON.parse(response.text); } catch {}
      const status = response.res.status;
      const alreadySet = /password_already_(?:set|exists)/i.test(String(data?.error?.code || data?.code || ""));
      if (mode === "add" && attempt === 0 && [400, 409].includes(status) && alreadySet) {
        // 仅在明确的“已有密码”拒绝响应下切换流程，不把已有密码当作设置成功。
        mode = "reset";
        await saveState("preparing");
        console.log("[password-set] 平台确认账号已有密码，改为验证并重置密码。");
        continue;
      }
      if (status >= 400 && status < 500) throw flowError("PASSWORD_SET_REJECTED", `平台拒绝设置新密码（HTTP ${status}），请检查验证状态或密码要求`);
      const continueUrl = data?.continue_url || data?.redirect_url;
      const completed = data?.success === true || (data?.page?.type === "external_url" && typeof continueUrl === "string"
        && !/\/(?:log-in|email-verification|reset-password\/new-password)(?:[/?#]|$)/.test(continueUrl));
      if (status < 200 || status >= 300 || data?.error || !completed) {
        throw flowError("PASSWORD_SET_RESULT_UNKNOWN", "平台未返回明确的密码设置结果，请先核实新密码");
      }
      // 写入原子结果后再报告完成。服务中断时也能恢复已确认的新密码。
      await writePasswordJson(resultPath, {
        version: 1, operationId, confirmed: true, email, password, added_at: new Date().toISOString(),
      });
      await saveState("completed");
      console.log("[ok] Account password set and saved securely");
      return;
    }
  } catch (error) {
    const unknown = error.code === "PASSWORD_SET_RESULT_UNKNOWN"
      || (state.state === "submitted" && error.code !== "PASSWORD_SET_REJECTED");
    const message = unknown ? "密码提交后未能确认完整结果，请核实新密码后再操作"
      : formatPasswordSetError(error, phase);
    await saveState(unknown ? "unknown" : "failed", message);
    throw flowError(unknown ? "PASSWORD_SET_RESULT_UNKNOWN" : "PASSWORD_SET_FAILED", message);
  }
}
