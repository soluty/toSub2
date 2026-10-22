import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Filter,
  Folder,
  Globe2,
  KeyRound,
  ListPlus,
  LoaderCircle,
  LogIn,
  LogOut,
  Mail,
  MailCheck,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Smartphone,
  PhoneIncoming,
  Pencil,
  Search,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import "./styles.css";
import { validateAccountPassword } from "../../src/password-policy.mjs";
import { ACCOUNT_TYPES, ACCOUNT_STATUS_LABELS, normalizeAnnotationsPatch } from "../../src/account-annotations.mjs";

const EMPTY_ANNOTATION_FORM = { type: "", group: "", tags: "", note: "" };
const EMPTY_ACCOUNT_FILTERS = { type: "", status: "", group: null, tag: "", search: "" };

const POLL_INTERVAL_MS = 900;
const LUBAN_API_KEY_STORAGE_KEY = "chatgpt-onboarding.luban-api-key";
const LUBAN_SERVICE_ID_STORAGE_KEY = "chatgpt-onboarding.luban-service-id";
const SMS_PROVIDER_SETTINGS_KEY = "chatgpt-onboarding.sms-provider-settings-v1";
const MAIL_REQUEST_SETTINGS_KEY = "chatgpt-onboarding.mail-request-settings-v1";
const SUB2API_UPLOAD_SETTINGS_KEY = "chatgpt-onboarding.sub2api-upload-settings-v1";
const ACCOUNT_PROXY_STORAGE_KEY = "chatgpt-onboarding.account-proxy-v1";
const SMS_PROVIDER_EXTERNAL_LINKS = {
  luban: {
    href: "https://lubansms.com/",
    label: "点击获取 API 密钥",
  },
  smsbower: {
    href: "https://smsbower.app/cabinet/profile",
    label: "点击获取 API 密钥",
  },
};
const REGION_NAMES = typeof Intl.DisplayNames === "function"
  ? new Intl.DisplayNames(["zh-CN"], { type: "region" })
  : null;

