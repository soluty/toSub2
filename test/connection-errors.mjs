import assert from "node:assert/strict";
import { describeTlsHandshakeFailure } from "../src/connection-errors.mjs";

const rawError = new Error("SSLError: Failed to perform, curl: (35) TLS connect error: error:00000000:invalid library (0):OPENSSL_internal:invalid library (0)");
rawError.requestInfo = {
  method: "GET", origin: "https://auth.example.test",
  pathname: "/api/accounts/authorize", connectionMode: "direct",
};
const diagnostic = describeTlsHandshakeFailure(rawError);
assert.match(diagnostic, /TLS 握手失败.*curl 35.*未配置账号代理/);
assert.match(diagnostic, /GET auth\.example\.test\/api\/accounts\/authorize/);
assert.match(diagnostic, /尚未收到.*HTTP 响应/);
assert.match(diagnostic, /无法确定具体原因/);
assert.doesNotMatch(diagnostic, /密码错误|账号封禁|并发过高|库已损坏/);
assert.equal(describeTlsHandshakeFailure(new Error("请求失败", { cause: rawError })), diagnostic);

const proxyError = Object.assign(new Error(rawError.message), {
  requestInfo: { ...rawError.requestInfo, origin: "https://user:private-password@auth.example.test",
    pathname: "/callback/secret-token-123?state=private-state#private-code", connectionMode: "proxy" },
});
const privateDiagnostic = describeTlsHandshakeFailure(proxyError);
assert.match(privateDiagnostic, /已配置账号代理/);
assert.doesNotMatch(privateDiagnostic, /private-password|private-state|private-code|secret-token-123/);

// 已收到 HTTP 响应的错误，以及其他故障，继续使用原来的分类与文案。
assert.equal(describeTlsHandshakeFailure(Object.assign(new Error(rawError.message), { httpStatus: 403 })), null);
assert.equal(describeTlsHandshakeFailure(new Error("curl: (60) SSL certificate problem")), null);
assert.equal(describeTlsHandshakeFailure(new Error("invalid_password")), null);
assert.equal(describeTlsHandshakeFailure(new Error("curl: (28) Operation timed out")), null);
assert.equal(describeTlsHandshakeFailure(null), null);
assert.match(describeTlsHandshakeFailure(Object.assign(new Error(rawError.message), {
  requestInfo: { origin: "invalid-url" },
})), /TLS 握手失败/);
console.log("TLS 错误提示测试通过：握手阶段说明、直连/代理标记、敏感信息隐藏与分类保护");
