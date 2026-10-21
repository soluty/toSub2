import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-totp-rotate-"));
const credentialRoot = path.join(root, ".credentials");
const credentialFile = path.join(credentialRoot, "credentials.json");
const port = await availablePort();
const base = `http://127.0.0.1:${port}`;
const oldSecret = "JBSWY3DPEHPK3PXP";
const password = "Rotation_Test_Password_927!";
const fixtures = new Map();
const accounts = new Map();
const requests = [];
const credentials = { version: 1, accounts: {} };
const serving = process.argv.includes("--serve");
let upstreamBase, child, childExit, headers, credentialBackup;
let logs = "";

const upstream = http.createServer(async (req, res) => {
  const url = new URL(req.url, upstreamBase);
  let body = "";
  for await (const chunk of req) body += chunk;
  const cookies = Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map(item => item.split("=")));
  const name = cookies.account;
  const account = accounts.get(name);
  const json = (status, data) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
  const mfaInfo = () => ({ mfa_enabled: account.enabled, mfa_enabled_v2: account.enabled,
    factors: { totp: account.enabled ? (name === "factor-missing" ? [{ factor_type: "totp" }]
      : name === "factor-ambiguous" ? [{ id: "first-factor", factor_type: "totp" }, { id: "second-factor", factor_type: "totp" }]
      : [{ id: `native-totp-${name}`, factor_type: "totp" }]) : [],
      passkeys: name === "other-factor" ? [{ id: "passkey" }] : [], sms: [], push_auth: null } });
  if (url.pathname === "/") {
    res.setHeader("set-cookie", "__Host-next-auth.csrf-token=test-csrf; Path=/");
    return res.end('<html><script>window.state={"accessToken":"mock-totp-session-access-token"}</script></html>');
  }
  if (url.pathname === "/api/auth/providers") return json(200, {});
  if (url.pathname === "/api/auth/csrf") return json(200, { csrfToken: "test-csrf" });
  if (url.pathname === "/api/auth/signin/openai") {
    const selected = url.searchParams.get("login_hint").split("@")[0];
    res.setHeader("set-cookie", `account=${selected}; Path=/`);
    return json(200, { url: `${upstreamBase}/log-in/password` });
  }
  if (url.pathname === "/log-in/password") return res.end('<html><input type="password"></html>');
  if (url.pathname === "/api/accounts/password/verify") {
    assert.equal(JSON.parse(body).password, password);
    if (!account.enabled) return json(200, { continue_url: `${upstreamBase}/web-callback`, page: { type: "external_url" } });
    return json(200, { page: { type: "mfa_challenge" }, continue_url: `${upstreamBase}/mfa-challenge/old-factor`,
      "oai-client-auth-session": { mfa_factors: [{ factor_type: "totp", id: "old-factor" }] } });
  }
  if (url.pathname === "/api/accounts/mfa/issue_challenge") return json(200, {});
  if (url.pathname === "/api/accounts/mfa/verify") {
    const payload = JSON.parse(body);
    if (name === "cancel-auth" || !validCode(account.secret, payload.code)) return json(400, { error: { message: "invalid totp" } });
    account.verified = true;
    requests.push({ name, action: "verified" });
    return json(200, { continue_url: `${upstreamBase}/web-callback`, page: { type: "external_url" } });
  }
  if (url.pathname === "/web-callback") return res.writeHead(302, { location: `${upstreamBase}/` }).end();
  if (url.pathname === "/api/auth/session") return json(200, { user: { email: `${name === "mismatch" ? "different" : name}@example.com` }, accessToken: "mock-totp-session-access-token" });
  if (url.pathname === "/backend-api/accounts/mfa_info") return json(200, mfaInfo());
  if (url.pathname === "/backend-api/accounts/disable_mfa") {
    requests.push({ name, action: "legacy-disable" });
    return json(405, { error: { message: "legacy endpoint not supported" } });
  }
  if (url.pathname === "/backend-api/accounts/mfa/user/disable_in_house") {
    assert.equal(req.method, "POST");
    assert.deepEqual(JSON.parse(body), { factor_id: `native-totp-${name}` }, "必须使用当前账号 mfa_info 返回的 TOTP ID，不能使用登录挑战 ID 或固定值");
    assert.equal(req.headers.authorization, "Bearer mock-totp-session-access-token");
    assert(account.verified, "关闭旧 2FA 前必须已验证原密钥");
    requests.push({ name, action: "disable" });
    if (name === "disable-405") return json(405, { error: { message: oldSecret } });
    if (name === "disable-404") return json(404, { error: { message: oldSecret } });
    if (name === "denied") return json(403, { error: { message: oldSecret } });
    if (name === "disable-retained") return json(200, { success: true });
    account.enabled = false;
    if (name === "disable-unknown") return res.destroy();
    if (name === "disable-204") return res.writeHead(204).end();
    return json(200, { success: true });
  }
  if (url.pathname === "/backend-api/accounts/mfa/enroll") {
    assert.equal(account.enabled, false, "必须确认旧 2FA 已关闭再生成新密钥");
    requests.push({ name, action: "enroll" });
    if (name === "cancel-disabled") return;
    if (name === "enroll-failed") return json(503, { error: { message: oldSecret } });
    return json(200, { secret: account.newSecret, session_id: `enroll-${name}` });
  }
  if (url.pathname === "/backend-api/accounts/mfa/user/activate_enrollment") {
    const payload = JSON.parse(body);
    assert(validCode(account.newSecret, payload.code));
    assert.equal(payload.session_id, `enroll-${name}`);
    requests.push({ name, action: "activate" });
    if (name === "activate-rejected") return json(400, { error: { message: account.newSecret } });
    account.secret = account.newSecret;
    account.enabled = true;
    if (name === "activate-unknown") return res.destroy();
    if (name === "cancel-activate") return;
    if (name === "persist-failed") {
      credentialBackup = await fs.readFile(credentialFile, "utf8");
      await fs.writeFile(credentialFile, "{broken");
    }
    return json(200, { success: true });
  }
  return json(404, { error: "测试出现未预期请求" });
});

