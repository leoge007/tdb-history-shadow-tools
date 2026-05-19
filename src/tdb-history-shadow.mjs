#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  INPUTS_DIR,
  SHADOW_ROOT,
  expandHome,
  parseArgs,
} from "./tdb-history-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const command = args._?.[0] || "help";

if (command === "help" || args.help || args.h) {
  printHelp();
  process.exit(0);
}

if (command !== "run") {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(2);
}

const month = args.month;
if (!month || !/^\d{4}-\d{2}$/.test(String(month))) {
  console.error("--month YYYY-MM is required.");
  process.exit(2);
}

const batchSize = args["batch-size"] ? Number(args["batch-size"]) : 300;
const batchIndex = args["batch-index"] ? Number(args["batch-index"]) : 1;
const batchId = String(args["batch-id"] || `batch-${String(batchIndex).padStart(3, "0")}`);
const config = args.config ? expandHome(args.config) : null;
const dryRun = Boolean(args["dry-run"] || args.dryRun);

if (!Number.isInteger(batchSize) || batchSize <= 0) {
  console.error("--batch-size must be a positive integer.");
  process.exit(2);
}
if (!Number.isInteger(batchIndex) || batchIndex <= 0) {
  console.error("--batch-index must be a positive 1-based integer.");
  process.exit(2);
}

const input = path.join(INPUTS_DIR, `${month}-${batchId}.json`);
const shadowDir = path.join(SHADOW_ROOT, month, batchId);

const steps = [
  ["inventory", ["src/tdb-history-inventory.mjs", "--output", "tmp/tdb-history/inventory.json"]],
  ["build-input", ["src/tdb-seed-input-builder.mjs", "--inventory", "tmp/tdb-history/inventory.json", "--month", month, "--batch-size", String(batchSize), "--batch-index", String(batchIndex), "--batch-id", batchId]],
  ["shadow-seed", ["src/tdb-shadow-seed-runner.mjs", "--input", input, "--month", month, "--batch-id", batchId, ...(config ? ["--config", config] : [])]],
  ["audit", ["src/tdb-shadow-audit.mjs", "--shadow-dir", shadowDir, "--input", input]],
];

if (!config && !dryRun) {
  console.error("--config is required unless --dry-run is set.");
  process.exit(2);
}

for (const [name, argv] of steps) {
  console.log(`\n==> ${name}`);
  console.log(["node", ...argv].map(shellQuote).join(" "));
  if (dryRun) continue;
  const result = spawnSync(process.execPath, argv, { stdio: "inherit", cwd: process.cwd() });
  if (result.status !== 0) {
    console.error(`Step failed: ${name}`);
    process.exit(result.status || 1);
  }
}

console.log(JSON.stringify({ ok: true, month, batchId, input, shadowDir }, null, 2));

function shellQuote(value) {
  const s = String(value);
  return /^[A-Za-z0-9_./:=@+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

function printHelp() {
  console.log(`TDB History Shadow Tools\n\nUsage:\n  tdb-history-shadow run --month 2026-04 --batch-size 300 --batch-index 1 --config /secure/local/seed-config.json\n\nOptions:\n  --month YYYY-MM        Month to process.\n  --batch-size N         Rounds per batch. Default: 300.\n  --batch-index N        1-based batch index. Default: 1.\n  --batch-id ID          Batch id. Default: batch-<index>.\n  --config PATH          Explicit seed config path. Required unless --dry-run.\n  --dry-run              Print commands without running them.\n`);
}
