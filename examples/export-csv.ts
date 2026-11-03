// Daily visitors and page views of every project as CSV, for Google Sheets or Excel.
// Run: VERCEL_TOKEN=... VERCEL_TEAM_ID=... npx tsx examples/export-csv.ts > visits.csv
// In your own project, import from "vercel-analytics-api" instead of "../src/index.js".
import { createClient } from "../src/index.js";

const va = createClient({ token: process.env.VERCEL_TOKEN ?? "", teamId: process.env.VERCEL_TEAM_ID });
const since = Date.now() - 30 * 86_400_000;
const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);

console.log("date,project,visitors,pageviews");
for (const p of await va.projects()) {
  if (!p.analyticsEnabled) continue;
  for (const d of await va.timeseries({ projectId: p.id, since, granularity: "day" })) {
    console.log([d.timestamp.slice(0, 10), cell(p.domain ?? p.name), d.visitors, d.pageviews].join(","));
  }
}
