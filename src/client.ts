import { VercelApiError } from "./errors.js";
import type {
  BreakdownRow,
  CallOptions,
  ClientOptions,
  DateInput,
  Dimension,
  EventCount,
  EventPoint,
  Granularity,
  Project,
  RangeOptions,
  SpeedInsightsOptions,
  SpeedInsightsResult,
  Team,
  TimeseriesPoint,
  Totals,
} from "./types.js";

const API = "https://api.vercel.com";
const MAX_PAGES = 50;
const MAX_RETRY_WAIT_MS = 60_000;
/** Speed Insights queries are slow at Vercel: a 30-day one by route can take about 15 s. */
const SPEED_TIMEOUT_MS = 45_000;
const VISITS = "/v1/query/web-analytics/visits";
const EVENTS = "/v1/query/web-analytics/events";

type Query = Record<string, string | readonly string[] | undefined>;

export interface RequestOptions extends CallOptions {
  query?: Query;
  /** A JSON body. The request is then a POST. */
  body?: unknown;
  timeoutMs?: number;
}

export interface VercelAnalyticsClient {
  /** The teams the token can read. */
  teams(opts?: { signal?: AbortSignal }): Promise<Team[]>;
  /** Every project in the team, with whether Web Analytics is on. */
  projects(opts?: CallOptions): Promise<Project[]>;
  /** Unique visitors and page views in the window. */
  totals(opts: RangeOptions): Promise<Totals>;
  /** Visitors and page views per hour or day. */
  timeseries(opts: RangeOptions & { granularity?: Granularity }): Promise<TimeseriesPoint[]>;
  /** Top values of one dimension: pages, referrers, countries, devices, browsers, OSes or UTM tags. */
  breakdown(opts: RangeOptions & { by: Dimension; limit?: number }): Promise<BreakdownRow[]>;
  /** Custom events by name, most fired first. */
  events(opts: RangeOptions & { limit?: number }): Promise<EventCount[]>;
  /** One custom event's count per hour or day. */
  eventSeries(opts: RangeOptions & { event: string; granularity?: Granularity }): Promise<EventPoint[]>;
  /** Speed Insights (Core Web Vitals) for the team, as `vercel metrics` asks. */
  speedInsights(opts: SpeedInsightsOptions): Promise<SpeedInsightsResult>;
  /** Any other api.vercel.com call, with the same auth, timeout, retries and errors. */
  request<T = unknown>(path: string, opts?: RequestOptions): Promise<T>;
}

const EMPTY_KEY: Record<Dimension, string> = {
  requestPath: "/",
  referrerHostname: "Direct",
  country: "Unknown",
  deviceType: "Unknown",
  browserName: "Unknown",
  osName: "Unknown",
  utmSource: "(none)",
  utmMedium: "(none)",
  utmCampaign: "(none)",
};

/** A DateInput → ISO timestamp. Throws a TypeError for a date that doesn't parse. */
export function toIso(d: DateInput): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid date: ${String(d)}`);
  return date.toISOString();
}

/** Vercel sometimes leaves the zone off a bucket's timestamp; it is UTC. */
const utc = (s: string) => new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`).toISOString();
/** A count from Vercel: null, missing, negative or non-numeric reads as 0. */
const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const rowsOf = (body: unknown): Record<string, unknown>[] => {
  const data = (body as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data.filter((r): r is Record<string, unknown> => !!r && typeof r === "object") : [];
};

interface RawProject {
  id: string;
  name: string;
  framework?: string | null;
  webAnalytics?: { enabledAt?: number; disabledAt?: number } | null;
  alias?: Array<{ domain: string; target?: string | null; redirect?: string | null; gitBranch?: string | null }> | null;
  targets?: { production?: { alias?: string[] | null } | null } | null;
}

function toProject(p: RawProject): Project {
  const wa = p.webAnalytics;
  // Older projects list their domains in `alias`; newer ones only in the production target's `alias`.
  const domains = [
    ...(p.alias ?? []).filter((a) => a.target === "PRODUCTION" && !a.redirect && a.gitBranch == null).map((a) => a.domain),
    ...(p.targets?.production?.alias ?? []),
  ].filter((d) => !d.endsWith(".vercel.app"));
  // The root-most domain wins (example.com over www.example.com); the first listed on a tie.
  const domain = domains.reduce<string | null>((best, d) => (best && best.split(".").length <= d.split(".").length ? best : d), null);
  return {
    id: p.id,
    name: p.name,
    domain,
    framework: p.framework ?? null,
    analyticsEnabled: !!wa?.enabledAt && !(wa.disabledAt && wa.disabledAt >= wa.enabledAt),
  };
}

function retryAfterMs(res: Response): number | null {
  const after = res.headers.get("retry-after");
  if (after && /^\d+$/.test(after)) return Number(after) * 1000;
  const reset = res.headers.get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset)) return Math.max(0, Number(reset) * 1000 - Date.now());
  return null;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Creates a client. One per token; it holds no other state. */
