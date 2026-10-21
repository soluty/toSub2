import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform === "linux") {
  await verifyPersistence(false);
  await verifyPersistence(true);
  console.log("Linux 持久化测试通过：默认/自定义目录、导入、重启、更新、删除、文件权限与损坏保护");
} else {
  console.log("当前非 Linux，跳过 Linux 服务持久化测试（文件存储单元测试仍运行）");
}

async function verifyPersistence(customRoot) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-linux-persistence-"));
  const outputRoot = path.join(root, "output");
  const credentialRoot = customRoot ? path.join(root, "private") : path.join(outputRoot, ".credentials");
  const credentialFile = path.join(credentialRoot, "credentials.json");
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const accounts = ["persist-first@example.com", "persist-second@example.com"].map(email => ({
    id: crypto.randomUUID(), email,
    password: ' Imported_密码$"927! ',
    totpSecret: "JBSWY3DPEHPK3PXP",
    proxyUrl: "http://test:proxy-secret@127.0.0.1:9/",
    mailApiUrl: "http://127.0.0.1:9/messages/test-mail-token",
  }));
  let child;
  let childExit;
  let headers;
  let logs = "";
  try {
    // 已完成的本地任务只更新资料，不会向真实账号或代理发起请求。
    for (const account of accounts) {
      const directory = path.join(outputRoot, account.id);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "job-meta.json"), JSON.stringify({ email: account.email, status: "completed" }));
      await fs.writeFile(path.join(directory, "sub2api-import-oauth.json"), JSON.stringify({
        type: "sub2api-data", accounts: [{ credentials: { email: account.email } }],
      }));
    }
    await start();
    await Promise.all(accounts.map(async account => {
      const response = await request("/api/jobs", { ...account, email: account.email.toUpperCase() });
      assert.equal(response.status, 200, await response.text());
    }));
    assert.equal((await fs.stat(credentialRoot)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(credentialFile)).mode & 0o777, 0o600);
    await verifySavedAccounts();
    await stop();
    await start();
    await verifySavedAccounts();

    // 文件损坏必须报实际存储错误，不能伪装成账号忙碌或覆盖旧文件。
    const backup = await fs.readFile(credentialFile, "utf8");
    await fs.writeFile(credentialFile, "{damaged");
    const failed = await request("/api/jobs/set-password-batch", {
      ids: [accounts[0].id], password: "Unused_Uniform_927!", proxyUrl: accounts[0].proxyUrl,
    });
    assert.equal(failed.status, 500);
    assert.match((await failed.json()).error, /Linux 凭据文件格式损坏/);
    assert.equal(await fs.readFile(credentialFile, "utf8"), "{damaged");
    await fs.writeFile(credentialFile, backup);

    accounts[0].password = "Changed_Password_928!";
    accounts[0].totpSecret = "NB2W45DFOIZAQWER";
    accounts[0].proxyUrl = "socks5h://updated:another-secret@127.0.0.1:9";
    const updated = await request("/api/jobs", accounts[0]);
    assert.equal(updated.status, 200, await updated.text());
    await stop();
    await start();
    await verifySavedAccounts();
    const removed = await request("/api/jobs/delete-batch", { ids: [accounts[0].id] });
    assert.equal(removed.status, 200, await removed.text());
    const saved = JSON.parse(await fs.readFile(credentialFile, "utf8"));
    assert.equal(Object.hasOwn(saved.accounts, accounts[0].email), false);
    assert.equal(saved.accounts[accounts[1].email].password, accounts[1].password);
    await stop();
    await start();
    const page = await (await request("/api/jobs")).json();
    assert.deepEqual(page.jobs.map(job => job.id), [accounts[1].id]);
  } finally {
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  }

  async function verifySavedAccounts() {
    const page = await (await request("/api/jobs")).json();
    const saved = JSON.parse(await fs.readFile(credentialFile, "utf8"));
    const exported = await (await request("/api/jobs/export-source", { ids: accounts.map(account => account.id) })).text();
    for (const account of accounts) {
      const job = page.jobs.find(item => item.id === account.id);
      assert.deepEqual(job.missingCredentials, []);
      assert.equal(job.loginMode, "password");
      assert.equal(job.hasTotpKey, true);
      assert.equal(job.autoEmailOtp, true);
      assert.deepEqual(saved.accounts[account.email], {
        password: account.password, totpSecret: account.totpSecret, proxyUrl: account.proxyUrl,
      });
      assert(exported.includes([account.email, account.password, account.mailApiUrl, account.totpSecret].join("----")));
      const metadata = await fs.readFile(path.join(outputRoot, account.id, "job-meta.json"), "utf8");
      const protocolLogs = await (await request(`/api/jobs/${account.id}/logs`)).text();
      for (const secret of [account.password, account.totpSecret, account.proxyUrl]) {
        const serialized = JSON.stringify(secret).slice(1, -1);
        for (const visible of [JSON.stringify(page), metadata, protocolLogs, logs]) assert(!visible.includes(serialized));
      }
    }
    assert.deepEqual(await fs.readdir(credentialRoot), ["credentials.json"]);
  }

  async function start() {
    child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ONBOARDING_OUTPUT_ROOT: outputRoot,
        TOSUB2_LINUX_CREDENTIAL_ROOT: customRoot ? credentialRoot : "",
        ONBOARDING_PROTOCOL_SCRIPT: path.join(projectRoot, "test", "mock-protocol-login.mjs") },
    });
    child.stdout.on("data", data => { logs += data; });
    child.stderr.on("data", data => { logs += data; });
    childExit = new Promise(resolve => child.once("exit", resolve));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const bootstrap = await fetch(base + "/api/bootstrap").then(response => response.json());
        headers = { "content-type": "application/json", "x-console-token": bootstrap.token };
        return;
      } catch {}
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`服务启动失败：${logs.slice(-2000)}`);
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await childExit;
    }
  }
  function request(route, body) {
    return fetch(base + route, { method: body === undefined ? "GET" : "POST", headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
}
