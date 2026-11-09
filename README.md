# vercel-analytics-api

[![npm](https://img.shields.io/npm/v/vercel-analytics-api)](https://www.npmjs.com/package/vercel-analytics-api)
[![CI](https://github.com/lookoutstats/vercel-analytics-api/actions/workflows/ci.yml/badge.svg)](https://github.com/lookoutstats/vercel-analytics-api/actions/workflows/ci.yml)

A typed client for the Vercel Web Analytics and Speed Insights API. It has no dependencies. It needs Node 20+ or another runtime with `fetch`.

Use it in a script, a cron job or your own dashboard. It reads visitors, page views, top pages, referrers, countries, devices, custom events and Core Web Vitals.

> Unofficial. Vercel did not make this package and does not support it. It calls Vercel's public REST API at `api.vercel.com`.

## Install

```sh
npm install vercel-analytics-api
```

## Quick start

```ts
import { createClient } from "vercel-analytics-api";

const va = createClient({
  token: process.env.VERCEL_TOKEN!, // vercel.com/account/settings/tokens
  teamId: "team_abc123", // omit for a personal (Hobby) account
});

const since = "2026-10-01"; // a Date, epoch ms or date string; `until` defaults to now

const { visitors, pageviews } = await va.totals({ projectId: "prj_123", since });
const topPages = await va.breakdown({ projectId: "prj_123", since, by: "requestPath", limit: 5 });
```

## Command line

You can query the API from a terminal without an install:

```sh
npx vercel-analytics-api visitors --since 30d
```

```text
PROJECT           VISITORS  PAGE VIEWS
example.com          1,200       3,400
docs.example.com       480         910
```

| Command | Prints |
|---|---|
| `teams` | The teams the token can read. |
| `projects` | The team's projects, with Web Analytics on or off. |
| `visitors` | Visitors and page views for each project with Web Analytics. Add `--project` for one project. |
| `top <what> --project <p>` | The top values. `<what>` is `pages`, `referrers`, `countries`, `devices`, `browsers`, `os`, `utm-source`, `utm-medium` or `utm-campaign`. |
| `events --project <p>` | Custom events, most fired first. |
| `series --project <p>` | Visitors and page views per day. Add `--hourly` for each hour. |

Options:

- `--project`, `-p`: the project name, its production domain or its id.
- `--since`, `-s`: `24h`, `7d`, `30d` or a date such as `2026-10-01`. The default is `7d`. `--until`, `-u` sets the end.
- `--limit`, `-n`: the number of rows for `top` and `events`. The default is 10.
- `--json`: print JSON for a script or another tool.
- `--team`, `-t`: the team slug or id.

The token comes from `--token`, then `VERCEL_TOKEN`. If neither is set, the command uses your Vercel CLI login (`vercel login`) and its current team. If that login expired, run a Vercel CLI command such as `vercel whoami` to renew it.

The exit code is 0 on success, 1 when Vercel returns an error, and 2 for a usage error.

## Methods

| Method | Returns |
|---|---|
| `teams()` | The teams the token can read, with their plan. |
| `projects()` | Every project in the team, with its production domain and whether Web Analytics is on. |
| `totals({ projectId, since, until? })` | `{ visitors, pageviews }` for the window. |
| `timeseries({ ..., granularity? })` | `{ timestamp, visitors, pageviews }[]` per `"day"` (the default) or `"hour"`. |
| `breakdown({ ..., by, limit? })` | `{ key, visitors, pageviews }[]` for one dimension, 10 rows by default. |
| `events({ ..., limit? })` | Custom events as `{ name, count, visitors }[]`, most fired first. |
| `eventSeries({ ..., event, granularity? })` | One custom event's `{ timestamp, count }[]`. |
| `speedInsights({ since, outputs, groupBy?, ... })` | Core Web Vitals for the team: `{ series, summary }`. |
| `request(path, { query?, body? })` | Any other `api.vercel.com` call, with the same auth, timeout, retries and errors. |

Every method takes `teamId` (to use a different team than the client's) and `signal` (an `AbortSignal`).

### Breakdown dimensions

`by` takes one of these: `requestPath`, `referrerHostname`, `country`, `deviceType`, `browserName`, `osName`, `utmSource`, `utmMedium`, `utmCampaign`.

The client gives an empty value a label: `Direct` for a referrer, `/` for a path, `(none)` for a UTM tag and `Unknown` for the other dimensions. Vercel groups the rows past `limit` into one row with the key `Others`. The client puts that row last.

The UTM dimensions need [Web Analytics Plus](https://vercel.com/docs/analytics/limits-and-pricing). Without it, Vercel answers 402 and the error's `isPlanRequired` is `true`.

### Speed Insights

```ts
const { summary } = await va.speedInsights({
  since: "2026-10-01",
  groupBy: ["route"],
  outputs: {
    lcp: { metric: "vercel.speed_insights.lcp_ms", aggregation: "p75" },
    samples: { metric: "vercel.speed_insights.lcp_ms", aggregation: "count" },
  },
  limit: { count: 10, rankBy: "samples" }, // the 10 routes with the most samples
});
// summary: [{ dimensions: { route: "/" }, values: { lcp: 1123.5, samples: 494 } }, ...]
```

The metrics are `lcp_ms`, `inp_ms`, `cls`, `fcp_ms` and `ttfb_ms`, each with the prefix `vercel.speed_insights.`. By default it reads production data only. It needs a `teamId`.

## Errors

A failed call throws `VercelApiError`. It has `status`, Vercel's `code`, `message` and `retryAfterMs`, plus these flags:

- `isAuthError`: a 401 or 403. The token is wrong or expired, or it cannot read this team.
- `isRateLimited`: a 429.
- `isPlanRequired`: a 402. The team's plan does not include this data.

A call that takes longer than `timeoutMs` (10 seconds by default) throws a `VercelApiError` with status 504 and code `timeout`.

The client retries a 429 or a 5xx answer two times by default. It waits the time that Vercel asks for, but not more than 60 seconds. Set `retries: 0` to stop all retries.

```ts
import { VercelApiError } from "vercel-analytics-api";

try {
  await va.totals({ projectId, since });
} catch (e) {
  if (e instanceof VercelApiError && e.isAuthError) console.error("Check VERCEL_TOKEN");
  else throw e;
}
```

## Notes on the data

- **Visitors are unique per window.** One person can visit on more than one day. So the visitors of a 7-day window are fewer than the sum of the 7 daily figures.
- **The API does not return bounce rate.** The dashboard shows it, but the API does not. [What bounce rate means in Vercel Analytics](https://lookoutstats.com/guides/vercel-analytics-bounce-rate).
- **Timestamps are UTC.** A day bucket starts at 00:00 UTC.
- **Security.** The token goes only to `api.vercel.com`. `request()` refuses a full URL or a path that does not start with `/`.

## Recipes

Each recipe is one file in [`examples/`](examples). Copy it into your project and import from `vercel-analytics-api`.

| Recipe | What it does |
|---|---|
| [`weekly-slack.ts`](examples/weekly-slack.ts) + [`weekly-slack.yml`](examples/weekly-slack.yml) | Posts last week's visitors per project to Slack every Monday, with the change on the week before. It runs in GitHub Actions. |
| [`export-csv.ts`](examples/export-csv.ts) | Writes 30 days of daily visitors and page views per project as CSV for Google Sheets or Excel. |
| [`report.ts`](examples/report.ts) | Prints a 7-day report with the top pages for each project that has Web Analytics on. |

```sh
VERCEL_TOKEN=... VERCEL_TEAM_ID=... npx tsx examples/report.ts
```

### Visitors in a Next.js route

This route handler returns a project's visitors for the last 7 days. The response stays in the cache for an hour, so the page does not call Vercel on each request.

```ts
// app/api/visitors/route.ts
import { createClient } from "vercel-analytics-api";

export const revalidate = 3600;

const va = createClient({ token: process.env.VERCEL_TOKEN!, teamId: process.env.VERCEL_TEAM_ID });

export async function GET() {
  const since = Date.now() - 7 * 86_400_000;
  const { visitors } = await va.totals({ projectId: process.env.VERCEL_PROJECT_ID!, since });
  return Response.json({ visitors });
}
```

Keep the token on the server. Do not send it to the browser.

## All your projects on one screen

[Lookout](https://lookoutstats.com) shows the Vercel Web Analytics of all your projects in one dashboard. It also has a TV mode, client share links and alerts. It reads the same API.

[![Lookout: every Vercel project on one board, with drop alerts, a scorecard, a TV mode and a phone app](https://raw.githubusercontent.com/lookoutstats/vercel-analytics-api/main/docs/lookout-demo.webp)](https://lookoutstats.com/demo)

▶ [Watch the 30-second video](https://youtu.be/JLAQP-RVzvI) · [Open the live demo](https://lookoutstats.com/demo)

## License

MIT
