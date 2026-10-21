import assert from "node:assert/strict";
import { getLogoutSession, logoutAllDevices } from "../src/account-security.mjs";
import { TlsFingerprintTransport } from "../src/tls-transport.mjs";

const session = { accessToken: "test-secret" };
for (const [status, text, contentType, expected] of [
  [200, '{"success":true}', "application/json", "accepted"],
  [204, "", "", "accepted"],
  [200, '{"success":false}', "application/json", "failed"],
  [200, "false", "application/json", "failed"],
  [200, '"unexpected"', "application/json", "unknown"],
  [200, "<html>请登录</html>", "text/html", "unknown"],
  [302, "", "", "unknown"],
  [401, '{"error":"secret-response"}', "application/json", "failed"],
  [429, "{}", "application/json", "failed"],
  [503, "{}", "application/json", "unknown"],
]) {
  const states = [];
  let requests = 0;
  await logoutAllDevices({ request: async (method, url, options) => {
    requests += 1;
    assert.equal(states[0].state, "requesting", "发送前必须保存请求状态");
    assert.equal(options.retryRiskControl, false);
    assert.equal(options.allowChallengeReplay, false);
    return { res: { status, headers: new Headers({ "content-type": contentType }) }, text };
  } }, {
    chatgptBase: "https://chatgpt.com", session, deviceId: "test-device",
    saveState: async (state, error) => states.push({ state, error }),
  });
  assert.equal(requests, 1);
  assert.equal(states.at(-1).state, expected);
  assert(!JSON.stringify(states).includes("secret-response"));
}

let requests = 0;
await assert.rejects(logoutAllDevices({ request: async () => { requests += 1; } }, {
  chatgptBase: "https://chatgpt.com", session, deviceId: "test",
  saveState: async () => { throw new Error("磁盘不可写"); },
}), /磁盘不可写/);
assert.equal(requests, 0, "操作记录写入失败时不能发送远端请求");

await assert.rejects(getLogoutSession({ request: async () => ({
  res: { status: 200 }, text: JSON.stringify({ accessToken: "secret", user: { email: "other@example.com" } }),
}) }, { chatgptBase: "https://chatgpt.com", email: "selected@example.com" }), /不一致/);

const transport = new TlsFingerprintTransport({ enabled: true, sameProxyRiskRetries: 3 });
let transportRequests = 0;
transport.send = async message => {
  if (message.operation === "configure") return {};
  assert.equal(message.operation, "request", "登出请求不能通过挑战求解自动重放");
  transportRequests += 1;
  return { status: 403, headers: [["content-type", "text/html"]],
    body: Buffer.from('<html><script>window._cf_chl_opt = {}; /cdn-cgi/challenge-platform/</script></html>').toString("base64"), cookies: [] };
};
await transport.configure("http://proxy.example:8080");
const response = await transport.request("POST", "https://chatgpt.com/backend-api/accounts/logout_all", {
  retryRiskControl: false, allowChallengeReplay: false,
});
assert.equal(response.status, 403);
assert.equal(transportRequests, 1);
await transport.close();
console.log("账号安全测试通过：可靠响应判断、先记录后发送、账号身份匹配、禁用请求重放");
