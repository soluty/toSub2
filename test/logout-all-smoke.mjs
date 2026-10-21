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
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-logout-"));
const port = await availablePort();
const base = `http://127.0.0.1:${port}`;
const counts = new Map();
const signins = new Map();
const held = new Map();
const fixtures = new Map();
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
  const cookies = Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map(pair => pair.split("=")));
  const send = (status, data) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
  if (url.pathname === "/api/auth/session") {
    const name = cookies["session-account"];
    return send(200, name ? { user: { email: `${name}@example.com` }, accessToken: `private-web-token-${name}` } : {});
  }
  if (url.pathname === "/backend-api/accounts/logout_all") {
    assert.equal(req.method, "POST");
    assert.equal(body, "");
    const name = (req.headers.authorization || "").replace("Bearer private-web-token-", "");
    assert(fixtures.has(name) || name === "active");
    counts.set(name, (counts.get(name) || 0) + 1);
    if (name === "disconnect") return res.destroy();
    if (name === "denied") return send(403, { error: "private-upstream-detail" });
    if (name === "crash" || (name === "success" && !serving)) { held.set(name, res); return; }
    return send(200, { success: true });
  }
  if (url.pathname === "/api/v1/admin/accounts") {
    return send(200, { data: { items: [{ id: 91, platform: "openai", status: "error", credentials: { email: "success@example.com" } }], total: 1, pages: 1 } });
  }
  if (url.pathname === "/messages") return send(200, []);
  if (url.pathname === "/") {
    res.setHeader("set-cookie", "__Host-next-auth.csrf-token=test-csrf; Path=/");
    return res.end("<html>测试登录页面</html>");
  }
  if (url.pathname === "/api/auth/providers") return send(200, {});
  if (url.pathname === "/api/auth/csrf") return send(200, { csrfToken: "test-csrf" });
  if (url.pathname === "/api/auth/signin/openai") {
    const name = url.searchParams.get("login_hint").split("@")[0];
    signins.set(name, (signins.get(name) || 0) + 1);
    res.setHeader("set-cookie", `auth-account=${name}; Path=/`);
    return send(200, { url: `${upstreamBase}/email-verification` });
  }
  if (url.pathname === "/email-verification") return res.end("<html>邮箱验证码</html>");
  if (url.pathname === "/api/accounts/email-otp/validate") {
    assert.equal(JSON.parse(body).code, "123456");
    if (cookies["auth-account"] === "fresh") return send(200, {
      page: { type: "mfa_challenge" }, continue_url: `${upstreamBase}/mfa-challenge/test-factor`,
      "oai-client-auth-session": { mfa_factors: [{ factor_type: "totp", id: "test-factor" }] },
    });
    res.setHeader("set-cookie", [`session-account=${cookies["auth-account"]}; Path=/`, "__Secure-next-auth.session-token=test-session; Path=/"]);
    return send(200, { continue_url: `${upstreamBase}/web-callback`, page: { type: "external_url" } });
  }
  if (url.pathname === "/api/accounts/mfa/issue_challenge") return send(200, {});
  if (url.pathname === "/api/accounts/mfa/verify") {
    assert.equal(JSON.parse(body).code, "654321");
    res.setHeader("set-cookie", [`session-account=${cookies["auth-account"]}; Path=/`, "__Secure-next-auth.session-token=test-session; Path=/"]);
    return send(200, { continue_url: `${upstreamBase}/web-callback`, page: { type: "external_url" } });
  }
  if (url.pathname === "/web-callback") return res.writeHead(302, { location: `${upstreamBase}/` }).end();
  send(404, { error: "测试中出现了非预期请求" });
});

