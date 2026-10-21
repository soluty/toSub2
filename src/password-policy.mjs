export function validateAccountPassword(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 128) {
    throw new Error("新密码需要 12–128 个字符");
  }
  if (/[\r\n\0]/.test(value)) throw new Error("新密码不能包含换行或空字符");
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value) || !/[^A-Za-z0-9]/.test(value)) {
    throw new Error("新密码需要包含大写字母、小写字母、数字和符号");
  }
  return value;
}
