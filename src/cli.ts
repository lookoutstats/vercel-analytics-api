// The command line: `npx vercel-analytics-api <command>`. Its logic is here, apart from the bin file, so tests run it
// with a fake fetch, environment and output.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createClient, type VercelAnalyticsClient } from "./client.js";
import { VercelApiError } from "./errors.js";
import type { Dimension, Project } from "./types.js";

export interface CliIO {
  env: Record<string, string | undefined>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
  /** Reads a file as text, or null when it can't. Default: the file system. */
  readText?: (path: string) => Promise<string | null>;
  platform?: NodeJS.Platform;
  home?: string;
}

const HELP = `Usage: vercel-analytics-api <command> [options]

Commands:
  teams                      The teams the token can read
  projects                   The team's projects, with Web Analytics on or off
  visitors                   Visitors and page views per project (every project with Web Analytics)
  top <what>                 Top values for one project: pages, referrers, countries, devices,
                             browsers, os, utm-source, utm-medium, utm-campaign
  events                     Custom events for one project, most fired first
  series                     Visitors and page views per day (or hour) for one project

Options:
  -p, --project <name|id>    The project: its name, its production domain or its id
  -t, --team <slug|id>       The team. Default: VERCEL_TEAM_ID, else the Vercel CLI's current team
  -s, --since <when>         Start: 24h, 7d, 30d, or a date (2026-10-01). Default: 7d
  -u, --until <when>         End: a date. Default: now
  -n, --limit <n>            Rows for top and events. Default: 10
      --hourly               series: per hour instead of per day
      --json                 Print JSON instead of a table
      --token <token>        A Vercel token. Default: VERCEL_TOKEN, else the Vercel CLI's login
  -h, --help                 Show this help

Examples:
  npx vercel-analytics-api visitors --since 30d
  npx vercel-analytics-api top pages --project my-site --limit 5
  npx vercel-analytics-api series -p my-site --json`;

const TOP: Record<string, Dimension> = {
  pages: "requestPath",
  referrers: "referrerHostname",
  countries: "country",
  devices: "deviceType",
  browsers: "browserName",
  os: "osName",
  "utm-source": "utmSource",
  "utm-medium": "utmMedium",
  "utm-campaign": "utmCampaign",
};

class UsageError extends Error {}

const DAY = 86_400_000;

/** "7d", "24h" or a date → epoch ms. */
export function parseWhen(s: string, now: number): number {
  const rel = /^(\d+)([hd])$/.exec(s.trim());
  if (rel) return now - Number(rel[1]) * (rel[2] === "h" ? 3_600_000 : DAY);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new UsageError(`Not a time: "${s}". Use 24h, 7d, 30d or a date such as 2026-10-01.`);
  return t;
}

/** Where the Vercel CLI keeps its files (the `xdg-app-paths` data directory for "com.vercel.cli"). */
function vercelCliDir(platform: NodeJS.Platform, home: string, env: CliIO["env"]): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "com.vercel.cli");
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "com.vercel.cli", "Data");
  return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "com.vercel.cli");
}

