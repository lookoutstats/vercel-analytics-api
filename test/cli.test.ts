import { describe, expect, it } from "vitest";
import { parseWhen, run, type CliIO } from "../src/cli.js";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const PROJECTS = [
  { id: "prj_a", name: "site-a", webAnalytics: { enabledAt: 1 }, targets: { production: { alias: ["a.com"] } } },
  { id: "prj_b", name: "site-b", webAnalytics: { enabledAt: 1 }, targets: { production: { alias: ["b.com"] } } },
  { id: "prj_c", name: "site-c", webAnalytics: null },
];

/** Runs the CLI against a fake Vercel API; returns the exit code, the output lines and the requests. */
async function cli(argv: string[], over: Partial<CliIO> & { answer?: (url: URL) => Response } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const seen: URL[] = [];
  const answer = over.answer ?? ((url: URL) => {
    if (url.pathname === "/v2/teams") return json({ teams: [{ id: "team_1", slug: "acme", name: "Acme", billing: { plan: "pro" } }] });
    if (url.pathname === "/v10/projects") return json({ projects: PROJECTS });
    if (url.pathname.endsWith("/visits/count")) return json({ data: url.searchParams.get("projectId") === "prj_a" ? { visitors: 1200, pageviews: 3400 } : { visitors: 80, pageviews: 90 } });
    if (url.pathname.endsWith("/visits/aggregate")) {
      const by = url.searchParams.get("by");
      if (by === "day") return json({ data: [{ timestamp: "2026-11-01T00:00:00", visitors: 10, pageviews: 20 }, { timestamp: "2026-11-02T00:00:00", visitors: 12, pageviews: 25 }] });
      return json({ data: [{ requestPath: "/", visitors: 900, pageviews: 1500 }, { requestPath: "/pricing", visitors: 120, pageviews: 130 }] });
    }
    if (url.pathname.endsWith("/events/aggregate")) return json({ data: [{ eventName: "signup", count: 40, visitors: 35 }] });
    return json({ error: { message: "not found" } }, 404);
  });
  const code = await run(argv, {
    env: { VERCEL_TOKEN: "tok" },
    stdout: (l) => out.push(...l.split("\n")),
    stderr: (l) => err.push(...l.split("\n")),
    now: () => NOW,
    readText: async () => null,
    platform: "linux",
    home: "/home/me",
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      seen.push(url);
      return answer(url);
    }) as typeof fetch,
    ...over,
  });
  return { code, out, err, seen };
}

describe("vercel-analytics-api CLI", () => {
  it("visitors: every project with Web Analytics, busiest first, as an aligned table", async () => {
    const r = await cli(["visitors", "--team", "team_1"]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["PROJECT  VISITORS  PAGE VIEWS", "a.com       1,200       3,400", "b.com          80          90"]);
    // site-c has Web Analytics off: not asked.
    expect(r.seen.filter((u) => u.pathname.endsWith("/visits/count")).map((u) => u.searchParams.get("projectId"))).toEqual(["prj_a", "prj_b"]);
    expect(r.seen[1]!.searchParams.get("since")).toBe(new Date(NOW - 7 * 86_400_000).toISOString());
  });

  it("top pages for a project named by its domain, with --json and a team slug", async () => {
    const r = await cli(["top", "pages", "-p", "a.com", "-t", "acme", "-n", "2", "--since", "2026-10-01", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.join("\n"))).toEqual([{ key: "/", visitors: 900, pageviews: 1500 }, { key: "/pricing", visitors: 120, pageviews: 130 }]);
    const q = r.seen.find((u) => u.pathname.endsWith("/visits/aggregate"))!.searchParams;
    expect([q.get("teamId"), q.get("projectId"), q.get("by"), q.get("limit"), q.get("since")]).toEqual(["team_1", "prj_a", "requestPath", "2", "2026-10-01T00:00:00.000Z"]);
  });

  it("events and series", async () => {
    expect((await cli(["events", "-p", "site-a"])).out).toEqual(["EVENT   COUNT  VISITORS", "signup     40        35"]);
    expect((await cli(["series", "-p", "site-a"])).out).toEqual(["DAY         VISITORS  PAGE VIEWS", "2026-11-01        10          20", "2026-11-02        12          25"]);
  });

  it("uses the Vercel CLI's login and current team when no token is set; an expired login says how to renew it", async () => {
    const files: Record<string, string> = {
      "/home/me/.local/share/com.vercel.cli/auth.json": JSON.stringify({ token: "cli-token", expiresAt: NOW / 1000 + 3600 }),
      "/home/me/.local/share/com.vercel.cli/config.json": JSON.stringify({ currentTeam: "team_9" }),
    };
    let auth: string | null = null;
    const r = await cli(["projects"], {
      env: {},
      readText: async (p) => files[p] ?? null,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        auth = new Headers(init?.headers).get("authorization");
        expect(new URL(String(input)).searchParams.get("teamId")).toBe("team_9");
        return json({ projects: PROJECTS });
      }) as typeof fetch,
    });
    expect(r.code).toBe(0);
    expect(auth).toBe("Bearer cli-token");
    expect(r.out[0]).toBe("PROJECT  DOMAIN  ANALYTICS  ID");
    expect(r.out).toContain("site-c           off        prj_c");

    files["/home/me/.local/share/com.vercel.cli/auth.json"] = JSON.stringify({ token: "old", expiresAt: NOW / 1000 - 1 });
    const expired = await cli(["projects"], { env: {}, readText: async (p) => files[p] ?? null });
    expect(expired.code).toBe(2);
    expect(expired.err[0]).toContain("Vercel CLI login expired");
    const none = await cli(["projects"], { env: {} });
    expect(none.err[0]).toContain("No Vercel token");
  });

  it("explains usage mistakes (exit 2) and Vercel's errors (exit 1)", async () => {
    expect((await cli([])).code).toBe(2);
    expect((await cli(["--help"])).out[0]).toBe("Usage: vercel-analytics-api <command> [options]");
    expect((await cli(["top", "pages"])).err[0]).toBe("This command needs --project <name|id>.");
    expect((await cli(["top", "colors", "-p", "a.com"])).err[0]).toContain("top needs one of: pages, referrers");
    expect((await cli(["top", "pages", "-p", "nope"])).err[0]).toContain('No project "nope"');
    expect((await cli(["visitors", "--since", "soon"])).err[0]).toContain('Not a time: "soon"');
    const plan = await cli(["top", "utm-campaign", "-p", "a.com"], {
      answer: (url) => (url.pathname === "/v10/projects" ? json({ projects: PROJECTS }) : json({ error: { code: "payment_required", message: "UTM dimensions require Web Analytics Plus" } }, 402)),
    });
    expect(plan.code).toBe(1);
    expect(plan.err[0]).toContain("Vercel answered 402");
    expect(plan.err[0]).toContain("Web Analytics Plus");
  });

  it("parseWhen: 24h, 30d and dates", () => {
    expect(parseWhen("24h", NOW)).toBe(NOW - 86_400_000);
    expect(parseWhen("30d", NOW)).toBe(NOW - 30 * 86_400_000);
    expect(parseWhen("2026-10-01", NOW)).toBe(Date.parse("2026-10-01"));
  });
});
