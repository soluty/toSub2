import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { build } from "vite";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
await fs.mkdir(path.join(projectRoot, "tmp"), { recursive: true });
const temp = await fs.mkdtemp(path.join(projectRoot, "tmp", "job-input-ui-"));
const dom = new JSDOM('<!doctype html><table><tbody id="rows"></tbody></table>', {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
  // 导入真实页面组件，但不启动 App 的轮询或任何真实登录任务。
  __chatgptOnboardingRoot: { render() {} },
});

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const root = createRoot(document.getElementById("rows"));
const requests = [];
const globalErrors = [];
let respond = () => new Response("{}", { status: 200 });
globalThis.fetch = async (url, options) => {
  assert.equal(url, "/api/jobs/manual-email/input", "仅允许模拟的验证码提交接口");
  assert.equal(options.method, "POST");
  requests.push(JSON.parse(options.body));
  return respond();
};

try {
  const output = await build({
    root: projectRoot,
    configFile: false,
    logLevel: "silent",
    build: { ssr: path.join(projectRoot, "web/src/main.jsx"), write: false },
  });
  const compiled = output.output.find(item => item.type === "chunk" && item.isEntry);
  const entry = path.join(temp, "job-row.mjs");
  await fs.writeFile(entry, compiled.code);
  const { JobRow } = await import(pathToFileURL(entry).href);
  const job = {
    id: "manual-email", email: "old@example.com", status: "email_change_otp",
    emailChange: { state: "awaiting_code", newEmail: "new@example.com" },
    autoEmailOtp: false, loginMode: "password", hasPasswordCredential: true,
    createdAt: "2026-01-01T00:00:00Z", prompt: "请输入新邮箱验证码",
  };
  async function render(next = job) {
    await act(async () => root.render(React.createElement(JobRow, {
      job: next, token: "test-token", onError: error => globalErrors.push(error),
      accountProxyUrl: "",
    })));
  }
  const input = () => document.querySelector('.inline-entry input');
  const submit = () => document.querySelector('.inline-entry button.submit');
  const error = () => document.querySelector('.step-cell [role="alert"]');
  async function type(value) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input(), value);
      input().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  }
  await render();

  // 五位、七位和非数字均在当前行提示，不发出请求，也不丢失输入。
  for (const value of ["12345", "1234567", "12a456"]) {
    await type(value);
    await act(async () => submit().click());
    assert.equal(requests.length, 0);
    assert.equal(error().textContent, "新邮箱验证码必须是 6 位数字");
    assert.equal(input().value, value);
    assert.equal(input().getAttribute("aria-describedby"), error().id);
    assert.equal(input().getAttribute("aria-invalid"), "true");
  }
  // 模拟列表轮询刷新同一任务，行内错误不能跟随页面顶部错误消失。
  await render({ ...job, updatedAt: "2026-01-01T00:00:01Z" });
  assert.equal(error().textContent, "新邮箱验证码必须是 6 位数字");
  assert.deepEqual(globalErrors, []);

  // 没有邮箱收码 API 时仍可手填；保留验证码开头的零。
  await type("012345");
  assert.equal(error(), null);
  let resolve;
  respond = () => new Promise(done => { resolve = done; });
  await act(async () => submit().click());
  assert.deepEqual(requests, [{ action: "new_email_otp", value: "012345" }]);
  assert.equal(submit().disabled, true);
  assert.equal(input().disabled, true);
  await act(async () => submit().click());
  assert.equal(requests.length, 1);

  await act(async () => resolve(new Response(JSON.stringify({ error: "模拟：任务已过期，请重新获取验证码" }), { status: 409 })));
  assert.match(error().textContent, /任务已过期/);
  assert.equal(input().value, "012345");
  assert.equal(submit().disabled, false);
  await render({ ...job });
  assert.match(error().textContent, /任务已过期/);

  // 修正后可以按回车提交；仅成功后清空输入和错误。
  await type(" 654321 ");
  respond = () => new Response("{}", { status: 200 });
  await act(async () => input().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  assert.deepEqual(requests.at(-1), { action: "new_email_otp", value: "654321" });
  assert.equal(input().value, "");
  assert.equal(error(), null);

  await type("12345");
  await act(async () => submit().click());
  await render({ ...job, status: "working" });
  await render({ ...job });
  assert.equal(error(), null, "进入新阶段后清理上一阶段的输入错误");
  console.log("手动邮箱验证码 UI 验证通过：位数校验、行内错误、轮询、提交状态及回车重试。");
} finally {
  await act(async () => root.unmount());
  dom.window.close();
  await fs.rm(temp, { recursive: true, force: true });
}
