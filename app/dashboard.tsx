"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sectionAtPosition } from "./section-navigation";

type RateLimitWindow = { usedPercent: number; windowDurationMins?: number | null; resetsAt: number | null };
type ResetCredit = { expiresAt?: number | string | null; expires_at?: number | string | null; expirationTime?: number | string | null };
type Account = {
  id: string;
  email: string;
  note: string;
  planType: string;
  lastSyncedAt: string;
  rateLimits: ({ rateLimits: {
    primary?: RateLimitWindow | null;
    secondary?: RateLimitWindow | null;
    credits?: { balance?: string | null; unlimited: boolean } | null;
    individualLimit?: { remainingPercent: number } | null;
  }; rateLimitResetCredits?: { availableCount?: number; credits?: ResetCredit[] | null } | null }) | null;
  usage: {
    summary: { lifetimeTokens?: number | null; peakDailyTokens?: number | null };
    dailyUsageBuckets?: { startDate: string; tokens: number }[];
  } | null;
  syncError: string | null;
  isActive: boolean;
};
type Device = {
  id: string;
  name: string;
  lastSeenAt: string | null;
  activeAccountId: string | null;
  activeAccountEmail: string | null;
  lastError: string | null;
  agentVersion: string | null;
  codexAuthState: "signed-in" | "signed-out" | "unknown-account" | null;
  platform: "mac" | "windows";
  isOnline: boolean;
};
type SwitchHistory = {
  id: string;
  accountId: string;
  accountEmail: string;
  accountNote: string;
  createdAt: string;
  status: "selected" | "pending" | "complete" | "partial" | "failed" | "superseded";
  devices: { id: string; name: string; status: string; error: string | null }[];
};
type RefreshInfo = { refreshing: boolean; lastRefreshAt: string | null; nextRefreshAt: string; intervalMs: number };
type UsageTimeline = {
  totalTokens24h: number;
  establishedAt: string | null;
  updatedAt: string | null;
  buckets: { timestamp: number; tokens: number }[];
  reports?: Record<string, { updatedAt: string }>;
  deviceBuckets?: { timestamp: number; deviceId: string; tokens: number }[];
  modelTotals?: { model: string; tokens: number }[];
};
type LoginStatus = "waiting" | "syncing" | "complete" | "error";
type SortMode = "remaining" | "remaining-asc" | "updated" | "name";

const CONFIGURED_API_ORIGIN = process.env.NEXT_PUBLIC_ACCOUNT_API_ORIGIN || "";
const CURRENT_SWITCHER_VERSIONS = { mac: "1.8.0", windows: "1.8.0" } as const;
const PLUS_WEEKLY_TOKEN_ESTIMATE = 320_000_000;
const PLUS_FIVE_HOUR_TOKEN_ESTIMATE = 80_000_000;

function isSwitcherOutdated(version: string | null | undefined, platform: Device["platform"]) {
  const installed = String(version || "").match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  const current = CURRENT_SWITCHER_VERSIONS[platform].split(".").map(Number);
  if (!installed) return true;
  for (let index = 0; index < current.length; index += 1) {
    if (installed[index] !== current[index]) return installed[index] < current[index];
  }
  return false;
}

function apiOrigin() {
  if (
    typeof window !== "undefined" &&
    window.location.port === "3000" &&
    ["localhost", "127.0.0.1"].includes(window.location.hostname)
  ) {
    return `${window.location.protocol}//${window.location.hostname}:3210`;
  }
  return CONFIGURED_API_ORIGIN;
}

function formatTokens(value: number | null | undefined) {
  if (value == null) return "—";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString("zh-CN");
}

function formatResetCountdown(value: number | null | undefined, now: number) {
  if (!value) return "刷新时间未知";
  if (!now) return "正在计算刷新时间";
  const remainingMinutes = Math.max(0, Math.ceil((value * 1000 - now) / 60_000));
  if (remainingMinutes === 0) return "即将刷新";
  const days = Math.floor(remainingMinutes / (24 * 60));
  const hours = Math.floor((remainingMinutes % (24 * 60)) / 60);
  const minutes = remainingMinutes % 60;
  return `还剩${days}天${hours}小时${minutes}分刷新`;
}

