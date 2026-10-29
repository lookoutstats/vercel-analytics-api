/** A point in time: a Date, epoch milliseconds, or a string `Date` can parse ("2026-10-01", an ISO timestamp). */
export type DateInput = Date | number | string;

/** The bucket size of a time series. */
export type Granularity = "hour" | "day";

/** What a breakdown groups visits by. The `utm*` dimensions need Web Analytics Plus (Vercel answers 402 without it). */
export type Dimension =
  | "requestPath"
  | "referrerHostname"
  | "country"
  | "deviceType"
  | "browserName"
  | "osName"
  | "utmSource"
  | "utmMedium"
  | "utmCampaign";

export interface ClientOptions {
  /** A Vercel access token (vercel.com/account/settings/tokens). Read access to the team is enough. */
  token: string;
  /** The default team for every call. Omit it for projects on a personal (Hobby) account. */
  teamId?: string;
  /** Per-request timeout in milliseconds. Default 10 000; Speed Insights queries get at least 45 000. */
  timeoutMs?: number;
  /** Retries after a 429 or a 5xx answer, waiting what Vercel asks (at most 60 s). Default 2; 0 turns them off. */
  retries?: number;
  /** A fetch implementation. Default: the global fetch. */
  fetch?: typeof fetch;
}

/** Options every call takes. */
export interface CallOptions {
  /** This call's team, instead of the client's default. */
  teamId?: string;
  signal?: AbortSignal;
}

/** A project's time window. */
export interface RangeOptions extends CallOptions {
  projectId: string;
  /** Start of the window. */
  since: DateInput;
  /** End of the window. Default: now. */
  until?: DateInput;
}

export interface Team {
  id: string;
  slug: string;
  name: string | null;
  /** "hobby", "pro" or "enterprise", as Vercel reports it. */
  plan: string | null;
}

export interface Project {
  id: string;
  name: string;
  /** The root-most custom production domain, else null (no *.vercel.app domains). */
  domain: string | null;
  framework: string | null;
  /** Web Analytics is turned on for this project. */
  analyticsEnabled: boolean;
}

export interface Totals {
  /** Unique visitors in the window. */
  visitors: number;
  pageviews: number;
}

export interface TimeseriesPoint extends Totals {
  /** The bucket's start, as an ISO timestamp in UTC. */
  timestamp: string;
}

export interface BreakdownRow extends Totals {
  /**
   * The dimension's value. An empty value reads as "Direct" for referrers, "/" for paths, "(none)" for UTM tags and
   * "Unknown" for the rest. Vercel groups the rows past `limit` into one row keyed "Others".
   */
  key: string;
}

export interface EventCount {
  name: string;
  /** Times the event fired. */
  count: number;
  /** Unique visitors who fired it. */
  visitors: number;
}

export interface EventPoint {
  timestamp: string;
  count: number;
}

/** The Speed Insights metrics, by Vercel's name. */
export type SpeedMetric =
  | "vercel.speed_insights.lcp_ms"
  | "vercel.speed_insights.inp_ms"
  | "vercel.speed_insights.cls"
  | "vercel.speed_insights.fcp_ms"
  | "vercel.speed_insights.ttfb_ms";

export type SpeedDimension = "projectId" | "route" | "deviceType";
/** "p75" (what Vercel scores) or "count" (samples). Other aggregations pass through to Vercel unchecked. */
export type SpeedAggregation = "p75" | "count" | (string & {});

export interface SpeedInsightsOptions extends CallOptions {
  since: DateInput;
  until?: DateInput;
  /** Output name → metric and aggregation, e.g. `{ lcp: { metric: "vercel.speed_insights.lcp_ms", aggregation: "p75" } }`. */
  outputs: Record<string, { metric: SpeedMetric; aggregation: SpeedAggregation }>;
  groupBy?: SpeedDimension[];
  /** Vercel's filter expression. Default: "environment:production". Group by "projectId" to split by project. */
  filter?: string;
  /** Bucket size of `series` in seconds. Default and maximum: 86 400 (a day). */
  bucketSeconds?: number;
  /** Keep the `count` groups with the most of `rankBy` (an output name). */
  limit?: { count: number; rankBy: string };
}

export interface SpeedRow {
  dimensions: Partial<Record<SpeedDimension, string>>;
  values: Record<string, number | null>;
}

export interface SpeedInsightsResult {
  /** One row per group per bucket. */
  series: Array<SpeedRow & { timestamp: string }>;
  /** One row per group over the whole window. */
  summary: SpeedRow[];
}
