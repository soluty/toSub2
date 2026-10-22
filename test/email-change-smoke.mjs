import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-email-smoke-"));
const credentialRoot = path.join(root, ".credentials");
const credentialFile = path.join(credentialRoot, "credentials.json");
const port = await availablePort();
const base = `http://127.0.0.1:${port}`;
const password = "Email_Test_Password_927!";
const oldSecret = "JBSWY3DPEHPK3PXP";
const otp = "654321";
const fixtures = new Map(), accounts = new Map(), requests = [];
const remoteAccounts = new Map();
const credentials = { version: 1, accounts: {} };
const annotations = { type: "team_5x", group: "测试分组", tags: ["保留标签"], note: "保留备注" };
const serving = process.argv.includes("--serve");
let upstreamBase, child, childExit, headers, credentialBackup;
let logs = "";
const upstream = http.createServer((req, res) => { void handleUpstream(req, res).catch(error => { logs += error.stack; res.writeHead(500).end(); }); });

async function handleUpstream(req, res) {
  const url = new URL(req.url, upstreamBase);
  let body = "";
  for await (const chunk of req) body += chunk;
  const cookie = Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map(item => item.split("=")));
  const email = decodeURIComponent(cookie.account || "");
  const name = email.split("@")[0].replace(/-new$/, "");
  const account = accounts.get(name);
  const json = (status, data) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
  if (url.pathname === "/api/v1/admin/accounts") {
    assert.equal(req.method, "GET", "同步不能创建远端账号");
    assert.equal(url.searchParams.has("status"), false, "换绑关联应包含所有状态的账号");
    return json(200, { data: { items: [...remoteAccounts.values()], pages: 1 } });
  }
  if (/^\/api\/v1\/admin\/accounts\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split("/").at(-1)), remote = remoteAccounts.get(id);
    if (req.method === "GET") return json(200, { data: remote });
    assert.equal(req.method, "PUT");
    const changes = JSON.parse(body);
    assert.deepEqual(Object.keys(changes).sort(), ["credentials", "extra"], "同步不改变远端状态或调度开关");
    const key = remote.name.split("@")[0];
    requests.push({ name: key, action: "sync" });
    if (key === "sync-fail" && !accounts.get(key).retry) return json(503, {});
    remoteAccounts.set(id, { ...remote, ...changes });
    return json(200, { data: remoteAccounts.get(id) });
  }
  if (url.pathname === "/test/authorization") {
    const target = url.searchParams.get("email");
    const key = target.split("@")[0].replace(/-new$/, "");
    const item = accounts.get(key);
    requests.push({ name: key, action: "authorize" });
    if (key === "oauth-fail" && !item.retry) return json(503, {});
    return json(200, { email: key === "oauth-wrong" && !item.retry ? "wrong@example.com" : target, userId: `auth-${key}` });
  }
  if (url.pathname.startsWith("/mail/")) {
    const key = url.pathname.split("/").at(-1);
    assert.equal(req.method, "GET", "新邮箱收码不能沿用原 POST 配置");
    requests.push({ name: key, action: "mail" });
    return json(200, { messages: [{ id: "old-message", subject: "Your verification code is 111111", date: "2020-01-01T00:00:00Z" },
      ...(accounts.get(key).begun ? [{ id: "new-message", subject: `Your verification code is ${otp}`, date: new Date().toISOString() }] : [])] });
  }
  if (url.pathname === "/") {
    res.setHeader("set-cookie", "__Host-next-auth.csrf-token=test-csrf; Path=/");
    return res.end('<html><script>window.state={"accessToken":"test-session"}</script></html>');
  }
  if (url.pathname === "/api/auth/providers") return json(200, {});
  if (url.pathname === "/api/auth/csrf") return json(200, { csrfToken: "test-csrf" });
  if (url.pathname === "/api/auth/signin/openai") {
    const target = url.searchParams.get("login_hint");
    requests.push({ name: target.split("@")[0].replace(/-new$/, ""), action: "login", email: target });
    res.setHeader("set-cookie", `account=${encodeURIComponent(target)}; Path=/`);
    return json(200, { url: `${upstreamBase}/log-in/password` });
  }
  if (url.pathname === "/log-in/password") return res.end('<html><input type="password"></html>');
  if (url.pathname === "/api/accounts/password/verify") {
    assert.equal(JSON.parse(body).password, password);
    if (name === "profile" || (name === "unregistered" && email !== account.email)) return json(200, { page: { type: "account_profile" }, continue_url: `${upstreamBase}/about-you` });
    return json(200, { page: { type: "mfa_challenge" }, continue_url: `${upstreamBase}/mfa-challenge/factor`,
      "oai-client-auth-session": { mfa_factors: [{ factor_type: "totp", id: "original-factor" }] } });
  }
  if (url.pathname === "/api/accounts/create_account") { requests.push({ name, action: "signup" }); return json(500, {}); }
  if (url.pathname === "/api/accounts/mfa/issue_challenge") return json(200, {});
  if (url.pathname === "/api/accounts/mfa/verify") {
    assert.match(JSON.parse(body).code, /^\d{6}$/);
    requests.push({ name, action: "mfa-login" });
    return json(200, { continue_url: `${upstreamBase}/web-callback`, page: { type: "external_url" } });
  }
  if (url.pathname === "/web-callback") return res.writeHead(302, { location: `${upstreamBase}/` }).end();
  if (url.pathname === "/api/auth/session") {
    const mismatch = (name === "wrong-id") || (name === "identity-mismatch" && account.email.endsWith("-new@example.com"));
    const currentEmail = name === "cached" ? email : account.email;
    return json(200, { user: { email: name === "wrong-id" ? "other@example.com" : currentEmail, id: mismatch ? "other-user" : `user-${name}` },
      accessToken: `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { user_id: `auth-${name}` } })).toString("base64url")}.signature` });
  }
  if (url.pathname.endsWith("/change_email/eligibility")) {
    requests.push({ name, action: "eligibility" });
    if (name === "denied") return json(200, { eligible: false, reason: "account_not_supported" });
    if (name === "unclear") return json(200, {});
    if (name === "check-error") return json(403, { error: password });
    return json(200, { eligible: true });
  }
  if (url.pathname.endsWith("/mfa_info")) { requests.push({ name, action: "mfa-info" }); return json(200, { mfa_enabled: true }); }
  if (url.pathname.endsWith("/change_email/begin")) {
    assert.equal(req.method, "POST");
    requests.push({ name, action: "begin" });
    account.begun = true;
    return json(200, { success: true });
  }
  if (url.pathname.endsWith("/change_email/verify")) {
    requests.push({ name, action: "verify" });
    const submitted = JSON.parse(body);
    if (submitted.code !== otp) return json(400, { error: { code: "invalid_code" } });
    if (name !== "unregistered") account.email = submitted.email;
    if (name === "lost" || name === "unregistered") return res.destroy();
    if (name === "cancel-submit") return;
    if (name === "persist-fail") {
      credentialBackup = await fs.readFile(credentialFile, "utf8");
      await fs.writeFile(credentialFile, "{broken");
    }
    return json(200, { success: true });
  }
  return json(404, { error: `未预期测试请求：${url.pathname}` });
}

