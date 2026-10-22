import fs from "node:fs/promises";
import { writePasswordJson as writePrivateJson } from "./password-set.mjs";

export const EMAIL_CHANGE_STATE_FILENAME = "email-change-state.json";
export const EMAIL_CHANGE_CHECKPOINT_FILENAME = "email-change-checkpoint.json";
export const EMAIL_CHANGE_OLD_OUTPUT_FILENAME = "email-change-old-oauth.json";
export { writePrivateJson as writeEmailChangeState };

export async function readEmailChangeState(file, jobId, operationId) {
  try {
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    return state?.version === 1 && state.jobId === jobId && state.operationId === operationId
      && typeof state.oldEmail === "string" && typeof state.newEmail === "string" ? state : null;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function emailChangeSummary(state) {
  return Object.fromEntries(["version", "jobId", "operationId", "oldEmail", "newEmail", "state", "confirmed", "localCommitted",
    "oauthCompleted", "startedAt", "updatedAt", "error", "failureCode", "previousAutoRepairPaused", "remoteAccountIds", "remoteBackend"]
    .filter(key => Object.hasOwn(state, key)).map(key => [key, state[key]]));
}

function flowError(message, code = "EMAIL_CHANGE_FAILED") {
  return Object.assign(new Error(message), { emailChangeMessage: message, code });
}

function payload(response) {
  let data;
  try { data = JSON.parse(response.text); } catch {}
  return { status: response.res.status, data };
}

function authClaims(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))["https://api.openai.com/auth"] || {}; }
  catch { return {}; }
}

export async function readEmailChangeIdentity(client, chatgptBase) {
  const { status, data } = payload(await client.request("GET", `${chatgptBase}/api/auth/session`, {
    referer: `${chatgptBase}/`, retryRiskControl: false, allowChallengeReplay: false,
  }));
  const claims = authClaims(typeof data?.accessToken === "string" ? data.accessToken : "");
  const id = data?.user?.id || claims.user_id;
  if (status !== 200 || typeof data?.user?.email !== "string" || !data.user.email
    || typeof id !== "string" || !id || typeof data?.accessToken !== "string" || !data.accessToken) {
    throw flowError("无法取得可核对的登录身份，换绑流程已停止", "EMAIL_CHANGE_IDENTITY_UNAVAILABLE");
  }
  return { email: data.user.email.trim().toLowerCase(), userId: id, authUserId: typeof claims.user_id === "string" ? claims.user_id : "",
    accessToken: data.accessToken };
}

function sameIdentity(before, after) {
  return before.userId === after.userId
    && (!before.authUserId || !after.authUserId || before.authUserId === after.authUserId);
}

export async function confirmEmailChange(options) {
  const { statePath, jobId, operationId, readIdentity } = options;
  const state = await readEmailChangeState(statePath, jobId, operationId);
  if (!state?.identity?.userId) throw flowError("缺少原账号身份记录，不能自动核实换绑结果");
  const identity = await readIdentity();
  if (identity.email !== state.newEmail.toLowerCase() || !sameIdentity(state.identity, identity)) {
    throw flowError("新邮箱登录身份与原账号不一致，换绑结果仍待核实", "EMAIL_CHANGE_RESULT_UNKNOWN");
  }
  const confirmed = { ...state, state: "confirmed", confirmed: true, error: null, updatedAt: new Date().toISOString() };
  await writePrivateJson(statePath, confirmed);
  console.log("[email-change-confirmed] 已核实新邮箱仍属于原账号。");
  return confirmed;
}