function App() {
  const [token, setToken] = useState("");
  const [features, setFeatures] = useState({});
  const [jobs, setJobs] = useState([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState("");
  const [batchAnnotations, setBatchAnnotations] = useState({ ...EMPTY_ANNOTATION_FORM });
  const [annotationTargets, setAnnotationTargets] = useState(null);
  const [emailChangeTarget, setEmailChangeTarget] = useState(null);
  const [accountFilters, setAccountFilters] = useState({ ...EMPTY_ACCOUNT_FILTERS });
  const [accountSearch, setAccountSearch] = useState("");
  const [accountFacets, setAccountFacets] = useState({ total: 0, groups: [], tags: [], types: {}, statuses: {} });
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [filterError, setFilterError] = useState("");
  const [emailFilter, setEmailFilter] = useState([]);
  const [error, setError] = useState("");
  const [expandedJobId, setExpandedJobId] = useState(null);
  const [selectedJobIds, setSelectedJobIds] = useState(() => new Set());
  const [jobSelectionIndex, setJobSelectionIndex] = useState([]);
  const [batchAction, setBatchAction] = useState("");
  const [passwordBatchTargets, setPasswordBatchTargets] = useState(null);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
  const [stats, setStats] = useState({ active: 0, queued: 0, completed: 0 });
  const [smsSettings, setSmsSettings] = useState(readSmsProviderSettings);
  const [smsSettingsOpen, setSmsSettingsOpen] = useState(false);
  const [smsSettingsDraft, setSmsSettingsDraft] = useState(readSmsProviderSettings);
  const [smsSettingsError, setSmsSettingsError] = useState("");
  const [smsNumberOptions, setSmsNumberOptions] = useState([]);
  const [smsOptionsLoading, setSmsOptionsLoading] = useState(false);
  const [mailRequestSettings, setMailRequestSettings] = useState(readMailRequestSettings);
  const [mailRequestSettingsDraft, setMailRequestSettingsDraft] = useState(readMailRequestSettings);
  const [mailRequestSettingsOpen, setMailRequestSettingsOpen] = useState(false);
  const [mailRequestSettingsError, setMailRequestSettingsError] = useState("");
  const [mailRequestSettingsSaving, setMailRequestSettingsSaving] = useState(false);
  const [sub2apiSettings, setSub2apiSettings] = useState(readSub2ApiSettings);
  const [sub2apiSettingsDraft, setSub2apiSettingsDraft] = useState(readSub2ApiSettings);
  const [sub2apiGroups, setSub2apiGroups] = useState([]);
  const [sub2apiProxies, setSub2apiProxies] = useState([]);
  const [sub2apiSettingsOpen, setSub2apiSettingsOpen] = useState(false);
  const [sub2apiSettingsError, setSub2apiSettingsError] = useState("");
  const [sub2apiGroupsLoading, setSub2apiGroupsLoading] = useState(false);
  const [sub2apiSettingsSaving, setSub2apiSettingsSaving] = useState(false);
  const [sub2apiMonitorChecking, setSub2apiMonitorChecking] = useState(false);
  const [sub2apiMonitorStatus, setSub2apiMonitorStatus] = useState({
    configured: false,
    enabled: false,
    running: false,
    lastCheckAt: null,
    nextCheckAt: null,
    lastError: null,
    lastResult: null,
    intervalMinutes: 5,
  });
  const [uploadNotice, setUploadNotice] = useState("");
  const [accountProxyUrl, setAccountProxyUrl] = useState(() => readLocalTextSetting(ACCOUNT_PROXY_STORAGE_KEY));
  const hasAccountFilters = Boolean(accountFilters.type || accountFilters.status || accountFilters.group !== null || accountFilters.tag || accountFilters.search);

  useEffect(() => {
    if (accountSearch.trim() === accountFilters.search) return undefined;
    const timer = window.setTimeout(() => {
      setAccountFilters(current => current.search === accountSearch.trim() ? current : { ...current, search: accountSearch.trim() });
      setPage(1);
      setSelectedJobIds(new Set());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [accountSearch]);

  useEffect(() => writeLocalJson(SMS_PROVIDER_SETTINGS_KEY, smsSettings), [smsSettings]);
  useEffect(() => writeLocalJson(MAIL_REQUEST_SETTINGS_KEY, mailRequestSettings), [mailRequestSettings]);
  useEffect(() => writeLocalJson(SUB2API_UPLOAD_SETTINGS_KEY, sub2apiSettings), [sub2apiSettings]);
  useEffect(() => writeLocalTextSetting(ACCOUNT_PROXY_STORAGE_KEY, accountProxyUrl.trim()), [accountProxyUrl]);

  useEffect(() => {
    let stopped = false;
    fetch("/api/bootstrap")
      .then(readResponse)
      .then((data) => {
        if (!stopped) {
          setToken(data.token);
          setFeatures(data.features || {});
        }
      })
      .catch((requestError) => setError(requestError.message));
    return () => {
      stopped = true;
    };
  }, []);

  useEffect(() => {
    if (!token) return;
    void apiFetch(token, "/api/mail-request-config", {
      method: "POST",
      body: JSON.stringify({ config: buildMailRequestConfig(mailRequestSettings) }),
    }).catch((requestError) => setError(requestError.message));
  }, [token]);

  useEffect(() => {
    if (!token) return undefined;
    let stopped = false;
    let timer;
    const poll = async () => {
      try {
        const data = emailFilter.length || hasAccountFilters
          ? await apiFetch(token, "/api/jobs/query", {
              method: "POST",
              body: JSON.stringify({ page, ...(emailFilter.length ? { emails: emailFilter } : {}), filters: {
                ...(accountFilters.type ? { type: accountFilters.type } : {}),
                ...(accountFilters.status ? { status: accountFilters.status } : {}),
                ...(accountFilters.group !== null ? { group: accountFilters.group } : {}),
                ...(accountFilters.tag ? { tag: accountFilters.tag } : {}),
                ...(accountFilters.search ? { search: accountFilters.search } : {}),
              } }),
            })
          : await apiFetch(token, `/api/jobs?page=${page}`);
        if (!stopped) {
          setJobs(data.jobs);
          setJobSelectionIndex(data.selection || data.jobs);
          setPagination(data.pagination || { page, pageSize: 20, total: data.jobs.length, totalPages: 1 });
          setStats(data.stats || { active: 0, queued: 0, completed: 0 });
          if (data.facets) setAccountFacets(data.facets);
          if (data.pagination?.page && data.pagination.page !== page) setPage(data.pagination.page);
          setError("");
        }
      } catch (requestError) {
        if (!stopped) setError(requestError.message);
      } finally {
        if (!stopped) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [token, page, emailFilter, accountFilters, refreshVersion]);

  useEffect(() => {
    if (!token || !features.sub2apiMonitor) return undefined;
    let stopped = false;
    const load = async () => {
      try {
        const data = await apiFetch(token, "/api/sub2api/monitor");
        if (!stopped) {
          setSub2apiMonitorStatus(data);
          setSub2apiSettings((current) => ({ ...current, monitorEnabled: Boolean(data.enabled) }));
        }
      } catch {}
    };
    void load();
    const timer = window.setInterval(load, 5_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [token, features.sub2apiMonitor]);

  const pageJobIds = useMemo(() => jobs.map((job) => job.id), [jobs]);
  const smsProviderDefinitions = Array.isArray(features.smsProviders) ? features.smsProviders : [];
  const activeSmsProvider = useMemo(
    () => resolveSmsProvider(smsProviderDefinitions, smsSettings),
    [smsProviderDefinitions, smsSettings],
  );
  const draftSmsProvider = useMemo(
    () => resolveSmsProvider(smsProviderDefinitions, smsSettingsDraft),
    [smsProviderDefinitions, smsSettingsDraft],
  );
  const selectedJobs = useMemo(
    () => jobSelectionIndex.filter((job) => selectedJobIds.has(job.id)),
    [jobSelectionIndex, selectedJobIds],
  );
  const downloadableSelectedCount = selectedJobs.filter((job) => job.canDownload).length;
  const allPageSelected = pageJobIds.length > 0 && pageJobIds.every((id) => selectedJobIds.has(id));
  const canDownloadSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && downloadableSelectedCount > 0;
  const canReauthorizeSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && selectedJobs.every((job) => job.canRegenerate || job.canRetry);
  const forceReloginSelectedCount = selectedJobs.filter((job) => job.canForceRelogin).length;
  const canForceReloginSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && forceReloginSelectedCount > 0;
  const canUploadSelected = selectedJobs.length > 0 && downloadableSelectedCount > 0;
  const totpSetupSelectedCount = selectedJobs.filter((job) => job.canSetupTotp).length;
  const canSetupTotpSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && totpSetupSelectedCount > 0;
  const totpRotateSelectedCount = selectedJobs.filter((job) => job.canRotateTotp).length;
  const canRotateTotpSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && totpRotateSelectedCount > 0;
  const passwordAddSelectedCount = selectedJobs.filter((job) => job.canAddPassword).length;
  const canAddPasswordSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && passwordAddSelectedCount > 0;
  const passwordSetSelectedCount = selectedJobs.filter((job) => job.canSetPassword).length;
  const canSetPasswordSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && passwordSetSelectedCount > 0;

  function openSmsSettings() {
    const draft = withSmsProviderDefaults(smsProviderDefinitions, smsSettings);
    setSmsSettingsDraft(draft);
    setSmsSettingsError("");
    setSmsSettingsOpen(true);
  }

  function openMailRequestSettings() {
    setMailRequestSettingsDraft({ ...mailRequestSettings });
    setMailRequestSettingsError("");
    setMailRequestSettingsOpen(true);
  }

  async function saveMailRequestSettings(event) {
    event.preventDefault();
    let config;
    try {
      config = buildMailRequestConfig(mailRequestSettingsDraft);
    } catch (requestError) {
      setMailRequestSettingsError(requestError.message);
      return;
    }
    setMailRequestSettingsSaving(true);
    setMailRequestSettingsError("");
    try {
      await apiFetch(token, "/api/mail-request-config", {
        method: "POST",
        body: JSON.stringify({ config }),
      });
      setMailRequestSettings(normalizeMailRequestSettings(mailRequestSettingsDraft));
      setMailRequestSettingsOpen(false);
    } catch (requestError) {
      setMailRequestSettingsError(requestError.message);
    } finally {
      setMailRequestSettingsSaving(false);
    }
  }

  function openSub2ApiSettings() {
    setSub2apiSettingsDraft({ ...sub2apiSettings, monitorEnabled: Boolean(sub2apiMonitorStatus.enabled) });
    setSub2apiSettingsError("");
    setSub2apiSettingsOpen(true);
  }

  async function loadSub2ApiOptions(settings = sub2apiSettingsDraft) {
    setSub2apiGroupsLoading(true);
    setSub2apiSettingsError("");
    try {
      const data = await apiFetch(token, "/api/sub2api/options", {
        method: "POST",
        body: JSON.stringify({ config: settings }),
      });
      setSub2apiGroups(Array.isArray(data.groups) ? data.groups : []);
      setSub2apiProxies(Array.isArray(data.proxies) ? data.proxies : []);
    } catch (requestError) {
      setSub2apiGroups([]);
      setSub2apiProxies([]);
      setSub2apiSettingsError(requestError.message);
    } finally {
      setSub2apiGroupsLoading(false);
    }
  }

  async function saveSub2ApiSettings(event) {
    event.preventDefault();
    const baseUrl = String(sub2apiSettingsDraft.baseUrl || "").trim();
    const adminApiKey = String(sub2apiSettingsDraft.adminApiKey || "").trim();
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
      setSub2apiSettingsError("请输入 http:// 或 https:// 开头的 Sub2API 后端地址");
      return;
    }
    if (!adminApiKey) {
      setSub2apiSettingsError("请输入 Sub2API 管理员 API Key");
      return;
    }
    const nextSettings = {
      ...readSub2ApiSettings(sub2apiSettingsDraft),
      baseUrl: baseUrl.replace(/\/+$/, ""),
      adminApiKey,
    };
    setSub2apiSettingsSaving(true);
    try {
      const monitor = await apiFetch(token, "/api/sub2api/monitor", {
        method: "POST",
        body: JSON.stringify({ enabled: nextSettings.monitorEnabled, config: nextSettings }),
      });
      setSub2apiSettings(nextSettings);
      setSub2apiMonitorStatus(monitor);
      setSub2apiSettingsOpen(false);
      setSub2apiSettingsError("");
    } catch (requestError) {
      setSub2apiSettingsError(requestError.message);
    } finally {
      setSub2apiSettingsSaving(false);
    }
  }

  async function checkSub2ApiMonitorNow() {
    if (!sub2apiMonitorStatus.enabled || sub2apiMonitorChecking) return;
    setSub2apiMonitorChecking(true);
    setSub2apiSettingsError("");
    try {
      const data = await apiFetch(token, "/api/sub2api/monitor/check", { method: "POST" });
      setSub2apiMonitorStatus(data);
      setUploadNotice(formatMonitorResult(data.result));
      setError("");
    } catch (requestError) {
      if (sub2apiSettingsOpen) setSub2apiSettingsError(requestError.message);
      else setError(requestError.message);
    } finally {
      setSub2apiMonitorChecking(false);
    }
  }

  function setSub2ApiGroupChecked(groupId, checked) {
    setSub2apiSettingsDraft((current) => {
      const selected = new Set(current.groupIds);
      if (checked) selected.add(String(groupId));
      else selected.delete(String(groupId));
      return { ...current, groupIds: [...selected] };
    });
  }

  async function uploadSelected(ids) {
    if (!sub2apiSettings.baseUrl || !sub2apiSettings.adminApiKey) {
      openSub2ApiSettings();
      setUploadNotice("请先配置 Sub2API 后端地址、管理员 API Key 和目标号池");
      return;
    }
    if (batchAction) return;
    setBatchAction("upload");
    setUploadNotice("");
    try {
      const data = await apiFetch(token, "/api/sub2api/upload", {
        method: "POST",
        body: JSON.stringify({ ids, config: sub2apiSettings }),
      });
      const result = data.result || {};
      const created = result.account_created ?? result.success ?? data.uploaded;
      const failed = result.account_failed ?? result.failed ?? 0;
      setUploadNotice(`已上传 ${created} 条${failed ? `，失败 ${failed} 条` : ""}${data.skipped ? `，跳过未完成任务 ${data.skipped} 条` : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function loadSmsNumberOptions(settings = smsSettingsDraft) {
    const resolved = resolveSmsProvider(smsProviderDefinitions, settings);
    if (!resolved.definition?.optionsEndpoint) return;
    if (!String(resolved.config.apiKey || "").trim()) {
      setSmsSettingsError("请先填写 API Key");
      return;
    }
    setSmsOptionsLoading(true);
    setSmsSettingsError("");
    try {
      const data = await apiFetch(token, resolved.definition.optionsEndpoint, {
        method: "POST",
        body: JSON.stringify({ config: resolved.config }),
      });
      const options = Array.isArray(data.options) ? data.options : [];
      setSmsNumberOptions(options);
      const current = resolved.config.maxPrice
        ? options.find((option) => option.country === resolved.config.country) || options[0]
        : options[0];
      if (!current) throw new Error("当前没有可购买的国家号码");
      updateSmsProviderConfig(resolved.id, {
        country: current.country,
        maxPrice: String(current.price),
        countryLabel: formatSmsCountryName(current),
      });
    } catch (requestError) {
      setSmsNumberOptions([]);
      setSmsSettingsError(requestError.message);
    } finally {
      setSmsOptionsLoading(false);
    }
  }

  function updateSmsProviderConfig(providerId, values) {
    setSmsSettingsDraft((current) => ({
      ...current,
      configs: {
        ...(current.configs || {}),
        [providerId]: {
          ...(current.configs?.[providerId] || {}),
          ...values,
        },
      },
    }));
  }

  function saveSmsSettings(event) {
    event.preventDefault();
    const resolved = resolveSmsProvider(smsProviderDefinitions, smsSettingsDraft);
    if (!resolved.definition) {
      setSmsSettingsError("请选择接码平台");
      return;
    }
    const missing = resolved.definition.fields.find((field) => (
      field.required !== false && !String(resolved.config[field.key] || "").trim()
    ));
    if (missing) {
      setSmsSettingsError(`请填写${missing.label}`);
      return;
    }
    if (resolved.id === "custom") {
      const customEntries = inspectCustomSmsEntries(resolved.config.entries);
      if (customEntries.error) {
        setSmsSettingsError(customEntries.error);
        return;
      }
    }
    setSmsSettings(withSmsProviderDefaults(smsProviderDefinitions, smsSettingsDraft));
    setSmsSettingsOpen(false);
    setSmsSettingsError("");
  }

  useEffect(() => {
    const valid = new Set(jobSelectionIndex.map((job) => job.id));
    setSelectedJobIds((current) => {
      const next = new Set([...current].filter((id) => valid.has(id)));
      if (next.size === current.size && [...next].every((id) => current.has(id))) return current;
      return next;
    });
  }, [jobSelectionIndex]);

  useEffect(() => {
    setExpandedJobId(null);
  }, [page]);

  function changeAccountFilter(field, value) {
    setAccountFilters(current => ({ ...current, [field]: value }));
    setSelectedJobIds(new Set());
    setExpandedJobId(null);
    setPage(1);
  }

  function clearAccountFilters() {
    setAccountSearch("");
    setAccountFilters({ ...EMPTY_ACCOUNT_FILTERS });
    setSelectedJobIds(new Set());
    setPage(1);
  }

  async function saveAnnotations(annotations, tagsMode) {
    const data = await apiFetch(token, "/api/jobs/annotations", {
      method: "POST", body: JSON.stringify({ ids: annotationTargets.ids, annotations, tagsMode }),
    });
    setUploadNotice(`已保存 ${data.updated} 个账号的标记${data.failures?.length ? `；${data.failures.length} 个保存失败：${data.failures[0].error}` : ""}`);
    setAnnotationTargets(null);
    setRefreshVersion(version => version + 1);
  }

  async function createJob(event) {
    event.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    try {
      const data = await apiFetch(token, "/api/jobs", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), proxyUrl: accountProxyUrl.trim() }),
      });
      setPage(1);
      if (page === 1) setJobs((current) => mergeJobs([data.job], current).slice(0, 20));
      setEmail("");
      clearAccountFilters();
      setEmailFilter([]);
      setRefreshVersion(version => version + 1);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function createBatch(event) {
    event.preventDefault();
    if (!batchText.trim() || batchBusy) return;
    setBatchBusy(true);
    try {
      const data = await apiFetch(token, "/api/jobs/batch", {
        method: "POST",
        body: JSON.stringify({ text: batchText, proxyUrl: accountProxyUrl.trim(), annotations:
          normalizeAnnotationsPatch(Object.fromEntries(Object.entries(batchAnnotations).filter(([, value]) => value.trim()))) }),
      });
      setPage(1);
      if (page === 1) setJobs((current) => mergeJobs(data.jobs, current).slice(0, 20));
      setBatchText("");
      setBatchError("");
      setBatchOpen(false);
      setBatchAnnotations({ ...EMPTY_ANNOTATION_FORM });
      clearAccountFilters();
      setEmailFilter([]);
      setRefreshVersion(version => version + 1);
      setUploadNotice(`已新增 ${data.created} 个账号，更新 ${data.updated} 个账号；标记已保存`);
      setError("");
    } catch (requestError) {
      setBatchError(requestError.message);
    } finally {
      setBatchBusy(false);
    }
  }

  function applyEmailFilter(event) {
    event.preventDefault();
    try {
      const emails = parseEmailFilter(filterText);
      setEmailFilter(emails);
      setSelectedJobIds(new Set());
      setExpandedJobId(null);
      setPage(1);
      setFilterError("");
      setFilterOpen(false);
    } catch (filterParseError) {
      setFilterError(filterParseError.message);
    }
  }

  function clearEmailFilter() {
    setEmailFilter([]);
    setFilterText("");
    setSelectedJobIds(new Set());
    setExpandedJobId(null);
    setPage(1);
    setFilterError("");
  }

  function toggleJobSelection(jobId) {
    setSelectedJobIds((current) => {
      const next = new Set(current);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  function toggleAllOnPage() {
    setSelectedJobIds((current) => {
      const next = new Set(current);
      pageJobIds.forEach((id) => {
        if (allPageSelected) next.delete(id);
        else next.add(id);
      });
      return next;
    });
  }

  async function downloadSelected() {
    if (!canDownloadSelected || batchAction) return;
    setBatchAction("download");
    try {
      const response = await fetch("/api/jobs/download-batch", {
        method: "POST",
        headers: { "content-type": "application/json", "x-console-token": token },
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      if (!response.ok) throw new Error((await response.json()).error || "批量下载失败");
      await saveDownloadResponse(response, `sub2api-import-oauth-${downloadableSelectedCount}-accounts-${localTimestamp()}.json`);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function reauthorizeSelected() {
    if (!canReauthorizeSelected || batchAction) return;
    setBatchAction("reauthorize");
    try {
      await apiFetch(token, "/api/jobs/reauthorize-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds], proxyUrl: accountProxyUrl.trim() }),
      });
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function rotateTotpSelected() {
    if (!canRotateTotpSelected || batchAction) return;
    const skipped = selectedJobIds.size - totpRotateSelectedCount;
    if (!window.confirm(`确定更换 ${totpRotateSelectedCount} 个账号的 2FA 吗？\n将验证原 2FA，先关闭再重新启用，每个账号生成独立新密钥并保存。旧验证器将失效；中途失败时可能需要继续设置 2FA。${skipped ? `\n另有 ${skipped} 个账号不符合条件，将跳过。` : ""}`)) return;
    setBatchAction("rotate-2fa");
    try {
      const data = await apiFetch(token, "/api/jobs/rotate-2fa-batch", {
        method: "POST", body: JSON.stringify({ ids: [...selectedJobIds], confirmed: true }),
      });
      setUploadNotice(`已开始为 ${data.started} 个账号更换 2FA，新密钥保存后可导出原始信息${data.skipped ? `，跳过 ${data.skipped} 个账号` : ""}${data.failures?.length ? `；${data.failures[0].error}` : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) { setError(requestError.message); }
    finally { setBatchAction(""); }
  }

  async function setupTotpSelected() {
    if (!canSetupTotpSelected || batchAction) return;
    const skipped = selectedJobIds.size - totpSetupSelectedCount;
    const message = `确定为选中的 ${totpSetupSelectedCount} 个账号设置 2FA 吗？${skipped ? `另有 ${skipped} 个账号不符合条件，将自动跳过。` : ""}`;
    if (!window.confirm(message)) return;
    setBatchAction("setup-2fa");
    try {
      const data = await apiFetch(token, "/api/jobs/setup-2fa-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds], proxyUrl: accountProxyUrl.trim() }),
      });
      setUploadNotice(`已开始为 ${data.started} 个账号设置 2FA${data.skipped ? `，跳过 ${data.skipped} 个` : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function addPasswordSelected() {
    if (!canAddPasswordSelected || batchAction) return;
    const skipped = selectedJobIds.size - passwordAddSelectedCount;
    const message = `确定为选中的 ${passwordAddSelectedCount} 个无密码账号生成并添加随机强密码吗？${skipped ? `另有 ${skipped} 个账号已有密码或不符合条件，将自动跳过。` : ""}`;
    if (!window.confirm(message)) return;
    setBatchAction("add-password");
    try {
      const data = await apiFetch(token, "/api/jobs/add-password-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds], proxyUrl: accountProxyUrl.trim() }),
      });
      setUploadNotice(`已开始为 ${data.started} 个账号添加密码${data.skipped ? `，跳过 ${data.skipped} 个` : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function setPasswordSelected(password) {
    setBatchAction("set-password");
    try {
      const data = await apiFetch(token, "/api/jobs/set-password-batch", {
        method: "POST",
        body: JSON.stringify({ ids: passwordBatchTargets.ids, password, proxyUrl: accountProxyUrl.trim() }),
      });
      setUploadNotice(`已开始为 ${data.started} 个账号设置统一密码${data.skipped ? `，跳过 ${data.skipped} 个当前不可操作的账号` : ""}${data.failures?.length ? `，${data.failures.length} 个账号启动失败：${data.failures[0].error}` : ""}`);
      setSelectedJobIds(new Set());
      setPasswordBatchTargets(null);
      setError("");
    } finally {
      setBatchAction("");
    }
  }

  async function forceReloginSelected() {
    if (!canForceReloginSelected || batchAction) return;
    const skipped = selectedJobIds.size - forceReloginSelectedCount;
    const message = `确定让选中的 ${forceReloginSelectedCount} 个账号跳过刷新令牌，重新登录并授权吗？${skipped ? `另有 ${skipped} 个进行中账号将自动跳过。` : ""}`;
    if (!window.confirm(message)) return;
    setBatchAction("relogin");
    try {
      const data = await apiFetch(token, "/api/jobs/relogin-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds], proxyUrl: accountProxyUrl.trim() }),
      });
      setUploadNotice(`已开始重新登录并授权 ${data.started} 个账号${data.skipped ? `，跳过 ${data.skipped} 个` : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function exportSelectedSource() {
    if (!selectedJobIds.size || batchAction) return;
    setBatchAction("source");
    try {
      const response = await fetch("/api/jobs/export-source", {
        method: "POST",
        headers: { "content-type": "application/json", "x-console-token": token },
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      if (!response.ok) throw new Error((await response.json()).error || "原始信息导出失败");
      await saveDownloadResponse(response, `chatgpt-account-source-${selectedJobIds.size}-accounts-${localTimestamp()}.txt`);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function deleteSelected() {
    if (!selectedJobIds.size || batchAction) return;
    if (!window.confirm(`确定删除选中的 ${selectedJobIds.size} 条任务吗？对应的本地授权文件也会被删除。`)) return;
    setBatchAction("delete");
    try {
      await apiFetch(token, "/api/jobs/delete-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      setJobs((current) => current.filter((job) => !selectedJobIds.has(job.id)));
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function cancelAllRunningJobs() {
    const runningCount = (stats.active || 0) + (stats.queued || 0);
    if (!runningCount || batchAction) return;
    if (!window.confirm(`确定停止全部 ${runningCount} 条进行中和排队任务吗？`)) return;
    setBatchAction("cancel-all");
    try {
      await apiFetch(token, "/api/jobs/cancel-all", { method: "POST" });
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark"><ShieldCheck size={21} strokeWidth={2.2} /></div>
          <div>
            <h1>ChatGPT 账号授权控制台</h1>
            <p>本地多任务协议登录</p>
          </div>
        </div>
        <div className="summary" aria-label="任务统计">
          <span><i className="status-dot active" />进行中 <strong>{stats.active}</strong></span>
          <span><i className="status-dot queued" />排队中 <strong>{stats.queued || 0}</strong></span>
          <span><i className="status-dot complete" />已完成 <strong>{stats.completed}</strong></span>
        </div>
      </header>

      <section className="workspace">
        <div className="section-heading">
          <div>
            <h2>授权任务</h2>
            <p>{emailFilter.length || hasAccountFilters
              ? `匹配 ${pagination.total} 条，共 ${pagination.totalAll ?? pagination.total} 条任务`
              : (pagination.total ? `共 ${pagination.total} 条任务` : "添加邮箱后开始第一条任务")}</p>
          </div>
          <form className="add-form" onSubmit={createJob}>
            <div className="email-field">
              <Mail size={17} aria-hidden="true" />
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="输入邮箱地址"
                autoComplete="email"
                aria-label="邮箱地址"
                required
              />
            </div>
            <button className="primary-button" type="submit" disabled={!token || busy}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}
              添加任务
            </button>
            <button className="secondary-button" type="button" onClick={() => { setBatchError(""); setBatchOpen(true); }} disabled={!token}>
              <ListPlus size={17} />
              批量添加
            </button>
            <button
              className={`secondary-button ${emailFilter.length ? "filter-active" : ""}`}
              type="button"
              onClick={() => { setFilterError(""); setFilterText(emailFilter.join("\n")); setFilterOpen(true); }}
              disabled={!token}
            >
              <Filter size={17} />
              {emailFilter.length ? `筛选 ${emailFilter.length}` : "筛选账号"}
            </button>
            {emailFilter.length > 0 && (
              <button className="selection-text-button clear-filter-button" type="button" onClick={clearEmailFilter}>
                清除筛选
              </button>
            )}
          </form>
        </div>

        <div className="provider-toolbar sms-provider-toolbar" aria-label="接码平台配置">
          <div className="provider-heading"><PhoneIncoming size={17} /><strong>接码平台</strong></div>
          <span className="provider-name">{activeSmsProvider.name || "未选择"}</span>
          <span className={`provider-ready ${activeSmsProvider.ready ? "" : "incomplete"}`}>
            {activeSmsProvider.ready ? <Check size={14} /> : <CircleAlert size={14} />}
            {activeSmsProvider.ready
              ? (activeSmsProvider.summary ? `已配置 · ${activeSmsProvider.summary}` : "已配置")
              : "未完成配置"}
          </span>
          <button type="button" className="secondary-button provider-settings-button" onClick={openSmsSettings} disabled={!smsProviderDefinitions.length}>
            <Settings2 size={16} />配置
          </button>
        </div>

        <div className="provider-toolbar mail-request-toolbar" aria-label="邮件接码请求配置">
          <div className="provider-heading"><MailCheck size={17} /><strong>邮件 API</strong></div>
          <span className="provider-name">{mailRequestSettings.method}</span>
          <span className="provider-ready">
            <Check size={14} />
            {formatMailRequestSummary(mailRequestSettings)}
          </span>
          <button type="button" className="secondary-button provider-settings-button" onClick={openMailRequestSettings} disabled={!token}>
            <Settings2 size={16} />配置
          </button>
        </div>

        <div className="provider-toolbar sub2api-toolbar" aria-label="Sub2API 配置与号池监控">
          <div className="provider-heading"><Send size={17} /><strong>Sub2API</strong></div>
          <span className="provider-name">{sub2apiSettings.baseUrl || "未配置后端"}</span>
          <span className={`provider-ready ${sub2apiSettings.adminApiKey ? "" : "incomplete"}`}>
            {sub2apiSettings.adminApiKey ? <Check size={14} /> : <CircleAlert size={14} />}
            {sub2apiSettings.adminApiKey
              ? `${sub2apiSettings.groupIds.length ? `已配置 · ${sub2apiSettings.groupIds.length} 个号池` : "已配置 · 默认号池"}${sub2apiSettings.proxyId ? " · 已指定代理" : ""}`
              : "未完成配置"}
          </span>
          {features.sub2apiMonitor && (
            <span className={`provider-ready monitor-ready ${sub2apiMonitorStatus.enabled ? "" : "incomplete"}`}>
              {sub2apiMonitorStatus.running
                ? <LoaderCircle className="spin" size={14} />
                : sub2apiMonitorStatus.enabled ? <ShieldCheck size={14} /> : <CircleAlert size={14} />}
              {sub2apiMonitorStatus.running
                ? "正在巡检"
                : sub2apiMonitorStatus.enabled
                  ? `号池监控已启用${sub2apiMonitorStatus.lastCheckAt ? ` · ${formatRelativeMonitorTime(sub2apiMonitorStatus.lastCheckAt)}` : ""}`
                  : "号池监控未启用"}
            </span>
          )}
          {features.sub2apiMonitor && sub2apiMonitorStatus.enabled && (
            <button
              type="button"
              className="icon-button monitor-check-button"
              onClick={checkSub2ApiMonitorNow}
              disabled={sub2apiMonitorChecking || sub2apiMonitorStatus.running}
              title="立即检查 Sub2API 异常账号"
            >
              <RefreshCw className={sub2apiMonitorChecking || sub2apiMonitorStatus.running ? "spin" : ""} size={16} />
            </button>
          )}
          <button type="button" className="secondary-button provider-settings-button" onClick={openSub2ApiSettings} disabled={!token}>
            <Settings2 size={16} />配置
          </button>
        </div>

        <div className="provider-toolbar account-proxy-toolbar" aria-label="代理 IP 配置">
          <div className="provider-heading"><Globe2 size={17} /><strong>代理 IP</strong></div>
          <div className="account-proxy-input">
            <label className="provider-field account-proxy-field" title="支持 http://、https://、socks5:// 和 socks5h://；用户名中包含 -sid- 时会自动轮换会话编号">
              <Globe2 size={15} aria-hidden="true" />
              <input
                value={accountProxyUrl}
                onChange={(event) => setAccountProxyUrl(event.target.value)}
                placeholder="socks5h://用户名:密码@主机:端口"
                spellCheck="false"
                aria-label="代理 IP 地址"
              />
            </label>
          </div>
          <span className={`provider-ready ${accountProxyUrl.trim() ? "" : "incomplete"}`}>
            {accountProxyUrl.trim() ? <Check size={14} /> : <CircleAlert size={14} />}
            {accountProxyUrl.trim() ? "已配置，按账号检测出口" : "未配置，使用本地 IP"}
          </span>
          <a
            className="provider-external-link"
            href="https://invite.zooproxy.com/share/ez2v2jdb7"
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={13} aria-hidden="true" />
            点击获取代理 IP
          </a>
        </div>

        {error && (
          <div className="global-error" role="alert">
            <CircleAlert size={17} />
            <span>{error}</span>
            <button type="button" onClick={() => setError("")} title="关闭"><X size={16} /></button>
          </div>
        )}
        {uploadNotice && (
          <div className="global-success" role="status">
            <Check size={17} />
            <span>{uploadNotice}</span>
            <button type="button" onClick={() => setUploadNotice("")} title="关闭"><X size={16} /></button>
          </div>
        )}

        {features.accountAnnotations && (
          <section className="account-organizer" aria-label="账号分组与筛选">
            <div className="account-type-filters" aria-label="按账号类型筛选">
              {[{ value: "", label: "全部账号" }, ...ACCOUNT_TYPES, { value: "unknown", label: "未标记" }].map(type => (
                <button key={type.value} type="button" className={`account-type-filter ${accountFilters.type === type.value ? "active" : ""}`}
                  aria-pressed={accountFilters.type === type.value} onClick={() => changeAccountFilter("type", type.value)}>
                  {type.label}<span>{type.value ? accountFacets.types[type.value] || 0 : accountFacets.total}</span>
                </button>
              ))}
            </div>
            <div className="account-filter-controls">
              {features.accountStatusFilter && <label><Filter size={15} /><span>状态</span>
                <select aria-label="筛选账号状态" value={accountFilters.status} onChange={event => changeAccountFilter("status", event.target.value)}>
                  <option value="">全部状态</option>
                  {Object.entries(ACCOUNT_STATUS_LABELS).map(([status, label]) => <option key={status} value={status}>{label}（{accountFacets.statuses?.[status] || 0}）</option>)}
                </select>
              </label>}
              <label><Folder size={15} /><span>分组</span>
                <select aria-label="筛选本地分组" value={accountFilters.group === null ? "all" : JSON.stringify(accountFilters.group)}
                  onChange={event => changeAccountFilter("group", event.target.value === "all" ? null : JSON.parse(event.target.value))}>
                  <option value="all">全部分组</option>
                  <option value={'""'}>未分组（{accountFacets.groups.find(group => !group.value)?.count || 0}）</option>
                  {accountFacets.groups.filter(group => group.value).map(group => <option key={group.value} value={JSON.stringify(group.value)}>{group.value}（{group.count}）</option>)}
                </select>
              </label>
              <label><Tags size={15} /><span>标签</span>
                <select aria-label="筛选标签" value={accountFilters.tag} onChange={event => changeAccountFilter("tag", event.target.value)}>
                  <option value="">全部标签</option>
                  {accountFacets.tags.map(tag => <option key={tag.value} value={tag.value}>{tag.value}（{tag.count}）</option>)}
                </select>
              </label>
              <label className="account-search"><Search size={16} />
                <input aria-label="搜索邮箱、分组、标签或备注" placeholder="搜索邮箱、分组、标签、备注" value={accountSearch} onChange={event => setAccountSearch(event.target.value)} maxLength={200} />
              </label>
              {hasAccountFilters && <button type="button" className="selection-text-button" onClick={clearAccountFilters}>清除分类筛选</button>}
            </div>
          </section>
        )}

        {features.bulkActions && jobs.length > 0 && (
          <div className="selection-toolbar">
            <div className="selection-summary">
              <span>当前页 {jobs.length} 条，跨页已选 {selectedJobIds.size} 条，可下载 {downloadableSelectedCount} 条</span>
              <button type="button" className="selection-text-button" onClick={toggleAllOnPage} disabled={allPageSelected || !pageJobIds.length}>
                本页全选
              </button>
              <button type="button" className="selection-text-button" onClick={() => setSelectedJobIds(new Set())} disabled={!selectedJobIds.size}>
                清除选择
              </button>
            </div>
            <div className="bulk-actions">
              {features.accountAnnotations && (
                <button type="button" className="secondary-button bulk-button" disabled={!selectedJobIds.size || Boolean(batchAction)}
                  onClick={() => setAnnotationTargets({ ids: [...selectedJobIds], bulk: true })}>
                  <Tags size={16} />批量标记
                </button>
              )}
              {features.cancelAll && (
                <button
                  type="button"
                  className="stop-all-button"
                  onClick={cancelAllRunningJobs}
                  disabled={!(stats.active || stats.queued) || Boolean(batchAction)}
                >
                  {batchAction === "cancel-all" ? <LoaderCircle className="spin" size={16} /> : <Ban size={16} />}
                  停止全部
                </button>
              )}
              <button type="button" className="download-button" onClick={downloadSelected} disabled={!canDownloadSelected || Boolean(batchAction)}>
                {batchAction === "download" ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
                批量下载
              </button>
              {features.sub2apiUpload && (
                <button type="button" className="secondary-button bulk-button" onClick={() => uploadSelected([...selectedJobIds])} disabled={!canUploadSelected || Boolean(batchAction)}>
                  {batchAction === "upload" ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
                  上传到 Sub2API
                </button>
              )}
              {features.sourceExport && (
                <button type="button" className="secondary-button bulk-button" onClick={exportSelectedSource} disabled={!selectedJobIds.size || Boolean(batchAction)}>
                  {batchAction === "source" ? <LoaderCircle className="spin" size={16} /> : <FileText size={16} />}
                  导出原始信息
                </button>
              )}
              <button type="button" className="regenerate-button bulk-button" onClick={reauthorizeSelected} disabled={!canReauthorizeSelected || Boolean(batchAction)}>
                {batchAction === "reauthorize" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
                批量重新授权
              </button>
              {features.forceRelogin && (
                <button type="button" className="relogin-button bulk-button" onClick={forceReloginSelected} disabled={!canForceReloginSelected || Boolean(batchAction)}>
                  {batchAction === "relogin" ? <LoaderCircle className="spin" size={16} /> : <LogIn size={16} />}
                  批量重新登录并授权
                </button>
              )}
              {features.totpSetup && (
                <button type="button" className="secondary-button bulk-button" onClick={setupTotpSelected} disabled={!canSetupTotpSelected || Boolean(batchAction)}>
                  {batchAction === "setup-2fa" ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
                  批量设置 2FA
                </button>
              )}
              {features.totpRotate && (
                <button type="button" className="secondary-button bulk-button" onClick={rotateTotpSelected}
                  disabled={!canRotateTotpSelected || Boolean(batchAction)} title="为已有 2FA 且已保存原密钥的账号更换验证器">
                  {batchAction === "rotate-2fa" ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}
                  批量更换 2FA
                </button>
              )}
              {features.passwordAdd && (
                <button type="button" className="secondary-button bulk-button" onClick={addPasswordSelected} disabled={!canAddPasswordSelected || Boolean(batchAction)}>
                  {batchAction === "add-password" ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
                  批量添加密码
                </button>
              )}
              {features.passwordSet && (
                <button type="button" className="secondary-button bulk-button"
                  onClick={() => setPasswordBatchTargets({ ids: [...selectedJobIds], count: passwordSetSelectedCount })}
                  disabled={!canSetPasswordSelected || Boolean(batchAction)}>
                  {batchAction === "set-password" ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
                  批量设置统一密码
                </button>
              )}
              <button type="button" className="delete-button" onClick={deleteSelected} disabled={!selectedJobIds.size || Boolean(batchAction)}>
                {batchAction === "delete" ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
                批量删除
              </button>
            </div>
          </div>
        )}

        <div className="table-frame">
          <table>
            <thead>
              <tr>
                <th className="select-heading">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={toggleAllOnPage}
                    disabled={!features.bulkActions || !pageJobIds.length}
                    aria-label="选择当前页全部任务"
                  />
                </th>
                <th>账号</th>
                <th>状态</th>
                <th>当前操作</th>
                <th>开始时间</th>
                <th>最近操作时间</th>
                <th className="actions-heading">操作</th>
              </tr>
            </thead>
            <tbody>
              {!jobs.length && <EmptyState filtered={emailFilter.length > 0 || hasAccountFilters} />}
              {jobs.map((job) => (
                <React.Fragment key={job.id}>
                  <JobRow
                    job={job}
                    token={token}
                    expanded={expandedJobId === job.id}
                    onToggleLogs={() => setExpandedJobId((current) => current === job.id ? null : job.id)}
                    onError={setError}
                    selected={selectedJobIds.has(job.id)}
                    onToggleSelected={() => toggleJobSelection(job.id)}
                    selectionSupported={Boolean(features.bulkActions)}
                    smsProviderAvailable={smsProviderDefinitions.length > 0}
                    smsProvider={activeSmsProvider}
                    onUpload={() => uploadSelected([job.id])}
                    sub2apiUploadAvailable={Boolean(features.sub2apiUpload && sub2apiSettings.baseUrl && sub2apiSettings.adminApiKey)}
                    totpSetupAvailable={Boolean(features.totpSetup)}
                    passwordAddAvailable={Boolean(features.passwordAdd)}
                    logoutAllAvailable={Boolean(features.logoutAllDevices)}
                    forceReloginAvailable={Boolean(features.forceRelogin)}
                    accountProxyUrl={accountProxyUrl}
                    onEditAnnotations={features.accountAnnotations ? () => setAnnotationTargets({ ids: [job.id], email: job.email, initial: job.annotations, bulk: false }) : null}
                    onChangeEmail={features.emailChange ? () => setEmailChangeTarget(job) : null}
                  />
                  {expandedJobId === job.id && (
                    <tr className="log-row">
                      <td colSpan="7"><JobLogs token={token} jobId={job.id} /></td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {features.pagination && pagination.totalPages > 1 && (
          <nav className="pagination" aria-label="任务分页">
            <button type="button" className="icon-button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1} title="上一页">
              <ChevronLeft size={17} />
            </button>
            <span>第 <strong>{pagination.page}</strong> / {pagination.totalPages} 页</span>
            <button type="button" className="icon-button" onClick={() => setPage((current) => Math.min(pagination.totalPages, current + 1))} disabled={page >= pagination.totalPages} title="下一页">
              <ChevronRight size={17} />
            </button>
          </nav>
        )}
      </section>
      {smsSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSmsSettingsOpen(false);
        }}>
          <form className="batch-dialog sms-settings-dialog" onSubmit={saveSmsSettings} role="dialog" aria-modal="true" aria-labelledby="sms-settings-title">
            <div className="dialog-header">
              <div>
                <h2 id="sms-settings-title">接码平台配置</h2>
                <span>配置保存在当前浏览器</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setSmsSettingsOpen(false)} title="关闭">
                <X size={18} />
              </button>
            </div>

            <div className="provider-tabs" role="tablist" aria-label="选择接码平台">
              {smsProviderDefinitions.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  role="tab"
                  aria-selected={draftSmsProvider.id === provider.id}
                  className={draftSmsProvider.id === provider.id ? "active" : ""}
                  onClick={() => {
                    setSmsSettingsDraft((current) => withSmsProviderDefaults(smsProviderDefinitions, {
                      ...current,
                      selectedProviderId: provider.id,
                    }));
                    setSmsSettingsError("");
                  }}
                >
                  {provider.name}
                </button>
              ))}
            </div>

            {draftSmsProvider.definition && (
              <div className="provider-config-section">
                <div className="provider-description-row">
                  <div className="provider-description">{draftSmsProvider.definition.description}</div>
                  {SMS_PROVIDER_EXTERNAL_LINKS[draftSmsProvider.id] && (
                    <a
                      className="provider-external-link"
                      href={SMS_PROVIDER_EXTERNAL_LINKS[draftSmsProvider.id].href}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={13} aria-hidden="true" />
                      {SMS_PROVIDER_EXTERNAL_LINKS[draftSmsProvider.id].label}
                    </a>
                  )}
                </div>
                <div className="provider-config-grid">
                  {draftSmsProvider.definition.fields.filter((field) => field.type !== "hidden").map((field) => (
                    <label key={field.key} className={`settings-field ${["price-select", "textarea"].includes(field.type) ? "wide-settings-field" : ""}`}>
                      <span>{field.label}</span>
                      {field.type === "price-select" ? (
                        <div className="price-select-row">
                          <div className="price-select-box">
                            <Settings2 size={15} />
                            <select
                              value={draftSmsProvider.config.country || ""}
                              onChange={(event) => {
                                const selected = smsNumberOptions.find((option) => option.country === event.target.value);
                                if (!selected) return;
                                updateSmsProviderConfig(draftSmsProvider.id, {
                                  country: selected.country,
                                  maxPrice: String(selected.price),
                                  countryLabel: formatSmsCountryName(selected),
                                });
                              }}
                              disabled={!smsNumberOptions.length || smsOptionsLoading}
                              aria-label="SMSBower 国家与价格"
                            >
                              {!smsNumberOptions.length && (
                                <option value={draftSmsProvider.config.country || ""}>
                                  {smsOptionsLoading ? "正在查询实时价格..." : "请先查询实时价格"}
                                </option>
                              )}
                              {smsNumberOptions.map((option) => (
                                <option key={option.country} value={option.country}>{formatSmsPriceOption(option)}</option>
                              ))}
                            </select>
                          </div>
                          <button
                            type="button"
                            className="price-refresh-button"
                            onClick={() => loadSmsNumberOptions()}
                            disabled={smsOptionsLoading || !draftSmsProvider.config.apiKey}
                          >
                            {smsOptionsLoading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                            {smsOptionsLoading ? "查询中" : "查询价格"}
                          </button>
                        </div>
                      ) : field.type === "textarea" ? (
                        <textarea
                          className="settings-textarea"
                          value={draftSmsProvider.config[field.key] || ""}
                          onChange={(event) => updateSmsProviderConfig(draftSmsProvider.id, { [field.key]: event.target.value })}
                          placeholder={field.placeholder}
                          rows="8"
                          autoComplete="off"
                          spellCheck="false"
                        />
                      ) : (
                        <div>
                          {field.type === "password" ? <KeyRound size={15} /> : <Settings2 size={15} />}
                          <input
                            type={field.type || "text"}
                            value={draftSmsProvider.config[field.key] || ""}
                            onChange={(event) => updateSmsProviderConfig(draftSmsProvider.id, { [field.key]: event.target.value })}
                            placeholder={field.placeholder}
                            autoComplete="off"
                            spellCheck="false"
                          />
                        </div>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {smsSettingsError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{smsSettingsError}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setSmsSettingsOpen(false)}>取消</button>
              <button type="submit" className="primary-button" disabled={!draftSmsProvider.definition}>
                <Check size={17} />保存配置
              </button>
            </div>
          </form>
        </div>
      )}
      {mailRequestSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !mailRequestSettingsSaving) setMailRequestSettingsOpen(false);
        }}>
          <form className="batch-dialog mail-request-settings-dialog" onSubmit={saveMailRequestSettings} role="dialog" aria-modal="true" aria-labelledby="mail-request-settings-title">
            <div className="dialog-header">
              <div>
                <h2 id="mail-request-settings-title">邮件 API 请求配置</h2>
                <span>配置保存在当前浏览器，请求内容不会写入任务日志</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setMailRequestSettingsOpen(false)} disabled={mailRequestSettingsSaving} title="关闭">
                <X size={18} />
              </button>
            </div>

            <div className="provider-tabs mail-method-tabs" role="tablist" aria-label="邮件 API 请求方式">
              {["GET", "POST"].map((method) => (
                <button
                  key={method}
                  type="button"
                  role="tab"
                  aria-selected={mailRequestSettingsDraft.method === method}
                  className={mailRequestSettingsDraft.method === method ? "active" : ""}
                  onClick={() => setMailRequestSettingsDraft((current) => ({ ...current, method }))}
                >
                  {method}
                </button>
              ))}
            </div>

            <div className="provider-config-grid mail-request-config-grid">
              {mailRequestSettingsDraft.method === "POST" && (
                <label className="settings-field wide-settings-field">
                  <span className="mail-request-url-label">
                    统一 POST 请求 URL
                    <small>必填</small>
                  </span>
                  <input
                    className="mail-request-url-input"
                    type="url"
                    value={mailRequestSettingsDraft.url}
                    onChange={(event) => setMailRequestSettingsDraft((current) => ({ ...current, url: event.target.value }))}
                    placeholder="https://mail.example/api/messages"
                    autoComplete="off"
                    spellCheck="false"
                  />
                  <small>每个账号自己的请求体请在批量添加账号时一并导入</small>
                </label>
              )}
              <label className="settings-field wide-settings-field">
                <span>请求头 JSON</span>
                <textarea
                  className="settings-textarea"
                  value={mailRequestSettingsDraft.headersText}
                  onChange={(event) => setMailRequestSettingsDraft((current) => ({ ...current, headersText: event.target.value }))}
                  placeholder={'{"Authorization":"Bearer ...","Referer":"https://mail.example/"}'}
                  rows="7"
                  autoComplete="off"
                  spellCheck="false"
                />
              </label>
            </div>

            {mailRequestSettingsError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{mailRequestSettingsError}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setMailRequestSettingsOpen(false)} disabled={mailRequestSettingsSaving}>取消</button>
              <button type="submit" className="primary-button" disabled={mailRequestSettingsSaving || !token}>
                {mailRequestSettingsSaving ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
                保存配置
              </button>
            </div>
          </form>
        </div>
      )}
      {sub2apiSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSub2apiSettingsOpen(false);
        }}>
          <form className="batch-dialog sub2api-settings-dialog" onSubmit={saveSub2ApiSettings} role="dialog" aria-modal="true" aria-labelledby="sub2api-settings-title">
            <div className="dialog-header">
              <div>
                <h2 id="sub2api-settings-title">Sub2API 配置</h2>
                <span>管理员 Key 不写入任务文件或日志；启用监控后由本机服务保存</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setSub2apiSettingsOpen(false)} title="关闭"><X size={18} /></button>
            </div>
            <div className="provider-config-grid sub2api-config-grid">
              <label className="settings-field wide-settings-field">
                <span>Sub2API 后端地址</span>
                <input
                  type="url"
                  value={sub2apiSettingsDraft.baseUrl}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                  placeholder="例如 http://127.0.0.1:8080"
                  autoComplete="url"
                />
              </label>
              {features.sub2apiMonitor && (
                <label className="settings-field wide-settings-field sub2api-monitor-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(sub2apiSettingsDraft.monitorEnabled)}
                    onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, monitorEnabled: event.target.checked }))}
                  />
                  <span>
                    <strong>每 5 分钟监控异常账号</strong>
                    <small>只自动处理上次完整登录未人工输入密码、邮箱码或登录 2FA 的任务</small>
                  </span>
                </label>
              )}
              <label className="settings-field wide-settings-field">
                <span>管理员 API Key</span>
                <input
                  type="password"
                  value={sub2apiSettingsDraft.adminApiKey}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, adminApiKey: event.target.value }))}
                  placeholder="输入 sub2api 管理员 API Key"
                  autoComplete="off"
                />
              </label>
              <fieldset className="settings-field wide-settings-field sub2api-group-field">
                <legend>目标号池（可多选）</legend>
                <section className="sub2api-group-picker" aria-label="目标号池">
                  {sub2apiGroups.length ? sub2apiGroups.map((group) => {
                    const groupId = String(group.id);
                    return (
                      <label key={group.id} className="sub2api-group-option">
                        <input
                          type="checkbox"
                          checked={sub2apiSettingsDraft.groupIds.includes(groupId)}
                          onChange={(event) => setSub2ApiGroupChecked(groupId, event.target.checked)}
                        />
                        <span>{group.name}</span>
                        <small>ID: {group.id}</small>
                      </label>
                    );
                  }) : <div className="sub2api-group-empty">暂无可选号池</div>}
                </section>
                <section className="sub2api-group-selection" aria-label="号池选择操作">
                  <span>已选 {sub2apiSettingsDraft.groupIds.length} 个</span>
                  <button
                    type="button"
                    onClick={() => setSub2apiSettingsDraft((current) => ({ ...current, groupIds: sub2apiGroups.map((group) => String(group.id)) }))}
                    disabled={!sub2apiGroups.length || sub2apiGroups.every((group) => sub2apiSettingsDraft.groupIds.includes(String(group.id)))}
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    onClick={() => setSub2apiSettingsDraft((current) => ({ ...current, groupIds: [] }))}
                    disabled={!sub2apiSettingsDraft.groupIds.length}
                  >
                    清空
                  </button>
                </section>
              </fieldset>
              <label className="settings-field wide-settings-field">
                <span>代理 IP</span>
                <select
                  value={sub2apiSettingsDraft.proxyId}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, proxyId: event.target.value }))}
                >
                  <option value="">使用账号原配置</option>
                  {sub2apiProxies.map((proxy) => <option key={proxy.id} value={String(proxy.id)}>{formatSub2ApiProxy(proxy)}</option>)}
                </select>
              </label>
              <label className="settings-field wide-settings-field">
                <span>Codex 指纹收敛</span>
                <select
                  value={sub2apiSettingsDraft.codexFingerprintMode}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, codexFingerprintMode: event.target.value }))}
                >
                  <option value="off">关闭（透传）</option>
                  <option value="device">仅设备</option>
                  <option value="session">设备+会话（推荐）</option>
                  <option value="full">完全收敛</option>
                </select>
              </label>
              <label className="settings-field">
                <span>并发数</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="1"
                  value={sub2apiSettingsDraft.concurrency}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, concurrency: event.target.value }))}
                  placeholder="留空使用账号原值"
                />
              </label>
              <label className="settings-field">
                <span>负载因子</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="1"
                  value={sub2apiSettingsDraft.loadFactor}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, loadFactor: event.target.value }))}
                  placeholder="留空使用账号原值"
                />
              </label>
              <label className="settings-field">
                <span>优先级</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="1"
                  value={sub2apiSettingsDraft.priority}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, priority: event.target.value }))}
                  placeholder="留空使用账号原值"
                />
              </label>
              <label className="settings-field wide-settings-field">
                <span>允许使用的模型</span>
                <textarea
                  className="sub2api-model-textarea"
                  value={sub2apiSettingsDraft.modelWhitelist}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, modelWhitelist: event.target.value }))}
                  placeholder={"每行一个模型，也支持逗号分隔，例如：\ngpt-5\ngpt-5-mini\ngpt-4.1"}
                  rows="5"
                  spellCheck="false"
                />
              </label>
            </div>
            <div className="dialog-hint">分组为空时，上传使用 Sub2API 默认号池，监控检查全部 OpenAI 账号；选择分组后只监控这些号池。Codex 指纹收敛会写入每个上传或巡检更新的 OpenAI OAuth 账号。</div>
            {features.sub2apiMonitor && sub2apiMonitorStatus.configured && (
              <div className={`sub2api-monitor-status ${sub2apiMonitorStatus.lastError ? "error" : ""}`}>
                <ShieldCheck size={15} />
                <span>{sub2apiMonitorStatus.lastError
                  ? `上次巡检失败：${sub2apiMonitorStatus.lastError}`
                  : sub2apiMonitorStatus.lastCheckAt
                    ? formatMonitorResult(sub2apiMonitorStatus.lastResult)
                    : "尚未执行号池巡检"}</span>
              </div>
            )}
            {sub2apiSettingsError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{sub2apiSettingsError}</div>}
            <div className="dialog-actions sub2api-dialog-actions">
              <button type="button" className="secondary-button" onClick={() => loadSub2ApiOptions()} disabled={sub2apiGroupsLoading || !token}>
                {sub2apiGroupsLoading ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}读取配置
              </button>
              {features.sub2apiMonitor && sub2apiMonitorStatus.enabled && (
                <button type="button" className="secondary-button" onClick={checkSub2ApiMonitorNow} disabled={sub2apiMonitorChecking || sub2apiMonitorStatus.running}>
                  {sub2apiMonitorChecking || sub2apiMonitorStatus.running ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}立即检查
                </button>
              )}
              <span className="dialog-actions-spacer" />
              <button type="button" className="cancel-button" onClick={() => setSub2apiSettingsOpen(false)} disabled={sub2apiSettingsSaving}>取消</button>
              <button type="submit" className="primary-button" disabled={sub2apiSettingsSaving}>
                {sub2apiSettingsSaving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存配置
              </button>
            </div>
          </form>
        </div>
      )}
      {passwordBatchTargets && <BatchPasswordDialog targets={passwordBatchTargets} onSubmit={setPasswordSelected} onClose={() => setPasswordBatchTargets(null)} />}
      {annotationTargets && <AccountAnnotationsDialog targets={annotationTargets} groups={accountFacets.groups}
        onSubmit={saveAnnotations} onClose={() => setAnnotationTargets(null)} />}
      {emailChangeTarget && <EmailChangeDialog job={emailChangeTarget} token={token}
        syncAvailable={sub2apiMonitorStatus.configured} onClose={() => setEmailChangeTarget(null)}
        onStarted={() => { setEmailChangeTarget(null); setRefreshVersion(current => current + 1); }} />}
      {batchOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !batchBusy) setBatchOpen(false);
        }}>
          <form className="batch-dialog" onSubmit={createBatch} role="dialog" aria-modal="true" aria-labelledby="batch-title">
            <div className="dialog-header">
              <div>
                <h2 id="batch-title">批量添加账号</h2>
                <span>{countBatchLines(batchText)} 条，超出并发上限后自动排队</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setBatchOpen(false)} disabled={batchBusy} title="关闭">
                <X size={18} />
              </button>
            </div>
            <label className="batch-label" htmlFor="batch-input">
              {mailRequestSettings.method === "POST"
                ? "每行：邮箱----编码请求体，或 邮箱----密码----编码请求体；邮箱及可识别字段顺序不限"
                : "每行一个账号：自动识别邮箱、密码、邮件 API 和 2FA，字段顺序不限"}
            </label>
            <textarea
              id="batch-input"
              value={batchText}
              onChange={(event) => setBatchText(event.target.value)}
              placeholder={mailRequestSettings.method === "POST"
                ? "a@example.com----eyJtYWlsYm94X2lkIjoiaWQtYSJ9\nb@example.com----账号密码----mailbox_id%3Did-b"
                : "name@icloud.com----https://mail.example/messages/name\nhttps://mail.example/messages/name2|账号密码|name2@example.co.uk|BASE32二步验证密钥\nBASE32二步验证密钥::name3@example.dev::账号密码"}
              spellCheck="false"
              autoFocus
            />
            {features.accountAnnotations && <><fieldset className="import-annotations">
              <legend><Tags size={15} />本批账号标记（可选）</legend>
              <AccountAnnotationFields value={batchAnnotations} onChange={(key, value) => setBatchAnnotations(current => ({ ...current, [key]: value }))}
                prefix="import" groups={accountFacets.groups} disabled={batchBusy} />
              <p className="dialog-hint">应用于本次导入的账号；留空不覆盖已有标记。授权记录未能识别的类型，可按已知账号信息填写。</p>
            </fieldset>
            <details className="annotation-import-help"><summary>每行需要不同的标签或备注？</summary>
              <p>支持每行一个 JSON 对象，行内标记优先于上面的批量标记。已有账号只填写 email 和 annotations 时，仅更新标记。</p>
              <code>{'{"email":"name@example.com","password":"账号密码","annotations":{"type":"5x","group":"工作号","tags":["新入库"],"note":"到期后续费"}}'}</code>
            </details></>}
            {batchError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{batchError}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setBatchOpen(false)} disabled={batchBusy}>取消</button>
              <button type="submit" className="primary-button" disabled={!batchText.trim() || batchBusy || countBatchLines(batchText) > 500}>
                {batchBusy ? <LoaderCircle className="spin" size={17} /> : <ListPlus size={17} />}
                创建 {countBatchLines(batchText) || ""} 条任务
              </button>
            </div>
          </form>
        </div>
      )}
      {filterOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setFilterOpen(false);
        }}>
          <form className="batch-dialog filter-dialog" onSubmit={applyEmailFilter} role="dialog" aria-modal="true" aria-labelledby="filter-title">
            <div className="dialog-header">
              <div>
                <h2 id="filter-title">筛选账号</h2>
                <span>{countBatchLines(filterText)} 个邮箱</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setFilterOpen(false)} title="关闭">
                <X size={18} />
              </button>
            </div>
            <label className="batch-label" htmlFor="filter-input">每行输入一个完整邮箱地址</label>
            <textarea
              id="filter-input"
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              placeholder={"name1@icloud.com\nname2@icloud.com"}
              spellCheck="false"
              autoFocus
            />
            {filterError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{filterError}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setFilterOpen(false)}>取消</button>
              <button type="submit" className="primary-button" disabled={!filterText.trim() || countBatchLines(filterText) > 500}>
                <Filter size={17} />应用筛选
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

function AccountAnnotationFields({ value, onChange, prefix, groups = [], disabled = false, enabled, onToggle }) {
  const fieldLabel = (key, label) => enabled
    ? <label className="annotation-field-label"><input type="checkbox" checked={enabled[key]} onChange={event => onToggle(key, event.target.checked)} disabled={disabled} aria-label={`修改${label}`} />{label}</label>
    : <label className="annotation-field-label" htmlFor={`${prefix}-${key}`}>{label}</label>;
  const inactive = key => disabled || (enabled && !enabled[key]);
  return <div className="annotation-fields">
    <div className="annotation-field">
      {fieldLabel("type", "账号类型")}
      <select id={`${prefix}-type`} aria-label="账号类型" value={value.type} onChange={event => onChange("type", event.target.value)} disabled={inactive("type")}>
        <option value="">自动 / 未标记</option>
        {ACCOUNT_TYPES.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}
      </select>
    </div>
    <div className="annotation-field">
      {fieldLabel("group", "本地分组")}
      <input id={`${prefix}-group`} aria-label="本地分组" list={`${prefix}-groups`} value={value.group} onChange={event => onChange("group", event.target.value)} disabled={inactive("group")} maxLength={60} placeholder="选择已有分组，或输入新分组" />
      <datalist id={`${prefix}-groups`}>{groups.filter(group => group.value).map(group => <option key={group.value} value={group.value} />)}</datalist>
    </div>
    <div className="annotation-field annotation-field-wide">
      {fieldLabel("tags", "标签")}
      <input id={`${prefix}-tags`} aria-label="标签" value={value.tags} onChange={event => onChange("tags", event.target.value)} disabled={inactive("tags")} maxLength={500} placeholder="例如：新入库, 待续费, 主力号" />
      <small>用逗号分隔，最多 12 个标签，每个标签最多 30 个字符。</small>
    </div>
    <div className="annotation-field annotation-field-wide">
      {fieldLabel("note", "备注")}
      <textarea id={`${prefix}-note`} aria-label="备注" value={value.note} onChange={event => onChange("note", event.target.value)} disabled={inactive("note")} maxLength={1000} rows={3} placeholder="例如：购买批次、用途、到期时间" />
    </div>
  </div>;
}

function AccountAnnotationsDialog({ targets, groups, onSubmit, onClose }) {
  const dialog = useRef(null);
  const [value, setValue] = useState(() => ({ ...EMPTY_ANNOTATION_FORM, ...targets.initial, tags: targets.initial?.tags?.join(", ") || "" }));
  const [enabled, setEnabled] = useState({ type: false, group: false, tags: false, note: false });
  const [dirty, setDirty] = useState(() => new Set());
  const [tagsMode, setTagsMode] = useState("append");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);
  const keys = targets.bulk ? Object.keys(enabled).filter(key => enabled[key]) : [...dirty];
  async function submit(event) {
    event.preventDefault();
    if (busy || !keys.length) return;
    setBusy(true);
    try {
      await onSubmit(normalizeAnnotationsPatch(Object.fromEntries(keys.map(key => [key, value[key]]))), targets.bulk ? tagsMode : "replace");
    } catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="batch-dialog annotation-dialog" aria-labelledby="annotation-title"
    onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}>
    <form onSubmit={submit}>
      <div className="dialog-header"><div><h2 id="annotation-title">{targets.bulk ? "批量标记账号" : "账号标记"}</h2></div>
        <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭账号标记"><X size={18} /></button>
      </div>
      <p className="annotation-dialog-description">{targets.bulk ? `已选 ${targets.ids.length} 个账号。勾选需要更新的项目，留空可清空该项。` : targets.email}</p>
      <AccountAnnotationFields value={value} prefix="edit-annotation" groups={groups} disabled={busy}
        enabled={targets.bulk ? enabled : undefined} onToggle={(key, checked) => setEnabled(current => ({ ...current, [key]: checked }))}
        onChange={(key, next) => { setValue(current => ({ ...current, [key]: next })); setDirty(current => new Set([...current, key])); setError(""); }} />
      {targets.bulk && enabled.tags && <label className="annotation-tag-mode">标签更新方式
        <select aria-label="标签更新方式" value={tagsMode} onChange={event => setTagsMode(event.target.value)} disabled={busy}>
          <option value="append">追加到已有标签</option><option value="replace">替换已有标签（留空则清空）</option>
        </select>
      </label>}
      <p className="dialog-hint">手动类型优先显示；选择“自动 / 未标记”后沿用已有授权记录。未识别的类型可手动补充。</p>
      {error && <div className="dialog-error" role="alert">{error}</div>}
      <div className="dialog-footer">
        <button type="button" className="cancel-button" onClick={onClose} disabled={busy}>取消</button>
        <button type="submit" className="primary-button" disabled={busy || !keys.length}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存标记</button>
      </div>
    </form>
  </dialog>;
}

function EmailChangeDialog({ job, token, syncAvailable, onClose, onStarted }) {
  const dialog = useRef(null);
  const [newEmail, setNewEmail] = useState("");
  const [mailApiUrl, setMailApiUrl] = useState("");
  const [syncSub2api, setSyncSub2api] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    if (newEmail.trim().toLowerCase() === job.email.toLowerCase()) {
      setError("新邮箱不能与原邮箱相同");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await apiFetch(token, `/api/jobs/${job.id}/change-email`, { method: "POST",
        body: JSON.stringify({ newEmail: newEmail.trim(), mailApiUrl: mailApiUrl.trim(), syncSub2api, confirmed: true }) });
      onStarted();
    } catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="batch-dialog annotation-dialog email-change-dialog" aria-labelledby="email-change-title"
    onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}>
    <form onSubmit={submit}>
      <div className="dialog-header"><div><h2 id="email-change-title">换绑邮箱</h2></div>
        <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭换绑邮箱"><X size={18} /></button>
      </div>
      <p className="annotation-dialog-description">原邮箱：<strong>{job.email}</strong></p>
      <div className="email-change-eligibility">
        <ShieldCheck size={17} />
        <div><strong>资格待检查</strong><p>Plus、Team、5x、10x、25x 是套餐或本地类型标记，不能据此判断是否支持换绑。验证原账号后会先检查平台资格；不允许或无法确认时立即停止，不发送新邮箱验证码。</p></div>
      </div>
      <div className="annotation-fields">
        <div className="annotation-field annotation-field-wide">
          <label className="annotation-field-label" htmlFor="email-change-address">新邮箱</label>
          <input id="email-change-address" type="email" autoComplete="off" required maxLength={254} autoFocus
            value={newEmail} onChange={event => setNewEmail(event.target.value)} disabled={busy} placeholder="你可以接收验证码的新邮箱" />
        </div>
        <div className="annotation-field annotation-field-wide">
          <label className="annotation-field-label" htmlFor="email-change-mail-api">新邮箱收码地址（可选）</label>
          <input id="email-change-mail-api" type="url" autoComplete="off" value={mailApiUrl}
            onChange={event => setMailApiUrl(event.target.value)} disabled={busy} placeholder="https://mail.example/messages/…" />
          <small>仅支持 GET 收码地址。留空时，在账号列表中手动输入新邮箱验证码。</small>
        </div>
      </div>
      <label className="email-change-sync"><input type="checkbox" checked={syncSub2api}
        onChange={event => setSyncSub2api(event.target.checked)} disabled={busy || !syncAvailable} />同步更新已关联的 Sub2API 账号</label>
      {!syncAvailable && <p className="dialog-hint">配置 Sub2API 后可选同步已有账号。</p>}
      <p className="dialog-hint">确认后将验证原账号、新邮箱及账号身份，成功后保存新邮箱并重新授权。原密码、2FA、分组、标签和备注会保留；登录时仍可能需要原邮箱或 2FA 验证码。</p>
      {error && <div className="dialog-error" role="alert">{error}</div>}
      <div className="dialog-footer">
        <button type="button" className="cancel-button" onClick={onClose} disabled={busy}>取消</button>
        <button type="submit" className="primary-button" disabled={busy || !newEmail.trim()}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <MailCheck size={16} />}检查资格并开始换绑
        </button>
      </div>
    </form>
  </dialog>;
}

function BatchPasswordDialog({ targets, onSubmit, onClose }) {
  const dialog = useRef(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setError("");
    try {
      validateAccountPassword(password);
      setBusy(true);
      await onSubmit(password);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} className="batch-dialog password-batch-dialog" aria-labelledby="password-batch-title"
      onCancel={(event) => { if (busy) event.preventDefault(); else onClose(); }}>
      <form onSubmit={submit}>
        <div className="dialog-header">
          <div><h2 id="password-batch-title">批量设置统一密码</h2></div>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭"><X size={18} /></button>
        </div>
        <p>为 {targets.count} 个账号设置同一个密码。没有密码的账号会添加密码，已有密码的账号会改为新密码。</p>
        {targets.ids.length > targets.count && <p className="password-batch-hint">另有 {targets.ids.length - targets.count} 个账号当前不可操作，将跳过。</p>}
        <label className="batch-label" htmlFor="batch-new-password">新密码</label>
        <input id="batch-new-password" type="password" value={password} onChange={(event) => { setPassword(event.target.value); setError(""); }}
          autoComplete="new-password" minLength={12} maxLength={128} required autoFocus disabled={busy} aria-describedby="batch-password-hint" />
        <p id="batch-password-hint" className="password-batch-hint">12–128 个字符，包含大写字母、小写字母、数字和符号。</p>
        {error && <div className="dialog-error" role="alert">{error}</div>}
        <div className="dialog-footer">
          <button type="button" className="cancel-button" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className="primary-button" disabled={busy || !password}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}确认设置
          </button>
        </div>
      </form>
    </dialog>
  );
}

function EmptyState({ filtered = false }) {
  return (
    <tr>
      <td colSpan="7">
        <div className="empty-state">
          <div><Mail size={24} /></div>
          <h3>{filtered ? "没有匹配账号" : "暂无授权任务"}</h3>
          <p>{filtered ? "当前筛选邮箱不在任务列表中。" : "在右上方输入邮箱地址开始登录。"}</p>
        </div>
      </td>
    </tr>
  );
}

export function JobRow({ job, token, expanded, onToggleLogs, onError, selected, onToggleSelected, selectionSupported, smsProviderAvailable, smsProvider, onUpload, sub2apiUploadAvailable, totpSetupAvailable, passwordAddAvailable, forceReloginAvailable, accountProxyUrl, logoutAllAvailable, onEditAnnotations, onChangeEmail }) {
  const [value, setValue] = useState("");
  const [inputError, setInputError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const logoutOperationId = useRef(null);
  const inputErrorId = `job-input-error-${job.id}`;

  useEffect(() => {
    setValue("");
    setInputError("");
  }, [job.status]);

  async function continueEmailChange(action) {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/${action}`, { method: "POST" });
      onError("");
    } catch (requestError) { onError(requestError.message); }
    finally { setSubmitting(false); }
  }

  async function sendInput(action, submittedValue = value) {
    if (submitting) return;
    const inputValue = action === "new_email_otp" ? submittedValue.trim() : submittedValue;
    if (action === "new_email_otp" && !/^\d{6}$/.test(inputValue)) {
      setInputError("新邮箱验证码必须是 6 位数字");
      return;
    }
    setInputError("");
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/input`, {
        method: "POST",
        body: JSON.stringify({ action, value: inputValue }),
      });
      setValue("");
      onError("");
    } catch (requestError) {
      setInputError(requestError.message || "提交失败，请重试");
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/cancel`, { method: "POST" });
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function retry() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/retry`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function regenerate() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/regenerate`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function forceRelogin() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/relogin`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function setupTotp() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/setup-2fa`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function addPassword() {
    if (!window.confirm("确定为该账号生成并添加随机强密码吗？成功后会自动更新账号原始信息。")) return;
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/add-password`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function logoutAllDevices() {
    if (submitting || !job.canLogoutAllDevices) return;
    if (!window.confirm(`确定将 ${job.email} 登出所有设备吗？\n这将停止当前登录任务并暂停自动重登。`)) return;
    setSubmitting(true);
    try {
      logoutOperationId.current ||= crypto.randomUUID();
      await apiFetch(token, `/api/jobs/${job.id}/logout-all`, {
        method: "POST",
        body: JSON.stringify({ confirmed: true, operationId: logoutOperationId.current, proxyUrl: accountProxyUrl.trim() }),
      });
      logoutOperationId.current = null;
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function copyTotpSecret() {
    try {
      await navigator.clipboard.writeText(job.totpSetupSecret || "");
      onError("");
    } catch {
      onError("无法自动复制，请手动选择 2FA 密钥");
    }
  }

  async function requestSmsNumber() {
    if (!smsProvider.ready) return;
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/sms-number`, {
        method: "POST",
        body: JSON.stringify({ providerId: smsProvider.id, config: smsProvider.config }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function downloadTotpRecovery() {
    setSubmitting(true);
    try {
      const response = await fetch(`/api/jobs/${job.id}/totp-rotation-recovery`, { headers: { "x-console-token": token } });
      if (!response.ok) throw new Error((await response.json()).error || "下载 2FA 恢复信息失败");
      await saveDownloadResponse(response, `${job.email}-2fa-recovery.json`);
      onError("");
    } catch (requestError) { onError(requestError.message); }
    finally { setSubmitting(false); }
  }

  async function download() {
    try {
      const response = await fetch(`/api/jobs/${job.id}/download`, {
        headers: { "x-console-token": token },
      });
      if (!response.ok) throw new Error((await response.json()).error || "下载失败");
      await saveDownloadResponse(response, `${job.email}-sub2api-import-oauth-${localTimestamp()}.json`);
    } catch (requestError) {
      onError(requestError.message);
    }
  }

  const inputConfig = getInputConfig(job.status, job.currentPhone);
  const terminal = ["completed", "failed", "canceled", "reauth_required", "resume_available"].includes(job.status);

  return (
    <tr className={`job-row status-${job.status}`}>
      <td className="select-cell">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelected}
          disabled={!selectionSupported}
          aria-label={`选择 ${job.email}`}
        />
      </td>
      <td>
        <div className="account-cell">
          <div className="account-avatar">{job.email.slice(0, 1).toUpperCase()}</div>
          <div className="account-details"><strong title={job.email}>{job.email}</strong><span>{shortId(job.id)}</span></div>
          <LoginMethodBadge job={job} />
        </div>
        {onEditAnnotations && <>
          <div className="account-annotation-row">
            <span className={`account-type-badge type-${job.accountType || "unknown"}`}
              title={job.accountTypeSource === "authorization" ? "来自已有授权记录，当前套餐和额度请以官方页面为准" : job.accountTypeSource === "manual" ? "手动标记" : "尚无账号类型标记"}>
              {ACCOUNT_TYPES.find(type => type.value === job.accountType)?.label || "未标记"}
              {job.accountTypeSource === "authorization" && <small>记录</small>}
            </span>
            <span className="account-group-badge" title={job.annotations?.group || "未分组"}><Folder size={12} />{job.annotations?.group || "未分组"}</span>
            <button type="button" className="icon-button annotation-edit-button" onClick={onEditAnnotations} aria-label={`编辑 ${job.email} 的标记`} title="编辑类型、分组、标签和备注"><Pencil size={13} /></button>
          </div>
          {Boolean(job.annotations?.tags?.length) && <div className="account-tag-list">
            {job.annotations.tags.slice(0, 3).map(tag => <span key={tag} title={tag}>{tag}</span>)}
            {job.annotations.tags.length > 3 && <span title={job.annotations.tags.slice(3).join("、")}>+{job.annotations.tags.length - 3}</span>}
          </div>}
          {job.annotations?.note && <div className="account-note" title={job.annotations.note}>{job.annotations.note}</div>}
        </>}
      </td>
      <td><StatusBadge status={job.status} /></td>
      <td className="step-cell">
        <div className="prompt-line">{job.prompt}</div>
        {job.lastError && <div className="row-error">{extractResponseMessage(job.lastError)}</div>}
        {job.autoRepairBlocked && (
          <div className="row-error">号池监控已永久跳过：{extractResponseMessage(job.autoRepairBlockedReason || "账号已不可用")}</div>
        )}
        {job.totpSetupError && <div className="row-error">2FA：{extractResponseMessage(job.totpSetupError)}</div>}
        {job.totpRotationError && <div className="row-error">更换 2FA：{extractResponseMessage(job.totpRotationError)}</div>}
        {job.passwordAddError && <div className="row-error">添加密码：{extractResponseMessage(job.passwordAddError)}</div>}
        {job.passwordSetError && <div className="row-error">统一密码：{extractResponseMessage(job.passwordSetError)}</div>}
        {job.emailChange && !["completed", "failed"].includes(job.emailChange.state) &&
          <div className="email-change-target">换绑目标：{job.emailChange.newEmail}</div>}
        {job.emailChange?.error && <div className="row-error">换绑邮箱：{extractResponseMessage(job.emailChange.error)}</div>}
        {job.autoRepairPaused && <div className="security-paused"><ShieldCheck size={13} />自动重登已暂停</div>}
        {job.mailApiError && ["email_otp", "email_change_otp"].includes(job.status) && <div className="mail-error">{job.mailApiError}</div>}
        {job.currentPhone && ["working", "phone", "phone_otp"].includes(job.status) && (
          <div className="phone-target"><Smartphone size={13} />当前手机号：<strong>{job.currentPhone}</strong></div>
        )}
        {job.phoneError && <div className="phone-error"><CircleAlert size={13} />{job.phoneError}</div>}
        {job.smsStatus && !["idle", "unavailable"].includes(job.smsStatus) && (
          <div className={`sms-status ${job.smsStatus === "error" ? "error" : ""}`}>
            {job.smsStatus === "error" ? <CircleAlert size={13} /> : <PhoneIncoming size={13} />}
            <span>{smsStatusText(job)}</span>
          </div>
        )}
        {job.status === "totp_setup_otp" && job.totpSetupSecret && (
          <div className="totp-setup-secret">
            <span>2FA 密钥</span>
            <code>{job.totpSetupSecret}</code>
            <button type="button" className="icon-button" onClick={copyTotpSecret} title="复制 2FA 密钥">
              <Copy size={15} />
            </button>
          </div>
        )}
        {inputConfig && (
          <div className="inline-entry">
            <div className="compact-input">
              {inputConfig.icon}
              <input
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  setInputError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && value && !submitting) {
                    event.preventDefault();
                    sendInput(inputConfig.action);
                  }
                }}
                inputMode={inputConfig.inputMode}
                type={inputConfig.type || "text"}
                placeholder={inputConfig.placeholder}
                aria-label={inputConfig.placeholder}
                aria-invalid={Boolean(inputError)}
                aria-describedby={inputError ? inputErrorId : undefined}
                disabled={submitting}
                autoComplete={inputConfig.autoComplete || "one-time-code"}
              />
            </div>
            <button
              type="button"
              className="icon-button submit"
              onClick={() => sendInput(inputConfig.action)}
              disabled={!value || submitting}
              title={inputConfig.submitLabel}
            >
              {submitting ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}
            </button>
            {job.status === "email_otp" && (
              <button type="button" className="text-action" onClick={() => sendInput("resend_email", "")} disabled={submitting}>
                <RefreshCw size={14} />重发
              </button>
            )}
            {job.status === "phone_otp" && (
              <>
                <button type="button" className="text-action" onClick={() => sendInput("resend_phone", "")} disabled={submitting}>
                  <RefreshCw size={14} />重发
                </button>
                <button type="button" className="text-action" onClick={() => sendInput("change_phone", "")} disabled={submitting}>
                  <RotateCcw size={14} />换号
                </button>
              </>
            )}
            {job.status === "phone" && smsProviderAvailable && (
              <>
                <span className="input-separator" aria-hidden="true" />
                <button
                  type="button"
                  className="platform-number-button"
                  onClick={requestSmsNumber}
                  disabled={!smsProvider.ready || submitting || job.smsStatus === "requesting"}
                  title={smsProvider.ready ? `使用 ${smsProvider.name} 取号` : "请先完成接码平台配置"}
                >
                  {submitting || job.smsStatus === "requesting" ? <LoaderCircle className="spin" size={15} /> : <PhoneIncoming size={15} />}
                  {smsProvider.name || "平台"}取号
                </button>
              </>
            )}
          </div>
        )}
        {inputConfig && inputError && <div id={inputErrorId} className="row-error" role="alert">{inputError}</div>}
      </td>
      <td className="time-cell"><time dateTime={job.createdAt}>{formatDateTime(job.createdAt)}</time></td>
      <td className="operation-time-cell">
        <time dateTime={job.lastOperationAt || job.createdAt}>{formatDateTime(job.lastOperationAt || job.createdAt)}</time>
        <span>{operationLabel(job.lastOperationType)}</span>
      </td>
      <td>
        <div className="row-actions">
          {onChangeEmail && <button type="button" className="secondary-button" onClick={onChangeEmail}
            disabled={submitting || !job.canChangeEmail} title={job.canChangeEmail ? "验证原账号后先检查平台换绑资格" : "请先结束当前任务或处理未完成的换绑"}>
            <Mail size={16} />换绑邮箱
          </button>}
          {job.canVerifyEmailChange && <button type="button" className="secondary-button" disabled={submitting}
            onClick={() => continueEmailChange("verify-email-change")} title="通过新邮箱核实同一账号，不重复提交换绑">
            <ShieldCheck size={16} />核实换绑
          </button>}
          {job.canFinishEmailChange && <button type="button" className="secondary-button" disabled={submitting}
            onClick={() => continueEmailChange("finish-email-change")}>
            <RefreshCw size={16} />{job.emailChange?.state === "sync_pending" ? "重试同步" : "继续保存"}
          </button>}
          {job.canDownload && (
            <button type="button" className="download-button" onClick={download}>
              <Download size={16} />下载
            </button>
          )}
          {job.canDownload && sub2apiUploadAvailable && (
            <button type="button" className="secondary-button" onClick={onUpload} disabled={submitting} title="上传到已配置的 Sub2API 号池">
              <Send size={16} />上传
            </button>
          )}
          {job.canRegenerate && (
            <button type="button" className="regenerate-button" onClick={regenerate} disabled={submitting} title="重新授权：优先使用刷新令牌，失效后自动重新登录">
              {submitting ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
              重新授权
            </button>
          )}
          {forceReloginAvailable && job.canForceRelogin && (
            <button type="button" className="relogin-button" onClick={forceRelogin} disabled={submitting} title="跳过刷新令牌和旧检查点，完整重新登录后自动授权">
              {submitting ? <LoaderCircle className="spin" size={16} /> : <LogIn size={16} />}
              重新登录并授权
            </button>
          )}
          {totpSetupAvailable && job.canSetupTotp && (
            <button type="button" className="icon-button" onClick={setupTotp} disabled={submitting} title="设置 2FA">
              {submitting ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
            </button>
          )}
          {job.canDownloadTotpRecovery && (
            <button type="button" className="secondary-button" onClick={downloadTotpRecovery} disabled={submitting}>
              <Download size={16} />下载新 2FA 恢复信息
            </button>
          )}
          {logoutAllAvailable && (
            <button type="button" className="logout-all-button" onClick={logoutAllDevices} disabled={submitting || !job.canLogoutAllDevices}>
              <LogOut size={16} />登出所有设备
            </button>
          )}
          {passwordAddAvailable && job.canAddPassword && (
            <button type="button" className="icon-button" onClick={addPassword} disabled={submitting} title="添加密码">
              {submitting ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
            </button>
          )}
          {job.canRetry && (
            <button type="button" className="retry-button" onClick={retry} disabled={submitting}>
              {submitting ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
              {job.securityCheckRequired ? "手动重试" : job.canResume ? "继续流程" : "重新授权"}
            </button>
          )}
          <button type="button" className="icon-button" onClick={onToggleLogs} title={expanded ? "收起日志" : "查看日志"}>
            <FileText size={17} />
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          {!terminal && (
            <button type="button" className="icon-button danger" onClick={cancel} disabled={submitting} title="取消任务">
              <Ban size={17} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function JobLogs({ token, jobId }) {
  const [logs, setLogs] = useState("正在读取日志...");

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const data = await apiFetch(token, `/api/jobs/${jobId}/logs`);
        if (!stopped) setLogs(data.logs || "暂无日志");
      } catch (error) {
        if (!stopped) setLogs(`日志读取失败：${error.message}`);
      }
    };
    load();
    const timer = window.setInterval(load, 1_200);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [jobId, token]);

  return (
    <div className="log-panel">
      <div className="log-title"><FileText size={15} />协议日志</div>
      <pre>{logs}</pre>
    </div>
  );
}

function StatusBadge({ status }) {
  const icon = {
    queued: <LoaderCircle size={14} />,
    starting: <LoaderCircle className="spin" size={14} />,
    working: <LoaderCircle className="spin" size={14} />,
    password: <KeyRound size={14} />,
    mfa_otp: <ShieldCheck size={14} />,
    totp_starting: <LoaderCircle className="spin" size={14} />,
    password_add_starting: <LoaderCircle className="spin" size={14} />,
    password_set_starting: <LoaderCircle className="spin" size={14} />,
    logout_starting: <LoaderCircle className="spin" size={14} />,
    email_change_starting: <LoaderCircle className="spin" size={14} />,
    email_change_otp: <MailCheck size={14} />,
    totp_setup_otp: <ShieldCheck size={14} />,
    email_otp: <Mail size={14} />,
    phone: <Smartphone size={14} />,
    phone_otp: <Smartphone size={14} />,
    finalizing: <LoaderCircle className="spin" size={14} />,
    refreshing: <RefreshCw className="spin" size={14} />,
    completed: <Check size={14} />,
    failed: <CircleAlert size={14} />,
    canceled: <Ban size={14} />,
    reauth_required: <RefreshCw size={14} />,
    resume_available: <RotateCcw size={14} />,
  }[status] || null;
  return <span className={`status-badge ${status}`}>{icon}{ACCOUNT_STATUS_LABELS[status] || status}</span>;
}

function LoginMethodBadge({ job }) {
  if (job.missingCredentials?.length) {
    return <span className="mail-mode error" title="当前只有曾配置凭据的标记，实际凭据无法读取。请通过批量添加重新导入原账号资料。">
      <CircleAlert size={12} />缺少{job.missingCredentials.join("、")}
    </span>;
  }
  if (job.loginMode === "password") {
    const methods = ["密码", job.autoEmailOtp ? "自动收码" : "", job.hasTotpKey ? "2FA" : ""].filter(Boolean);
    return (
      <span className="mail-mode password-mode">
        {job.hasTotpKey ? <ShieldCheck size={12} /> : <KeyRound size={12} />}
        {methods.join(" + ")}
      </span>
    );
  }
  if (job.autoEmailOtp) {
    return (
      <span className={`mail-mode ${["error", "timeout"].includes(job.mailStatus) ? "error" : ""}`}>
        {job.hasTotpKey ? <ShieldCheck size={12} /> : <MailCheck size={12} />}
        {job.hasTotpKey ? "自动收码 + 2FA" : "自动收码"}
      </span>
    );
  }
  if (job.loginMode === "manual") {
    return (
      <span className="mail-mode unknown-mode">
        <CircleAlert size={12} />旧任务资料未记录
      </span>
    );
  }
  if (!job.hasTotpKey) return null;
  return (
    <span className="mail-mode">
      <ShieldCheck size={12} />邮箱码 + 2FA
    </span>
  );
}

function getInputConfig(status, currentPhone) {
  if (status === "password") {
    return { action: "password", placeholder: "输入账号密码", submitLabel: "提交密码", inputMode: "text", type: "password", autoComplete: "current-password", icon: <KeyRound size={15} /> };
  }
  if (status === "mfa_otp") {
    return { action: "mfa_otp", placeholder: "6 位 2FA 验证码", submitLabel: "提交 2FA 验证码", inputMode: "numeric", icon: <ShieldCheck size={15} /> };
  }
  if (status === "totp_setup_otp") {
    return { action: "totp_setup_otp", placeholder: "新 2FA 的 6 位验证码", submitLabel: "激活新的 2FA", inputMode: "numeric", icon: <ShieldCheck size={15} /> };
  }
  if (status === "email_otp") {
    return { action: "email_otp", placeholder: "6 位邮箱验证码", submitLabel: "提交邮箱验证码", inputMode: "numeric", icon: <Mail size={15} /> };
  }
  if (status === "email_change_otp") {
    return { action: "new_email_otp", placeholder: "新邮箱的 6 位验证码", submitLabel: "确认新邮箱并换绑", inputMode: "numeric", icon: <MailCheck size={15} /> };
  }
  if (status === "phone") {
    return { action: "phone", placeholder: "+60123456789", submitLabel: "发送手机验证码", inputMode: "tel", icon: <Smartphone size={15} /> };
  }
  if (status === "phone_otp") {
    return { action: "phone_otp", placeholder: currentPhone ? `${currentPhone} 的验证码` : "手机验证码", submitLabel: "提交手机验证码", inputMode: "numeric", icon: <Smartphone size={15} /> };
  }
  return null;
}

function smsStatusText(job) {
  const providerName = job.smsProviderName || "接码平台";
  if (job.smsError) return `${providerName}：${job.smsError}`;
  return {
    requesting: `${providerName}：正在获取手机号`,
    number_acquired: `${providerName}：已获取手机号，正在发送验证码`,
    waiting_sms: `${providerName}：验证码已发送，正在等待短信`,
    submitting: `${providerName}：已收到验证码，正在自动提交`,
    submitted: `${providerName}：验证码已自动提交`,
    manual_submitted: `${providerName}：已停止自动读取，正在验证手动输入的验证码`,
    completed: `${providerName}：手机验证已通过，订单已完成`,
  }[job.smsStatus] || `${providerName}：处理中`;
}

async function saveDownloadResponse(response, fallbackName) {
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = downloadFilename(response.headers.get("content-disposition")) || fallbackName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

function downloadFilename(contentDisposition) {
  if (!contentDisposition) return "";
  const encodedMatch = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(contentDisposition);
  const plainMatch = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(contentDisposition);
  const rawName = encodedMatch?.[1] || plainMatch?.[1] || plainMatch?.[2] || "";
  try {
    return decodeURIComponent(rawName.trim().replace(/^"|"$/g, "")).replace(/[\\/]/g, "_");
  } catch {
    return rawName.trim().replace(/^"|"$/g, "").replace(/[\\/]/g, "_");
  }
}

function localTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function formatMonitorResult(result) {
  if (!result || typeof result !== "object") return "号池巡检已完成";
  const parts = [`检查 ${Number(result.checked || 0)} 条异常记录`];
  if (result.started) parts.push(`已启动自动修复 ${result.started} 条`);
  if (result.updated) parts.push(`已更新 ${result.updated} 条`);
  if (result.blocked) parts.push(`永久跳过 ${result.blocked} 条`);
  if (result.ineligible) parts.push(`需人工 ${result.ineligible} 条`);
  if (result.missingTask) parts.push(`本地无任务 ${result.missingTask} 条`);
  if (result.busy) parts.push(`正在运行 ${result.busy} 条`);
  if (result.cooldown) parts.push(`冷却中 ${result.cooldown} 条`);
  return parts.join("，");
}

function formatRelativeMonitorTime(value) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return "刚刚检查";
  if (elapsed < 60_000) return "刚刚检查";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前检查`;
  return `${Math.floor(elapsed / (60 * 60_000))} 小时前检查`;
}

async function apiFetch(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-console-token": token,
      ...(options.headers || {}),
    },
  });
  return readResponse(response);
}

async function readResponse(response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败：HTTP ${response.status}`);
  return data;
}

function shortId(id) {
  return `任务 ${id.slice(0, 8)}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const now = new Date();
  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return new Intl.DateTimeFormat("zh-CN", {
    ...(isToday ? {} : { month: "2-digit", day: "2-digit" }),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function operationLabel(type) {
  return ({
    initial_authorization: "首次授权",
    reauthorize: "重新授权",
    relogin: "重新登录并授权",
    automatic_relogin: "号池自动重登并授权",
    resume: "继续中断流程",
    setup_2fa: "设置 2FA",
    rotate_2fa: "更换 2FA",
    change_email: "换绑邮箱",
    add_password: "添加密码",
    set_password: "设置统一密码",
    logout_all: "登出所有设备",
    account_update: "更新账号资料",
    proxy_update: "更新代理 IP",
  })[type] || "账号操作";
}

function countBatchLines(value) {
  return String(value || "").split(/\r?\n/).filter((line) => line.trim()).length;
}

function parseEmailFilter(value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  if (!lines.length) throw new Error("请至少输入一个筛选邮箱");
  if (lines.length > 500) throw new Error("一次最多筛选 500 个邮箱");
  lines.forEach((email, index) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new Error(`第 ${index + 1} 行邮箱格式错误`);
    }
  });
  return [...new Set(lines)];
}

function extractResponseMessage(value) {
  const text = String(value || "").trim();
  const jsonAt = text.indexOf("{");
  if (jsonAt >= 0) {
    try {
      const payload = JSON.parse(text.slice(jsonAt));
      const message = payload?.error?.message || payload?.message;
      if (typeof message === "string" && message.trim()) return message.trim();
    } catch {}
  }
  const match = text.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/i);
  if (match) {
    try {
      return JSON.parse(`"${match[1]}"`).trim();
    } catch {
      return match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").trim();
    }
  }
  return text;
}

function readLocalSetting(key) {
  try {
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function readLocalTextSetting(key) {
  let value = readLocalSetting(key).trim();
  for (let attempt = 0; attempt < 4 && value; attempt += 1) {
    if (!(value.startsWith('"') && value.endsWith('"'))) return value;
    try {
      const decoded = JSON.parse(value);
      if (typeof decoded !== "string") return value;
      value = decoded.trim();
    } catch {
      return value;
    }
  }
  return value;
}

function readSmsProviderSettings() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SMS_PROVIDER_SETTINGS_KEY) || "null");
    if (stored && typeof stored === "object" && stored.configs && typeof stored.configs === "object") {
      return stored;
    }
  } catch {}
  return {
    selectedProviderId: "luban",
    configs: {
      luban: {
        apiKey: readLocalSetting(LUBAN_API_KEY_STORAGE_KEY),
        serviceId: readLocalSetting(LUBAN_SERVICE_ID_STORAGE_KEY),
      },
    },
  };
}

function normalizeMailRequestSettings(value) {
  const stored = value && typeof value === "object" ? value : {};
  let headersText = typeof stored.headersText === "string" ? stored.headersText : "";
  if (!headersText && stored.headers && typeof stored.headers === "object" && !Array.isArray(stored.headers)) {
    headersText = JSON.stringify(stored.headers, null, 2);
  }
  return {
    method: String(stored.method || "GET").toUpperCase() === "POST" ? "POST" : "GET",
    url: typeof stored.url === "string" ? stored.url.trim() : "",
    headersText: headersText.trim() || "{}",
  };
}

function readMailRequestSettings(value) {
  try {
    const stored = value || JSON.parse(window.localStorage.getItem(MAIL_REQUEST_SETTINGS_KEY) || "null");
    return normalizeMailRequestSettings(stored);
  } catch {
    return normalizeMailRequestSettings({});
  }
}

function buildMailRequestConfig(settings) {
  const normalized = normalizeMailRequestSettings(settings);
  let headers;
  try {
    headers = JSON.parse(normalized.headersText || "{}");
  } catch {
    throw new Error("请求头必须是有效的 JSON 对象");
  }
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("请求头必须是 JSON 对象，例如 {\"Authorization\":\"Bearer ...\"}");
  }
  if (normalized.method === "POST") {
    try {
      const parsedUrl = new URL(normalized.url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error();
    } catch {
      throw new Error("POST 模式必须填写有效的 HTTP 或 HTTPS 请求 URL");
    }
  }
  return {
    method: normalized.method,
    url: normalized.method === "POST" ? normalized.url : "",
    headers,
  };
}

function formatMailRequestSummary(settings) {
  try {
    const config = buildMailRequestConfig(settings);
    const headerCount = Object.keys(config.headers).length;
    return `${config.method === "POST" ? "已配置统一 URL · " : ""}${headerCount} 个请求头`;
  } catch {
    return "配置需要检查";
  }
}

function normalizeSub2ApiSettings(value) {
  const stored = value && typeof value === "object" ? value : {};
  const rawGroupIds = Array.isArray(stored.groupIds)
    ? stored.groupIds
    : String(stored.groupId || "").trim()
      ? [stored.groupId]
      : [];
  return {
    baseUrl: String(stored.baseUrl || ""),
    adminApiKey: String(stored.adminApiKey || ""),
    groupIds: [...new Set(rawGroupIds.map((id) => String(id).trim()).filter(Boolean))],
    proxyId: String(stored.proxyId || ""),
    concurrency: String(stored.concurrency ?? ""),
    loadFactor: String(stored.loadFactor ?? ""),
    priority: String(stored.priority ?? ""),
    modelWhitelist: String(stored.modelWhitelist || ""),
    codexFingerprintMode: ["off", "device", "session", "full"].includes(stored.codexFingerprintMode)
      ? stored.codexFingerprintMode
      : "session",
    monitorEnabled: stored.monitorEnabled === true,
  };
}

function readSub2ApiSettings(value) {
  try {
    const stored = value || JSON.parse(window.localStorage.getItem(SUB2API_UPLOAD_SETTINGS_KEY) || "null");
    if (stored && typeof stored === "object") return normalizeSub2ApiSettings(stored);
  } catch {}
  return normalizeSub2ApiSettings({});
}

function formatSub2ApiProxy(proxy) {
  const protocol = String(proxy.protocol || "http").replace(/:\/\/$/, "");
  const host = String(proxy.host || "");
  const port = proxy.port ? `:${proxy.port}` : "";
  const endpoint = host ? `${protocol}://${host}${port}` : "地址未知";
  const ip = String(proxy.ipAddress || "").trim();
  return `${proxy.name || `代理 ${proxy.id}`} | ${endpoint}${ip ? ` | 出口 IP：${ip}` : ""}`;
}

function withSmsProviderDefaults(definitions, settings) {
  const configs = { ...(settings?.configs || {}) };
  definitions.forEach((provider) => {
    const current = { ...(configs[provider.id] || {}) };
    provider.fields.forEach((field) => {
      if (!String(current[field.key] || "").trim() && field.defaultValue) current[field.key] = field.defaultValue;
    });
    configs[provider.id] = current;
  });
  const selectedProviderId = definitions.some((provider) => provider.id === settings?.selectedProviderId)
    ? settings.selectedProviderId
    : definitions[0]?.id || settings?.selectedProviderId || "luban";
  return { selectedProviderId, configs };
}

function resolveSmsProvider(definitions, settings) {
  const normalized = withSmsProviderDefaults(definitions, settings || {});
  const definition = definitions.find((provider) => provider.id === normalized.selectedProviderId) || null;
  const config = definition ? normalized.configs[definition.id] || {} : {};
  const requiredFieldsReady = Boolean(definition) && definition.fields.every((field) => (
    field.required === false || String(config[field.key] || "").trim()
  ));
  const customEntries = definition?.id === "custom" ? inspectCustomSmsEntries(config.entries) : null;
  const ready = requiredFieldsReady && !customEntries?.error;
  const summary = definition?.id === "custom"
    ? (customEntries?.count ? `${customEntries.count} 个号码` : "")
    : definition
    ? definition.fields
      .filter((field) => field.summary || field.summaryKey)
      .map((field) => config[field.summaryKey || field.key])
      .filter(Boolean)
      .join(" / ")
    : "";
  return {
    id: definition?.id || "",
    name: definition?.name || "",
    definition,
    config,
    ready,
    summary,
  };
}

function inspectCustomSmsEntries(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { count: 0, error: "请粘贴至少一条手机号和接码 API" };
  if (lines.length > 500) return { count: 0, error: "自定义接码一次最多导入 500 条" };
  const phones = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const delimiterAt = lines[index].indexOf("----");
    if (delimiterAt < 0) return { count: 0, error: `第 ${index + 1} 行格式错误，请使用 手机号----接码API` };
    const phone = lines[index].slice(0, delimiterAt).trim();
    const apiUrl = lines[index].slice(delimiterAt + 4).trim();
    if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
      return { count: 0, error: `第 ${index + 1} 行手机号必须使用 +861871291167 这种国际格式` };
    }
    try {
      const parsed = new URL(apiUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid protocol");
    } catch {
      return { count: 0, error: `第 ${index + 1} 行接码 API 必须是有效的 HTTP 或 HTTPS 地址` };
    }
    phones.add(phone);
  }
  return { count: phones.size, error: "" };
}

function formatSmsCountryName(option) {
  if (option.iso && REGION_NAMES) {
    try {
      return REGION_NAMES.of(option.iso) || option.title;
    } catch {}
  }
  return option.title || `国家 ${option.country}`;
}

function formatSmsPriceOption(option) {
  const name = formatSmsCountryName(option);
  return `${name} | 价格 ${option.price} | 库存 ${option.count}`;
}

function writeLocalJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing modes may disable localStorage; the current tab still works.
  }
}

function writeLocalTextSetting(key, value) {
  try {
    window.localStorage.setItem(key, String(value || ""));
  } catch {
    // Private browsing modes may disable localStorage; the current tab still works.
  }
}

function mergeJobs(...groups) {
  const unique = new Map();
  groups.flat().forEach((job) => {
    if (!unique.has(job.id)) unique.set(job.id, job);
  });
  return [...unique.values()];
}

const appRoot = globalThis.__chatgptOnboardingRoot || createRoot(document.getElementById("root"));
globalThis.__chatgptOnboardingRoot = appRoot;
appRoot.render(<App />);