function formatTime(value: string | null | undefined) {
  if (!value) return "尚未连接";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function rateLimitWindows(account: Account) {
  const snapshot = account.rateLimits?.rateLimits;
  const windows = [snapshot?.primary, snapshot?.secondary].filter((window): window is RateLimitWindow => Boolean(window));
  const fiveHour = windows.find((window) => Number(window.windowDurationMins || 0) > 0 && Number(window.windowDurationMins) <= 300) || null;
  const total = windows.find((window) => Number(window.windowDurationMins || 0) >= 7 * 24 * 60)
    || windows.filter((window) => window !== fiveHour).sort((left, right) => Number(right.windowDurationMins || 0) - Number(left.windowDurationMins || 0))[0]
    || null;
  return { total, fiveHour };
}

function windowRemaining(window: RateLimitWindow | null | undefined) {
  return window ? Math.min(100, Math.max(0, 100 - Number(window.usedPercent || 0))) : null;
}

function quotaTone(value: number | null) {
  if (value == null) return "unknown";
  if (value < 10) return "critical";
  if (value < 30) return "warning";
  return "healthy";
}

function accountRemaining(account: Account) {
  const snapshot = account.rateLimits?.rateLimits;
  return snapshot?.individualLimit?.remainingPercent ?? windowRemaining(rateLimitWindows(account).total) ?? windowRemaining(snapshot?.primary);
}

function estimatedRemainingTokens(account: Account, kind: "total" | "five-hour", remaining: number | null) {
  if (remaining == null || !account.planType.toLowerCase().includes("plus")) return null;
  const capacity = kind === "total" ? PLUS_WEEKLY_TOKEN_ESTIMATE : PLUS_FIVE_HOUR_TOKEN_ESTIMATE;
  return Math.round(capacity * remaining / 100);
}

function accountPlusEquivalent(account: Account) {
  if (!account.planType.toLowerCase().includes("plus")) return null;
  const remaining = accountRemaining(account);
  return remaining == null ? null : Math.min(1, Math.max(0, 100 - remaining) / 100);
}

function formatPlusEquivalent(value: number | null | undefined) {
  if (value == null) return "—";
  return `${formatPlusValue(value)} 个 Plus`;
}

function formatPlusValue(value: number | null | undefined) {
  if (value == null) return "—";
  return value.toLocaleString("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

function resetExpiry(account: Account) {
  const credits = account.rateLimits?.rateLimitResetCredits?.credits || [];
  const times = credits.map((credit) => credit.expiresAt ?? credit.expires_at ?? credit.expirationTime).map((value) => {
    if (value == null) return NaN;
    if (typeof value === "string" && !/^\d+$/.test(value)) return new Date(value).getTime();
    const numeric = Number(value);
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }).filter(Number.isFinite);
  return times.length ? Math.min(...times) : null;
}

function formatDateTime(value: string | number | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

const historyStatusLabel: Record<SwitchHistory["status"], string> = {
  selected: "已选中",
  pending: "切换中",
  complete: "已完成",
  partial: "部分完成",
  failed: "失败",
  superseded: "已被替换",
};

// Soft but clearly separated on the dark chart: iris, cyan and warm amber.
const USAGE_COLORS = ["#8b7cf6", "#20b8d4", "#f2b84b", "#72c58a", "#5f91f2", "#c58aea"];
const MODEL_COLORS = ["#8b7cf6", "#20b8d4", "#f2b84b", "#72c58a", "#5f91f2", "#c58aea", "#8e97a8"];

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${apiOrigin()}${path}`, {
      ...options,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
      signal: options?.signal || controller.signal,
    });
    const body = (await response.json()) as T & { error?: string };
    if (!response.ok) throw Object.assign(new Error(body.error || "操作失败"), { status: response.status });
    return body;
  } catch (cause) {
    if (controller.signal.aborted) throw new Error("请求超时，请检查网络后重试");
    throw cause;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function Dashboard() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [history, setHistory] = useState<SwitchHistory[]>([]);
  const [usageTimeline, setUsageTimeline] = useState<UsageTimeline>({ totalTokens24h: 0, establishedAt: null, updatedAt: null, buckets: [] });
  const [refresh, setRefresh] = useState<RefreshInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [refreshAllBusy, setRefreshAllBusy] = useState(false);
  const [animationKeys, setAnimationKeys] = useState<Record<string, number>>({});
  const [sortMode, setSortMode] = useState<SortMode>("remaining-asc");
  const [editingNote, setEditingNote] = useState<Account | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [login, setLogin] = useState<{ id: string; authUrl: string; userCode?: string | null; status: LoginStatus; error?: string | null } | null>(null);
  const [pairing, setPairing] = useState<{ code: string; platform: "mac" | "windows"; installCommand: string; expiresAt: string } | null>(null);
  const [repairing, setRepairing] = useState<{ device: Device; command: string } | null>(null);
  const [switchingAccount, setSwitchingAccount] = useState<Account | null>(null);
  const [targetBusyId, setTargetBusyId] = useState<string | null>(null);
  const switchRequestInFlight = useRef(false);
  const [editingDevice, setEditingDevice] = useState<Device | null>(null);
  const [deviceNameDraft, setDeviceNameDraft] = useState("");
  const [deviceNameBusy, setDeviceNameBusy] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [activeSection, setActiveSection] = useState<"accounts" | "usage" | "devices">("accounts");
  const [trendHoverIndex, setTrendHoverIndex] = useState<number | null>(null);
  const [modelHoverIndex, setModelHoverIndex] = useState<number | null>(null);
  const [headerScrolled, setHeaderScrolled] = useState(false);
  const [recentlySwitchedAccountId, setRecentlySwitchedAccountId] = useState<string | null>(null);
  const [historyPage, setHistoryPage] = useState(1);

  const loadData = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [accountResult, deviceResult, historyResult, usageTimelineResult] = await Promise.all([
        api<{ accounts: Account[]; refresh: RefreshInfo }>("/api/accounts"),
        api<{ devices: Device[] }>("/api/devices"),
        api<{ history: SwitchHistory[] }>("/api/switch-history"),
        api<UsageTimeline>("/api/usage-timeline").catch(() => ({ totalTokens24h: 0, establishedAt: null, updatedAt: null, buckets: [] })),
      ]);
      setAccounts(accountResult.accounts);
      setRefresh(accountResult.refresh);
      setDevices(deviceResult.devices);
      setHistory(historyResult.history);
      setUsageTimeline(usageTimelineResult);
      setAuthenticated(true);
      setError(null);
    } catch (cause) {
      if ((cause as { status?: number }).status === 401) setAuthenticated(false);
      else setError(cause instanceof Error ? cause.message : "无法连接账号服务");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void api<{ authenticated: boolean }>("/api/session")
      .then(() => { setAuthenticated(true); void loadData(); })
      .catch(() => { setAuthenticated(false); setLoading(false); });
  }, [loadData]);

  useEffect(() => {
    if (!authenticated) return;
    const timer = window.setInterval(() => void loadData(true), 30_000);
    return () => window.clearInterval(timer);
  }, [authenticated, loadData]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    // Authentication resolves before the dashboard mounts; wait for loading too.
    if (!authenticated || loading) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const sections = ["accounts", "usage", "devices"].flatMap((id) => {
        const element = document.getElementById(id);
        return element ? [{ id, top: element.getBoundingClientRect().top }] : [];
      });
      const root = document.scrollingElement || document.documentElement;
      setHeaderScrolled(root.scrollTop > 12);
      const atBottom = root.scrollHeight > window.innerHeight + 2 &&
        root.scrollTop + window.innerHeight >= root.scrollHeight - 2;
      const headerBottom = document.querySelector(".app-header")?.getBoundingClientRect().bottom || 80;
      const selected = sectionAtPosition(sections, Math.max(104, headerBottom + 24), atBottom);
      if (selected) setActiveSection(selected as "accounts" | "usage" | "devices");
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("hashchange", schedule);
    const observer = new ResizeObserver(schedule);
    const content = document.querySelector(".content");
    if (content) observer.observe(content);
    schedule();
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("hashchange", schedule);
      observer.disconnect();
    };
  }, [authenticated, loading]);

  useEffect(() => {
    if (!login || login.status === "complete" || login.status === "error") return;
    const timer = window.setInterval(() => {
      void api<{ status: LoginStatus; error?: string | null }>(`/api/accounts/login/${login.id}`)
        .then(async (result) => {
          setLogin((current) => current ? { ...current, ...result } : current);
          if (result.status === "complete") await loadData(true);
        })
        .catch((cause) => setLogin((current) => current ? { ...current, status: "error", error: cause instanceof Error ? cause.message : "登录状态读取失败" } : current));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [login, loadData]);

  const lifetimeTotal = useMemo(() => accounts.reduce((sum, account) => sum + (account.usage?.summary.lifetimeTokens || 0), 0), [accounts]);
  const plusEquivalentTotal = useMemo(() => accounts.reduce((sum, account) => sum + (accountPlusEquivalent(account) || 0), 0), [accounts]);
  const plusRemainingTotal = useMemo(() => accounts.reduce((sum, account) => {
    if (!account.planType.toLowerCase().includes("plus")) return sum;
    const remaining = accountRemaining(account);
    return sum + (remaining == null ? 0 : Math.min(100, Math.max(0, remaining)) / 100);
  }, 0), [accounts]);
  const plusCapacityTotal = useMemo(() => accounts.filter((account) => account.planType.toLowerCase().includes("plus")).length, [accounts]);
  const plusRemainingPercent = plusCapacityTotal > 0 ? Math.min(100, Math.max(0, plusRemainingTotal / plusCapacityTotal * 100)) : 0;
  const dailyUsage = useMemo(() => {
    const todayAnchor = new Date(clockNow);
    const days = Array.from({ length: 14 }, (_, index) => {
      const date = new Date(todayAnchor);
      date.setHours(12, 0, 0, 0);
      date.setDate(date.getDate() - (13 - index));
      return {
        date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
        label: `${date.getMonth() + 1}/${date.getDate()}`,
        accounts: [] as { id: string; label: string; tokens: number; plusEquivalent: number | null; color: string }[],
        total: 0,
        plusEquivalent: 0,
      };
    });
    const byDate = new Map(days.map((day) => [day.date, day]));
    for (const bucket of usageTimeline.deviceBuckets || []) {
      const date = new Date(bucket.timestamp * 1000);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const day = byDate.get(key);
      if (!day || !bucket.tokens) continue;
      const deviceIndex = devices.findIndex(device => device.id === bucket.deviceId);
      const device = devices[deviceIndex];
      let entry = day.accounts.find(item => item.id === bucket.deviceId);
      if (!entry) {
        entry = { id: bucket.deviceId, label: device?.name || "已移除设备", tokens: 0, plusEquivalent: 0, color: USAGE_COLORS[Math.max(0, deviceIndex) % USAGE_COLORS.length] };
        day.accounts.push(entry);
      }
      entry.tokens += bucket.tokens;
      entry.plusEquivalent = entry.tokens / PLUS_WEEKLY_TOKEN_ESTIMATE;
      day.total += bucket.tokens;
      day.plusEquivalent += bucket.tokens / PLUS_WEEKLY_TOKEN_ESTIMATE;
    }
    const peak = Math.max(1, ...days.map((day) => day.total));
    const last7 = days.slice(-7).reduce((sum, day) => sum + day.total, 0);
    const peakDay = days.reduce((current, day) => day.total > current.total ? day : current, days[0]);
    return {
      days,
      peak,
      peakPlus: peakDay?.plusEquivalent || 0,
      last7,
      last7Plus: days.slice(-7).reduce((sum, day) => sum + day.plusEquivalent, 0),
      today: days.at(-1)?.total || 0,
      todayPlus: days.at(-1)?.plusEquivalent || 0,
    };
  }, [usageTimeline.deviceBuckets, devices, clockNow]);
  const usageTrend = useMemo(() => {
    const bucketMs = 30 * 60 * 1000;
    const now = clockNow || Date.now();
    const currentBucket = Math.floor(now / bucketMs) * bucketMs;
    const values = new Map((usageTimeline.buckets || []).map((item) => [Number(item.timestamp) * 1000, Math.max(0, Number(item.tokens || 0))]));
    const points = Array.from({ length: 48 }, (_, index) => {
      const timestamp = currentBucket - (47 - index) * bucketMs;
      return { timestamp, tokens: values.get(timestamp) || 0 };
    });
    const peak = Math.max(0, ...points.map((point) => point.tokens));
    const scalePeak = Math.max(1, peak * 1.15);
    const width = 760;
    const height = 270;
    const inset = { left: 48, right: 22, top: 22, bottom: 34 };
    const plotWidth = width - inset.left - inset.right;
    const plotHeight = height - inset.top - inset.bottom;
    const coordinates = points.map((point, index) => ({
      ...point,
      x: inset.left + index / (points.length - 1) * plotWidth,
      y: inset.top + (1 - Math.min(1, point.tokens / scalePeak)) * plotHeight,
    }));
    const pathFor = (items: typeof coordinates) => items.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
    const completed = coordinates.slice(0, -1);
    const linePath = pathFor(completed);
    const areaPath = completed.length ? `${linePath} L${completed.at(-1)?.x},${inset.top + plotHeight} L${completed[0].x},${inset.top + plotHeight} Z` : "";
    const partialPath = pathFor(coordinates.slice(-2));
    const maxIndex = completed.reduce((best, point, index) => point.tokens > (completed[best]?.tokens || -1) ? index : best, 0);
    return { points: coordinates, peak, scalePeak, width, height, inset, plotHeight, linePath, areaPath, partialPath, maxIndex };
  }, [usageTimeline.buckets, clockNow]);
  const modelUsage = useMemo(() => {
    const sorted = (usageTimeline.modelTotals || [])
      .filter((item) => Number(item.tokens) > 0)
      .map((item) => ({ model: item.model || "unknown", tokens: Number(item.tokens) }))
      .sort((left, right) => right.tokens - left.tokens);
    const visible = sorted.slice(0, 6);
    if (sorted.length > 6) {
      visible.push({ model: "other", tokens: sorted.slice(6).reduce((sum, item) => sum + item.tokens, 0) });
    }
    const total = visible.reduce((sum, item) => sum + item.tokens, 0);
    let offset = 0;
    const segments = visible.map((item, index) => {
      const percent = total ? item.tokens / total * 100 : 0;
      const segment = { ...item, percent, offset, color: MODEL_COLORS[index % MODEL_COLORS.length] };
      offset += percent;
      return segment;
    });
    return { total, segments };
  }, [usageTimeline.modelTotals]);
  const historyPageCount = Math.max(1, Math.ceil(history.length / 5));
  const visibleHistoryPage = Math.min(historyPage, historyPageCount);
  const pagedHistory = history.slice((visibleHistoryPage - 1) * 5, visibleHistoryPage * 5);
  const sortedAccounts = useMemo(() => [...accounts].sort((left, right) => {
    if (sortMode === "name") return (left.note || left.email).localeCompare(right.note || right.email, "zh-CN");
    if (sortMode === "updated") return new Date(right.lastSyncedAt).getTime() - new Date(left.lastSyncedAt).getTime();
    const leftRemaining = accountRemaining(left);
    const rightRemaining = accountRemaining(right);
    if (leftRemaining == null) return rightRemaining == null ? 0 : 1;
    if (rightRemaining == null) return -1;
    return sortMode === "remaining-asc" ? leftRemaining - rightRemaining : rightRemaining - leftRemaining;
  }), [accounts, sortMode]);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setLoginBusy(true);
    setError(null);
    try {
      await api("/api/session", { method: "POST", body: JSON.stringify({ password }) });
      setAuthenticated(true);
      setPassword("");
      await loadData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败");
    } finally {
      setLoginBusy(false);
    }
  }

  async function signOut() {
    await api("/api/session", { method: "DELETE" });
    setAuthenticated(false);
    setAccounts([]);
    setDevices([]);
    setHistory([]);
  }

  async function refreshAll() {
    setRefreshAllBusy(true);
    setError(null);
    try {
      await api("/api/accounts/refresh-all", { method: "POST" });
      setNotice("正在刷新全部账号，完成后页面会自动更新");
      window.setTimeout(() => setNotice(null), 3500);
      window.setTimeout(() => {
        void loadData(true).then(() => replayUsageAnimations(accounts.map((account) => account.id)));
      }, 1800);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "全部刷新失败");
    } finally {
      window.setTimeout(() => setRefreshAllBusy(false), 1200);
    }
  }

  function replayUsageAnimations(accountIds: string[]) {
    const stamp = Date.now();
    setAnimationKeys((current) => Object.fromEntries([
      ...Object.entries(current),
      ...accountIds.map((id) => [id, stamp]),
    ]));
  }

  function startEditNote(account: Account) {
    setEditingNote(account);
    setNoteDraft(account.note || "");
  }

  async function saveNote(event: FormEvent) {
    event.preventDefault();
    if (!editingNote) return;
    setBusyId(editingNote.id);
    try {
      await api(`/api/accounts/${editingNote.id}`, { method: "PATCH", body: JSON.stringify({ note: noteDraft }) });
      setEditingNote(null);
      await loadData(true);
      setNotice("账号备注已保存");
      window.setTimeout(() => setNotice(null), 2500);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "备注保存失败");
    } finally {
      setBusyId(null);
    }
  }

  async function startAccountLogin() {
    const loginWindow = window.open("about:blank", "_blank");
    setError(null);
    try {
      const result = await api<{ id: string; authUrl: string; userCode?: string | null }>("/api/accounts/login", { method: "POST" });
      setLogin({ ...result, status: "waiting" });
      if (loginWindow) loginWindow.location.href = result.authUrl;
    } catch (cause) {
      loginWindow?.close();
      setError(cause instanceof Error ? cause.message : "无法启动 ChatGPT 登录");
    }
  }

  async function refreshAccount(account: Account) {
    setBusyId(account.id);
    try {
      await api(`/api/accounts/${account.id}/refresh`, { method: "POST" });
      await loadData(true);
      replayUsageAnimations([account.id]);
      setNotice(`${account.note || account.email} 已刷新`);
      window.setTimeout(() => setNotice(null), 2500);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "刷新失败");
    } finally {
      setBusyId(null);
    }
  }

  async function activateAccount(account: Account) {
    setError(null);
    setSwitchingAccount(account);
  }

  async function switchAccount(account: Account, device: Device | null) {
    if (switchRequestInFlight.current || devices.length === 0) return;
    switchRequestInFlight.current = true;
    const targetId = device?.id || "all";
    setTargetBusyId(targetId);
    setError(null);
    try {
      const result = await api<{ deviceCount: number; enqueuedCount: number; deduplicatedCount: number; targeted: boolean }>(`/api/accounts/${account.id}/activate`, {
        method: "POST",
        body: JSON.stringify(device
          ? { deviceId: device.id, force: device.activeAccountId === account.id }
          : { allDevices: true }),
      });
      setSwitchingAccount(null);
      await loadData(true);
      setRecentlySwitchedAccountId(account.id);
      window.setTimeout(() => setRecentlySwitchedAccountId((current) => current === account.id ? null : current), 1800);
      if (device) {
        setNotice(result.enqueuedCount === 0
          ? `${device.name} 的重复请求已安全合并`
          : device.isOnline
            ? `已向 ${device.name} 发送切换指令，其他电脑不会变化`
            : `${device.name} 当前离线，已排队等待上线后切换`);
      } else {
        setNotice(result.enqueuedCount === 0
          ? "全部设备的重复请求已安全合并"
          : `已向 ${result.enqueuedCount} 台设备发送切换指令${result.deduplicatedCount ? `，另 ${result.deduplicatedCount} 台已合并重复请求` : ""}`);
      }
      window.setTimeout(() => setNotice(null), 4200);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "切换失败");
    } finally {
      setTargetBusyId(null);
      switchRequestInFlight.current = false;
    }
  }

  async function removeAccount(account: Account) {
    if (!window.confirm(`删除 ${account.email} 的登录凭据？`)) return;
    setBusyId(account.id);
    try {
      await api(`/api/accounts/${account.id}`, { method: "DELETE" });
      await loadData(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败");
    } finally {
      setBusyId(null);
    }
  }

  async function createPairing(platform: "mac" | "windows") {
    try {
      setPairing(await api("/api/devices/pair", { method: "POST", body: JSON.stringify({ platform }) }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法创建配对码");
    }
  }

  async function copyInstallCommand() {
    if (!pairing) return;
    await navigator.clipboard.writeText(pairing.installCommand);
    setNotice("安装命令已复制");
    window.setTimeout(() => setNotice(null), 2500);
  }

  async function removeDevice(device: Device) {
    if (!window.confirm(`移除设备 ${device.name}？`)) return;
    await api(`/api/devices/${device.id}`, { method: "DELETE" });
    await loadData(true);
  }

  function startEditDevice(device: Device) {
    setEditingDevice(device);
    setDeviceNameDraft(device.name);
  }

  async function saveDeviceName(event: FormEvent) {
    event.preventDefault();
    if (!editingDevice) return;
    setDeviceNameBusy(true);
    setError(null);
    try {
      await api(`/api/devices/${editingDevice.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: deviceNameDraft }),
      });
      setEditingDevice(null);
      await loadData(true);
      setNotice("设备名称已保存");
      window.setTimeout(() => setNotice(null), 2500);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "设备改名失败");
    } finally {
      setDeviceNameBusy(false);
    }
  }

  async function repairDevice(device: Device) {
    try {
      const result = await api<{ command: string }>(`/api/devices/${device.id}/repair`, { method: "POST" });
      setRepairing({ device, command: result.command });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法生成更新命令");
    }
  }

  async function copyRepairCommand() {
    if (!repairing) return;
    await navigator.clipboard.writeText(repairing.command);
    setNotice("更新命令已复制");
    window.setTimeout(() => setNotice(null), 2500);
  }

  if (authenticated === null || (authenticated && loading && accounts.length === 0)) {
    return <main className="dashboard-skeleton" aria-label="正在连接账号服务" aria-busy="true">
      <div className="skeleton-header"><span /><i /><i /><i /></div>
      <section><div className="skeleton-title"><i /><b /></div><div className="skeleton-summary"><i /><i /><i /></div></section>
      <div className="skeleton-cards"><article><header /><div /><div /><footer /></article><article><header /><div /><div /><footer /></article></div>
      <p>正在连接账号服务…</p>
    </main>;
  }

  if (!authenticated) {
    return (
      <main className="auth-page">
        <form className="auth-card" onSubmit={signIn}>
          <span className="brand-icon auth-logo">G</span>
          <h1>GPT 账号管理</h1>
          <p>输入管理密码继续</p>
          {error && <div className="inline-error">{error}</div>}
          <input type="password" autoComplete="current-password" placeholder="管理密码" value={password} onChange={(event) => setPassword(event.target.value)} required />
          <button className="primary-button" type="submit" disabled={loginBusy}>{loginBusy ? "登录中…" : "登录"}</button>
        </form>
      </main>
    );
  }

  return (
    <main className="account-app">
      <header className={`app-header${headerScrolled ? " scrolled" : ""}`}>
        <div className="brand"><span className="brand-icon" aria-hidden="true">G</span><span>GPT 账号</span></div>
        <div className="header-actions">
          <span className="service-state online"><i /> 每 5 分钟更新</span>
          <button className="header-refresh" type="button" disabled={refreshAllBusy || refresh?.refreshing} onClick={() => void refreshAll()}><span className={refreshAllBusy || refresh?.refreshing ? "spin-icon" : ""} aria-hidden="true">↻</span>{refreshAllBusy || refresh?.refreshing ? "刷新中" : "全部刷新"}</button>
          <button className="header-link" type="button" onClick={() => void signOut()}>退出</button>
          <button className="primary-button" type="button" onClick={() => void startAccountLogin()}><span aria-hidden="true">＋</span> 添加账号</button>
        </div>
      </header>

      <nav className="floating-directory" aria-label="页面目录">
        <span className="directory-kicker">目录</span>
        <a onClick={() => setActiveSection("accounts")} className={activeSection === "accounts" ? "active" : ""} href="#accounts" aria-current={activeSection === "accounts" ? "location" : undefined}><i>01</i><span>账号</span></a>
        <a onClick={() => setActiveSection("usage")} className={activeSection === "usage" ? "active" : ""} href="#usage" aria-current={activeSection === "usage" ? "location" : undefined}><i>02</i><span>用量</span></a>
        <a onClick={() => setActiveSection("devices")} className={activeSection === "devices" ? "active" : ""} href="#devices" aria-current={activeSection === "devices" ? "location" : undefined}><i>03</i><span>设备</span></a>
      </nav>

      <section className="content" id="accounts">
        <div className="summary">
          <div><p>账号管理</p><h1>我的账号</h1></div>
          <div className="summary-side">
            <label className="sort-control"><span>排序</span><select aria-label="账号排序" value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}><option value="remaining-asc">剩余额度：少到多</option><option value="remaining">剩余额度：多到少</option><option value="updated">更新时间</option><option value="name">账号名称</option></select></label>
            <div className="summary-numbers">
              <span><b>{accounts.length}</b> 个账号</span>
              <span className="remaining-plus-summary">
                <span className="remaining-plus-values"><b>余额 {formatPlusValue(plusRemainingTotal)} Plus</b><small>总量 {formatPlusValue(plusCapacityTotal)} Plus</small></span>
                <span className="plus-battery" role="progressbar" aria-label={`Plus 总余额 ${formatPlusValue(plusRemainingTotal)}，总量 ${formatPlusValue(plusCapacityTotal)}`} aria-valuemin={0} aria-valuemax={plusCapacityTotal} aria-valuenow={Number(plusRemainingTotal.toFixed(2))}>
                  <i style={{ width: `${plusRemainingPercent}%` }} />
                </span>
              </span>
              <span><b>{formatTokens(lifetimeTotal)}</b> 累计 Token</span>
              <span><b>{formatTime(refresh?.lastRefreshAt)}</b> 最近刷新</span>
            </div>
          </div>
        </div>

        {error && <div className="error-banner"><span>!</span><p>{error}</p><button type="button" onClick={() => setError(null)}>×</button></div>}

        {accounts.length === 0 ? (
          <div className="empty-state"><span className="empty-icon">G</span><h2>还没有已验证账号</h2><button className="primary-button" type="button" onClick={() => void startAccountLogin()}>通过 ChatGPT 添加账号</button></div>
        ) : (
          <div className="account-grid">
            {sortedAccounts.map((account) => {
              const snapshot = account.rateLimits?.rateLimits;
              const limitWindows = rateLimitWindows(account);
              const totalRemaining = accountRemaining(account);
              const fiveHourRemaining = windowRemaining(limitWindows.fiveHour);
              const knownRemaining = [totalRemaining, fiveHourRemaining].filter((value): value is number => value != null);
              const limitingRemaining = knownRemaining.length ? Math.min(...knownRemaining) : null;
              const remainingTone = limitingRemaining != null && limitingRemaining < 10 ? "critical" : limitingRemaining != null && limitingRemaining < 30 ? "warning" : "healthy";
              const availableResets = account.rateLimits?.rateLimitResetCredits?.availableCount ?? 0;
              const expiresAt = resetExpiry(account);
              const busy = busyId === account.id;
              const connectedDevices = devices.filter((device) => device.activeAccountId === account.id);
              const connectedCount = connectedDevices.length;
              const connectedDeviceNames = connectedDevices.map((device) => device.name).join("、");
              const animationKey = animationKeys[account.id] || 0;
              const totalProgressPercent = Math.min(100, Math.max(0, totalRemaining ?? 0));
              const fiveHourProgressPercent = Math.min(100, Math.max(0, fiveHourRemaining ?? 0));
              const totalTokenEstimate = estimatedRemainingTokens(account, "total", totalRemaining);
              const fiveHourTokenEstimate = estimatedRemainingTokens(account, "five-hour", fiveHourRemaining);
              const plusEquivalent = accountPlusEquivalent(account);
              return (
                <article className={`account-card ${remainingTone}${connectedCount ? " active" : ""}${recentlySwitchedAccountId === account.id ? " just-switched" : ""}`} key={account.id}>
                  <div className="card-head"><span className="avatar">{account.email.slice(0, 2).toUpperCase()}</span><div className="identity"><div className="identity-title"><h2>{account.note || account.email}</h2><button className="note-button" type="button" aria-label={`编辑 ${account.email} 的备注`} onClick={() => startEditNote(account)}>编辑</button></div><p>{account.note ? account.email : `ChatGPT ${account.planType}`}</p>{account.note && <small>ChatGPT {account.planType}</small>}</div><span className={connectedCount ? "active-badge" : "verified-badge"}>{connectedCount ? `${connectedCount} 台使用` : "已验证"}</span></div>
                  <div className="token-block dual-quota-block">
                    <div className={`quota-meter total-quota ${quotaTone(totalRemaining)}`}>
                      <div className="quota-meter-heading"><span>总额度</span><strong>{totalRemaining == null ? "—" : `${Math.round(totalRemaining)}%`}</strong></div>
                      <button className="quota-progress-wrap" type="button" aria-label={`${account.note || account.email} 总额度剩余 ${totalRemaining == null ? "未知" : `${Math.round(totalRemaining)}%`}，估算剩余 ${totalTokenEstimate == null ? "未知" : `${totalTokenEstimate.toLocaleString("zh-CN")} Token`}`}>
                        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(totalProgressPercent)}><span key={`${account.id}-total-progress-${animationKey}`} style={{ width: `${totalProgressPercent}%` }} /></div>
                        <div className="quota-token-tooltip"><small>估算剩余</small><b>{totalTokenEstimate == null ? "暂无法估算" : `≈ ${formatTokens(totalTokenEstimate)} Token`}</b><em>按 Plus 历史折算基准，仅供参考</em></div>
                      </button>
                      <small>{formatResetCountdown(limitWindows.total?.resetsAt, clockNow)}</small>
                    </div>
                    <div className={`quota-meter five-hour-quota ${quotaTone(fiveHourRemaining)}`}>
                      <div className="quota-meter-heading"><span>5 小时额度</span><strong>{fiveHourRemaining == null ? "—" : `${Math.round(fiveHourRemaining)}%`}</strong></div>
                      <button className="quota-progress-wrap" type="button" aria-label={`${account.note || account.email} 5小时额度剩余 ${fiveHourRemaining == null ? "未知" : `${Math.round(fiveHourRemaining)}%`}，估算剩余 ${fiveHourTokenEstimate == null ? "未知" : `${fiveHourTokenEstimate.toLocaleString("zh-CN")} Token`}`}>
                        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fiveHourProgressPercent)}><span key={`${account.id}-five-hour-progress-${animationKey}`} style={{ width: `${fiveHourProgressPercent}%` }} /></div>
                        <div className="quota-token-tooltip"><small>估算剩余</small><b>{fiveHourTokenEstimate == null ? "暂无法估算" : `≈ ${formatTokens(fiveHourTokenEstimate)} Token`}</b><em>按 5 小时窗口经验值折算，仅供参考</em></div>
                      </button>
                      <small>{limitWindows.fiveHour ? formatResetCountdown(limitWindows.fiveHour.resetsAt, clockNow) : "尚未返回 5 小时额度"}</small>
                    </div>
                  </div>
                  <div className={`usage-grid${animationKey ? " metric-refresh" : ""}`} key={`${account.id}-metrics-${animationKey}`}>
                    <div><span>累计 TOKEN</span><b>{formatTokens(account.usage?.summary.lifetimeTokens)}</b>{plusEquivalent != null && <small className="plus-equivalent">≈ {formatPlusEquivalent(plusEquivalent)}</small>}</div>
                    <div><span>高峰单日</span><b>{formatTokens(account.usage?.summary.peakDailyTokens)}</b></div>
                    <div><span>可用重置</span><b>{availableResets} 次</b><small>{availableResets > 0 ? (expiresAt ? `${formatDateTime(expiresAt)} 失效` : "失效时间未提供") : "暂无可用重置"}</small></div>
                    <div><span>Credits</span><b>{snapshot?.credits?.unlimited ? "不限" : snapshot?.credits?.balance || "—"}</b></div>
                  </div>
                  <div className="card-actions">
                    <span>{account.syncError || (connectedCount ? `${connectedDeviceNames}设备正在使用` : "暂无设备使用")}</span>
                    <button className="launch-button" type="button" disabled={busy || targetBusyId !== null} onClick={() => void activateAccount(account)}>选择设备</button>
                    <button type="button" disabled={busy} onClick={() => void refreshAccount(account)}>刷新</button>
                    <button className="danger-button" type="button" disabled={busy} onClick={() => void removeAccount(account)}>删除</button>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        <section className="daily-usage-panel" id="usage">
          <div className="daily-usage-heading">
            <div><p>用量统计</p><h2>每日 Token 用量</h2><span>最近 14 天 · 设备本机记录 · 含缓存输入 · Plus 为估算</span></div>
            <div className="daily-usage-metrics"><span><small>今日</small><b>{formatTokens(dailyUsage.today)}</b><em>≈ {formatPlusValue(dailyUsage.todayPlus)} Plus</em></span><span><small>近 7 天</small><b>{formatTokens(dailyUsage.last7)}</b><em>≈ {formatPlusValue(dailyUsage.last7Plus)} Plus</em></span><span><small>单日峰值</small><b>{formatTokens(dailyUsage.peak)}</b><em>≈ {formatPlusValue(dailyUsage.peakPlus)} Plus</em></span><span className="plus-metric"><small>本周期折算</small><b>{formatPlusEquivalent(plusEquivalentTotal)}</b></span></div>
          </div>
          <div className="daily-chart" role="img" aria-label="最近 14 天每日 Token 用量柱状图">
            <div className="chart-grid-lines" aria-hidden="true"><i /><i /><i /><i /></div>
            {dailyUsage.days.map((day, index) => (
              <button className={`daily-column${index < 2 ? " tooltip-start" : index > dailyUsage.days.length - 3 ? " tooltip-end" : ""}`} key={day.date} type="button" aria-label={`${day.label}，${day.total.toLocaleString("zh-CN")} Token`}>
                <div className="daily-value">{day.total ? formatTokens(day.total) : ""}</div>
                <div className="daily-bar-track">
                  <div className="daily-bar" style={{ height: `${Math.max(day.total ? 6 : 0, day.total / dailyUsage.peak * 82)}%` }}>
                    {day.accounts.map((entry) => <span key={entry.id} style={{ height: `${entry.tokens / day.total * 100}%`, background: entry.color }} title={`${entry.label}：${entry.tokens.toLocaleString("zh-CN")} Token`} />)}
                  </div>
                </div>
                <time dateTime={day.date}>{day.label}</time>
                <div className="daily-tooltip" role="tooltip">
                  <small>{day.date}</small>
                  <strong>{formatTokens(day.total)} Token</strong>
                  <div className="daily-tooltip-plus">≈ {formatPlusValue(day.plusEquivalent)} Plus</div>
                  {day.accounts.map((entry) => <span key={entry.id}><i style={{ background: entry.color }} />{entry.label}<b>{formatTokens(entry.tokens)}{entry.plusEquivalent != null ? ` · ${formatPlusValue(entry.plusEquivalent)} Plus` : ""}</b></span>)}
                  {day.accounts.length === 0 && <em>当天暂无用量</em>}
                </div>
              </button>
            ))}
          </div>
          <div className="daily-usage-legend">{devices.map((device, index) => {
            const report = usageTimeline.reports?.[device.id];
            const fresh = report && (clockNow || Date.now()) - Date.parse(report.updatedAt) < 180000;
            return <span key={device.id}><i style={{ background: USAGE_COLORS[index % USAGE_COLORS.length] }} />{device.name} · {report ? (fresh ? "用量已同步" : `上次上报 ${formatDateTime(report.updatedAt)}`) : "等待升级或首次上报"}</span>;
          })}</div>
          <div className="usage-insights">
            <section className="trend-panel">
              <div className="insight-heading"><div><h3>Token 消耗趋势</h3><p>每30分钟汇总 · 最近24小时 · 设备每分钟上报</p></div><span>峰值 {formatTokens(usageTrend.peak)} Token/30分钟</span></div>
              {!usageTimeline.updatedAt && <p role="status">等待设备上报用量，请先更新 Mac / Windows 切换器。</p>}
              <div className="trend-chart" onMouseLeave={() => setTrendHoverIndex(null)}>
                <svg viewBox={`0 0 ${usageTrend.width} ${usageTrend.height}`} role="img" aria-label="最近24小时所有设备每30分钟 Token 消耗趋势曲线">
                  <defs><linearGradient id="trend-area-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#8b5cf6" stopOpacity=".42"/><stop offset=".72" stopColor="#22d3ee" stopOpacity=".09"/><stop offset="1" stopColor="#22d3ee" stopOpacity=".01"/></linearGradient></defs>
                  {[0, .25, .5, .75, 1].map((ratio) => { const y = usageTrend.inset.top + ratio * usageTrend.plotHeight; const value = usageTrend.scalePeak * (1 - ratio); return <g className="trend-grid" key={ratio}><line x1={usageTrend.inset.left} x2={usageTrend.width - usageTrend.inset.right} y1={y} y2={y}/><text x={usageTrend.inset.left - 10} y={y + 4}>{formatTokens(Math.round(value))}</text></g>; })}
                  {usageTrend.areaPath && <path className="trend-area" d={usageTrend.areaPath}/>}
                  {usageTrend.linePath && <path className="trend-line" pathLength="1" d={usageTrend.linePath}/>}
                  {usageTrend.partialPath && <path className="trend-partial-line" d={usageTrend.partialPath}/>}
                  {trendHoverIndex != null && <line className="trend-cursor" x1={usageTrend.points[trendHoverIndex].x} x2={usageTrend.points[trendHoverIndex].x} y1={usageTrend.inset.top} y2={usageTrend.inset.top + usageTrend.plotHeight} />}
                  {usageTrend.points.map((point, index) => <circle key={point.timestamp} className={`trend-hit${index === usageTrend.maxIndex ? " peak" : ""}${index === usageTrend.points.length - 1 ? " current" : ""}`} cx={point.x} cy={point.y} r={index === trendHoverIndex ? 6 : index === usageTrend.points.length - 1 ? 5 : 3} tabIndex={0} onMouseEnter={() => setTrendHoverIndex(index)} onFocus={() => setTrendHoverIndex(index)} aria-label={`${new Date(point.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}，${point.tokens.toLocaleString("zh-CN")} Token`}/>)}
                  {[0, 6, 12, 18, 24, 30, 36, 42, 47].map((index) => <text className="trend-x-label" key={index} x={usageTrend.points[index].x} y={usageTrend.height - 7} textAnchor={index === 0 ? "start" : index === 47 ? "end" : "middle"}>{new Date(usageTrend.points[index].timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</text>)}
                  <text className="trend-current-label" x={usageTrend.points.at(-1)?.x} y={Math.max(16, (usageTrend.points.at(-1)?.y || 0) - 12)} textAnchor="end">进行中</text>
                </svg>
                {trendHoverIndex != null && <div className="trend-tooltip" style={{ left: `${usageTrend.points[trendHoverIndex].x / usageTrend.width * 100}%`, top: `${usageTrend.points[trendHoverIndex].y / usageTrend.height * 100}%` }}><small>{new Date(usageTrend.points[trendHoverIndex].timestamp).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}{trendHoverIndex === usageTrend.points.length - 1 ? " · 当前区间" : ""}</small><b>{usageTrend.points[trendHoverIndex].tokens.toLocaleString("zh-CN")} Token</b></div>}
              </div>
            </section>
            <section className="model-panel" onMouseLeave={() => setModelHoverIndex(null)}>
              <div className="insight-heading"><div><h3>模型消耗占比</h3><p>最近24小时 · 按 Token 排名</p></div>{modelUsage.total > 0 && <span>{formatTokens(modelUsage.total)} Token</span>}</div>
              {modelUsage.total > 0 ? <>
                <div className="model-donut" role="img" aria-label={`最近24小时共统计 ${modelUsage.segments.length} 种模型`}>
                  <svg viewBox="0 0 120 120" aria-hidden="true">
                    <circle className="model-donut-track" cx="60" cy="60" r="46" pathLength="100" />
                    {modelUsage.segments.map((segment, index) => <circle key={segment.model} className={`model-donut-segment${modelHoverIndex != null && modelHoverIndex !== index ? " dimmed" : ""}${modelHoverIndex === index ? " focused" : ""}`} cx="60" cy="60" r="46" pathLength="100" stroke={segment.color} strokeDasharray={`${segment.percent} ${100 - segment.percent}`} strokeDashoffset={-segment.offset} onMouseEnter={() => setModelHoverIndex(index)} />)}
                  </svg>
                  <div><b>{(modelUsage.segments[modelHoverIndex ?? 0]?.percent || 0).toFixed(0)}%</b><span title={modelUsage.segments[modelHoverIndex ?? 0]?.model}>{modelUsage.segments[modelHoverIndex ?? 0]?.model === "unknown" ? "未知模型" : modelUsage.segments[modelHoverIndex ?? 0]?.model === "other" ? "其他模型" : modelUsage.segments[modelHoverIndex ?? 0]?.model}</span></div>
                </div>
                <div className="model-legend">
                  {modelUsage.segments.map((segment, index) => <div className={modelHoverIndex === index ? "active" : ""} key={segment.model} onMouseEnter={() => setModelHoverIndex(index)}><i style={{ background: segment.color }} /><span title={segment.model}>{segment.model === "unknown" ? "未知模型" : segment.model === "other" ? "其他模型" : segment.model}</span><b>{segment.percent.toFixed(segment.percent < 1 ? 1 : 0)}%</b><small>{formatTokens(segment.tokens)}</small></div>)}
                </div>
              </> : <div className="model-empty"><span>◌</span><b>等待模型数据</b><p>更新任意一台切换器后，模型占比会随 Token 用量自动出现。</p></div>}
            </section>
          </div>
        </section>

        <section className="devices-panel" id="devices">
          <div><p>设备</p><h2>已连接的电脑</h2></div>
          <div className="device-list">
            {devices.map((device) => {
              const needsUpdate = isSwitcherOutdated(device.agentVersion, device.platform);
              const needsRepair = device.platform === "windows" && !device.isOnline;
              const activeAccountLabel = device.codexAuthState === "signed-out"
                ? "未登录"
                : device.codexAuthState === "unknown-account"
                  ? "未登记账号"
                  : accounts.find((account) => account.id === device.activeAccountId)?.note || device.activeAccountEmail || "尚未上报";
              return <div className="device-row" key={device.id}><span className="device-icon">{device.platform === "windows" ? "⊞" : "⌘"}</span><div><div className="device-name"><b>{device.name}</b><span className={`online-badge ${device.isOnline ? "online" : "offline"}`}><i />{device.isOnline ? "在线" : "离线"}</span></div><small>{device.platform === "windows" ? "Windows" : "Mac"} · <span className={`device-version ${needsUpdate ? "outdated" : "current"}`}>切换器 v{device.agentVersion || "未知"}{needsUpdate ? " · 需更新" : ""}</span> · 当前账号：<span className="device-account">{activeAccountLabel}</span> · {formatTime(device.lastSeenAt)}</small>{device.lastError && <em>{device.lastError}</em>}</div><div className="device-row-actions">{(needsUpdate || needsRepair) && <button className="repair-device" type="button" onClick={() => void repairDevice(device)}>{needsUpdate ? "更新切换器" : "修复连接"}</button>}<button type="button" onClick={() => startEditDevice(device)}>改名</button><button type="button" onClick={() => void removeDevice(device)}>移除</button></div></div>;
            })}
            {devices.length === 0 && <span className="no-device">还没有连接设备</span>}
          </div>
          <div className="device-connect-actions"><button className="secondary-button" type="button" onClick={() => void createPairing("mac")}>连接 Mac</button><button className="secondary-button" type="button" onClick={() => void createPairing("windows")}>连接 Windows</button></div>
        </section>

        <section className="history-panel">
          <div className="history-heading"><div><p>记录</p><h2>切换记录</h2></div><span>{history.length ? `第 ${visibleHistoryPage}/${historyPageCount} 页 · 共 ${Math.min(history.length, 100)} 条` : "暂无记录"}</span></div>
          <div className="history-list" key={visibleHistoryPage}>
            {pagedHistory.map((entry) => <article className="history-row" key={entry.id}><span className={`history-dot ${entry.status}`} /><div className="history-account"><b>{entry.accountNote || entry.accountEmail}</b>{entry.accountNote && <small>{entry.accountEmail}</small>}</div><div className="history-devices"><span>{entry.devices.length ? entry.devices.map((device) => device.name).join("、") : "未连接设备"}</span><small>{entry.devices.some((device) => device.error) ? entry.devices.find((device) => device.error)?.error : `${entry.devices.length} 台设备`}</small></div><time>{formatDateTime(entry.createdAt)}</time><span className={`history-status ${entry.status}`}>{historyStatusLabel[entry.status]}</span></article>)}
            {history.length === 0 && <div className="history-empty">还没有切换记录</div>}
          </div>
          {history.length > 5 && <nav className="history-pagination" aria-label="切换记录分页"><button type="button" disabled={visibleHistoryPage === 1} onClick={() => setHistoryPage(Math.max(1, visibleHistoryPage - 1))}>上一页</button><span><b>{visibleHistoryPage}</b> / {historyPageCount}</span><button type="button" disabled={visibleHistoryPage === historyPageCount} onClick={() => setHistoryPage(Math.min(historyPageCount, visibleHistoryPage + 1))}>下一页</button></nav>}
        </section>
      </section>

      {login && <div className="modal-backdrop"><section className="login-modal" role="dialog" aria-modal="true"><span className={`login-spinner${login.status === "complete" ? " complete" : ""}`}>{login.status === "complete" ? "✓" : ""}</span><h2>{login.status === "complete" ? "账号已添加" : login.status === "error" ? "登录失败" : "等待 ChatGPT 验证"}</h2><p>{login.status === "syncing" ? "登录成功，正在读取真实用量…" : login.status === "complete" ? "账号信息与用量已经保存。" : login.status === "error" ? login.error : `请在 OpenAI 官方页面完成登录${login.userCode ? `，并输入验证码 ${login.userCode}` : ""}。`}</p>{login.status === "waiting" && <a href={login.authUrl} target="_blank" rel="noreferrer">重新打开登录页 ↗</a>}{(login.status === "complete" || login.status === "error") && <button className="primary-button" type="button" onClick={() => setLogin(null)}>完成</button>}</section></div>}
      {pairing && <div className="modal-backdrop"><section className="pair-modal" role="dialog" aria-modal="true"><h2>连接这台 {pairing.platform === "windows" ? "Windows 电脑" : "Mac"}</h2><p>打开{pairing.platform === "windows" ? "“PowerShell”" : "“终端”"}，粘贴并运行下面的命令。通常只需执行一次；重复运行会安全更新，不会创建重复设备或启动多个后台程序。</p><code>{pairing.installCommand}</code><div><button className="secondary-button" type="button" onClick={() => setPairing(null)}>关闭</button><button className="primary-button" type="button" onClick={() => void copyInstallCommand()}>复制命令</button></div></section></div>}
      {repairing && <div className="modal-backdrop"><section className="pair-modal" role="dialog" aria-modal="true"><h2>更新 {repairing.device.name}</h2><p>在这台 {repairing.device.platform === "windows" ? "Windows 电脑上打开 PowerShell" : "Mac 上打开终端"}，复制并运行下面的命令。它会保留现有配对、设备名称和账号设置，并更新为不会互相覆盖凭据的新版切换器。</p><code>{repairing.command}</code><div><button className="secondary-button" type="button" onClick={() => setRepairing(null)}>关闭</button><button className="primary-button" type="button" onClick={() => void copyRepairCommand()}>复制更新命令</button></div></section></div>}
      {switchingAccount && <div className="modal-backdrop"><section className="device-switch-modal" role="dialog" aria-modal="true" aria-labelledby="device-switch-title"><h2 id="device-switch-title">选择使用这个账号的电脑</h2><p>将 <b>{switchingAccount.note || switchingAccount.email}</b> 分配给一台电脑，其他电脑保持原账号；也可以让全部设备一起切换。</p><div className="device-switch-list">{devices.map((device) => { const alreadyUsing = device.activeAccountId === switchingAccount.id; return <div className="device-switch-option" key={device.id}><span className="device-icon" aria-hidden="true">{device.platform === "windows" ? "⊞" : "⌘"}</span><div><b>{device.name}</b><small>{device.platform === "windows" ? "Windows" : "Mac"} · <span className={device.isOnline ? "device-online-text" : "device-offline-text"}>{device.isOnline ? "在线" : "离线"}</span> · 当前账号：{accounts.find((account) => account.id === device.activeAccountId)?.note || device.activeAccountEmail || "尚未切换"}</small></div><button className="primary-button" type="button" disabled={targetBusyId !== null} onClick={() => void switchAccount(switchingAccount, device)}>{targetBusyId === device.id ? "发送中…" : alreadyUsing ? "再次应用" : device.isOnline ? "切换这台" : "上线后切换"}</button></div>; })}{devices.length === 0 && <div className="no-device">还没有连接设备，请先在下方连接 Mac 或 Windows。</div>}</div><footer><button className="secondary-button" type="button" disabled={targetBusyId !== null} onClick={() => setSwitchingAccount(null)}>取消</button><button className="primary-button" type="button" disabled={targetBusyId !== null || devices.length === 0} onClick={() => void switchAccount(switchingAccount, null)}>{targetBusyId === "all" ? "发送中…" : "全部设备切换"}</button></footer></section></div>}
      {editingDevice && <div className="modal-backdrop"><form className="note-modal" role="dialog" aria-modal="true" onSubmit={saveDeviceName}><h2>修改设备名称</h2><p>为这台 {editingDevice.platform === "windows" ? "Windows 电脑" : "Mac"} 设置容易识别的名称。</p><input maxLength={80} placeholder="例如：办公室电脑、家里 Mac" value={deviceNameDraft} onChange={(event) => setDeviceNameDraft(event.target.value)} required /><small>{deviceNameDraft.length}/80；重启或重新连接后仍会保留</small><div><button className="secondary-button" type="button" disabled={deviceNameBusy} onClick={() => setEditingDevice(null)}>取消</button><button className="primary-button" type="submit" disabled={deviceNameBusy}>{deviceNameBusy ? "保存中…" : "保存名称"}</button></div></form></div>}
      {editingNote && <div className="modal-backdrop"><form className="note-modal" role="dialog" aria-modal="true" onSubmit={saveNote}><h2>编辑账号备注</h2><p>{editingNote.email}</p><input maxLength={40} placeholder="例如：主账号、备用账号" value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} /><small>{noteDraft.length}/40；留空则显示邮箱</small><div><button className="secondary-button" type="button" onClick={() => setEditingNote(null)}>取消</button><button className="primary-button" type="submit" disabled={busyId === editingNote.id}>保存备注</button></div></form></div>}
      {notice && <div className="toast"><span>✓</span>{notice}</div>}
    </main>
  );
}
