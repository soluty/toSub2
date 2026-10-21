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
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-uniform-password-"));
const port = await availablePort();
const base = `http://127.0.0.1:${port}`;
const newPassword = 'Unified_$Pass"word_4826! ';
const oldPassword = "Previous_Password_927!";
const fixtures = new Map();
const accounts = new Map();
const mutations = [];
const modes = [];
const passwordChecks = [];
const pageRequests = new Map();
const mailboxRequests = [];
const emailOtpRequests = [];
const serving = process.argv.includes("--serve");
let upstreamBase;
let child;
let childExit;
let logs = "";
let headers;

const upstream = http.createServer(async (req, res) => {
  const url = new URL(req.url, upstreamBase);
  let body = "";
  for await (const chunk of req) body += chunk;
  const cookies = Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map(item => item.split("=")));
  const name = cookies.account;
  const mode = cookies.mode;
  const json = (status, data) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
  if (url.pathname.startsWith("/mail/")) {
    mailboxRequests.push(url.pathname);
    return json(200, []);
  }
  if (url.pathname === "/") {
    res.setHeader("set-cookie", "__Host-next-auth.csrf-token=test-csrf; Path=/");
    return res.end("<html>测试登录</html>");
  }
  if (url.pathname === "/api/auth/providers") return json(200, {});
  if (url.pathname === "/api/auth/csrf") return json(200, { csrfToken: "test-csrf" });
  if (url.pathname === "/api/auth/session") return json(200, name ? { user: { email: `${name}@example.com` }, accessToken: "test-session-access-token" } : {});
  if (url.pathname === "/api/auth/signin/openai") {
    const account = url.searchParams.get("login_hint").split("@")[0];
    const nextMode = url.searchParams.has("post_login_password_reset") ? "reset" : url.searchParams.has("post_login_add_password") ? "add" : "login";
    modes.push({ account, mode: nextMode });
    res.setHeader("set-cookie", [`account=${account}; Path=/`, `mode=${nextMode}; Path=/`]);
    if (["network", "flaky", "http-error"].includes(account)) return json(200, { url: `${upstreamBase}/api/accounts/authorize?state=private-state&code=private-code` });
    if (["lost", "otp-only", "stored", "mfa", "cancel", "rejected", "blocked"].includes(account)) {
      return json(200, { url: `${upstreamBase}/log-in/password` });
    }
    if (nextMode === "reset" && account !== "unexpected-email") return json(200, { url: `${upstreamBase}/reset-password/new-password` });
    return json(200, { url: `${upstreamBase}/email-verification` });
  }
  if (url.pathname === "/api/accounts/authorize") {
    pageRequests.set(name, (pageRequests.get(name) || 0) + 1);
    if (name === "http-error") return json(503, { error: { message: `${newPassword} private-token` } });
    if (name === "network" || (name === "flaky" && pageRequests.get(name) === 1)) return res.destroy();
    return res.writeHead(302, { location: `${upstreamBase}/reset-password/new-password` }).end();
  }
  if (url.pathname === "/log-in/password") return res.end(`<html><input type="password" name="password">${["otp-only", "rejected"].includes(name)
    ? '<button name="intent" value="passwordless_login_send_otp">Use a one-time code</button>' : ""}</html>`);
  if (url.pathname === "/api/accounts/password/verify") {
    const password = JSON.parse(body).password;
    passwordChecks.push({ name, password });
    if (password !== accounts.get(name)) return json(401, { error: { message: `invalid_password ${password}` } });
    if (["mfa", "cancel"].includes(name)) return json(200, { page: { type: "mfa_challenge" }, continue_url: `${upstreamBase}/mfa-challenge/test-factor`,
      "oai-client-auth-session": { mfa_factors: [{ factor_type: "totp", id: "test-factor" }] } });
    return json(200, { continue_url: `${upstreamBase}/reset-password/new-password`, page: { type: "reset_password_new_password" } });
  }
  if (url.pathname === "/api/accounts/passwordless/send-otp") {
    emailOtpRequests.push({ name, mode, action: "send" });
    assert(["otp-only", "rejected"].includes(name));
    assert.equal(req.method, "POST");
    return json(200, { continue_url: `${upstreamBase}/email-verification` });
  }
  if (url.pathname === "/email-verification") return res.end("<html>邮箱验证码</html>");
  if (url.pathname === "/api/accounts/email-otp/validate") {
    emailOtpRequests.push({ name, mode, action: "validate" });
    assert.equal(JSON.parse(body).code, "123456");
    return json(200, { continue_url: `${upstreamBase}/${mode === "login" ? "web-callback" : "reset-password/new-password"}`,
      page: { type: mode === "login" ? "external_url" : "reset_password_new_password" } });
  }
  if (url.pathname === "/api/accounts/mfa/issue_challenge") return json(200, {});
  if (url.pathname === "/api/accounts/mfa/verify") {
    assert.equal(JSON.parse(body).code, "654321");
    return json(200, { continue_url: `${upstreamBase}/reset-password/new-password`, page: { type: "reset_password_new_password" } });
  }
  if (url.pathname === "/reset-password/new-password") return res.end("<html>新密码</html>");
  if (url.pathname === "/web-callback") return res.writeHead(302, { location: `${upstreamBase}/` }).end();
  if (["/api/accounts/password/add", "/api/accounts/password/reset"].includes(url.pathname)) {
    assert.equal(req.method, "POST");
    assert.equal(url.pathname.split("/").at(-1), mode);
    assert.equal(JSON.parse(req.headers["openai-sentinel-token"]).flow, "password_reset");
    const password = JSON.parse(body).password;
    mutations.push({ name, mode, password });
    if (name === "denied") return json(400, { error: { code: "rejected", message: `Rejected ${password}` } });
    if (name === "uncertain") { accounts.set(name, password); return res.destroy(); }
    if (mode === "add" && accounts.get(name)) return json(409, { error: { code: "password_already_set" } });
    accounts.set(name, password);
    return json(200, { continue_url: `${upstreamBase}/web-callback`, page: { type: "external_url" } });
  }
  return json(404, { error: "测试中出现未预期请求" });
});

