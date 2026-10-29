# vercel-analytics-api

[![npm](https://img.shields.io/npm/v/vercel-analytics-api)](https://www.npmjs.com/package/vercel-analytics-api)
[![CI](https://github.com/lookoutstats/vercel-analytics-api/actions/workflows/ci.yml/badge.svg)](https://github.com/lookoutstats/vercel-analytics-api/actions/workflows/ci.yml)

A typed client for the Vercel Web Analytics and Speed Insights API. It has no dependencies. It needs Node 20+ or another runtime with `fetch`.

Use it in a script, a cron job or your own dashboard. It reads visitors, page views, top pages, referrers, countries, devices, custom events and Core Web Vitals.

> Unofficial. This package is not made by Vercel and Vercel does not support it. It calls Vercel's public REST API at `api.vercel.com`.

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

The metrics are `lcp_ms`, `inp_ms`, `cls`, `fcp_ms` and `ttfb_ms`, each with the prefix `vercel.speed_insights.`. The query covers production by default and needs a `teamId`.

## Errors

A failed call throws `VercelApiError`. It has `status`, Vercel's `code`, `message` and `retryAfterMs`, plus these flags:

- `isAuthError`: a 401 or 403. The token is wrong or expired, or it cannot read this team.
- `isRateLimited`: a 429.
- `isPlanRequired`: a 402. The team's plan does not include this query.

A request that takes longer than `timeoutMs` (10 seconds by default) throws a `VercelApiError` with status 504 and code `timeout`.

The client retries a 429 or a 5xx answer two times by default. It waits the time that Vercel asks for, but not more than 60 seconds. Set `retries: 0` to turn the retries off.

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

## Example

[`examples/report.ts`](examples/report.ts) prints a 7-day report for every project that has Web Analytics on:

```sh
VERCEL_TOKEN=... VERCEL_TEAM_ID=... npx tsx examples/report.ts
```

## All your projects on one screen

[Lookout](https://lookoutstats.com) shows the Vercel Web Analytics of all your projects in one dashboard. It also has a TV mode, client share links and alerts. It reads the same API.

## License

MIT