try {
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  for (const name of ["success", "disconnect", "denied", "mismatch", "fresh", "crash"]) await fixture(name);
  if (!serving) {
    for (const [name, state] of [["queued-logout", "preparing"], ["accepted-logout", "accepted"]]) {
      await fixture(name);
      const item = fixtures.get(name);
      const metadataPath = path.join(item.directory, "job-meta.json");
      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
      const operation = { version: 1, email: `${name}@example.com`, operationId: crypto.randomUUID(), state: "preparing", startedAt: new Date().toISOString() };
      await fs.writeFile(metadataPath, JSON.stringify({ ...metadata, status: "queued", queued_mode: "logout_all",
        last_operation_type: "logout_all", auto_repair_paused: true, logout_operation: operation }));
      await fs.writeFile(path.join(item.directory, "logout-all-result.json"), JSON.stringify({ ...operation, state }));
    }
  }
  await start();

  if (serving) {
    console.log(`隔离的账号安全演示页面：${base}`);
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
  assert.equal((await getJob(fixtures.get("queued-logout").id)).logout.state, "failed", "重启不能自动继续排队的登出操作");
  assert.equal((await getJob(fixtures.get("accepted-logout").id)).logout.state, "accepted", "远端已受理的落盘结果优先于旧元数据");
  await missing(fixtures.get("accepted-logout").checkpoint);
  assert.equal(counts.get("queued-logout") || 0, 0);
  assert.equal(counts.get("accepted-logout") || 0, 0);

  const success = fixtures.get("success");
  const operationId = crypto.randomUUID();
  assert.equal((await api(`/api/jobs/${success.id}/logout-all`, { operationId })).status, 400);
  const [first, duplicate] = await Promise.all([logout(success.id, operationId), logout(success.id, operationId)]);
  assert.equal(first.status, 202);
  assert.equal(duplicate.status, 202);
  await until(() => held.has("success"));
  assert.equal(counts.get("success"), 1, "重复操作编号只能发送一次登出请求");
  let job = await getJob(success.id);
  assert.equal(job.autoRepairPaused, true);
  assert.equal(job.autoRepairEligible, false);
  assert.equal((await api(`/api/jobs/${success.id}/relogin`, {})).status, 409);
  assert.equal((await api(`/api/jobs/${success.id}/resume-auto-repair`, { confirmed: true })).status, 409);
  assert.equal((await api("/api/jobs/delete-batch", { ids: [success.id] })).status, 409);
  assert.equal((await api("/api/jobs", { email: "success@example.com", password: "changed" })).status, 409);
  held.get("success").writeHead(200, { "content-type": "application/json" }).end('{"success":true}');
  job = await waitJob(success.id, value => value.logout?.state === "accepted");
  assert.equal(job.canDownload, true, "设备登出不能冒充 OAuth 授权撤销");
  await missing(success.checkpoint);
  assert.equal((await logout(success.id, operationId)).status, 202);
  assert.equal(counts.get("success"), 1, "完成后重复操作编号也不得重发");

  for (const [name, expected] of [["disconnect", "unknown"], ["denied", "failed"], ["mismatch", "failed"]]) {
    const item = fixtures.get(name);
    assert.equal((await logout(item.id)).status, 202);
    job = await waitJob(item.id, value => value.logout?.state === expected);
    assert.equal(job.autoRepairPaused, true);
    assert.equal(counts.get(name) || 0, name === "mismatch" ? 0 : 1);
    if (expected === "unknown") await missing(item.checkpoint);
    else await fs.access(item.checkpoint);
  }

  const fresh = fixtures.get("fresh");
  await logout(fresh.id);
  await waitJob(fresh.id, value => value.status === "email_otp");
  assert.equal((await api(`/api/jobs/${fresh.id}/input`, { action: "email_otp", value: "123456" })).status, 200);
  await waitJob(fresh.id, value => value.status === "mfa_otp");
  assert.equal((await api(`/api/jobs/${fresh.id}/input`, { action: "mfa_otp", value: "654321" })).status, 200);
  await waitJob(fresh.id, value => value.logout?.state === "accepted");
  assert.equal(signins.get("fresh"), 1, "无检查点时应完成新的邮箱验证");

  const created = await (await api("/api/jobs", { email: "active@example.com" })).json();
  await waitJob(created.job.id, value => value.status === "email_otp");
  await logout(created.job.id);
  await until(() => signins.get("active") === 2);
  await waitJob(created.job.id, value => value.status === "email_otp");
  await api(`/api/jobs/${created.job.id}/cancel`, {});
  job = await waitJob(created.job.id, value => value.logout?.state === "failed");
  assert.equal(job.autoRepairPaused, true);
  assert.equal(counts.get("active") || 0, 0, "取消验证不得发送登出请求");
  const firstActiveId = JSON.parse(await fs.readFile(path.join(root, created.job.id, "job-meta.json"), "utf8")).logout_operation.operationId;
  await logout(created.job.id);
  await until(() => signins.get("active") === 3);
  await api(`/api/jobs/${created.job.id}/cancel`, {});
  assert.equal((await logout(created.job.id, firstActiveId)).status, 202);
  assert.equal(signins.get("active"), 3, "较早的操作编号也不能在后续操作完成后重新执行");

  const crash = fixtures.get("crash");
  await logout(crash.id);
  await until(() => held.has("crash"));
  // 模拟请求已经发出后服务异常退出，再断开模拟服务器的连接。
  child.kill("SIGKILL");
  await childExit;
  held.get("crash").destroy();
  await start();
  job = await getJob(crash.id);
  assert.equal(job.logout.state, "unknown");
  assert.equal(job.autoRepairPaused, true);
  await missing(crash.checkpoint);
  assert.equal(counts.get("crash"), 1, "重启后不能自动重发结果未知的请求");
  job = await getJob(success.id);
  assert.equal(job.logout.state, "accepted");
  assert.equal(job.autoRepairPaused, true);

  const monitorResponse = await api("/api/sub2api/monitor", { enabled: true, config: { baseUrl: upstreamBase, adminApiKey: "test-monitor-key", groupIds: [] } });
  assert.equal(monitorResponse.status, 200, await monitorResponse.text());
  const monitor = await api("/api/sub2api/monitor/check", {});
  assert.equal(monitor.status, 200, await monitor.text());
  assert.equal(signins.get("success") || 0, 0, "号池巡检不能重新登录被暂停的账号");
  assert.equal((await api(`/api/jobs/${success.id}/resume-auto-repair`, {})).status, 400);
  assert.equal((await api(`/api/jobs/${success.id}/resume-auto-repair`, { confirmed: true })).status, 200);
  assert.equal((await getJob(success.id)).autoRepairPaused, false);
  await api("/api/sub2api/monitor", { enabled: false });

  const accountLogs = await (await api(`/api/jobs/${fixtures.get("denied").id}/logs`)).json();
  assert(!JSON.stringify(accountLogs).includes("private-upstream-detail"));
  const metadata = await fs.readFile(path.join(success.directory, "job-meta.json"), "utf8");
  assert(!metadata.includes("private-web-token"));
  assert(!logs.includes("private-web-token"));
  console.log("登出测试通过：身份匹配、重复提交、验证与取消、异常响应、重启恢复、巡检暂停和日志脱敏");
  }
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await childExit;
  }
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}