async function credentials(io: Required<Pick<CliIO, "env" | "readText" | "platform" | "home" | "now">>, flags: { token?: string; team?: string }) {
  const dir = vercelCliDir(io.platform, io.home, io.env);
  const json = async (name: string) => {
    const text = await io.readText(join(dir, name));
    try {
      return text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  let token = flags.token ?? io.env.VERCEL_TOKEN;
  let team = flags.team ?? io.env.VERCEL_TEAM_ID;
  if (!token) {
    const auth = await json("auth.json");
    if (typeof auth?.token !== "string") {
      throw new UsageError("No Vercel token. Set VERCEL_TOKEN (vercel.com/account/settings/tokens), pass --token, or log in with the Vercel CLI (vercel login).");
    }
    if (typeof auth.expiresAt === "number" && auth.expiresAt * 1000 < io.now()) {
      throw new UsageError("Your Vercel CLI login expired. Run a Vercel CLI command (for example vercel whoami) to renew it, or set VERCEL_TOKEN.");
    }
    token = auth.token;
    if (!team) {
      const config = await json("config.json");
      if (typeof config?.currentTeam === "string") team = config.currentTeam;
    }
  }
  return { token, team };
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

/** Columns padded to their widest cell; numbers right-aligned. */
function table(head: string[], rows: (string | number)[][]): string[] {
  const cells = [head, ...rows.map((r) => r.map((c) => (typeof c === "number" ? fmt(c) : c)))];
  const numeric = head.map((_, i) => rows.length > 0 && rows.every((r) => typeof r[i] === "number"));
  const width = head.map((_, i) => Math.max(...cells.map((r) => r[i]!.length)));
  return cells.map((r) => r.map((c, i) => (numeric[i] ? c.padStart(width[i]!) : c.padEnd(width[i]!))).join("  ").trimEnd());
}

async function findProject(va: VercelAnalyticsClient, wanted: string | undefined, teamId: string | undefined): Promise<Project> {
  if (!wanted) throw new UsageError("This command needs --project <name|id>.");
  const projects = await va.projects({ teamId });
  const w = wanted.toLowerCase();
  const found = projects.find((p) => p.id === wanted) ?? projects.find((p) => p.name.toLowerCase() === w || p.domain?.toLowerCase() === w);
  if (!found) throw new UsageError(`No project "${wanted}" in this team. Run "vercel-analytics-api projects" to list them.`);
  return found;
}

/** Runs one command; resolves to the exit code. */
export async function run(argv: string[], io: CliIO): Promise<number> {
  const now = io.now ?? Date.now;
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        project: { type: "string", short: "p" },
        team: { type: "string", short: "t" },
        since: { type: "string", short: "s", default: "7d" },
        until: { type: "string", short: "u" },
        limit: { type: "string", short: "n", default: "10" },
        hourly: { type: "boolean" },
        json: { type: "boolean" },
        token: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    io.stderr(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values: f, positionals } = parsed;
  const [command, arg] = positionals;
  if (f.help || !command) {
    (f.help ? io.stdout : io.stderr)(HELP);
    return f.help ? 0 : 2;
  }
  const print = (data: unknown, lines: () => string[]) => {
    if (f.json) io.stdout(JSON.stringify(data, null, 2));
    else for (const l of lines()) io.stdout(l);
  };

  try {
    const limit = Number(f.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new UsageError(`--limit must be a whole number above 0, not "${f.limit}".`);
    const since = parseWhen(f.since!, now());
    const until = f.until ? parseWhen(f.until, now()) : now();
    const { token, team } = await credentials(
      { env: io.env, readText: io.readText ?? ((p) => readFile(p, "utf8").catch(() => null)), platform: io.platform ?? process.platform, home: io.home ?? homedir(), now },
      { token: f.token, team: f.team },
    );
    const va = createClient({ token, fetch: io.fetch });
    // A team slug ("acme") works too: the API wants the id.
    let teamId = team;
    if (teamId && !teamId.startsWith("team_")) {
      const t = (await va.teams()).find((x) => x.slug === teamId);
      if (!t) throw new UsageError(`No team "${team}" for this token. Run "vercel-analytics-api teams" to list them.`);
      teamId = t.id;
    }
    const range = { since, until, teamId };

    switch (command) {
      case "teams": {
        const teams = await va.teams();
        print(teams, () => table(["SLUG", "NAME", "PLAN", "ID"], teams.map((t) => [t.slug, t.name ?? "", t.plan ?? "", t.id])));
        return 0;
      }
      case "projects": {
        const projects = await va.projects({ teamId });
        print(projects, () => table(["PROJECT", "DOMAIN", "ANALYTICS", "ID"], projects.map((p) => [p.name, p.domain ?? "", p.analyticsEnabled ? "on" : "off", p.id])));
        return 0;
      }
      case "visitors": {
        const projects = f.project ? [await findProject(va, f.project, teamId)] : (await va.projects({ teamId })).filter((p) => p.analyticsEnabled);
        const rows: { project: string; domain: string | null; visitors: number; pageviews: number }[] = [];
        // Four at a time: a team with many projects stays inside Vercel's rate limit.
        for (let i = 0; i < projects.length; i += 4) {
          const batch = await Promise.all(projects.slice(i, i + 4).map(async (p) => ({ project: p.name, domain: p.domain, ...(await va.totals({ projectId: p.id, ...range })) })));
          rows.push(...batch);
        }
        rows.sort((a, b) => b.visitors - a.visitors);
        print(rows, () => (rows.length ? table(["PROJECT", "VISITORS", "PAGE VIEWS"], rows.map((r) => [r.domain ?? r.project, r.visitors, r.pageviews])) : ["No projects with Web Analytics on in this team."]));
        return 0;
      }
      case "top": {
        const by = arg ? TOP[arg] : undefined;
        if (!by) throw new UsageError(`top needs one of: ${Object.keys(TOP).join(", ")}.`);
        const p = await findProject(va, f.project, teamId);
        const rows = await va.breakdown({ projectId: p.id, by, limit, ...range });
        print(rows, () => table([arg!.toUpperCase(), "VISITORS", "PAGE VIEWS"], rows.map((r) => [r.key, r.visitors, r.pageviews])));
        return 0;
      }
      case "events": {
        const p = await findProject(va, f.project, teamId);
        const rows = await va.events({ projectId: p.id, limit, ...range });
        print(rows, () => (rows.length ? table(["EVENT", "COUNT", "VISITORS"], rows.map((r) => [r.name, r.count, r.visitors])) : ["No custom events in this window."]));
        return 0;
      }
      case "series": {
        const p = await findProject(va, f.project, teamId);
        const granularity = f.hourly ? "hour" : "day";
        const rows = await va.timeseries({ projectId: p.id, granularity, ...range });
        const when = (ts: string) => (granularity === "day" ? ts.slice(0, 10) : ts.slice(0, 16).replace("T", " "));
        print(rows, () => table([granularity === "day" ? "DAY" : "HOUR (UTC)", "VISITORS", "PAGE VIEWS"], rows.map((r) => [when(r.timestamp), r.visitors, r.pageviews])));
        return 0;
      }
      default:
        throw new UsageError(`Unknown command "${command}".\n\n${HELP}`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(e.message);
      return 2;
    }
    if (e instanceof VercelApiError) {
      const hint = e.status === 402 ? " UTM tags need Vercel Web Analytics Plus or Enterprise." : e.status === 401 || e.status === 403 ? " Check the token and its team." : "";
      io.stderr(`Vercel answered ${e.status}: ${e.message}${hint}`);
      return 1;
    }
    throw e;
  }
}
