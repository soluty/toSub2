import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { changeAccountEmail, confirmEmailChange, emailChangeSummary, readEmailChangeState, writeEmailChangeState } from "../src/email-change.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-email-unit-"));
const statePath = path.join(root, "state.json");
const baseState = { version: 1, jobId: "job", operationId: "operation", oldEmail: "old@example.com", newEmail: "new@example.com",
  targetMailApiUrl: "https://mail.example/private-key", state: "preparing", confirmed: false };
const identity = { userId: "stable-user", authUserId: "auth-user", email: baseState.newEmail };
const jwt = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { user_id: "auth-user" } })).toString("base64url")}.signature`;
const response = (data, status = 200) => ({ res: { status }, text: JSON.stringify(data) });
try {
  for (const eligibility of [response({ eligible: false, reason: "not_supported" }), response({}), response({ eligible: "true" }),
    response({ eligible: true, error: "denied" }), response({}, 403), response({}, 404), response({}, 405), response({}, 500)]) {
    const run = await setup({ eligibility });
    await assert.rejects(run.execute(), /尚未发送新邮箱验证码/);
    assert.deepEqual(run.events, ["session", "eligibility"], "资格未明确通过时不能准备新邮箱、查询 MFA、发码或确认");
    assert.equal((await read()).state, "failed");
    assert.equal((await read()).confirmed, false);
  }
  {
    const run = await setup({ eligibility: () => { throw new Error("private network detail"); } });
    await assert.rejects(run.execute(), /尚未提交/);
    assert.deepEqual(run.events, ["session", "eligibility"]);
    assert(!(await read()).error.includes("private network"));
  }
  {
    const run = await setup({ sessionEmail: "someone-else@example.com" });
    await assert.rejects(run.execute(), /原邮箱不一致/);
    assert.deepEqual(run.events, ["session"]);
  }
  {
    const run = await setup({ codes: ["bad", "111111", "654321"], rejectFirst: true });
    await run.execute();
    assert.deepEqual(run.events, ["session", "eligibility", "mfa", "prepare", "begin", "code", "code", "verify", "code", "verify", "confirm"]);
    assert.equal((await read()).state, "confirmed");
    assert.deepEqual((await read()).remoteAccountIds, [17], "父进程收码准备写入的关联信息不能丢失");
    if (process.platform !== "win32") assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
  }
  for (const scenario of ["disconnected", "ambiguous", "identity-mismatch"]) {
    const run = await setup({ scenario });
    await assert.rejects(run.execute());
    const state = await read();
    assert.equal(state.state, "unknown", scenario);
    assert.equal(state.confirmed, false);
    assert.equal(run.events.filter(value => value === "verify").length, 1, "最终确认不能在不确定结果下自动重试");
    await assert.rejects(run.execute(), /已提交/);
    await confirmEmailChange({ statePath, jobId: "job", operationId: "operation", readIdentity: async () => identity });
    assert.equal((await read()).confirmed, true);
    assert.equal(run.events.filter(value => value === "verify").length, 1, "核实不能重复提交换绑");
  }
  for (const status of [400, 403, 405, 409, 429]) {
    const run = await setup({ rejectStatus: status });
    await assert.rejects(run.execute(), /平台拒绝/);
    assert.equal((await read()).state, "failed");
  }
  {
    const run = await setup({ codes: ["q"] });
    await assert.rejects(run.execute(), /取消/);
    assert(!run.events.includes("verify"));
    assert.equal((await read()).state, "failed");
  }
  assert.equal(await readEmailChangeState(statePath, "other-job", "operation"), null);
  assert.equal(await readEmailChangeState(statePath, "job", "other-operation"), null);
  const publicState = JSON.stringify(emailChangeSummary({ ...baseState, identity, token: jwt, code: "654321" }));
  for (const secret of ["private-key", "stable-user", "654321", jwt]) assert(!publicState.includes(secret));
  console.log("换绑邮箱单元测试通过：资格早检、拒绝不明确结果、身份核对、提交不重试、私有记录及脱敏");
} finally { await fs.rm(root, { recursive: true, force: true }); }

function read() { return readEmailChangeState(statePath, "job", "operation"); }
async function setup(config = {}) {
  await writeEmailChangeState(statePath, baseState);
  const events = [];
  const codes = [...(config.codes || ["654321"])];
  let verificationCount = 0;
  const client = { async request(method, url, options) {
    assert.equal(options.retryRiskControl, false);
    assert.equal(options.allowChallengeReplay, false);
    if (url.endsWith("/api/auth/session")) {
      events.push("session");
      return response({ user: { id: "stable-user", email: config.sessionEmail || baseState.oldEmail }, accessToken: jwt });
    }
    if (url.endsWith("/eligibility")) {
      events.push("eligibility");
      return typeof config.eligibility === "function" ? config.eligibility() : config.eligibility || response({ eligible: true });
    }
    if (url.endsWith("/mfa_info")) { events.push("mfa"); return response({ mfa_enabled: true }); }
    if (url.endsWith("/begin")) { events.push("begin"); return response({ success: true }); }
    if (url.endsWith("/verify")) {
      events.push("verify");
      verificationCount += 1;
      if (config.scenario === "disconnected") throw new Error("socket private detail");
      if (config.scenario === "ambiguous") return response({});
      if (config.rejectStatus) return response({ error: { code: "not_allowed" } }, config.rejectStatus);
      if (config.rejectFirst && verificationCount === 1) return response({ error: { code: "invalid_code" } }, 400);
      assert.equal(options.json.code, "654321");
      return response({ success: true });
    }
    throw new Error(`未预期请求：${method} ${url}`);
  } };
  return { events, execute: () => changeAccountEmail(client, {
    chatgptBase: "https://platform.example", statePath, jobId: "job", operationId: "operation", deviceId: "device",
    prepareMailbox: async () => { events.push("prepare"); await writeEmailChangeState(statePath, { ...await read(), remoteAccountIds: [17] }); },
    askCode: async () => { events.push("code"); assert(codes.length, "不应无限等待验证码"); return codes.shift(); },
    confirmIdentity: async () => { events.push("confirm"); return { ...identity, ...(config.scenario === "identity-mismatch" ? { userId: "other-user" } : {}) }; },
  }) };
}
