// Posts last week's visitors per project to Slack, with the change on the week before.
// Run it every Monday from GitHub Actions: see examples/weekly-slack.yml.
// Run: VERCEL_TOKEN=... VERCEL_TEAM_ID=... SLACK_WEBHOOK_URL=... npx tsx examples/weekly-slack.ts
// In your own project, import from "vercel-analytics-api" instead of "../src/index.js".
import { createClient } from "../src/index.js";

const DAY = 86_400_000;
const today = Math.floor(Date.now() / DAY) * DAY; // 00:00 UTC: whole days only
const thisWeek = { since: today - 7 * DAY, until: today };
const lastWeek = { since: today - 14 * DAY, until: today - 7 * DAY };

const va = createClient({ token: process.env.VERCEL_TOKEN ?? "", teamId: process.env.VERCEL_TEAM_ID });
const lines: string[] = [];
for (const p of await va.projects()) {
  if (!p.analyticsEnabled) continue;
  const [now, before] = await Promise.all([va.totals({ projectId: p.id, ...thisWeek }), va.totals({ projectId: p.id, ...lastWeek })]);
  const change = before.visitors ? Math.round(((now.visitors - before.visitors) / before.visitors) * 100) : null;
  lines.push(`• *${p.domain ?? p.name}*: ${now.visitors.toLocaleString("en-US")} visitors${change === null ? "" : ` (${change >= 0 ? "+" : ""}${change}%)`}`);
}

const text = `*Last 7 days on Vercel*\n${lines.join("\n") || "No projects with Web Analytics on."}`;
const webhook = process.env.SLACK_WEBHOOK_URL;
if (!webhook) console.log(text);
else {
  const res = await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error(`Slack answered ${res.status}`);
}