try {
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  const names = serving ? ["alpha", "beta", "no-2fa", "missing"]
    : ["alpha", "beta", "no-2fa", "missing", "mismatch", "other-factor", "factor-missing", "factor-ambiguous", "denied", "disable-405", "disable-404", "disable-204", "disable-retained", "disable-unknown", "enroll-failed",
      "activate-rejected", "activate-unknown", "cancel-auth", "cancel-disabled", "cancel-activate", "persist-failed"];
  for (const name of names) await fixture(name);
  if (!serving) {
    for (const name of ["recovered", "stale", "interrupted-disabled", "postsetup-recovered"]) {
      await fixture(name);
      const item = fixtures.get(name);
      const state = { version: 1, email: `${name}@example.com`, operationId: crypto.randomUUID(),
        state: name === "stale" ? "preparing" : name === "recovered" ? "activating" : "needs_setup",
        oldDisabled: name !== "stale", previousAutoRepairPaused: name === "recovered" };
      await fs.writeFile(path.join(item.directory, "totp-rotate-state.json"), JSON.stringify(state));
      const metadata = JSON.parse(await fs.readFile(path.join(item.directory, "job-meta.json"), "utf8"));
      await fs.writeFile(path.join(item.directory, "job-meta.json"), JSON.stringify({ ...metadata, status: "working",
        last_operation_type: name === "postsetup-recovered" ? "setup_2fa" : "rotate_2fa", auto_repair_paused: true, totp_rotation: state }));
      if (["recovered", "stale"].includes(name)) await fs.writeFile(path.join(item.directory, "totp-rotate-result.json"), JSON.stringify({
        version: 1, email: state.email, operationId: name === "stale" ? crypto.randomUUID() : state.operationId,
        activation_succeeded: true, secret: accounts.get(name).newSecret, otpauth_uri: `otpauth://totp/${name}?secret=${accounts.get(name).newSecret}`,
      }), { mode: 0o600 });
      if (name === "recovered") await fs.rm(path.join(item.directory, "sub2api-import-oauth.json"));
      if (name === "postsetup-recovered") await fs.writeFile(path.join(item.directory, "totp-setup-result.json"), JSON.stringify({
        version: 1, email: state.email, activation_succeeded: true, secret: accounts.get(name).newSecret,
      }), { mode: 0o600 });
      if (name === "interrupted-disabled") accounts.get(name).enabled = false;
    }
  }
  await fs.mkdir(credentialRoot, { recursive: true });
  await fs.writeFile(credentialFile, JSON.stringify(credentials), { mode: 0o600 });
  await start();
  if (serving) {
    console.log(`2FA 更换隔离演示：http://127.0.0.1:${port}`);
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
    assert.equal((await getJob("recovered")).totpRotationState, "completed");
    assert.equal((await getJob("recovered")).autoRepairPaused, true, "恢复不能解除原有的自动重登暂停");
    assert((await exportSource("recovered")).includes(accounts.get("recovered").newSecret));
    assert.equal((await getJob("stale")).totpRotationState, "failed");
    assert((await exportSource("stale")).includes(oldSecret), "其他操作编号的结果不能覆盖原密钥");
    assert.equal((await getJob("interrupted-disabled")).totpRotationState, "needs_setup");
    assert(!(await exportSource("interrupted-disabled")).includes(oldSecret));
    assert.equal((await getJob("postsetup-recovered")).totpRotationState, "resolved");
    assert((await exportSource("postsetup-recovered")).includes(accounts.get("postsetup-recovered").newSecret));
    assert.equal(requests.length, 0, "重启恢复不能重新发送平台请求");

    const ids = ["alpha", "beta", "no-2fa", "missing"].map(name => fixtures.get(name).id);
    assert.equal((await request("/api/jobs/rotate-2fa-batch", { ids })).status, 400);
    const batch = await request("/api/jobs/rotate-2fa-batch", { ids, confirmed: true });
    assert.equal(batch.status, 200);
    const batchData = await batch.json();
    assert.equal(batchData.started, 2);
    assert.equal(batchData.skipped, 2);
    await completed("alpha", "completed");
    await completed("beta", "completed");
    assert.notEqual(accounts.get("alpha").secret, accounts.get("beta").secret, "每个账号必须使用独立的新密钥");
    for (const name of ["alpha", "beta"]) {
      assert.deepEqual(requests.filter(item => item.name === name).map(item => item.action), ["verified", "disable", "enroll", "activate"]);
      assert((await exportSource(name)).includes(accounts.get(name).newSecret));
      assert(!(await exportSource(name)).includes(oldSecret));
      assert.equal((await getJob(name)).autoRepairPaused, false);
      assert.equal((await getJob(name)).canRotateTotp, true);
    }

    assert.equal((await rotate("disable-204")).status, 200);
    await completed("disable-204", "completed");
    assert.deepEqual(requests.filter(item => item.name === "disable-204").map(item => item.action), ["verified", "disable", "enroll", "activate"]);
    for (const [name, expected] of [["mismatch", "failed"], ["other-factor", "failed"], ["factor-missing", "failed"], ["factor-ambiguous", "failed"],
      ["denied", "failed"], ["disable-405", "failed"], ["disable-404", "failed"], ["disable-retained", "unknown"],
      ["disable-unknown", "unknown"], ["enroll-failed", "needs_setup"], ["activate-rejected", "needs_setup"], ["activate-unknown", "unknown"]]) {
      assert.equal((await rotate(name)).status, 200);
      await completed(name, expected);
      const job = await getJob(name);
      if (expected === "failed" || ["disable-unknown", "disable-retained"].includes(name)) assert((await exportSource(name)).includes(oldSecret));
      else assert(!(await exportSource(name)).includes(oldSecret), "已关闭的原密钥不能继续作为有效凭据导出");
      if (["mismatch", "other-factor", "factor-missing", "factor-ambiguous"].includes(name)) assert.equal(requests.filter(item => item.name === name && item.action === "disable").length, 0);
      if (name === "disable-retained") {
        assert.deepEqual(requests.filter(item => item.name === name).map(item => item.action), ["verified", "disable"], "关闭返回 200 但旧验证器仍存在时，不能继续绑定新 2FA");
      }
      if (["disable-405", "disable-404"].includes(name)) {
        assert.match(job.totpRotationError, /接口适配失败.*HTTP 40[45]/);
        assert(!job.totpRotationError.includes("请重新验证"));
        assert.deepEqual(requests.filter(item => item.name === name).map(item => item.action), ["verified", "disable"], "接口不兼容时不能猜测其他方法、重发关闭请求或生成新密钥");
        assert.equal(accounts.get(name).enabled, true);
        assert.equal((await fs.stat(path.join(fixtures.get(name).directory, "totp-rotate-result.json")).catch(error => error.code)), "ENOENT");
        const state = JSON.parse(await fs.readFile(path.join(fixtures.get(name).directory, "totp-rotate-state.json"), "utf8"));
        assert.equal(state.failureCode, "DISABLE_ENDPOINT_UNSUPPORTED");
        assert.equal(state.oldDisabled, false);
      }
      if (expected === "needs_setup") assert.equal(job.canSetupTotp, true);
      if (expected === "unknown") {
        assert.equal(job.canRotateTotp, false);
        assert.equal(job.canSetupTotp, false);
        assert.equal(job.autoRepairEligible, false);
        assert.equal((await rotate(name)).status, 409);
      }
    }
    assert.equal((await getJob("activate-unknown")).canDownloadTotpRecovery, true);
    const recoveryResponse = await request(`/api/jobs/${fixtures.get("activate-unknown").id}/totp-rotation-recovery`);
    assert.equal(recoveryResponse.headers.get("cache-control"), "no-store");
    const recovery = await recoveryResponse.json();
    assert.equal(recovery.secret, accounts.get("activate-unknown").newSecret);
    assert.equal(recovery.activationConfirmed, false);

    for (const [name, waiting, expected] of [["cancel-auth", "mfa_otp", "failed"], ["cancel-disabled", "enroll", "needs_setup"], ["cancel-activate", "activate", "unknown"]]) {
      assert.equal((await rotate(name)).status, 200);
      await until(async () => waiting === "mfa_otp" ? (await getJob(name)).status === waiting
        : requests.some(item => item.name === name && item.action === waiting));
      assert.equal((await rotate(name)).status, 409);
      assert.equal((await request(`/api/jobs/${fixtures.get(name).id}/relogin`, {})).status, 409);
      assert.equal((await request("/api/jobs", { email: `${name}@example.com`, password, totpSecret: oldSecret })).status, 409);
      await request(`/api/jobs/${fixtures.get(name).id}/cancel`, {});
      await completed(name, expected);
    }

    const setupId = fixtures.get("interrupted-disabled").id;
    assert.equal((await request(`/api/jobs/${setupId}/setup-2fa`, {})).status, 200);
    await completed("interrupted-disabled", "resolved");
    assert((await exportSource("interrupted-disabled")).includes(accounts.get("interrupted-disabled").newSecret));

    assert.equal((await rotate("persist-failed")).status, 200);
    await completed("persist-failed", "save_failed");
    const pendingFile = path.join(fixtures.get("persist-failed").directory, "totp-rotate-result.json");
    assert.equal(JSON.parse(await fs.readFile(pendingFile, "utf8")).activation_succeeded, true);
    assert.equal((await getJob("persist-failed")).canDownloadTotpRecovery, true);
    await fs.writeFile(credentialFile, credentialBackup);
    const requestCount = requests.length;
    await stop();
    await start();
    assert.equal(requests.length, requestCount, "重启后不得重复关闭、生成或激活 2FA");
    assert.equal((await getJob("persist-failed")).totpRotationState, "completed");
    assert((await exportSource("persist-failed")).includes(accounts.get("persist-failed").newSecret));
    await assert.rejects(fs.stat(pendingFile), { code: "ENOENT" });
    for (const name of ["alpha", "beta"]) assert((await exportSource(name)).includes(accounts.get(name).newSecret));
    assert.equal((await getJob("activate-unknown")).canDownloadTotpRecovery, true);
    assert.equal((await getJob("cancel-activate")).totpRotationState, "unknown");
    assert.equal((await getJob("interrupted-disabled")).totpRotationState, "resolved");

    const resolvedSecret = accounts.get("activate-unknown").newSecret;
    assert.equal((await request("/api/jobs", { email: "activate-unknown@example.com", password, totpSecret: resolvedSecret })).status, 200);
    assert.equal((await getJob("activate-unknown")).totpRotationState, "resolved");
    assert.equal((await getJob("activate-unknown")).canRotateTotp, true);
    assert.equal(requests.filter(item => item.action === "legacy-disable").length, 0, "不能回退到已返回 405 的旧关闭接口");
    for (const [name, fixtureData] of fixtures) {
      const publicData = JSON.stringify(await getJob(name));
      const log = JSON.stringify(await (await request(`/api/jobs/${fixtureData.id}/logs`)).json());
      const metadata = await fs.readFile(path.join(fixtureData.directory, "job-meta.json"), "utf8");
      for (const secret of [oldSecret, accounts.get(name).newSecret]) {
        assert(!publicData.includes(secret)); assert(!log.includes(secret)); assert(!metadata.includes(secret));
      }
    }
    console.log("2FA 更换测试通过：原密钥验证、独立新密钥、保存导出、失败与取消、结果待核实、重启恢复、继续设置及日志脱敏");
  }
} finally {
  await stop();
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}