export function createClient(options: ClientOptions): VercelAnalyticsClient {
  const { token, timeoutMs = 10_000, retries = 2 } = options;
  if (!token) throw new TypeError("createClient: `token` is required");

  async function once<T>(url: URL, body: unknown, signal: AbortSignal | undefined, timeout: number): Promise<T> {
    if (signal?.aborted) throw signal.reason;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new DOMException("Vercel request timed out", "TimeoutError")), timeout);
    const onAbort = () => ac.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      // Read the global fetch per call, so instrumentation installed after createClient still sees it.
      const res = await (options.fetch ?? fetch)(url, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
      if (res.ok) return (await res.json()) as T;
      const err = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; issues?: { path?: string; message?: string }[] } } | null;
      // The metrics API says why in its first issue; "Invalid metrics request" alone says nothing.
      const issue = err?.error?.issues?.[0];
      const message = (err?.error?.message ?? `Vercel answered ${res.status}`) + (issue?.message ? ` (${issue.path ? `${issue.path}: ` : ""}${issue.message})` : "");
      throw new VercelApiError(res.status, err?.error?.code ?? `http_${res.status}`, message, retryAfterMs(res));
    } catch (e) {
      if (e instanceof VercelApiError) throw e;
      if (!signal?.aborted && (ac.signal.reason as { name?: string } | undefined)?.name === "TimeoutError") {
        throw new VercelApiError(504, "timeout", `Vercel request timed out after ${timeout} ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    // The token only ever goes to api.vercel.com: a full URL or a "//host" path is refused.
    if (!path.startsWith("/") || path.startsWith("//")) throw new TypeError(`request: path must start with "/": ${path}`);
    const url = new URL(path, API);
    if (url.origin !== API) throw new TypeError(`request: not an api.vercel.com path: ${path}`);
    const teamId = opts.teamId ?? options.teamId;
    const query: Query = { ...(teamId ? { teamId } : {}), ...opts.query };
    // An array repeats its key: Vercel's `by` takes two dimensions as by=a&by=b.
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === "string") url.searchParams.set(key, value);
      else if (value) for (const v of value) url.searchParams.append(key, v);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return await once<T>(url, opts.body, opts.signal, opts.timeoutMs ?? timeoutMs);
      } catch (e) {
        const retryable = e instanceof VercelApiError && (e.status === 429 || (e.status >= 500 && e.code !== "timeout"));
        if (!retryable || attempt >= retries) throw e;
        await sleep(Math.min(MAX_RETRY_WAIT_MS, e.retryAfterMs ?? 500 * 2 ** attempt), opts.signal);
      }
    }
  }

  const range = (o: RangeOptions) => ({ projectId: o.projectId, since: toIso(o.since), until: toIso(o.until ?? Date.now()) });
  const call = (o: CallOptions) => ({ teamId: o.teamId, signal: o.signal });
  const eventFilter = (event: string) => `eventName eq '${event.replaceAll("'", "''")}'`;

  return {
    request,

    async teams(opts = {}) {
      const teams: Team[] = [];
      let until: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        type Raw = { teams: Array<{ id: string; slug: string; name?: string | null; billing?: { plan?: string } | null }>; pagination?: { next?: number | null } };
        // /v2/teams lists every team the token can read; a teamId here would narrow nothing.
        const body = await request<Raw>("/v2/teams", { signal: opts.signal, teamId: "", query: { limit: "100", until } });
        teams.push(...body.teams.map((t) => ({ id: t.id, slug: t.slug, name: t.name ?? null, plan: t.billing?.plan ?? null })));
        const next = body.pagination?.next;
        if (next == null || String(next) === until) break;
        until = String(next);
      }
      return teams;
    },

    async projects(opts = {}) {
      const projects: Project[] = [];
      let from: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = await request<RawProject[] | { projects: RawProject[]; pagination?: { next?: string | number | null } }>("/v10/projects", {
          ...call(opts),
          query: { limit: "100", from },
        });
        projects.push(...(Array.isArray(body) ? body : body.projects).map(toProject));
        const next = Array.isArray(body) ? null : body.pagination?.next;
        if (next == null || String(next) === from) break;
        from = String(next);
      }
      return projects;
    },

    async totals(o) {
      const body = await request<{ data?: { visitors?: unknown; pageviews?: unknown } }>(`${VISITS}/count`, { ...call(o), query: range(o) });
      return { visitors: num(body.data?.visitors), pageviews: num(body.data?.pageviews) };
    },

    async timeseries(o) {
      const body = await request(`${VISITS}/aggregate`, { ...call(o), query: { ...range(o), by: o.granularity ?? "day" } });
      return rowsOf(body)
        .filter((r) => typeof r.timestamp === "string")
        .map((r) => ({ timestamp: utc(r.timestamp as string), visitors: num(r.visitors), pageviews: num(r.pageviews) }));
    },

    async breakdown(o) {
      const body = await request(`${VISITS}/aggregate`, { ...call(o), query: { ...range(o), by: o.by, limit: String(o.limit ?? 10) } });
      // Vercel can answer "" and null as two rows; they are one value.
      const rows = rowsOf(body);
      const merged = new Map<string, BreakdownRow>();
      for (const r of rows) {
        const raw = r[o.by];
        const key = typeof raw === "string" && raw.trim() ? raw : EMPTY_KEY[o.by];
        const prev = merged.get(key);
        merged.set(key, { key, visitors: (prev?.visitors ?? 0) + num(r.visitors), pageviews: (prev?.pageviews ?? 0) + num(r.pageviews) });
      }
      // Past `limit`, Vercel adds one "Others" row for the rest, often first: it goes last.
      const others = rows.length > (o.limit ?? 10) ? merged.get("Others") : undefined;
      if (others) merged.delete("Others");
      return others ? [...merged.values(), others] : [...merged.values()];
    },

    async events(o) {
      const limit = o.limit ?? 100;
      const rows = rowsOf(await request(`${EVENTS}/aggregate`, { ...call(o), query: { ...range(o), by: "eventName", limit: String(limit) } }));
      const merged = new Map<string, EventCount>();
      for (const r of rows) {
        const name = r.eventName;
        // Past `limit`, Vercel adds one "Others" row: it is not an event.
        if (typeof name !== "string" || !name.trim() || (rows.length > limit && name === "Others")) continue;
        const prev = merged.get(name);
        merged.set(name, { name, count: (prev?.count ?? 0) + num(r.count), visitors: (prev?.visitors ?? 0) + num(r.visitors) });
      }
      return [...merged.values()].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
    },

    async eventSeries(o) {
      const body = await request(`${EVENTS}/aggregate`, { ...call(o), query: { ...range(o), by: o.granularity ?? "day", filter: eventFilter(o.event) } });
      return rowsOf(body)
        .filter((r) => typeof r.timestamp === "string")
        .map((r) => ({ timestamp: utc(r.timestamp as string), count: num(r.count) }));
    },

    async speedInsights(o) {
      const teamId = o.teamId ?? options.teamId;
      if (!teamId) throw new TypeError("speedInsights: a `teamId` is required (on the client or the call)");
      // Speed Insights' timestamps are whole seconds, and Vercel refuses a range with milliseconds.
      const second = (d: DateInput) => toIso(Math.floor(new Date(toIso(d)).getTime() / 1000) * 1000);
      const body = {
        scope: { ownerId: teamId },
        timeRange: { start: second(o.since), end: second(o.until ?? Date.now()) },
        bucketSeconds: o.bucketSeconds ?? 86_400,
        groupBy: o.groupBy ?? [],
        filter: o.filter ?? "environment:production",
        metrics: o.outputs,
        outputs: Object.keys(o.outputs),
        ...(o.limit ? { seriesSelection: { limit: o.limit.count, mode: "exact", rankBy: [{ metric: o.limit.rankBy, direction: "desc" }] } } : {}),
      };
      const res = await request<Partial<SpeedInsightsResult>>("/metrics/v1", {
        teamId,
        signal: o.signal,
        body,
        timeoutMs: Math.max(timeoutMs, SPEED_TIMEOUT_MS),
      });
      return { series: res.series ?? [], summary: res.summary ?? [] };
    },
  };
}
