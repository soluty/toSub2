import path from "node:path";
import fs from "node:fs/promises";
import { writePasswordJson as writePrivateJson } from "./password-set.mjs";

export const TOTP_ROTATE_STATE_FILENAME = "totp-rotate-state.json";
export const TOTP_ROTATE_RESULT_FILENAME = "totp-rotate-result.json";
export { writePrivateJson as writeTotpRotationJson };
const DISABLE_TOTP_PATH = "/backend-api/accounts/mfa/user/disable_in_house";

export async function readTotpRotationJson(file, operationId, email) {
  try {
    const data = JSON.parse(await fs.readFile(file, "utf8"));
    return data?.version === 1 && data.operationId === operationId
      && data.email?.toLowerCase() === email.toLowerCase() ? data : null;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function flowError(message, uncertain = false) {
  return Object.assign(new Error(message), { totpRotationMessage: message, uncertain });
}

function parseResponse(response) {
  let data;
  try { data = JSON.parse(response.text); } catch {}
  return { status: response.res.status, data };
}

function totpFactors(info) {
  if (typeof info?.mfa_enabled_v2 !== "boolean" || !Array.isArray(info?.factors?.totp)) {
    throw flowError("平台返回的 2FA 状态无法识别，已停止更换");
  }
  return info.factors.totp;
}

export async function rotateAccountTotp(client, options) {
  const { chatgptBase, email, session, deviceId, operationId, resultPath, generateTotp } = options;
  const statePath = path.join(path.dirname(resultPath), TOTP_ROTATE_STATE_FILENAME);
  const prior = await readTotpRotationJson(statePath, operationId, email);
  if (prior && prior.state !== "preparing") throw flowError("这次 2FA 更换已经提交或结束，请先核实结果");
  let state = { version: 1, operationId, email, state: "preparing", oldDisabled: false, startedAt: new Date().toISOString() };
  const save = async (next, error = null) => {
    state = { ...state, state: next, error, updatedAt: new Date().toISOString() };
    await writePrivateJson(statePath, state);
  };
  await save("preparing");
  const request = (method, route, json) => client.request(method, `${chatgptBase}${route}`, {
    headers: { authorization: `Bearer ${session.accessToken}`, "oai-device-id": deviceId,
      "oai-language": "zh-CN", "x-openai-target-path": route, "x-openai-target-route": route },
    origin: chatgptBase, referer: `${chatgptBase}/`, ...(json === undefined ? {} : { json }),
    retryRiskControl: false, allowChallengeReplay: false,
  });
  const readInfo = async () => {
    const { status, data } = parseResponse(await request("GET", "/backend-api/accounts/mfa_info"));
    if (status !== 200 || data?.error) throw flowError(`读取 2FA 状态失败（HTTP ${status}）`);
    totpFactors(data);
    return data;
  };
  try {
    if (session.user?.email?.toLowerCase() !== email.toLowerCase()) throw flowError("登录账号与所选邮箱不一致，已停止更换 2FA");
    const info = await readInfo();
    if (!info.mfa_enabled_v2 || !totpFactors(info).length) throw flowError("账号当前没有启用 TOTP 2FA，请使用设置 2FA 功能");
    if (Object.entries(info.factors).some(([kind, factors]) => kind !== "totp"
      && (Array.isArray(factors) ? factors.length > 0 : Boolean(factors)))) {
      throw flowError("账号还启用了其他验证方式，请在官方页面更换验证器；本次未关闭任何验证方式");
    }
    const factors = totpFactors(info);
    if (factors.length !== 1 || typeof factors[0]?.id !== "string" || !factors[0].id.trim()
      || (factors[0].factor_type && factors[0].factor_type !== "totp")) {
      throw flowError("无法唯一确定当前 TOTP 验证器的 ID，已停止更换，旧 2FA 未关闭");
    }
    const factorId = factors[0].id;
    await save("disabling");
    console.log("[2fa-rotate-disabling] 正在关闭旧 2FA。");
    // 2026-09-27 的公开更换实现：查询当前 TOTP factor_id 后按验证器关闭。
    // https://github.com/quyetlv12/chatgpt-tool/blob/4d0d1201bf0d837fa58e5bca64d72cec11f57ac0/modules/twofa/mfa_phase.py#L646-L665
    // 关闭后必须重新读取状态，不能仅凭 HTTP 成功继续；不自动重试关闭请求。
    const disabled = parseResponse(await request("POST", DISABLE_TOTP_PATH, { factor_id: factorId }));
    if ([404, 405].includes(disabled.status)) {
      state.failureCode = "DISABLE_ENDPOINT_UNSUPPORTED";
      await save("failed", `关闭 2FA 接口适配失败（HTTP ${disabled.status}）：平台不接受当前的 POST ${DISABLE_TOTP_PATH} 请求，需要核对现行关闭流程；本次登录验证已完成，旧 2FA 未关闭`);
      throw flowError(state.error);
    }
    if ([400, 401, 403, 409, 422, 429].includes(disabled.status)
      || (disabled.status >= 200 && disabled.status < 300 && (disabled.data?.success === false || disabled.data?.error || disabled.data === false))) {
      await save("failed", `平台拒绝关闭旧 2FA（HTTP ${disabled.status}），请重新验证账号后再试`);
      throw flowError(state.error);
    }
    if (disabled.status < 200 || disabled.status >= 300) throw flowError(`关闭旧 2FA 的结果待核实（HTTP ${disabled.status}）`, true);
    const afterDisable = await readInfo();
    if (afterDisable.mfa_enabled_v2 || totpFactors(afterDisable).length) throw flowError("平台尚未确认旧 2FA 已关闭，请先在官方页面核实", true);
    state.oldDisabled = true;
    await save("disabled");
    console.log("[2fa-rotate-disabled] 旧 2FA 已关闭，正在生成新密钥。");

    await save("enrolling");
    const enrollment = parseResponse(await request("POST", "/backend-api/accounts/mfa/enroll", { factor_type: "totp" }));
    const secret = String(enrollment.data?.secret || "").toUpperCase().replace(/[\s=]/g, "");
    const sessionId = enrollment.data?.session_id;
    if (enrollment.status < 200 || enrollment.status >= 300 || enrollment.data?.error
      || !/^[A-Z2-7]{16,128}$/.test(secret) || typeof sessionId !== "string" || !sessionId) {
      throw flowError(`生成新 2FA 密钥失败（HTTP ${enrollment.status}）`);
    }
    const result = { version: 1, operationId, email, secret, activation_succeeded: false,
      otpauth_uri: `otpauth://totp/${encodeURIComponent(`OpenAI:${email}`)}?${new URLSearchParams({ secret, issuer: "OpenAI", algorithm: "SHA1", digits: "6", period: "30" })}` };
    // 在发送激活请求前保存新密钥；即使响应丢失，也能导出并核实新验证器。
    await writePrivateJson(resultPath, result);
    const code = generateTotp(secret);
    await save("activating");
    console.log("[2fa-rotate-activating] 新密钥已私有保存，正在启用新 2FA。");
    const activated = parseResponse(await request("POST", "/backend-api/accounts/mfa/user/activate_enrollment", {
      code, factor_type: "totp", session_id: sessionId,
    }));
    if ([400, 401, 403, 404, 405, 409, 422, 429].includes(activated.status)
      || (activated.status >= 200 && activated.status < 300 && (activated.data?.success === false || activated.data?.error))) {
      await save("needs_setup", "旧 2FA 已关闭，但平台未接受新 2FA 的激活，请继续设置 2FA");
      throw flowError(state.error);
    }
    if (activated.status < 200 || activated.status >= 300 || activated.data?.success !== true) {
      throw flowError("新 2FA 的激活结果待核实，请下载新密钥并在官方页面核实", true);
    }
    await writePrivateJson(resultPath, { ...result, activation_succeeded: true, activated_at: new Date().toISOString() });
    await save("completed");
    console.log("[ok] 2FA rotation activated and saved securely");
  } catch (error) {
    const uncertain = error.uncertain || ["disabling", "activating"].includes(state.state);
    const next = uncertain ? "unknown" : state.oldDisabled ? "needs_setup" : "failed";
    const message = error.totpRotationMessage || (uncertain
      ? "2FA 更换请求后连接或保存中断，结果待核实；不会自动重复提交"
      : "2FA 更换未完成，请检查网络或本机存储后重试");
    await save(next, message);
    throw flowError(message, uncertain);
  }
}
