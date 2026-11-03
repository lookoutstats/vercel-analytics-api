#!/usr/bin/env node
// `npx vercel-analytics-api`: see ./cli.ts.
import { run } from "./cli.js";

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});
