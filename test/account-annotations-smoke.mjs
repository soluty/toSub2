import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-account-annotations-"));
const port = await availablePort();
const base = `http://127.0.0.1:${port}`;
const fixtures = new Map();
const serving = process.argv.includes("--serve");
let child, childExit, headers;
let logs = "";

try {
  await fixture("plus", "plus", { group: "日常使用", tags: ["主力号"], note: "月底检查续费" });
  await fixture("five", "pro", { type: "5x", group: "日常使用", tags: ["代码项目"], note: "前端开发用" });
  await fixture("team", "business", { group: "团队账号", tags: ["协作"], note: "产品组共享工作区" });
  await fixture("team-five", "self_serve_business_prolite", { group: "团队账号" });
  await fixture("twenty", "pro", { type: "20x", group: "备用账号", tags: ["新入库", "高额度"], note: "10 月采购，待分配" });
  await fixture("unmarked", "", {});
  if (!serving) {
    await fixture("pro", "pro", {});
    for (let i = 0; i < 25; i++) await fixture(`paged-${i}`, "plus", { group: "跨页测试", tags: ["批次 A"], note: `续费批次 ${i}` });
    await fixture("checkpoint", "", { type: "team", group: "恢复测试", note: "检查点账号" }, "checkpoint");
    await fixture("checkpoint-team-five", "team_5x", {}, "checkpoint");
    await fixture("unrecognized-team", "self_serve_business_unconfirmed", {});
    await fixture("metadata", "", { type: "free", group: "恢复测试", tags: ["历史"] }, "metadata");
    await fixture("invalid-metadata", "", { type: "not-a-plan", group: {}, tags: ["可恢复"], note: "保留有效字段" });
  }
  await start();
  if (serving) {
    console.log(`账号标记隔离演示：${base}`);
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
    assert.equal((await getJob("plus")).accountType, "plus");
    assert.equal((await getJob("plus")).accountTypeSource, "authorization");
    assert.equal((await getJob("five")).accountType, "5x");
    assert.equal((await getJob("five")).accountTypeSource, "manual");
    assert.equal((await getJob("team")).accountType, "team");
    assert.equal((await getJob("team-five")).accountType, "team_5x", "应识别实际授权记录中的 Team 5x 标识");
    assert.equal((await getJob("team-five")).accountTypeSource, "authorization");
    assert.equal((await getJob("checkpoint-team-five")).accountType, "team_5x", "检查点账号应恢复已保存的识别结果");
    assert.equal((await getJob("unrecognized-team")).accountType, "unknown", "不能把其他未确认的团队套餐都归为 Team 5x");
    const teamFiveId = fixtures.get("team-five").id;
    assert.equal((await annotate([teamFiveId], { type: "plus" })).status, 200);
    assert.equal((await getJob("team-five")).accountTypeSource, "manual");
    assert.equal((await getJob("team-five")).accountType, "plus");
    assert.equal((await annotate([teamFiveId], { type: "" })).status, 200);
    assert.equal((await getJob("team-five")).accountType, "team_5x");
    assert.equal((await query({ type: "team_5x" })).pagination.total, 2);
    assert.equal((await getJob("pro")).accountType, "pro", "不能把 Pro 推断成 5x 或 20x");
    assert.equal((await getJob("unmarked")).accountType, "unknown");
    assert.equal((await getJob("invalid-metadata")).annotations.note, "保留有效字段");
    assert.equal((await getJob("invalid-metadata")).annotations.group, "");

    const paged = await query({ group: "跨页测试", type: "plus", tag: "批次 A", search: "续费" }, 2);
    assert.equal(paged.pagination.total, 25);
    assert.equal(paged.jobs.length, 5);
    assert.equal(paged.selection.length, 25, "筛选必须在分页前执行，并支持跨页选择");
    assert(paged.selection.every(job => job.accountType === "plus"));
    assert.equal((await query({ group: "不存在" })).pagination.total, 0);
    const combined = await (await request("/api/jobs/query", { emails: ["plus@example.com", "five@example.com"], filters: { type: "plus" } })).json();
    assert.deepEqual(combined.jobs.map(job => job.email), ["plus@example.com"]);
    assert.equal((await request("/api/jobs/query", { filters: { type: "invalid" } })).status, 400);

    const plusId = fixtures.get("plus").id;
    const before = await getJob("plus");
    assert.equal((await annotate([plusId], { note: "采购批次 B\n备注支持多行", tags: "主力号，待续费, 主力号" })).status, 200);
    const edited = await getJob("plus");
    assert.deepEqual(edited.annotations.tags, ["主力号", "待续费"]);
    assert.equal(edited.annotations.group, "日常使用");
    assert.equal(edited.status, before.status);
    assert.equal(edited.attempt, before.attempt);
    assert.equal(edited.lastOperationType, before.lastOperationType, "修改标记不能覆盖认证操作记录");
    assert.equal((await annotate([plusId], { tags: ["新标签", "主力号"] }, "append")).status, 200);
    assert.deepEqual((await getJob("plus")).annotations.tags, ["主力号", "待续费", "新标签"]);
    assert.equal((await annotate([plusId], { tags: [], note: "" })).status, 200);
    assert.deepEqual((await getJob("plus")).annotations.tags, []);
    assert.equal((await getJob("plus")).annotations.note, "");
    const fiveId = fixtures.get("five").id;
    assert.equal((await annotate([fiveId], { type: "" })).status, 200);
    assert.equal((await getJob("five")).accountType, "pro", "清空手动类型后沿用授权记录");
    assert.equal((await annotate([fiveId], { type: "5x" })).status, 200);

    for (const invalid of [{ type: "unknown" }, { group: "x".repeat(61) }, { note: "x".repeat(1001) },
      { tags: Array.from({ length: 13 }, (_, i) => String(i)) }, { tags: [12] }, { group: "a\nb" }, { typo: "标签" }]) {
      assert.equal((await annotate([plusId], invalid)).status, 400);
    }
    assert.equal((await annotate([plusId], {})).status, 400);
    assert.equal((await annotate([plusId], { tags: [] }, "bad-mode")).status, 400);

    const bulkIds = paged.selection.map(job => job.id);
    const bulk = await annotate(bulkIds, { type: "20x", group: "批量已归档", tags: ["已核对"] }, "append");
    assert.equal((await bulk.json()).updated, 25);
    const archived = await query({ group: "批量已归档", type: "20x", tag: "已核对" });
    assert.equal(archived.pagination.total, 25);
    assert(archived.jobs.every(job => job.annotations.tags.includes("批次 A")));
    assert(!archived.facets.groups.some(group => group.value === "跨页测试"));

    const existingPassword = "Existing_Annotation_Password_927!";
    assert.equal((await request("/api/jobs", { email: "plus@example.com", password: existingPassword, totpSecret: "JBSWY3DPEHPK3PXP" })).status, 200);
    assert.equal((await request("/api/jobs/batch", { text: "plus@example.com" })).status, 201);
    assert.equal((await getJob("plus")).annotations.group, "日常使用", "旧格式重新导入不能清空已有标记");
    const metadataImport = await request("/api/jobs/batch", { text: JSON.stringify({ email: "plus@example.com", annotations: { note: "只修改备注" } }) });
    assert.equal(metadataImport.status, 201);
    assert.equal((await getJob("plus")).annotations.note, "只修改备注");
    const source = await (await request("/api/jobs/export-source", { ids: [plusId] })).text();
    assert(source.includes(existingPassword));
    assert(source.includes("JBSWY3DPEHPK3PXP"));

    const importResponse = await request("/api/jobs/batch", { annotations: { group: "统一分组", tags: ["新入库"], note: "公共备注" }, text: [
      "import-legacy@example.com----Legacy_Password_927!",
      JSON.stringify({ email: "import-json@example.com", password: 'Json_"Password_927!', annotations: { type: "5x", note: "单行备注" } }),
      JSON.stringify({ email: "import-team@example.com", annotations: { type: "team", group: "行内分组", tags: [] } }),
      "{Brace_Password_927!----import-brace@example.com",
    ].join("\n") });
    assert.equal(importResponse.status, 201, await importResponse.clone().text());
    const imported = await importResponse.json();
    assert.equal(imported.created, 4);
    for (const job of imported.jobs) fixtures.set(job.email.split("@")[0], { id: job.id, directory: path.join(root, job.id) });
    assert.equal((await getJob("import-json")).annotations.group, "统一分组");
    assert.equal((await getJob("import-json")).annotations.note, "单行备注");
    assert.equal((await getJob("import-team")).annotations.group, "行内分组");
    assert.deepEqual((await getJob("import-team")).annotations.tags, []);
    await until(async () => (await getJob("import-json")).status === "email_otp");
    const activeBefore = await getJob("import-json");
    assert.equal((await annotate([activeBefore.id], { note: "执行中也能修改备注" })).status, 200);
    const activeAfter = await getJob("import-json");
    assert.equal(activeAfter.attempt, activeBefore.attempt);
    assert.equal(activeAfter.status, activeBefore.status);
    const inlineSource = await (await request("/api/jobs/export-source", { ids: [activeBefore.id] })).text();
    assert(inlineSource.includes('Json_"Password_927!'));
    assert.equal((await request("/api/jobs/batch", { text: JSON.stringify({ email: "import-json@example.com", annotations: { tags: ["单独标记"] } }) })).status, 201);
    assert.equal((await getJob("import-json")).attempt, activeBefore.attempt, "只导入标记不能重启正在执行的任务");

    const totalBeforeInvalid = (await query({})).pagination.totalAll;
    assert.equal((await request("/api/jobs/batch", { text: 'valid-new@example.com\n{"email":"bad@example.com","annotations":{"type":"bad"}}' })).status, 400);
    assert.equal((await query({})).pagination.totalAll, totalBeforeInvalid, "整批校验失败不能留下部分导入的账号");
    const badJson = await request("/api/jobs/batch", { text: '{"email":"bad@example.com","password":"private-password"' });
    assert.equal(badJson.status, 400);
    assert(!(await badJson.text()).includes("private-password"));

    await stop();
    await start();
    assert.equal((await getJob("plus")).annotations.note, "只修改备注");
    assert.equal((await getJob("five")).accountType, "5x");
    assert.equal((await getJob("checkpoint")).annotations.group, "恢复测试");
    assert.equal((await getJob("team-five")).accountType, "team_5x");
    assert.equal((await getJob("team-five")).accountTypeSource, "authorization");
    assert.equal((await getJob("checkpoint-team-five")).accountType, "team_5x");
    assert.equal((await getJob("metadata")).annotations.type, "free");
    assert.equal((await getJob("import-json")).annotations.note, "执行中也能修改备注");
    assert.equal((await query({ group: "批量已归档" })).pagination.total, 25);
    const stored = JSON.parse(await fs.readFile(path.join(root, fiveId, "job-meta.json"), "utf8"));
    assert.equal(stored.account_annotations.type, "5x");
    assert.equal((await fs.stat(path.join(root, fiveId, "job-meta.json"))).mode & 0o777, 0o600);
    assert(!JSON.stringify(await getJob("plus")).includes(existingPassword));
    console.log("账号标记测试通过：套餐参考与手动类型、导入、单条及批量修改、跨页筛选、运行中编辑、凭据保留与重启恢复");
  }
} finally {
  await stop();
  await fs.rm(root, { recursive: true, force: true });
}