export async function changeAccountEmail(client, options) {
  const { chatgptBase, statePath, jobId, operationId, deviceId, prepareMailbox, askCode, confirmIdentity } = options;
  let state = await readEmailChangeState(statePath, jobId, operationId);
  if (!state || state.state !== "preparing") throw flowError("换绑记录不存在，或这次操作已提交，请先核实结果");
  const save = async (next, error = null, extra = {}) => {
    state = { ...state, ...extra, state: next, error, updatedAt: new Date().toISOString() };
    await writePrivateJson(statePath, state);
  };
  try {
    const identity = await readEmailChangeIdentity(client, chatgptBase);
    if (identity.email !== state.oldEmail.toLowerCase()) throw flowError("登录账号与所选原邮箱不一致，换绑已停止");
    await save("checking_eligibility", null, { identity: { userId: identity.userId, authUserId: identity.authUserId } });
    const request = (method, route, json) => client.request(method, `${chatgptBase}${route}`, {
      headers: { authorization: `Bearer ${identity.accessToken}`, "oai-device-id": deviceId, "oai-language": "zh-CN",
        "x-openai-target-path": route, "x-openai-target-route": route },
      origin: chatgptBase, referer: `${chatgptBase}/`, ...(json === undefined ? {} : { json }),
      retryRiskControl: false, allowChallengeReplay: false,
    });
    // 2026-08-25 的公开实现；资格必须明确为 true，不能从套餐或本地标签推断。
    // https://github.com/maile456/gpt-bindflow/blob/a3a3e9c4831a47853db4c3ee9dc5bc74e4651bf0/tools/account_pipeline.py#L348-L437
    console.log("[email-change-eligibility] 正在检查账号是否允许换绑邮箱。");
    const eligibility = payload(await request("GET", "/backend-api/accounts/change_email/eligibility"));
    if (eligibility.status !== 200 || eligibility.data?.error) throw flowError(`无法检查换绑资格（HTTP ${eligibility.status}），尚未发送新邮箱验证码`);
    if (eligibility.data?.eligible !== true) {
      const reason = eligibility.data?.reason || eligibility.data?.code;
      const hint = typeof reason === "string" && /^[a-z][a-z0-9_]{0,47}$/.test(reason) ? `（原因代码：${reason}）` : "";
      throw flowError(eligibility.data?.eligible === false
        ? `平台不允许此账号换绑邮箱${hint}，已提前停止，尚未发送新邮箱验证码`
        : "平台未明确确认换绑资格，已提前停止，尚未发送新邮箱验证码", "EMAIL_CHANGE_NOT_ELIGIBLE");
    }
    const mfa = payload(await request("GET", "/backend-api/accounts/mfa_info"));
    if (mfa.status !== 200 || mfa.data?.error) throw flowError(`无法核对账号验证状态（HTTP ${mfa.status}），尚未发送新邮箱验证码`);
    await save("eligible");
    await prepareMailbox();
    state = await readEmailChangeState(statePath, jobId, operationId) || state;
    await save("sending");
    console.log(`[email-otp-requested-at] ${new Date().toISOString()}`);
    const begun = payload(await request("POST", "/backend-api/accounts/change_email/begin", { email: state.newEmail }));
    if (begun.status < 200 || begun.status >= 300 || begun.data?.success !== true || begun.data?.error) {
      const occupied = /email_already_linked|email_already_exists/.test(String(begun.data?.error?.code || begun.data?.code || ""));
      throw flowError(occupied ? "目标邮箱已被其他账号占用，请更换新邮箱"
        : `平台未接受新邮箱验证请求（HTTP ${begun.status}），原邮箱尚未更换`);
    }
    await save("awaiting_code");
    for (;;) {
      const code = await askCode();
      if (code.toLowerCase() === "q") throw flowError("已取消新邮箱验证，原邮箱尚未更换");
      if (!/^\d{6}$/.test(code)) {
        console.log("[email-change-code-rejected] 新邮箱验证码应为 6 位数字，请重新输入。");
        continue;
      }
      await save("submitting");
      console.log("[email-change-submitting] 正在提交新邮箱验证，收到明确结果后才更新本机资料。");
      const verified = payload(await request("POST", "/backend-api/accounts/change_email/verify", { email: state.newEmail, code }));
      const reason = `${verified.data?.error?.code || verified.data?.code || ""} ${verified.data?.error?.message || ""}`;
      if ([400, 422].includes(verified.status) && /(?:invalid|incorrect|wrong|expired)[_\s-]*(?:otp|code)|(?:otp|code)[_\s-]*(?:invalid|incorrect|wrong|expired)/i.test(reason)) {
        await save("awaiting_code");
        console.log("[email-change-code-rejected] 新邮箱验证码错误或已过期，请重新输入；需要重发时可取消后重新发起。");
        continue;
      }
      if ([400, 401, 403, 404, 405, 409, 422, 429].includes(verified.status)
        || (verified.status >= 200 && verified.status < 300 && (verified.data?.success === false || verified.data?.error))) {
        await save("failed", `平台拒绝新邮箱确认（HTTP ${verified.status}），本次未确认换绑成功`);
        throw flowError(state.error);
      }
      if (verified.status < 200 || verified.status >= 300 || verified.data?.success !== true) {
        throw flowError("新邮箱确认请求未返回明确结果，请核实后再操作", "EMAIL_CHANGE_RESULT_UNKNOWN");
      }
      await save("verifying_identity", null, { remoteAccepted: true });
      await confirmEmailChange({ statePath, jobId, operationId, readIdentity: confirmIdentity });
      return;
    }
  } catch (error) {
    const uncertain = ["submitting", "verifying_identity"].includes(state.state) || error.code === "EMAIL_CHANGE_RESULT_UNKNOWN";
    const message = error.emailChangeMessage || (uncertain
      ? "确认请求后连接或保存中断，换绑结果待核实，不会自动重复提交"
      : "换绑准备或身份验证未完成，尚未提交最终确认");
    await save(uncertain ? "unknown" : "failed", message, { failureCode: error.code || "EMAIL_CHANGE_FAILED" });
    throw flowError(message, uncertain ? "EMAIL_CHANGE_RESULT_UNKNOWN" : error.code);
  }
}