try {
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  for (const name of ["legacy-one", "legacy-two", "existing", "passwordless", "untracked", "denied", "uncertain"]) {
    await fixture(name, ["existing", "denied", "uncertain"].includes(name));
  }
  accounts.set("untracked", oldPassword);
  if (!serving) {
    for (const name of ["lost", "otp-only", "stored", "mfa", "cancel", "rejected", "blocked", "unexpected-email", "network", "flaky", "http-error"]) {
      await fixture(name, true);
      if (!["stored", "mfa", "cancel", "rejected"].includes(name)) await fs.rm(path.join(fixtures.get(name).directory, "password-add-result.json"));
    }
    accounts.set("rejected", "Actual_Old_Password_928!");
    for (const [name, state] of [["pending", "preparing"], ["recovered", "completed"]]) {
      await fixture(name, false);
      const item = fixtures.get(name);
      const operation = { version: 1, email: `${name}@example.com`, operationId: crypto.randomUUID(), state, startedAt: new Date().toISOString() };
      await fs.writeFile(path.join(item.directory, "job-meta.json"), JSON.stringify({ email: operation.email,
        status: "queued", queued_mode: "password_set", last_operation_type: "set_password", password_set: operation }));
      await fs.writeFile(path.join(item.directory, "password-set-state.json"), JSON.stringify(operation));
      if (state === "completed") {
        await fs.rm(path.join(item.directory, "sub2api-import-oauth.json"));
        await fs.writeFile(path.join(item.directory, "password-add-result.json"), JSON.stringify({ version: 1,
          email: operation.email, operationId: operation.operationId, confirmed: true, password: newPassword, added_at: new Date().toISOString() }));
      }
    }
    // 模拟结果已落盘、子进程尚未来得及标记完成时服务退出。
    for (const name of ["crash-recovered", "stale-result"]) {
      await fixture(name, false);
      const item = fixtures.get(name);
      const operation = { version: 1, email: `${name}@example.com`, operationId: crypto.randomUUID(),
        state: name === "crash-recovered" ? "submitted" : "preparing" };
      await fs.writeFile(path.join(item.directory, "job-meta.json"), JSON.stringify({ email: operation.email,
        status: "working", last_operation_type: "set_password", password_set: operation }));
      await fs.writeFile(path.join(item.directory, "password-set-state.json"), JSON.stringify(operation));
      await fs.writeFile(path.join(item.directory, "password-add-result.json"), JSON.stringify({ version: 1,
        email: operation.email, operationId: name === "stale-result" ? crypto.randomUUID() : operation.operationId,
        confirmed: true, password: newPassword, added_at: new Date().toISOString() }));
    }
  }
  await start();
  if (serving) {
    console.log(`统一密码隔离演示：http://127.0.0.1:${port}`);
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
    assert.equal((await getJob("pending")).passwordSetState, "failed", "未提交的统一密码不能在重启后被随机密码替代");
    assert.equal((await getJob("recovered")).passwordSetState, "completed");
    assert.equal((await getJob("crash-recovered")).passwordSetState, "completed", "已确认的结果不能被旧的添加密码恢复逻辑提前删除");
    assert.equal((await getJob("stale-result")).passwordSetState, "failed");
    assert.notEqual((await getJob("stale-result")).loginMode, "password", "其他操作编号的结果不能覆盖当前凭据");
    const recovered = await (await request("/api/jobs/export-source", { ids: [fixtures.get("recovered").id] })).text();
    assert(recovered.includes(newPassword), "无授权文件或检查点时，也应恢复已确认的新密码");
    assert.equal(mutations.length, 0, "恢复过程不应重新提交改密");
    const legacyIds = ["legacy-one", "legacy-two", "existing"].map(name => fixtures.get(name).id);
    const legacy = await request("/api/jobs/add-password-batch", { ids: legacyIds });
    assert.equal(legacy.status, 200);
    const legacyData = await legacy.json();
    assert.equal(legacyData.started, 2);
    assert.equal(legacyData.skipped, 1, "原功能继续跳过已有密码账号");
    await complete(["legacy-one", "legacy-two"], job => job.status === "completed" && job.passwordAddedAt);
    assert.equal(accounts.get("legacy-one").length, 18);
    assert.notEqual(accounts.get("legacy-one"), accounts.get("legacy-two"), "原功能继续生成独立随机密码");
    assert.equal(accounts.get("existing"), oldPassword);

    const selected = ["existing", "passwordless", "untracked"];
    const ids = selected.map(name => fixtures.get(name).id);
    const before = mutations.length;
    assert.equal((await request("/api/jobs/set-password-batch", { ids, password: "short" })).status, 400);
    assert.equal(mutations.length, before, "密码校验失败时不能启动任何修改");
    const response = await request("/api/jobs/set-password-batch", { ids, password: newPassword });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).started, 3, "新功能应包括已有密码和无密码账号");
    assert.equal((await getJob("existing")).canAddPassword, false);
    assert.equal((await request("/api/jobs/set-password-batch", { ids, password: newPassword })).status, 409);
    await complete(selected, job => job.passwordSetState === "completed");
    selected.forEach(name => assert.equal(accounts.get(name), newPassword));
    assert(mutations.some(item => item.name === "passwordless" && item.mode === "add"));
    assert(mutations.some(item => item.name === "existing" && item.mode === "reset"));
    assert.deepEqual(mutations.filter(item => item.name === "untracked").map(item => item.mode), ["add", "reset"]);
    const exported = await (await request("/api/jobs/export-source", { ids })).text();
    selected.forEach(name => assert(exported.includes(`${name}@example.com----${newPassword}`)));
    assert.equal((await request("/api/jobs/add-password-batch", { ids })).status, 409, "新功能成功后原功能仍按已有密码规则跳过");

    const regressionNames = ["stored", "mfa", "flaky"];
    await request("/api/jobs/set-password-batch", { ids: regressionNames.map(name => fixtures.get(name).id), password: newPassword });
    await complete(regressionNames, job => job.passwordSetState === "completed");
    regressionNames.forEach(name => assert.equal(accounts.get(name), newPassword));
    assert(modes.filter(item => regressionNames.includes(item.account)).every(item => item.mode === "reset"), "统一改密不应先发起普通密码登录");
    assert.deepEqual(passwordChecks.map(item => item.name).sort(), ["mfa", "stored"]);
    assert(passwordChecks.every(item => item.password === oldPassword), "目标新密码不能被当作登录原密码");
    const mfaLogs = await (await request(`/api/jobs/${fixtures.get("mfa").id}/logs`)).json();
    assert(!mfaLogs.logs.includes("Password (q=quit):"));
    assert(mfaLogs.logs.includes("2FA"), "不能跳过平台要求的 2FA 验证");
    assert(!mfaLogs.logs.includes("Email OTP (r=resend, q=quit):"));
    assert.equal(pageRequests.get("flaky"), 2, "验证页网络中断只重试一次");
    for (const name of ["lost", "otp-only", "rejected", "blocked", "unexpected-email", "network", "http-error"]) {
      await request("/api/jobs/set-password-batch", { ids: [fixtures.get(name).id], password: newPassword });
      await complete([name], job => job.passwordSetState === "failed");
      const job = await getJob(name);
      if (["lost", "otp-only", "rejected", "blocked"].includes(name)) assert.match(job.passwordSetError, /原密码.*重新导入/);
      else if (name === "unexpected-email") assert.match(job.passwordSetError, /额外邮箱验证.*官方页面/);
      else {
        assert.match(job.passwordSetError, /打开密码验证页面失败/);
        assert.match(job.passwordSetError, /\/api\/accounts\/authorize/);
        assert.match(job.passwordSetError, name === "http-error" ? /HTTP 503/ : /连接中断/);
        assert.equal(pageRequests.get(name), 2);
      }
      assert(!job.passwordSetError.includes("private-state"));
      assert(!job.passwordSetError.includes("private-code"));
      assert(!job.passwordSetError.includes(newPassword));
      assert.equal(mutations.filter(item => item.name === name).length, 0);
      assert.equal(accounts.get(name), name === "rejected" ? "Actual_Old_Password_928!" : oldPassword);
    }

    const cancelId = fixtures.get("cancel").id;
    const countBeforeCancel = mutations.length;
    await request("/api/jobs/set-password-batch", { ids: [cancelId], password: "Canceled_Password_927!" });
    await until(async () => (await getJob("cancel")).status === "mfa_otp");
    await request(`/api/jobs/${cancelId}/cancel`, {});
    assert.equal((await getJob("cancel")).passwordSetState, "failed");
    assert.equal(accounts.get("cancel"), oldPassword);
    assert.equal(mutations.length, countBeforeCancel, "验证阶段取消不应提交新密码");

    for (const [name, state] of [["denied", "failed"], ["uncertain", "unknown"]]) {
      const id = fixtures.get(name).id;
      assert.equal((await request("/api/jobs/set-password-batch", { ids: [id], password: newPassword })).status, 200);
      await complete([name], job => job.passwordSetState === state);
      assert.equal(mutations.filter(item => item.name === name).length, 1, "异常提交不能自动重复发送");
      const source = await (await request("/api/jobs/export-source", { ids: [id] })).text();
      assert(source.includes(oldPassword), "未确认成功时不能覆盖原密码");
      const protocolLogs = await (await request(`/api/jobs/${id}/logs`)).json();
      assert(!protocolLogs.logs.includes(newPassword));
      assert(!protocolLogs.logs.includes(JSON.stringify(newPassword).slice(1, -1)));
    }
    const publicData = await (await request("/api/jobs")).text();
    assert(!publicData.includes(newPassword));
    for (const name of selected) {
      const metadata = await fs.readFile(path.join(fixtures.get(name).directory, "job-meta.json"), "utf8");
      assert(!metadata.includes(newPassword));
      assert(!metadata.includes(JSON.stringify(newPassword).slice(1, -1)));
    }

    await stop();
    await start();
    const restored = await (await request("/api/jobs/export-source", { ids })).text();
    selected.forEach(name => assert(restored.includes(`${name}@example.com----${newPassword}`)));
    assert.equal((await getJob("uncertain")).passwordSetState, "unknown");
    assert.equal((await getJob("uncertain")).autoRepairEligible, false);
    assert.equal(mutations.filter(item => item.name === "uncertain").length, 1);
    assert.equal(mailboxRequests.length, 0, "已配置邮箱收码接口的改密任务也不应读取邮箱");
    assert.equal(emailOtpRequests.filter(item => item.mode === "reset").length, 0, "改密不能发送或验证邮箱验证码");
    assert(emailOtpRequests.some(item => item.mode === "add"), "添加密码仍应完成平台要求的邮箱验证");
    assert.deepEqual(passwordChecks.map(item => item.name).sort(), ["cancel", "mfa", "rejected", "stored"]);
    assert(passwordChecks.every(item => item.password === oldPassword));
    console.log("统一密码测试通过：改密不读取邮箱、不等待邮箱验证码，保留原密码和 2FA 验证；覆盖添加、失败保护、取消、重启恢复与脱敏");
  }
} finally {
  await stop();
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}