async function fixture(name, plan, annotations, kind = "output") {
  const id = crypto.randomUUID(), directory = path.join(root, id), email = `${name}@example.com`;
  await fs.mkdir(directory);
  if (kind === "output") {
    const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_plan_type: plan } })).toString("base64url")}.test`;
    await fs.writeFile(path.join(directory, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", accounts: [{ credentials: { email, id_token: token } }] }));
  } else if (kind === "checkpoint") {
    await fs.writeFile(path.join(directory, "login-checkpoint.json"), JSON.stringify({ version: 1, email, stage: "email_verified", cookies: [] }));
  }
  await fs.writeFile(path.join(directory, "job-meta.json"), JSON.stringify({ email, status: kind === "output" ? "completed" : "canceled",
    account_annotations: annotations, observed_account_type: kind === "checkpoint" ? plan : "", last_operation_type: "initial_authorization" }));
  fixtures.set(name, { id, directory });
}

async function start() {
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test",
      ONBOARDING_OUTPUT_ROOT: root, TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(root, ".credentials"),
      TOSUB2_MAC_CREDENTIAL_ROOT: path.join(root, ".mac-credentials"),
      ONBOARDING_PROTOCOL_SCRIPT: path.join(projectRoot, "test/mock-queue-protocol.mjs") },
  });
  child.stdout.on("data", data => { logs += data; }); child.stderr.on("data", data => { logs += data; });
  childExit = new Promise(resolve => child.once("exit", resolve));
  await until(async () => { try {
    const data = await fetch(base + "/api/bootstrap").then(response => response.json());
    headers = { "content-type": "application/json", "x-console-token": data.token }; return data.features.accountAnnotations;
  } catch { return false; } });
}
async function stop() { if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await childExit; } }
function request(route, body) { return fetch(base + route, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
function annotate(ids, annotations, tagsMode = "replace") { return request("/api/jobs/annotations", { ids, annotations, tagsMode }); }
async function query(filters, page = 1) { return (await request("/api/jobs/query", { filters, page })).json(); }
async function getJob(name) { return (await (await request("/api/jobs/query", { emails: [`${name}@example.com`] })).json()).jobs[0]; }
async function until(predicate) { const deadline = Date.now() + 20_000; while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); } throw new Error(`测试等待超时\n${logs.slice(-2500)}`); }
async function availablePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