async function fixture(name) {
  const id = crypto.randomUUID();
  const directory = path.join(root, id);
  const enabled = name !== "no-2fa";
  const newSecret = [...crypto.randomBytes(24)].map(value => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[value % 32]).join("");
  accounts.set(name, { enabled, secret: oldSecret, newSecret, verified: false });
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", accounts: [{ credentials: { email: `${name}@example.com` } }] }));
  await fs.writeFile(path.join(directory, "job-meta.json"), JSON.stringify({ email: `${name}@example.com`, status: "completed", has_password: true,
    has_totp_key: enabled, totp_known_enabled: enabled, login_mode: "password" }));
  credentials.accounts[`${name}@example.com`] = { password, totpSecret: enabled && name !== "missing" ? oldSecret : "", proxyUrl: "" };
  fixtures.set(name, { id, directory });
}

async function start() {
  child = spawn(process.execPath, ["src/console-server.mjs", "--port", String(port)], {
    cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: root, TOSUB2_LINUX_CREDENTIAL_ROOT: credentialRoot,
      CHATGPT_BASE: upstreamBase, AUTH_BASE: upstreamBase, TOSUB2_TEST_SENTINEL_TOKEN: "test-sentinel", TOSUB2_TEST_SENTINEL_SO_TOKEN: "test-so" },
  });
  child.stdout.on("data", data => { logs += data; });
  child.stderr.on("data", data => { logs += data; });
  childExit = new Promise(resolve => child.once("exit", resolve));
  await until(async () => {
    try { const data = await fetch(base + "/api/bootstrap").then(r => r.json()); headers = { "content-type": "application/json", "x-console-token": data.token }; return data.features.totpRotate; }
    catch { return false; }
  });
}
async function stop() { if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await childExit; } }
function request(route, body) { return fetch(base + route, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
function rotate(name) { return request("/api/jobs/rotate-2fa-batch", { ids: [fixtures.get(name).id], confirmed: true }); }
async function getJob(name) { return (await (await request("/api/jobs/query", { emails: [`${name}@example.com`] })).json()).jobs.find(job => job.id === fixtures.get(name).id); }
async function exportSource(name) { return (await request("/api/jobs/export-source", { ids: [fixtures.get(name).id] })).text(); }
async function completed(name, state) {
  await until(async () => {
    const job = await getJob(name);
    if (job.totpRotationState === state && !job.totpRotationRunning && ["completed", "reauth_required", "resume_available"].includes(job.status)) return true;
    if (["email_otp", "password", "mfa_otp", "totp_setup_otp"].includes(job.status)) throw new Error(`不应等待手动验证：${name} / ${job.status}`);
    return false;
  });
}
async function until(predicate) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(`测试等待超时\n${logs.slice(-2000)}`);
}
async function availablePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function validCode(secret, code) { return [-1, 0, 1].some(offset => totp(secret, Date.now() + offset * 30_000) === code); }
function totp(secret, now) {
  let bits = "";
  for (const char of secret) bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) || []).map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hash = crypto.createHmac("sha1", key).update(counter).digest();
  return String((hash.readUInt32BE(hash.at(-1) & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
