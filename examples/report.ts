// A 7-day report for every project with Web Analytics on.
// Run: VERCEL_TOKEN=... VERCEL_TEAM_ID=... npx tsx examples/report.ts
import { createClient, VercelApiError } from "../src/index.js";

const va = createClient({ token: process.env.VERCEL_TOKEN ?? "", teamId: process.env.VERCEL_TEAM_ID });
const since = new Date(Date.now() - 7 * 86_400_000);

for (const project of await va.projects()) {
  if (!project.analyticsEnabled) continue;
  try {
    const { visitors, pageviews } = await va.totals({ projectId: project.id, since });
    const pages = await va.breakdown({ projectId: project.id, since, by: "requestPath", limit: 3 });
    console.log(`${project.domain ?? project.name}: ${visitors} visitors, ${pageviews} page views`);
    for (const p of pages) console.log(`  ${p.key}  ${p.visitors}`);
  } catch (e) {
    if (e instanceof VercelApiError) console.log(`${project.name}: ${e.status} ${e.message}`);
    else throw e;
  }
}