async function fixture(name, hasPassword) {
  const id = crypto.randomUUID();
  const directory = path.join(root, id);
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", accounts: [{ credentials: { email: `${name}@example.com` } }] }));
  await fs.writeFile(path.join(directory, "job-meta.json"), JSON.stringify({ email: `${name}@example.com`, status: "completed", has_password: hasPassword,
    login_mode: hasPassword ? "password" : "email_otp", mail_api_url: hasPassword ? `${upstreamBase}/mail/${name}` : null }));
  if (hasPassword) {
    accounts.set(name, oldPassword);
    await fs.writeFile(path.join(directory, "password-add-result.json"), JSON.stringify({ version: 1, email: `${name}@example.com`, password: oldPassword, added_at: new Date().toISOString() }), { mode: 0o600 });
  }
  fixtures.set(name, { id, directory });
}

async function start() {
  child = spawn(process.execPath, ["src/console-server.mjs", "--port", String(port)], {
    cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: root, CHATGPT_BASE: upstreamBase, AUTH_BASE: upstreamBase,
      TOSUB2_TLS_PROFILE: "chrome142", TOSUB2_TEST_SENTINEL_TOKEN: "test-sentinel", TOSUB2_TEST_SENTINEL_SO_TOKEN: "test-so" },
  });
  child.stdout.on("data", data => { logs += data; });
  child.stderr.on("data", data => { logs += data; });
  childExit = new Promise(resolve => child.once("exit", resolve));
  await until(async () => {
    try {
      const data = await fetch(base + "/api/bootstrap").then(r => r.json());
      headers = { "content-type": "application/json", "x-console-token": data.token };
      return data.features.passwordSet;
    } catch { return false; }
  });
}

