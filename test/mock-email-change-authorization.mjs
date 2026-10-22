// 换绑与核实执行真实协议代码；仅将之后的 OAuth 替换成可控的本地结果。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

assert.equal(process.env.NODE_ENV, "test");
assert.equal(new URL(process.env.CHATGPT_BASE).hostname, "127.0.0.1");
const args = process.argv.slice(2);
if (args.includes("--change-email") || args.includes("--verify-email-change")) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/protocol-login.mjs", import.meta.url)), ...args], { stdio: "inherit", env: process.env });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  const code = await new Promise(resolve => child.once("exit", code => resolve(code)));
  process.exitCode = code ?? 1;
} else {
  const email = args[args.indexOf("--email") + 1];
  assert(args.includes("--existing-account-only"), "换绑后授权必须禁止新建账号");
  const response = await fetch(`${process.env.CHATGPT_BASE}/test/authorization?email=${encodeURIComponent(email)}`);
  const result = await response.json();
  if (response.status !== 200) { console.error("[error] 模拟新邮箱授权暂时失败"); process.exitCode = 1; }
  else {
    const account = { name: email, credentials: { email: result.email, access_token: "test-new-access", refresh_token: "test-new-refresh" },
      extra: { chatgpt_user_id: result.userId } };
    await fs.writeFile(args[args.indexOf("--sub2api-out") + 1], JSON.stringify({ type: "sub2api-data", accounts: [account] }), { mode: 0o600 });
    console.log("[ok] Saved sub2api import: mock-output");
  }
}
