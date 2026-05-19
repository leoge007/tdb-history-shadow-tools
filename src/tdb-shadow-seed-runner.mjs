#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  SHADOW_ROOT,
  TMP_ROOT,
  assertNotLiveTdbOutput,
  assertWritableTarget,
  compareLiveSnapshots,
  ensureDir,
  expandHome,
  parseArgs,
  readJson,
  relativeToHome,
  snapshotLiveTdb,
} from "./tdb-history-lib.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.input) {
  console.error("Usage: node scripts/tdb-history/tdb-shadow-seed-runner.mjs --input tmp/tdb-history/inputs/2026-04-batch-001.json [--month 2026-04] [--batch-id batch-001]");
  process.exit(2);
}

const input = path.resolve(expandHome(args.input));
const month = String(args.month || path.basename(input).match(/(2026-\d\d)/)?.[1] || "");
const batchId = String(args["batch-id"] || path.basename(input).match(/(batch-\d+)/)?.[1] || "batch-001");
if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`Invalid month: ${month}`);

const shadowDir = assertNotLiveTdbOutput(assertWritableTarget(
  args["output-dir"] || path.join(SHADOW_ROOT, month, batchId),
  [SHADOW_ROOT],
));
const requiredShadowBase = path.join(SHADOW_ROOT, month, batchId);
if (!(shadowDir === requiredShadowBase || shadowDir.startsWith(`${requiredShadowBase}${path.sep}`))) {
  throw new Error(`Shadow output must be under ${requiredShadowBase}`);
}

if (!fs.existsSync(input)) throw new Error(`Input file not found: ${input}`);
if (fs.existsSync(shadowDir) && hasSeedOutput(shadowDir)) {
  throw new Error(`Refusing to reuse shadow output dir that already contains seed output: ${shadowDir}`);
}
if (fs.existsSync(shadowDir) && fs.readdirSync(shadowDir).length > 0) {
  await archiveRunnerOnlyAttempt(shadowDir, month, batchId);
}
await ensureDir(shadowDir);
await ensureDir(path.join(TMP_ROOT, "inputs"));
const runWorkDir = path.join(TMP_ROOT, "runs", `${month}-${batchId}`);
await ensureDir(runWorkDir);

if (!args.config) {
  throw new Error("Missing --config. For safety, this tool never generates seed configs from live OpenClaw config because they may contain secrets.");
}
const configPath = path.resolve(expandHome(args.config));

const inputJson = await readJson(input);
const sessionKeys = (inputJson.sessions || []).map((s) => s.sessionKey).filter(Boolean);
const before = snapshotLiveTdb();
const liveBeforeTmp = path.join(runWorkDir, "live-before.json");
await fsp.writeFile(liveBeforeTmp, `${JSON.stringify(before, null, 2)}\n`, { mode: 0o600 });

const command = [
  "memory-tdai",
  "seed",
  "--input", input,
  "--output-dir", shadowDir,
  "--config", configPath,
  "--strict-round-role",
  "--yes",
];

const runLogTmp = path.join(runWorkDir, "run.log");
const runLog = path.join(shadowDir, "run.log");
const liveBeforePath = path.join(shadowDir, "live-before.json");
const liveAfterPath = path.join(shadowDir, "live-after.json");
const log = fs.createWriteStream(runLogTmp, { flags: "w", mode: 0o600 });
log.write(`# ${new Date().toISOString()}\n`);
log.write(`$ openclaw ${command.map(shellQuote).join(" ")}\n\n`);

const child = spawn("openclaw", command, {
  cwd: path.resolve(expandHome(args.cwd || process.cwd())),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  log.write(chunk);
});
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  log.write(chunk);
});

let exitCode = await new Promise((resolve) => child.on("close", resolve));
const officialExitCode = exitCode;
log.write(`\n# officialExitCode=${exitCode}\n`);
await new Promise((resolve) => log.end(resolve));

const fallbackUsed = false;

const after = snapshotLiveTdb();
await fsp.writeFile(path.join(runWorkDir, "live-after.json"), `${JSON.stringify(after, null, 2)}\n`, { mode: 0o600 });
const hasShadowOutput = fs.existsSync(path.join(shadowDir, "vectors.db")) ||
  fs.existsSync(path.join(shadowDir, "conversations")) ||
  fs.existsSync(path.join(shadowDir, "records"));
const effectiveExitCode = exitCode === 0 && !hasShadowOutput ? 1 : exitCode;
const summary = {
  month,
  batchId,
  input: relativeToHome(input),
  shadowDir: relativeToHome(shadowDir),
  config: relativeToHome(configPath),
  runLog: relativeToHome(runLog),
  command: `openclaw ${command.map(shellQuote).join(" ")}`,
  exitCode: effectiveExitCode,
  processExitCode: exitCode,
  officialExitCode,
  hasShadowOutput,
  fallbackUsed,
  sessionKeys,
  liveComparison: compareLiveSnapshots(before, after),
  completedAt: new Date().toISOString(),
};
await fsp.copyFile(liveBeforeTmp, liveBeforePath);
await fsp.copyFile(path.join(runWorkDir, "live-after.json"), liveAfterPath);
await fsp.copyFile(runLogTmp, runLog);
await fsp.writeFile(path.join(shadowDir, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });

console.log(JSON.stringify(summary, null, 2));
if (effectiveExitCode !== 0) process.exit(effectiveExitCode);

function shellQuote(s) {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, "'\\''")}'`;
}

function hasSeedOutput(dir) {
  return fs.existsSync(path.join(dir, "vectors.db")) ||
    fs.existsSync(path.join(dir, "conversations")) ||
    fs.existsSync(path.join(dir, "records"));
}

async function archiveRunnerOnlyAttempt(dir, monthValue, batchValue) {
  const allowed = new Set(["live-before.json", "live-after.json", "run.log", "run-summary.json"]);
  const entries = fs.readdirSync(dir);
  const unexpected = entries.filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    throw new Error(`Refusing to reuse non-empty shadow output dir: ${dir} (unexpected entries: ${unexpected.join(", ")})`);
  }
  const archiveDir = path.join(TMP_ROOT, "runs", `${monthValue}-${batchValue}`, `failed-attempt-${Date.now()}`);
  await ensureDir(archiveDir);
  for (const name of entries) {
    await fsp.rename(path.join(dir, name), path.join(archiveDir, name));
  }
  console.error(`Archived previous runner-only failed attempt to ${archiveDir}`);
}