async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await childExit; }
}
function request(route, body) {
  return fetch(base + route, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function getJob(name) {
  const data = await (await request("/api/jobs/query", { emails: [`${name}@example.com`] })).json();
  return data.jobs.find(job => job.id === fixtures.get(name).id);
}
async function complete(names, done) {
  await until(async () => {
    let completeCount = 0;
    for (const name of names) {
      const job = await getJob(name);
      if (done(job)) { completeCount += 1; continue; }
      if (job.status === "email_otp") {
        assert.notEqual(modes.filter(item => item.account === name).at(-1)?.mode, "reset", `修改密码不应等待邮箱验证码：${name}`);
        const response = await request(`/api/jobs/${job.id}/input`, { action: "email_otp", value: "123456" });
        assert.equal(response.status, 200, await response.text());
      } else if (job.status === "mfa_otp") {
        const response = await request(`/api/jobs/${job.id}/input`, { action: "mfa_otp", value: "654321" });
        assert.equal(response.status, 200, await response.text());
      } else if (job.status === "password") {
        throw new Error(`统一改密不应重复索取密码：${name}`);
      } else if (["completed", "failed", "reauth_required"].includes(job.status)) {
        const output = await (await request(`/api/jobs/${job.id}/logs`)).json();
        throw new Error(`账号 ${name} 未达到预期结果：${JSON.stringify(job)}\n${output.logs}`);
      }
    }
    return completeCount === names.length;
  });
}
async function until(predicate) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`测试等待超时\n${logs.slice(-3000)}`);
}
async function availablePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