async function fixture(name) {
  const id = crypto.randomUUID();
  const directory = path.join(root, id);
  const checkpoint = path.join(directory, "login-checkpoint.json");
  const email = `${name}@example.com`;
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", accounts: [{ credentials: { email, refresh_token: "test-oauth-refresh" } }] }));
  await fs.writeFile(path.join(directory, "job-meta.json"), JSON.stringify({
    email, status: "completed", result_saved: true, last_auth_automated: true,
    last_auth_requirements: { emailOtp: false }, mail_api_url: `${upstreamBase}/messages`,
  }));
  if (name !== "fresh") await fs.writeFile(checkpoint, JSON.stringify({
    version: 1, email, stage: "email_verified", cookies: [
      { name: "session-account", value: name === "mismatch" ? "another-account" : name, domain: "127.0.0.1", path: "/" },
    ],
  }));
  fixtures.set(name, { id, directory, checkpoint });
}

async function start() {
  child = spawn(process.execPath, ["src/console-server.mjs", "--port", String(port)], {
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: root, CHATGPT_BASE: upstreamBase, AUTH_BASE: upstreamBase,
      TOSUB2_TLS_PROFILE: "chrome142", TOSUB2_TEST_SENTINEL_TOKEN: "test-sentinel", TOSUB2_TEST_SENTINEL_SO_TOKEN: "test-so" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  childExit = new Promise(resolve => child.once("exit", resolve));
  child.stdout.on("data", data => { logs += data; });
  child.stderr.on("data", data => { logs += data; });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(logs);
    try {
      const data = await fetch(`${base}/api/bootstrap`).then(r => r.json());
      headers = { "content-type": "application/json", "x-console-token": data.token };
      return data.features.logoutAllDevices;
    } catch { return false; }
  });
}

function api(route, body) {
  return fetch(base + route, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function logout(id, operationId = crypto.randomUUID()) {
  return api(`/api/jobs/${id}/logout-all`, { confirmed: true, operationId });
}
async function getJob(id) {
  const data = await (await api("/api/jobs")).json();
  return data.jobs.find(job => job.id === id);
}
async function waitJob(id, predicate) {
  let job;
  try {
    await until(async () => { job = await getJob(id); return job && predicate(job); });
  } catch (error) {
    const protocol = await (await api(`/api/jobs/${id}/logs`)).json();
    throw new Error(`${error.message}\n${JSON.stringify(job)}\n${protocol.logs}`);
  }
  return job;
}
async function until(predicate) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`测试等待超时\n${logs.slice(-4000)}`);
}
async function missing(file) {
  await assert.rejects(fs.access(file), { code: "ENOENT" });
}
async function availablePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const selected = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return selected;
}
