import { describe, expect, it, vi } from "vitest";
import { createClient, toIso, VercelApiError } from "../src/index.js";

interface Seen {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  auth: string | null;
  body: unknown;
}

/** A fetch that answers each call from `answer` and records what was asked. */
function fakeFetch(answer: (s: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const query: Record<string, string | string[]> = {};
    for (const key of new Set(url.searchParams.keys())) {
      const all = url.searchParams.getAll(key);
      query[key] = all.length > 1 ? all : all[0]!;
    }
    const s: Seen = {
      method: init?.method ?? "GET",
      path: `${url.origin}${url.pathname}`,
      query,
      auth: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(s);
    return answer(s);
  });
  return { fetch: fn as unknown as typeof fetch, seen };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const since = "2026-10-01";
const until = "2026-10-08T00:00:00Z";

describe("totals", () => {
  it("asks the count endpoint with the team, project and ISO window", async () => {
    const f = fakeFetch(() => json({ data: { visitors: 980, pageviews: null } }));
    const va = createClient({ token: "tok", teamId: "team_1", fetch: f.fetch });
    expect(await va.totals({ projectId: "prj_1", since, until })).toEqual({ visitors: 980, pageviews: 0 });
    expect(f.seen[0]).toMatchObject({
      method: "GET",
      path: "https://api.vercel.com/v1/query/web-analytics/visits/count",
      auth: "Bearer tok",
      query: { teamId: "team_1", projectId: "prj_1", since: "2026-10-01T00:00:00.000Z", until: "2026-10-08T00:00:00.000Z" },
    });
  });

  it("sends no teamId for a personal account, and a call's teamId wins over the client's", async () => {
    const f = fakeFetch(() => json({ data: { visitors: 1, pageviews: 1 } }));
    await createClient({ token: "tok", fetch: f.fetch }).totals({ projectId: "p", since, until });
    await createClient({ token: "tok", teamId: "a", fetch: f.fetch }).totals({ projectId: "p", since, until, teamId: "b" });
    expect(f.seen[0]!.query.teamId).toBeUndefined();
    expect(f.seen[1]!.query.teamId).toBe("b");
  });
});

describe("timeseries", () => {
  it("buckets by day by default and reads a timestamp without a zone as UTC", async () => {
    const f = fakeFetch(() =>
      json({
        data: [
          { timestamp: "2026-10-01T00:00:00.000Z", visitors: 5, pageviews: 9 },
          { timestamp: "2026-10-02T00:00:00", visitors: null, pageviews: null },
          { visitors: 3 },
        ],
      }),
    );
    const va = createClient({ token: "tok", fetch: f.fetch });
    expect(await va.timeseries({ projectId: "p", since, until })).toEqual([
      { timestamp: "2026-10-01T00:00:00.000Z", visitors: 5, pageviews: 9 },
      { timestamp: "2026-10-02T00:00:00.000Z", visitors: 0, pageviews: 0 },
    ]);
    expect(f.seen[0]!.query.by).toBe("day");
    await va.timeseries({ projectId: "p", since, until, granularity: "hour" });
    expect(f.seen[1]!.query.by).toBe("hour");
  });
});

describe("breakdown", () => {
  it("keys rows by the dimension, merges empty values into one label, and puts Others last", async () => {
    const f = fakeFetch(() =>
      json({
        data: [
          { referrerHostname: "Others", visitors: 2, pageviews: 3 },
          { referrerHostname: "google.com", visitors: 10, pageviews: 20 },
          { referrerHostname: "", visitors: 4, pageviews: 4 },
          { referrerHostname: null, visitors: 1, pageviews: 1 },
        ],
      }),
    );
    const va = createClient({ token: "tok", fetch: f.fetch });
    expect(await va.breakdown({ projectId: "p", since, until, by: "referrerHostname", limit: 3 })).toEqual([
      { key: "google.com", visitors: 10, pageviews: 20 },
      { key: "Direct", visitors: 5, pageviews: 5 },
      { key: "Others", visitors: 2, pageviews: 3 },
    ]);
    expect(f.seen[0]).toMatchObject({ path: "https://api.vercel.com/v1/query/web-analytics/visits/aggregate", query: { by: "referrerHostname", limit: "3" } });
  });

  it("reads an answer without a data array as no rows", async () => {
    const f = fakeFetch(() => json({}));
    expect(await createClient({ token: "tok", fetch: f.fetch }).breakdown({ projectId: "p", since, by: "country" })).toEqual([]);
    expect(f.seen[0]!.query.limit).toBe("10");
  });
});

describe("events", () => {
  it("merges names, drops Vercel's Others row past the limit, and sorts by count", async () => {
    const f = fakeFetch(() =>
      json({
        data: [
          { eventName: "Signup", count: 3, visitors: 3 },
          { eventName: "Purchase", count: 7, visitors: 5 },
          { eventName: "Signup", count: 2 },
          { eventName: "", count: 9 },
          { eventName: "Others", count: 40, visitors: 30 },
        ],
      }),
    );
    const va = createClient({ token: "tok", fetch: f.fetch });
    expect(await va.events({ projectId: "p", since, until, limit: 4 })).toEqual([
      { name: "Purchase", count: 7, visitors: 5 },
      { name: "Signup", count: 5, visitors: 3 },
    ]);
    expect(f.seen[0]).toMatchObject({ path: "https://api.vercel.com/v1/query/web-analytics/events/aggregate", query: { by: "eventName", limit: "4" } });
  });

  it("filters one event's series with a quoted OData literal", async () => {
    const f = fakeFetch(() => json({ data: [{ timestamp: "2026-10-01T00:00:00Z", count: 4 }] }));
    const va = createClient({ token: "tok", fetch: f.fetch });
    expect(await va.eventSeries({ projectId: "p", since, until, event: "it's" })).toEqual([{ timestamp: "2026-10-01T00:00:00.000Z", count: 4 }]);
    expect(f.seen[0]!.query.filter).toBe("eventName eq 'it''s'");
  });
});

describe("projects and teams", () => {
  it("follows the cursor and reports the domain and whether Web Analytics is on", async () => {
    const f = fakeFetch((s) =>
      s.query.from === undefined
        ? json({
            projects: [
              {
                id: "p1",
                name: "web",
                framework: "nextjs",
                webAnalytics: { enabledAt: 10 },
                alias: [
                  { domain: "web.vercel.app", target: "PRODUCTION" },
                  { domain: "www.example.com", target: "PRODUCTION" },
                  { domain: "example.com", target: "PRODUCTION" },
                  { domain: "old.com", target: "PRODUCTION", redirect: "example.com" },
                ],
              },
            ],
            pagination: { next: 123 },
          })
        : json({
            projects: [
              { id: "p2", name: "docs", webAnalytics: { enabledAt: 10, disabledAt: 20 } },
              { id: "p3", name: "app", alias: [], targets: { production: { alias: ["www.app.dev", "app.dev", "app-team.vercel.app"] } } },
            ],
            pagination: { next: null },
          }),
    );
    const va = createClient({ token: "tok", teamId: "t", fetch: f.fetch });
    expect(await va.projects()).toEqual([
      { id: "p1", name: "web", domain: "example.com", framework: "nextjs", analyticsEnabled: true },
      { id: "p2", name: "docs", domain: null, framework: null, analyticsEnabled: false },
      { id: "p3", name: "app", domain: "app.dev", framework: null, analyticsEnabled: false },
    ]);
    expect(f.seen.map((s) => s.query.from)).toEqual([undefined, "123"]);
  });

  it("lists teams without a teamId", async () => {
    const f = fakeFetch(() => json({ teams: [{ id: "t1", slug: "acme", name: "Acme", billing: { plan: "pro" } }], pagination: { next: null } }));
    expect(await createClient({ token: "tok", teamId: "t", fetch: f.fetch }).teams()).toEqual([{ id: "t1", slug: "acme", name: "Acme", plan: "pro" }]);
    expect(f.seen[0]!.query.teamId).toBeUndefined();
  });
});

describe("speedInsights", () => {
  it("POSTs the metrics query with whole seconds and the production filter", async () => {
    const f = fakeFetch(() => json({ summary: [{ dimensions: { route: "/" }, values: { lcp: 1800 } }] }));
    const va = createClient({ token: "tok", teamId: "team_1", fetch: f.fetch });
    const res = await va.speedInsights({
      since: Date.UTC(2026, 9, 1, 0, 0, 0, 123),
      until: until,
      groupBy: ["route"],
      outputs: { lcp: { metric: "vercel.speed_insights.lcp_ms", aggregation: "p75" } },
    });
    expect(res).toEqual({ series: [], summary: [{ dimensions: { route: "/" }, values: { lcp: 1800 } }] });
    expect(f.seen[0]).toMatchObject({
      method: "POST",
      path: "https://api.vercel.com/metrics/v1",
      query: { teamId: "team_1" },
      body: {
        scope: { ownerId: "team_1" },
        timeRange: { start: "2026-10-01T00:00:00.000Z", end: "2026-10-08T00:00:00.000Z" },
        filter: "environment:production",
        outputs: ["lcp"],
      },
    });
  });

  it("needs a team", async () => {
    const va = createClient({ token: "tok", fetch: fakeFetch(() => json({})).fetch });
    await expect(va.speedInsights({ since, outputs: {} })).rejects.toThrow(/teamId/);
  });
});

describe("errors and retries", () => {
  it("throws VercelApiError with Vercel's code and message", async () => {
    const f = fakeFetch(() => json({ error: { code: "forbidden", message: "Not authorized" } }, 403));
    const err = await createClient({ token: "tok", fetch: f.fetch }).totals({ projectId: "p", since }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VercelApiError);
    expect(err).toMatchObject({ status: 403, code: "forbidden", message: "Not authorized", isAuthError: true });
    expect(f.seen).toHaveLength(1);
  });

  it("marks a 402 as needing a plan", async () => {
    const f = fakeFetch(() => json({ error: { code: "payment_required", message: "Upgrade" } }, 402));
    const err = await createClient({ token: "tok", fetch: f.fetch }).breakdown({ projectId: "p", since, by: "utmSource" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ isPlanRequired: true });
  });

  it("retries a 429 after the wait Vercel asks, then succeeds", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const f = fakeFetch(() => (n++ === 0 ? json({ error: { code: "rate_limited" } }, 429, { "retry-after": "2" }) : json({ data: { visitors: 1, pageviews: 2 } })));
      const p = createClient({ token: "tok", fetch: f.fetch }).totals({ projectId: "p", since, until });
      await vi.advanceTimersByTimeAsync(1999);
      expect(f.seen).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toEqual({ visitors: 1, pageviews: 2 });
      expect(f.seen).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after `retries` and throws the last error", async () => {
    const f = fakeFetch(() => json({ error: { code: "internal" } }, 500, { "retry-after": "0" }));
    const err = await createClient({ token: "tok", retries: 1, fetch: f.fetch }).totals({ projectId: "p", since }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 500, code: "internal" });
    expect(f.seen).toHaveLength(2);
  });

  it("times out as a 504 and does not retry it", async () => {
    const f = fakeFetch(
      () =>
        new Promise<Response>((_, reject) => {
          const signal = f.fetch.mock.calls.at(-1)![1]!.signal!;
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    ) as ReturnType<typeof fakeFetch> & { fetch: ReturnType<typeof vi.fn> };
    const err = await createClient({ token: "tok", timeoutMs: 5, fetch: f.fetch as unknown as typeof fetch }).totals({ projectId: "p", since }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 504, code: "timeout" });
    expect(f.seen).toHaveLength(1);
  });

  it("passes the caller's abort through unchanged", async () => {
    const ac = new AbortController();
    ac.abort(new Error("stop"));
    const f = fakeFetch(() => json({}));
    await expect(createClient({ token: "tok", fetch: f.fetch }).totals({ projectId: "p", since, signal: ac.signal })).rejects.toThrow("stop");
    expect(f.seen).toHaveLength(0);
  });
});

describe("request", () => {
  it("only sends the token to api.vercel.com", async () => {
    const f = fakeFetch(() => json({}));
    const va = createClient({ token: "tok", fetch: f.fetch });
    await expect(va.request("https://evil.example/x")).rejects.toThrow(TypeError);
    await expect(va.request("//evil.example/x")).rejects.toThrow(TypeError);
    await va.request("/v9/projects/p1", { query: { a: ["1", "2"] } });
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]).toMatchObject({ path: "https://api.vercel.com/v9/projects/p1", query: { a: ["1", "2"] } });
  });
});

describe("toIso", () => {
  it("takes a Date, epoch ms or a date string, and refuses junk", () => {
    expect(toIso(new Date(0))).toBe("1970-01-01T00:00:00.000Z");
    expect(toIso(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(toIso("2026-10-01")).toBe("2026-10-01T00:00:00.000Z");
    expect(() => toIso("yesterday")).toThrow(TypeError);
  });

  it("refuses a client without a token", () => {
    expect(() => createClient({ token: "" })).toThrow(TypeError);
  });
});
