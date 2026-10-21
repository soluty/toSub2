export const ACCOUNT_TYPES = [
  { value: "plus", label: "Plus" },
  { value: "5x", label: "5x" },
  { value: "team", label: "Team" },
  { value: "team_5x", label: "Team 5x" },
  { value: "20x", label: "20x" },
  { value: "pro", label: "Pro" },
  { value: "free", label: "Free" },
  { value: "enterprise", label: "Enterprise" },
  { value: "edu", label: "Edu" },
];
const TYPE_VALUES = new Set(ACCOUNT_TYPES.map(type => type.value));
export const ACCOUNT_STATUS_LABELS = {
  completed: "已完成",
  reauth_required: "待重新授权",
  failed: "失败",
  resume_available: "可继续",
  canceled: "已取消",
  queued: "排队中",
  starting: "启动中",
  working: "处理中",
  refreshing: "刷新授权",
  finalizing: "生成中",
  email_otp: "待邮箱码",
  password: "待密码",
  mfa_otp: "待 2FA",
  phone: "待手机号",
  phone_otp: "待手机码",
  totp_starting: "准备 2FA",
  totp_setup_otp: "激活 2FA",
  password_add_starting: "准备密码",
  password_set_starting: "设置密码",
  logout_starting: "准备登出",
};
const STATUS_VALUES = new Set(Object.keys(ACCOUNT_STATUS_LABELS));
export const EMPTY_ANNOTATIONS = Object.freeze({ type: "", group: "", tags: [], note: "" });

function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }
function cleanText(value, label, limit) {
  if (typeof value !== "string" || value.length > limit || /[\0-\x08\x0b\x0c\x0e-\x1f]/.test(value)) {
    throw invalid(`${label}需为不超过 ${limit} 个字符的文本`);
  }
  return value.trim();
}

export function normalizeAnnotationsPatch(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("账号标记格式不正确");
  const patch = {};
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(EMPTY_ANNOTATIONS, key)) throw invalid("账号标记包含不支持的字段");
  }
  if (Object.hasOwn(value, "type")) {
    if (typeof value.type !== "string" || (value.type && !TYPE_VALUES.has(value.type))) throw invalid("账号类型不正确");
    patch.type = value.type;
  }
  if (Object.hasOwn(value, "group")) {
    patch.group = cleanText(value.group, "分组", 60);
    if (/[\r\n\t]/.test(patch.group)) throw invalid("分组不能包含换行或制表符");
  }
  if (Object.hasOwn(value, "note")) patch.note = cleanText(value.note, "备注", 1000);
  if (Object.hasOwn(value, "tags")) {
    const input = typeof value.tags === "string" ? value.tags.split(/[,，\n]/) : value.tags;
    if (!Array.isArray(input) || input.length > 40) throw invalid("标签格式不正确");
    patch.tags = [...new Set(input.map(tag => cleanText(tag, "标签", 30)).filter(Boolean))];
    if (patch.tags.length > 12) throw invalid("每个账号最多设置 12 个标签");
    if (patch.tags.some(tag => /[,，\r\n\t]/.test(tag))) throw invalid("单个标签不能包含逗号、换行或制表符");
  }
  return patch;
}

export function restoreAnnotations(value) {
  const restored = { ...EMPTY_ANNOTATIONS, tags: [] };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(restored)) {
      if (Object.hasOwn(value, key)) {
        try { Object.assign(restored, normalizeAnnotationsPatch({ [key]: value[key] })); } catch {}
      }
    }
  }
  return restored;
}

export function mergeAnnotations(current, patch, tagsMode = "replace") {
  if (!["replace", "append"].includes(tagsMode)) throw invalid("标签更新方式不正确");
  const previous = restoreAnnotations(current);
  const next = { ...previous, ...normalizeAnnotationsPatch(patch) };
  if (tagsMode === "append" && Object.hasOwn(patch, "tags")) {
    next.tags = normalizeAnnotationsPatch({ tags: [...new Set([...previous.tags, ...next.tags])] }).tags;
  }
  return next;
}

export function effectiveAccountType(job) {
  return job.annotations?.type || (TYPE_VALUES.has(job.observedAccountType) ? job.observedAccountType : "unknown");
}

export function normalizeAccountFilters(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("账号筛选格式不正确");
  const filters = {};
  if (Object.hasOwn(value, "status")) {
    if (!STATUS_VALUES.has(value.status)) throw invalid("筛选状态不正确");
    filters.status = value.status;
  }
  if (Object.hasOwn(value, "type")) {
    if (value.type !== "unknown" && !TYPE_VALUES.has(value.type)) throw invalid("筛选类型不正确");
    filters.type = value.type;
  }
  if (Object.hasOwn(value, "group")) filters.group = cleanText(value.group, "筛选分组", 60);
  if (Object.hasOwn(value, "tag")) filters.tag = cleanText(value.tag, "筛选标签", 30);
  if (Object.hasOwn(value, "search")) filters.search = cleanText(value.search, "搜索内容", 200).toLowerCase();
  return filters;
}

export function matchesAccountFilters(job, filters) {
  if (filters.status && job.status !== filters.status) return false;
  const annotations = restoreAnnotations(job.annotations);
  if (filters.type && effectiveAccountType(job) !== filters.type) return false;
  if (Object.hasOwn(filters, "group") && annotations.group !== filters.group) return false;
  if (filters.tag && !annotations.tags.includes(filters.tag)) return false;
  return !filters.search || [job.email, annotations.group, annotations.note, ...annotations.tags]
    .some(text => String(text || "").toLowerCase().includes(filters.search));
}

export function accountFacets(jobs) {
  const groups = new Map(), tags = new Map(), types = new Map(), statuses = new Map();
  for (const job of jobs) {
    statuses.set(job.status, (statuses.get(job.status) || 0) + 1);
    const annotations = restoreAnnotations(job.annotations);
    groups.set(annotations.group, (groups.get(annotations.group) || 0) + 1);
    for (const tag of annotations.tags) tags.set(tag, (tags.get(tag) || 0) + 1);
    const type = effectiveAccountType(job);
    types.set(type, (types.get(type) || 0) + 1);
  }
  const items = values => [...values].sort(([a], [b]) => a.localeCompare(b, "zh-CN")).map(([value, count]) => ({ value, count }));
  return { total: jobs.length, groups: items(groups), tags: items(tags), types: Object.fromEntries(types), statuses: Object.fromEntries(statuses) };
}

// 只读取已有授权记录的套餐标识作为参考，不发起平台请求，也不把 Pro 推断成 5x / 20x。
// self_serve_business_prolite：2026-10-22 本机 11 个账号的授权记录，用户确认均为 Team 5x。
export function observedAccountType(account) {
  const candidates = [account?.credentials?.chatgpt_plan_type, account?.extra?.chatgpt_plan_type];
  for (const token of [account?.credentials?.id_token, account?.credentials?.access_token]) {
    if (typeof token !== "string" || token.length > 65_536) continue;
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      candidates.push(payload?.["https://api.openai.com/auth"]?.chatgpt_plan_type);
    } catch {}
  }
  for (const value of candidates) {
    const type = typeof value === "string" ? value.toLowerCase() : "";
    if (type === "self_serve_business_prolite") return "team_5x";
    if (type === "business") return "team";
    if (["plus", "team", "team_5x", "pro", "free", "enterprise", "edu"].includes(type)) return type;
  }
  return "";
}