try {
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  const names = serving ? ["manual", "denied", "automatic", "unclear"] : ["manual", "denied", "unclear", "check-error", "wrong-id", "profile",
    "automatic", "cached", "lost", "identity-mismatch", "cancel", "cancel-submit", "persist-fail", "oauth-fail", "oauth-wrong", "unregistered", "sync-ok", "sync-fail", "sync-many"];
  for (const name of names) await fixture(name);
  await fs.mkdir(credentialRoot, { recursive: true });
  await fs.writeFile(credentialFile, JSON.stringify(credentials), { mode: 0o600 });
  if (!serving) {
    for (const [id, name] of [[71, "sync-ok"], [72, "sync-fail"], [73, "sync-many"], [74, "sync-many"]]) {
      remoteAccounts.set(id, { id, platform: "openai", name: `${name}@example.com`, status: "error", schedulable: false,
        credentials: { email: `${name}@example.com` }, extra: { preserved: true } });
    }
    await fs.writeFile(path.join(root, "sub2api-monitor.json"), JSON.stringify({ version: 1, enabled: false,
      config: { baseUrl: upstreamBase, adminApiKey: "test-admin-key" } }), { mode: 0o600 });
  }
  await start();
  if (serving) {
    console.log(`换绑邮箱隔离演示：${base}`);
    await new Promise(resolve => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
  } else {
    assert.equal((await change("manual", { newEmail: "MANUAL@example.com" })).status, 400);
    assert.equal((await change("manual", { newEmail: "denied@example.com" })).status, 409);
    for (const name of ["denied", "unclear", "check-error", "wrong-id", "profile"]) {
      assert.equal((await change(name, { mailApiUrl: `${upstreamBase}/mail/${name}?private=mail-key` })).status, 202);
      const job = await settled(name, "failed");
      assert.equal(job.email, `${name}@example.com`);
      assert.equal(job.canChangeEmail, true);
      const actions = actionsFor(name);
      for (const forbidden of ["mail", "mfa-info", "begin", "verify", "signup"]) assert(!actions.includes(forbidden), `${name} 资格早检不得执行 ${forbidden}`);
      if (["denied", "unclear", "check-error"].includes(name)) assert(actions.includes("eligibility"));
      assert(!job.emailChange.error.includes(password));
    }
    assert.equal((await change("manual")).status, 202);
    await stage("manual", "email_change_otp");
    assert.equal((await request("/api/jobs", { email: "manual-new@example.com" })).status, 409, "换绑过程中预留新邮箱");
    assert.equal((await change("cached", { newEmail: "manual-new@example.com" })).status, 409);
    assert.equal((await action("manual", "relogin", {})).status, 409);
    assert.equal((await action("manual", "input", { action: "email_otp", value: otp })).status, 409);
    await inputCode("manual", "111111");
    await stage("manual", "email_change_otp");
    await inputCode("manual", otp);
    await settled("manual", "completed");
    await assertMigrated("manual");

    assert.equal((await change("automatic", { mailApiUrl: `${upstreamBase}/mail/automatic?private=mail-key` })).status, 202);
    await settled("automatic", "completed");
    await assertMigrated("automatic");
    const automaticActions = actionsFor("automatic");
    assert(automaticActions.indexOf("eligibility") < automaticActions.indexOf("mail"));
    assert(automaticActions.indexOf("mail") < automaticActions.indexOf("begin"));
    assert.equal(automaticActions.filter(value => value === "verify").length, 1, "旧验证码不能被自动提交");
    const automaticMetadata = await readJson(path.join(fixtures.get("automatic").directory, "job-meta.json"));
    assert.equal(automaticMetadata.mail_request_method, "GET");

    for (const name of ["cached", "lost", "identity-mismatch", "oauth-fail", "oauth-wrong", "unregistered"]) {
      await change(name); await stage(name, "email_change_otp"); await inputCode(name, otp);
      await settled(name, ["lost", "identity-mismatch", "unregistered"].includes(name) ? "unknown" : name.startsWith("oauth-") ? "authorization_pending" : "completed");
    }
    assert(requests.some(item => item.name === "cached" && item.action === "login" && item.email === "cached-new@example.com"), "旧 session 邮箱未更新时重新核对新邮箱");
    assert.equal((await getJob("identity-mismatch")).email, "identity-mismatch@example.com");
    assert.equal((await getJob("identity-mismatch")).canRetry, false);
    for (const name of ["oauth-fail", "oauth-wrong"]) {
      assert.equal((await getJob(name)).canDownload, false);
      accounts.get(name).retry = true;
      await action(name, "retry", {});
      await settled(name, "completed");
    }
    await action("unregistered", "verify-email-change", {});
    await settled("unregistered", "unknown");
    assert(!actionsFor("unregistered").includes("signup"), "核实失败不能注册目标邮箱的新账号");

    await change("cancel"); await stage("cancel", "email_change_otp");
    await action("cancel", "cancel", {}); await settled("cancel", "failed");
    assert(!actionsFor("cancel").includes("verify"));
    await change("cancel-submit"); await stage("cancel-submit", "email_change_otp"); await inputCode("cancel-submit", otp);
    await until(() => actionsFor("cancel-submit").includes("verify"));
    await action("cancel-submit", "cancel", {}); await settled("cancel-submit", "unknown");

    await change("persist-fail"); await stage("persist-fail", "email_change_otp"); await inputCode("persist-fail", otp);
    await settled("persist-fail", "migration_failed");
    await fs.writeFile(credentialFile, credentialBackup, { mode: 0o600 });
    await action("persist-fail", "finish-email-change", {});
    await settled("persist-fail", "completed");
    await assertMigrated("persist-fail");

    await change("sync-many", { syncSub2api: true }); await settled("sync-many", "failed");
    assert(!actionsFor("sync-many").includes("begin"), "多个关联需在发码前停止");
    for (const name of ["sync-ok", "sync-fail"]) {
      await change(name, { syncSub2api: true }); await stage(name, "email_change_otp"); await inputCode(name, otp);
      await settled(name, name === "sync-ok" ? "completed" : "sync_pending");
    }
    assert.equal(remoteAccounts.get(71).credentials.email, "sync-ok-new@example.com");
    assert.equal(remoteAccounts.get(71).status, "error");
    assert.equal(remoteAccounts.get(71).schedulable, false);
    assert.equal(remoteAccounts.get(71).extra.preserved, true);
    accounts.get("sync-fail").retry = true;
    await action("sync-fail", "finish-email-change", {}); await settled("sync-fail", "completed");
    assert.equal(remoteAccounts.get(72).credentials.email, "sync-fail-new@example.com");
    assert.equal(actionsFor("sync-fail").filter(value => value === "verify").length, 1);

    // 已清理旧键后，原地址被另一账号重新使用，恢复时不能再次删除它的凭据。
    const saved = await readJson(credentialFile);
    saved.accounts["manual@example.com"] = { password: "new-owner-password", totpSecret: "", proxyUrl: "" };
    await fs.writeFile(credentialFile, JSON.stringify(saved), { mode: 0o600 });
    const beforeRestart = requests.length;
    await stop(); await start();
    assert.equal(requests.length, beforeRestart, "重启不能自动重发换绑或核实请求");
    assert.equal((await readJson(credentialFile)).accounts["manual@example.com"].password, "new-owner-password");
    for (const name of ["lost", "cancel-submit"]) {
      assert.equal((await getJob(name)).emailChange.state, "unknown");
      await action(name, "verify-email-change", {}); await settled(name, "completed");
      assert.equal(actionsFor(name).filter(value => value === "verify").length, 1);
    }
    for (const [name, item] of fixtures) {
      const publicData = JSON.stringify(await getJob(name));
      const log = JSON.stringify(await (await action(name, "logs")).json());
      const metadata = await fs.readFile(path.join(item.directory, "job-meta.json"), "utf8");
      for (const secret of [password, oldSecret, otp, "signature", "test-new-access"]) {
        assert(!publicData.includes(secret), `公开数据泄漏 ${name}`);
        assert(!log.includes(secret), `日志泄漏 ${name}`);
        assert(!metadata.includes(secret), `元数据泄漏 ${name}`);
      }
      assert(!publicData.includes("mail-key"));
      if ((await getJob(name)).emailChange?.state !== "completed") assert(!metadata.includes("mail-key"));
    }
    console.log("换绑邮箱集成测试通过：真实协议早检、原 2FA、手动/自动收码、互斥、身份连续性、迁移、授权失败、取消、重启和脱敏");
  }
} finally {
  await stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}

async function fixture(name) {
  const id = crypto.randomUUID(), directory = path.join(root, id);
  const email = `${name}@example.com`;
  fixtures.set(name, { id, directory }); accounts.set(name, { email, begun: false });
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", accounts: [{ credentials: { email } }] }));
  await fs.writeFile(path.join(directory, "job-meta.json"), JSON.stringify({ email, status: "completed", has_password: true,
    has_totp_key: true, totp_known_enabled: true, login_mode: "password", account_annotations: annotations }));
  credentials.accounts[email] = { password, totpSecret: oldSecret, proxyUrl: "" };
}
async function start() {
  child = spawn(process.execPath, ["src/console-server.mjs", "--port", String(port)], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: root, TOSUB2_LINUX_CREDENTIAL_ROOT: credentialRoot,
      ONBOARDING_PROTOCOL_SCRIPT: path.join(projectRoot, "test/mock-email-change-authorization.mjs"),
      CHATGPT_BASE: upstreamBase, AUTH_BASE: upstreamBase, TOSUB2_TEST_SENTINEL_TOKEN: "test-sentinel", TOSUB2_TEST_SENTINEL_SO_TOKEN: "test-so" } });
  child.stdout.on("data", data => { logs += data; }); child.stderr.on("data", data => { logs += data; });
  childExit = new Promise(resolve => child.once("exit", resolve));
  await until(async () => { try {
    const data = await fetch(base + "/api/bootstrap").then(r => r.json());
    headers = { "content-type": "application/json", "x-console-token": data.token }; return data.features.emailChange;
  } catch { return false; } });
}
async function stop() { if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await childExit; } }
function request(route, body) { return fetch(base + route, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
function action(name, route, body) { return request(`/api/jobs/${fixtures.get(name).id}/${route}`, body); }
function change(name, options = {}) { return action(name, "change-email", { newEmail: `${name}-new@example.com`, confirmed: true, ...options }); }
async function getJob(name) { return (await (await request("/api/jobs?limit=100")).json()).jobs.find(job => job.id === fixtures.get(name).id); }
async function inputCode(name, value) { assert.equal((await action(name, "input", { action: "new_email_otp", value })).status, 200); }
async function stage(name, status) { await until(async () => (await getJob(name)).status === status, name); }
async function settled(name, state) {
  let job;
  await until(async () => { job = await getJob(name); return job.emailChange?.state === state && ["completed", "reauth_required"].includes(job.status)
    && (state !== "completed" || job.canChangeEmail); }, name);
  return job;
}
function actionsFor(name) { return requests.filter(item => item.name === name).map(item => item.action); }
function readJson(file) { return fs.readFile(file, "utf8").then(JSON.parse); }
async function assertMigrated(name) {
  const job = await getJob(name), item = fixtures.get(name);
  assert.equal(job.id, item.id); assert.equal(job.email, `${name}-new@example.com`); assert.deepEqual(job.annotations, annotations);
  const saved = await readJson(credentialFile);
  assert.equal(saved.accounts[job.email].password, password); assert.equal(saved.accounts[job.email].totpSecret, oldSecret);
  assert.equal(saved.accounts[`${name}@example.com`], undefined);
  const archive = await readJson(path.join(item.directory, "email-change-old-oauth.json"));
  assert.equal(archive.accounts[0].credentials.email, `${name}@example.com`);
  const output = await readJson(path.join(item.directory, "sub2api-import-oauth.json"));
  assert.equal(output.accounts[0].credentials.email, job.email);
}
async function until(predicate, name) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  const job = name ? await getJob(name) : {};
  const jobLog = name ? await (await action(name, "logs")).text() : "";
  throw new Error(`测试等待超时 ${name || "启动"}: ${JSON.stringify(job)}\n${jobLog.slice(-3000)}\n${logs.slice(-1000)}`);
}
async function availablePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const number = server.address().port; await new Promise(resolve => server.close(resolve)); return number;
}
