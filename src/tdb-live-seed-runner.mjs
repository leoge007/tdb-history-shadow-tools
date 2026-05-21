#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  LIVE_TDB_DIR,
  TMP_ROOT,
  ensureDir,
  expandHome,
  parseArgs,
  readJson,
  relativeToHome,
  snapshotLiveTdb,
  compareLiveSnapshots,
} from "./tdb-history-lib.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.input) {
  console.error("Usage: node src/tdb-live-seed-runner.mjs --input tmp/tdb-history/inputs/2026-04-batch-001.json --yes-live [--gateway-url http://127.0.0.1:8420]");
  process.exit(2);
}
if (!args["yes-live"]) {
  throw new Error("Refusing to write live TDB without --yes-live.");
}

const inputPath = path.resolve(expandHome(args.input));
const input = await readJson(inputPath);
const month = String(args.month || path.basename(inputPath).match(/(\d{4}-\d{2})/)?.[1] || "");
const batchId = String(args["batch-id"] || path.basename(inputPath).match(/(batch-\d+(?:-retry-\d+)?)/)?.[1] || "batch-001");
if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`Invalid month: ${month}`);

const gatewayUrl = String(args["gateway-url"] || process.env.TDB_GATEWAY_URL || "http://127.0.0.1:8420").replace(/\/+$/, "");
const sessions = input.sessions || [];
if (!sessions.length) throw new Error(`No sessions found in ${inputPath}`);

const sessionKeys = sessions.map((s) => s.sessionKey).filter(Boolean);
const runDir = path.join(TMP_ROOT, "live-runs", `${month}-${batchId}-${Date.now()}`);
await ensureDir(runDir);
const runLogPath = path.join(runDir, "run.log");
const runLog = fs.createWriteStream(runLogPath, { flags: "w", mode: 0o600 });
runLog.write(`# ${new Date().toISOString()}\n`);
runLog.write(`# input=${inputPath}\n`);
runLog.write(`# gateway=${gatewayUrl}\n`);
runLog.write(`# liveDir=${LIVE_TDB_DIR}\n\n`);

const before = snapshotLiveTdb();
let rounds = 0;
let messages = 0;
let l0Recorded = 0;
const failures = [];

for (const session of sessions) {
  const sessionKey = session.sessionKey || args["session-key"];
  if (!sessionKey) throw new Error("Missing sessionKey in input session and no --session-key fallback supplied.");
  const sessionId = session.sessionId || "";
  for (let i = 0; i < (session.conversations || []).length; i++) {
    const round = session.conversations[i] || [];
    rounds++;
    messages += round.length;
    const user = round.find((m) => m.role === "user");
    const assistant = [...round].reverse().find((m) => m.role === "assistant");
    if (!user || !assistant) {
      failures.push({ sessionKey, round: i + 1, error: "round_missing_user_or_assistant" });
      continue;
    }
    const body = {
      user_content: user.content || "",
      assistant_content: assistant.content || "",
      session_key: sessionKey,
      session_id: sessionId,
      messages: round.map((m) => ({
        role: m.role,
        content: m.content || "",
        timestamp: m.timestamp,
      })),
    };
    try {
      const response = await postJson(`${gatewayUrl}/capture`, body);
      l0Recorded += Number(response.l0_recorded || 0);
      if (rounds % 25 === 0) {
        process.stdout.write(`\r[${rounds}] live captured, l0=${l0Recorded}    `);
      }
    } catch (err) {
      failures.push({ sessionKey, round: i + 1, error: err instanceof Error ? err.message : String(err) });
      runLog.write(`capture failed session=${sessionKey} round=${i + 1}: ${failures.at(-1).error}\n`);
      if (!args["continue-on-error"]) break;
    }
  }
  if (!args["continue-on-error"] && failures.length) break;
  if (args["flush-session"]) {
    try {
      await postJson(`${gatewayUrl}/session/end`, { session_key: sessionKey });
    } catch (err) {
      failures.push({ sessionKey, round: null, error: `session_end_failed: ${err instanceof Error ? err.message : String(err)}` });
      if (!args["continue-on-error"]) break;
    }
  }
}
process.stdout.write("\n");

const after = snapshotLiveTdb();
const summary = {
  mode: "live-capture",
  month,
  batchId,
  input: relativeToHome(inputPath),
  gatewayUrl,
  liveDir: relativeToHome(LIVE_TDB_DIR),
  sessions: sessions.length,
  sessionKeys,
  rounds,
  messages,
  l0Recorded,
  failures,
  exitCode: failures.length ? 1 : 0,
  liveComparison: compareLiveSnapshots(before, after),
  completedAt: new Date().toISOString(),
};
runLog.write(`\n${JSON.stringify(summary, null, 2)}\n`);
await new Promise((resolve) => runLog.end(resolve));
await fsp.writeFile(path.join(runDir, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));
if (summary.exitCode !== 0) process.exit(summary.exitCode);

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }
  return json;
}
