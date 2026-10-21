import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCredentialStore } from "../src/credential-store.mjs";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-credentials-"));

try {
  const powerShellRunner = async (script, input) => {
    if (script.includes("ProtectedData]::Protect")) {
      return { code: 0, stdout: Buffer.from(input, "utf8").toString("base64"), stderr: "" };
    }
    if (script.includes("ProtectedData]::Unprotect")) {
      return { code: 0, stdout: Buffer.from(input.trim(), "base64").toString("utf8"), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected script" };
  };
  const store = createCredentialStore({ platform: "win32", windowsRoot: tempRoot, powerShellRunner });
  const email = "Windows.User@example.com";
  const credentials = {
    password: "test-password",
    totpSecret: "JBSWY3DPEHPK3PXP",
    proxyUrl: "socks5h://user:secret@proxy.example:5000",
  };

  assert.deepEqual(await store.load(email), { password: "", totpSecret: "", proxyUrl: "" });
  await store.save(email, credentials);
  assert.deepEqual(await store.load(email.toLowerCase()), credentials);

  const updatedCredentials = {
    password: "更新后的密码",
    totpSecret: "NB2W45DFOIZAQWER",
    proxyUrl: "http://updated:secret@proxy.example:8080",
  };
  await store.save(email, updatedCredentials);
  assert.deepEqual(await store.load(email), updatedCredentials);

  const storedFiles = await fs.readdir(tempRoot);
  assert.equal(storedFiles.length, 1);
  const encryptedAtRest = await fs.readFile(path.join(tempRoot, storedFiles[0]), "utf8");
  assert.equal(encryptedAtRest.includes(updatedCredentials.password), false);
  assert.equal(encryptedAtRest.includes(updatedCredentials.proxyUrl), false);

  await store.delete(email);
  assert.deepEqual(await store.load(email), { password: "", totpSecret: "", proxyUrl: "" });

  if (process.platform === "win32") {
    const realStore = createCredentialStore({ windowsRoot: path.join(tempRoot, "real-dpapi") });
    await realStore.save(email, credentials);
    assert.deepEqual(await realStore.load(email), credentials);
    await realStore.delete(email);
    assert.deepEqual(await realStore.load(email), { password: "", totpSecret: "", proxyUrl: "" });
  }

  let macKey = "";
  const macStore = createCredentialStore({
    platform: "darwin",
    macRoot: path.join(tempRoot, "mac"),
    securityRunner: async (args, input = "") => {
      if (args[0] === "add-generic-password") {
        assert.equal(args.at(-1), "-w");
        assert.equal(args.some((value) => value.includes(credentials.password)), false);
        const enteredKeys = input.trim().split(/\r?\n/);
        assert.equal(enteredKeys.length, 2);
        assert.equal(enteredKeys[0], enteredKeys[1]);
        macKey = enteredKeys[0];
        assert.equal(Buffer.from(macKey, "base64").length, 32);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "find-generic-password") return { code: 0, stdout: macKey, stderr: "" };
      if (args[0] === "delete-generic-password") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected command" };
    },
  });
  await macStore.save(email, credentials);
  assert.deepEqual(await macStore.load(email), credentials);
  await macStore.delete(email);

  const truncatedPayload = JSON.stringify({
    version: 2,
    password: credentials.password,
    totpSecret: credentials.totpSecret,
    proxyUrl: credentials.proxyUrl.repeat(5),
  }).slice(0, 128);
  const legacyMacStore = createCredentialStore({
    platform: "darwin",
    macRoot: path.join(tempRoot, "legacy-mac"),
    securityRunner: async (args) => (
      args[0] === "find-generic-password"
        ? { code: 0, stdout: truncatedPayload, stderr: "" }
        : { code: 0, stdout: "", stderr: "" }
    ),
  });
  assert.deepEqual(await legacyMacStore.load(email), {
    password: credentials.password,
    totpSecret: credentials.totpSecret,
    proxyUrl: "",
  });

  const linuxRoot = path.join(tempRoot, "linux");
  const linuxStore = createCredentialStore({ platform: "linux", linuxRoot });
  const linuxFile = path.join(linuxRoot, "credentials.json");
  const empty = { password: "", totpSecret: "", proxyUrl: "" };
  assert.deepEqual(await linuxStore.load(email), empty);
  await linuxStore.delete(email);
  await assert.rejects(fs.access(linuxFile), { code: "ENOENT" });
  await linuxStore.save(` ${email} `, credentials);
  const reopened = createCredentialStore({ platform: "linux", linuxRoot });
  assert.deepEqual(await reopened.load(email.toUpperCase()), credentials);
  await reopened.save(email, updatedCredentials);
  assert.deepEqual(await linuxStore.load(email), updatedCredentials);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(linuxRoot)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(linuxFile)).mode & 0o777, 0o600);
    // 已存在的宽权限文件也会在更新时被替换为私有文件。
    await fs.chmod(linuxRoot, 0o755);
    await fs.chmod(linuxFile, 0o644);
    await linuxStore.save(email, updatedCredentials);
    assert.equal((await fs.stat(linuxRoot)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(linuxFile)).mode & 0o777, 0o600);
  }

  // 多个 store 实例批量写入及删除时，不能丢失其他账号。
  const batchEmails = Array.from({ length: 24 }, (_, index) => `batch-${index}@example.com`);
  await Promise.all(batchEmails.map((account, index) =>
    (index % 2 ? linuxStore : reopened).save(account, { ...credentials, password: `password-${index}` })));
  await Promise.all([
    ...batchEmails.slice(0, 12).map(account => linuxStore.delete(account)),
    ...batchEmails.slice(12).map(account => reopened.save(account, updatedCredentials)),
  ]);
  for (const [index, account] of batchEmails.entries()) {
    assert.deepEqual(await reopened.load(account), index < 12 ? empty : updatedCredentials);
  }
  assert.deepEqual(await fs.readdir(linuxRoot), ["credentials.json"]);
  await linuxStore.delete(email.toUpperCase());
  assert.deepEqual(await reopened.load(email), empty);

  // 格式损坏时不把现有文件当成空存储覆盖，修复后队列仍能正常工作。
  const validFile = await fs.readFile(linuxFile, "utf8");
  for (const corrupt of ["{broken", '{"version":1,"accounts":[]}', '{"version":1,"accounts":{"x":{"password":42}}}']) {
    await fs.writeFile(linuxFile, corrupt);
    await assert.rejects(linuxStore.load(email), /格式损坏/);
    await assert.rejects(linuxStore.save(email, credentials), /格式损坏/);
    await assert.rejects(linuxStore.delete(email), /格式损坏/);
    assert.equal(await fs.readFile(linuxFile, "utf8"), corrupt);
  }
  await fs.writeFile(linuxFile, validFile);
  await linuxStore.save(email, credentials);
  assert.deepEqual(await reopened.load(email), credentials);
  const blockedRoot = path.join(tempRoot, "not-a-directory");
  await fs.writeFile(blockedRoot, "保留此文件");
  const blockedStore = createCredentialStore({ platform: "linux", linuxRoot: blockedRoot });
  await assert.rejects(blockedStore.save(email, credentials), /无法读取 Linux 凭据文件/);
  assert.equal(await fs.readFile(blockedRoot, "utf8"), "保留此文件");

  const unsupportedStore = createCredentialStore({ platform: "freebsd" });
  await assert.rejects(
    unsupportedStore.save(email, credentials),
    (error) => error.status === 501 && error.message.includes("Windows DPAPI"),
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("credential store tests passed");
