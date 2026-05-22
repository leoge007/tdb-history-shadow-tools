#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  AUDITS_DIR,
  INPUTS_DIR,
  LIVE_TDB_DIR,
  TMP_ROOT,
  ensureDir,
  expandHome,
  parseArgs,
  relativeToHome,
  normalizedContentHash,
} from "./tdb-history-lib.mjs";
import { buildCaptureEquivalentExpected } from "./tdb-capture-equivalent.mjs";

const require = createRequire(import.meta.url);
const args = parseArgs(process.argv.slice(2));
const month = String(args.month || "2026-04");
const batchId = String(args["batch-id"] || "batch-003");
const execute = Boolean(args.execute);
const acceptExisting = Boolean(args["accept-existing"]);
const inputPath = path.join(INPUTS_DIR, `${month}-${batchId}.json`);
const liveDir = path.resolve(expandHome(args["live-dir"] || LIVE_TDB_DIR));
const dbPath = path.join(liveDir, "vectors.db");
const manifestPath = path.join(TMP_ROOT, "live-runs", `${month}-accepted-batches.json`);
const dryRunPath = path.join(AUDITS_DIR, `${month}-${batchId}-fast-l0-dry-run.md`);
const importReportPath = path.join(AUDITS_DIR, `${month}-${batchId}-l0-import-report.md`);
const liveRunsDir = path.join(TMP_ROOT, "live-runs", `${month}-${batchId}-fast-l0-import`);
const EXECUTE_BATCHES_BY_MONTH = new Map([
  ["2026-02", new Set(Array.from({ length: 6 }, (_, i) => `batch-${String(i + 1).padStart(3, "0")}`))],
  ["2026-03", new Set(Array.from({ length: 12 }, (_, i) => `batch-${String(i + 1).padStart(3, "0")}`))],
  ["2026-04", new Set(["batch-003", "batch-004", "batch-005", "batch-006", "batch-007", "batch-008", "batch-009"])],
]);
const FULL_SEED_BATCH_002_SECONDS = 1588;

const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const capture = buildCaptureEquivalentExpected(input);
const acceptedManifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
const liveCounts = queryLiveCounts(month);
const liveKeys = queryLiveCompareKeys(month);
const plannedKeys = new Set(capture.kept.map((m) => m.compareKey));
const duplicateKeys = [...plannedKeys].filter((key) => liveKeys.has(key));
const sessionCounts = new Map();
for (const msg of capture.kept) sessionCounts.set(msg.sessionKey, (sessionCounts.get(msg.sessionKey) || 0) + 1);
const acceptedAligned = acceptedManifest
  ? liveCounts.l0 === Number(acceptedManifest.acceptedTotalL0)
  : null;
const estimated = estimateRuntime(capture.expectedCount);

await ensureDir(AUDITS_DIR);
if (acceptExisting) {
  const result = await acceptExistingImport();
  console.log(JSON.stringify(result, null, 2));
} else if (execute) {
  const result = await executeImport();
  console.log(JSON.stringify(result, null, 2));
} else {
  await fsp.writeFile(dryRunPath, renderDryRun(), "utf8");
  console.log(JSON.stringify({
    reportPath: relativeToHome(dryRunPath),
    mode: "dry-run",
    month,
    batchId,
    rawInputMessages: capture.rawCount,
    captureEquivalentExpectedL0: capture.expectedCount,
    plannedL0Rows: capture.expectedCount,
    plannedJsonlRows: capture.expectedCount,
    plannedFtsRows: capture.expectedCount,
    plannedL0VectorRows: "optional/background",
    acceptedBaselineAligned: acceptedAligned,
    duplicateLiveRows: duplicateKeys.length,
    estimatedRuntimeSeconds: estimated,
  }, null, 2));
}

async function acceptExistingImport() {
  assertExecuteAllowed();
  const baselineL0 = Number(acceptedManifest.acceptedTotalL0);
  const after = queryLiveCounts(month);
  const afterKeys = queryLiveCompareKeys(month);
  const missingKeys = [...plannedKeys].filter((key) => !afterKeys.has(key));
  const actualDeltaL0 = after.l0 - baselineL0;
  const actualDeltaFts = after.l0Fts - baselineL0;
  const realExtra = Math.max(0, actualDeltaL0 - capture.expectedCount);
  const duplicateExisting = [...plannedKeys].filter((key) => afterKeys.has(key)).length;
  const ok =
    actualDeltaL0 === capture.expectedCount &&
    actualDeltaFts === capture.expectedCount &&
    missingKeys.length === 0 &&
    realExtra === 0 &&
    duplicateExisting === capture.expectedCount;
  if (!ok) {
    throw new Error(`STOP: existing import is not acceptable for ${month}-${batchId}: deltaL0=${actualDeltaL0}, deltaFts=${actualDeltaFts}, missing=${missingKeys.length}, duplicateExisting=${duplicateExisting}`);
  }
  await updateAcceptedManifest(after.l0);
  const result = {
    reportPath: relativeToHome(importReportPath),
    manifestPath: relativeToHome(manifestPath),
    mode: "accept-existing",
    decision: "OK",
    month,
    batchId,
    startedAt: "(previous import)",
    endedAt: new Date().toISOString(),
    durationSeconds: 0,
    sqliteWriteSeconds: 0,
    jsonlAppendSeconds: 0,
    beforeL0: baselineL0,
    afterL0: after.l0,
    expectedDeltaL0: capture.expectedCount,
    actualDeltaL0,
    beforeL0Fts: baselineL0,
    afterL0Fts: after.l0Fts,
    actualDeltaFts,
    duplicateBeforeImport: 0,
    realMissing: 0,
    realExtra: 0,
    plannedJsonlRows: capture.expectedCount,
    jsonlPath: relativeToHome(path.join(liveDir, "conversations", `${formatLocalDate(new Date())}.jsonl`)),
    sqlPath: relativeToHome(path.join(liveRunsDir, "insert-l0.sql")),
  };
  await fsp.writeFile(importReportPath, renderImportReport(result, { l0: baselineL0, l0Fts: baselineL0, l0Vec: null }, after, []), "utf8");
  return result;
}

async function executeImport() {
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  assertExecuteAllowed();
  const before = queryLiveCounts(month);
  const beforeKeys = queryLiveCompareKeys(month);
  const beforeDuplicateKeys = [...plannedKeys].filter((key) => beforeKeys.has(key));
  assertExecutePreflight(before, beforeDuplicateKeys);

  const rows = buildPlannedRows(startedAtMs);
  await ensureDir(liveRunsDir);
  const sqlPath = path.join(liveRunsDir, "insert-l0.sql");
  const jsonlPath = path.join(liveDir, "conversations", `${formatLocalDate(new Date())}.jsonl`);
  const sql = renderInsertSql(rows);
  await fsp.writeFile(sqlPath, sql, "utf8");

  const sqliteStartMs = Date.now();
  sqliteWrite(dbPath, `.read ${sqlPath}`);
  const sqliteDurationMs = Date.now() - sqliteStartMs;

  await ensureDir(path.dirname(jsonlPath));
  const jsonl = rows.map((row) => JSON.stringify(row.jsonlRecord)).join("\n") + "\n";
  const jsonlStartMs = Date.now();
  await fsp.appendFile(jsonlPath, jsonl, "utf8");
  const jsonlDurationMs = Date.now() - jsonlStartMs;

  const endedAtMs = Date.now();
  const after = queryLiveCounts(month);
  const afterKeys = queryLiveCompareKeys(month);
  const missingKeys = [...plannedKeys].filter((key) => !afterKeys.has(key));
  const actualDeltaL0 = after.l0 - before.l0;
  const actualDeltaFts = after.l0Fts - before.l0Fts;
  const realExtra = Math.max(0, actualDeltaL0 - capture.expectedCount);
  const expectedBaselineL0 = Number(acceptedManifest.acceptedTotalL0);
  const ok =
    before.l0 === expectedBaselineL0 &&
    actualDeltaL0 === capture.expectedCount &&
    actualDeltaFts === capture.expectedCount &&
    missingKeys.length === 0 &&
    realExtra === 0 &&
    beforeDuplicateKeys.length === 0;

  if (ok) {
    await updateAcceptedManifest(after.l0);
  }

  const result = {
    reportPath: relativeToHome(importReportPath),
    manifestPath: relativeToHome(manifestPath),
    mode: "execute",
    decision: ok ? "OK" : "STOP",
    month,
    batchId,
    startedAt: startedAtIso,
    endedAt: new Date(endedAtMs).toISOString(),
    durationSeconds: Number(((endedAtMs - startedAtMs) / 1000).toFixed(3)),
    sqliteWriteSeconds: Number((sqliteDurationMs / 1000).toFixed(3)),
    jsonlAppendSeconds: Number((jsonlDurationMs / 1000).toFixed(3)),
    beforeL0: before.l0,
    afterL0: after.l0,
    expectedDeltaL0: capture.expectedCount,
    actualDeltaL0,
    beforeL0Fts: before.l0Fts,
    afterL0Fts: after.l0Fts,
    actualDeltaFts,
    duplicateBeforeImport: beforeDuplicateKeys.length,
    realMissing: missingKeys.length,
    realExtra,
    plannedJsonlRows: rows.length,
    jsonlPath: relativeToHome(jsonlPath),
    sqlPath: relativeToHome(sqlPath),
  };
  await fsp.writeFile(importReportPath, renderImportReport(result, before, after, missingKeys), "utf8");
  return result;
}

function assertExecuteAllowed() {
  const defaultLive = path.resolve(expandHome(LIVE_TDB_DIR));
  const allowedBatches = EXECUTE_BATCHES_BY_MONTH.get(month);
  if (!allowedBatches) {
    throw new Error(`STOP: direct L0 execute is not allowed for month ${month}.`);
  }
  if (liveDir !== defaultLive) {
    throw new Error(`STOP: direct L0 execute is only allowed on default live TDB path: ${defaultLive}`);
  }
  if (!acceptedManifest) {
    throw new Error(`STOP: accepted manifest is missing: ${manifestPath}`);
  }
  if (!allowedBatches.has(batchId)) {
    throw new Error(`STOP: direct L0 execute is not allowed for ${month} ${batchId}.`);
  }
  if (!Number.isFinite(Number(acceptedManifest.acceptedTotalL0))) {
    throw new Error(`STOP: acceptedTotalL0 is not numeric: ${acceptedManifest.acceptedTotalL0}`);
  }
  if (capture.expectedCount <= 0) {
    throw new Error(`STOP: capture-equivalent expected L0 must be positive, got ${capture.expectedCount}`);
  }
}

function assertExecutePreflight(before, beforeDuplicateKeys) {
  const expectedBaselineL0 = Number(acceptedManifest.acceptedTotalL0);
  if (before.l0 !== expectedBaselineL0) {
    throw new Error(`STOP: live L0 ${before.l0} does not match acceptedTotalL0 ${acceptedManifest.acceptedTotalL0}`);
  }
  if (beforeDuplicateKeys.length > 0) {
    throw new Error(`STOP: duplicate live rows detected before import: ${beforeDuplicateKeys.length}`);
  }
}

function queryLiveCounts(targetMonth) {
  const sql = [
    "select",
    `(select count(*) from l0_conversations where session_key like '%seed:${targetMonth}%'),`,
    `(select count(*) from l0_fts where session_key like '%seed:${targetMonth}%'),`,
    `(select count(*) from l0_vec_rowids where id in (select record_id from l0_conversations where session_key like '%seed:${targetMonth}%'));`,
  ].join(" ");
  const out = sqlite(dbPath, sql).trim();
  const [l0, l0Fts, l0Vec] = out.split("|").map(Number);
  return { l0, l0Fts, l0Vec };
}

function queryLiveCompareKeys(targetMonth) {
  const rows = sqliteJson(dbPath, `
    select session_key, role, timestamp, message_text
    from l0_conversations
    where session_key like '%seed:${targetMonth}%';
  `);
  return new Set(rows.map((r) => `${r.session_key}\t${r.role}\t${Number(r.timestamp) || 0}\t${normalizedContentHash(r.message_text || "")}`));
}

function estimateRuntime(rows) {
  // Dry-run heuristic: official L0 metadata+FTS writes are millisecond-scale;
  // the slow path in full seed is L1/L2/L3 waits. Keep a conservative floor.
  const metadataSeconds = Math.max(5, Math.ceil(rows * 0.01));
  const withOptionalL0EmbeddingSeconds = Math.max(60, Math.ceil(rows * 0.12));
  return { metadataOnly: metadataSeconds, withOptionalL0Embeddings: withOptionalL0EmbeddingSeconds };
}

function buildPlannedRows(baseMs) {
  const recordedAt = new Date(baseMs).toISOString();
  return capture.kept.map((msg, i) => {
    const suffix = (msg.normalizedContentHash || crypto.createHash("sha256").update(msg.content).digest("hex")).slice(0, 6);
    const recordId = `l0_${msg.sessionKey}_${baseMs + i}_${i}_${suffix}`;
    const messageId = msg.sourceKey || `fast_l0_${baseMs}_${i}_${suffix}`;
    return {
      recordId,
      sessionKey: msg.sessionKey,
      sessionId: msg.sessionId || "",
      role: msg.role,
      messageText: msg.content,
      recordedAt,
      timestamp: Number(msg.timestamp) || 0,
      ftsText: tokenizeForFts(msg.content),
      jsonlRecord: {
        sessionKey: msg.sessionKey,
        sessionId: msg.sessionId || "",
        recordedAt,
        id: messageId,
        role: msg.role,
        content: msg.content,
        timestamp: Number(msg.timestamp) || 0,
      },
    };
  });
}

function renderInsertSql(rows) {
  const lines = [
    "PRAGMA busy_timeout = 10000;",
    "BEGIN IMMEDIATE;",
  ];
  for (const row of rows) {
    lines.push(
      `INSERT INTO l0_conversations (record_id, session_key, session_id, role, message_text, recorded_at, timestamp) VALUES (${[
        row.recordId,
        row.sessionKey,
        row.sessionId,
        row.role,
        row.messageText,
        row.recordedAt,
        row.timestamp,
      ].map(sqlValue).join(", ")});`,
    );
    lines.push(
      `INSERT INTO l0_fts (message_text, message_text_original, record_id, session_key, session_id, role, recorded_at, timestamp) VALUES (${[
        row.ftsText,
        row.messageText,
        row.recordId,
        row.sessionKey,
        row.sessionId,
        row.role,
        row.recordedAt,
        row.timestamp,
      ].map(sqlValue).join(", ")});`,
    );
  }
  lines.push("COMMIT;");
  return `${lines.join("\n")}\n`;
}

async function updateAcceptedManifest(afterL0) {
  const manifest = JSON.parse(JSON.stringify(acceptedManifest));
  manifest.acceptedTotalL0 = afterL0;
  manifest.updatedAt = new Date().toISOString();
  manifest.batches = Array.isArray(manifest.batches) ? manifest.batches : [];
  const existingIndex = manifest.batches.findIndex((b) => b.batchId === batchId);
  const entry = {
    batchId,
    status: "OK",
    deltaL0: capture.expectedCount,
    basis: `fast L0 direct import: beforeL0=${acceptedManifest.acceptedTotalL0}, afterL0=${afterL0}, expectedL0=${capture.expectedCount}`,
  };
  if (existingIndex >= 0) manifest.batches[existingIndex] = entry;
  else manifest.batches.push(entry);
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function renderImportReport(result, before, after, missingKeys) {
  const speedup = result.durationSeconds > 0 ? (FULL_SEED_BATCH_002_SECONDS / result.durationSeconds).toFixed(1) : "n/a";
  return [
    `# ${month} ${batchId} L0 Direct Import Report`,
    "",
    "## Decision",
    "",
    `- decision: ${result.decision}`,
    `- ${batchId} status: ${result.decision === "OK" ? "OK" : "STOP"}`,
    `- started at: ${result.startedAt}`,
    `- ended at: ${result.endedAt}`,
    `- import duration: ${result.durationSeconds}s`,
    `- SQLite write duration: ${result.sqliteWriteSeconds}s`,
    `- JSONL append duration: ${result.jsonlAppendSeconds}s`,
    "",
    "## Guardrails",
    "",
    "- full seed was not started.",
    "- shadow execute was not started.",
    "- rollback was not executed.",
    "- promotion was not executed.",
    "- no full live backup was created.",
    "- L1/L2/L3/persona were not written, triggered, waited for, or repaired by this task.",
    "",
    "## Preflight",
    "",
    `- allowed execute target: ${month} ${[...(EXECUTE_BATCHES_BY_MONTH.get(month) || [])].join(", ")}`,
    `- accepted manifest: ${relativeToHome(manifestPath)}`,
    `- acceptedTotalL0 before import: ${acceptedManifest?.acceptedTotalL0}`,
    `- current live L0 before import: ${before.l0}`,
    `- baseline aligned: ${before.l0 === Number(acceptedManifest?.acceptedTotalL0) ? "yes" : "no"}`,
    `- duplicate live rows before import: ${result.duplicateBeforeImport}`,
    "",
    "## Planned Writes",
    "",
    `- raw input messages: ${capture.rawCount}`,
    `- capture-equivalent expected L0: ${capture.expectedCount}`,
    `- planned SQLite l0_conversations rows: ${capture.expectedCount}`,
    `- planned SQLite l0_fts rows: ${capture.expectedCount}`,
    `- planned conversations JSONL rows: ${result.plannedJsonlRows}`,
    "- planned L0 vector rows: 0 (optional, non-blocking, deliberately not written)",
    `- sanitizer transformed count: ${capture.transformedCount}`,
    `- filtered count: ${capture.filteredCount}`,
    `- JSONL shard: ${result.jsonlPath}`,
    "",
    "## L0 Delta Verification",
    "",
    `- before L0: ${result.beforeL0}`,
    `- expected delta L0: ${result.expectedDeltaL0}`,
    `- after L0: ${result.afterL0}`,
    `- actual delta L0: ${result.actualDeltaL0}`,
    `- before L0 FTS: ${result.beforeL0Fts}`,
    `- after L0 FTS: ${result.afterL0Fts}`,
    `- actual delta FTS: ${result.actualDeltaFts}`,
    `- real missing: ${result.realMissing}`,
    `- real extra: ${result.realExtra}`,
    `- duplicate before import: ${result.duplicateBeforeImport}`,
    "",
    "## Current Live Counts",
    "",
    `- live seed:${month} L0: ${after.l0}`,
    `- live seed:${month} L0 FTS: ${after.l0Fts}`,
    `- live seed:${month} L0 vector rowids: ${after.l0Vec}`,
    "",
    "## Speed",
    "",
    `- full seed batch-002 runtime reference: ${FULL_SEED_BATCH_002_SECONDS}s (~26.5 min)`,
    `- ${batchId} direct L0 import runtime: ${result.durationSeconds}s`,
    `- observed speedup vs full seed reference: ${speedup}x`,
    "",
    "## Accepted Manifest",
    "",
    `- updated acceptedTotalL0: ${result.decision === "OK" ? result.afterL0 : "(not updated)"}`,
    `- manifest path: ${relativeToHome(manifestPath)}`,
    "",
    missingKeys.length > 0 ? "## Missing Samples" : "",
    ...missingKeys.slice(0, 20).map((key) => `- ${key}`),
    "",
  ].filter((line, idx, arr) => line !== "" || arr[idx - 1] !== "").join("\n");
}

function sqlValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? String(Math.trunc(value)) : "0";
  if (value == null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function formatLocalDate(d) {
  const year = d.getFullYear();
  const monthPart = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${monthPart}-${day}`;
}

function tokenizeForFts(raw) {
  const jieba = getJieba();
  if (!jieba?.cutForSearch) return raw;
  return jieba.cutForSearch(String(raw || ""), true).join(" ");
}

function getJieba() {
  if (getJieba.cached !== undefined) return getJieba.cached;
  const candidates = [
    process.env.TDB_HISTORY_JIEBA_MODULE,
    "@node-rs/jieba",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      getJieba.cached = require(candidate);
      return getJieba.cached;
    } catch {
      // Try the next known install location.
    }
  }
  getJieba.cached = null;
  return null;
}

function renderDryRun() {
  const sessionRows = [...sessionCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([sessionKey, count]) => `| ${sessionKey} | ${count} |`);
  const speedupMetadata = (1588 / estimated.metadataOnly).toFixed(1);
  const speedupWithVec = (1588 / estimated.withOptionalL0Embeddings).toFixed(1);
  return [
    `# ${month} ${batchId} Fast L0 Import Dry Run`,
    "",
    "## Decision",
    "",
    "- Mode: dry-run only",
    "- No live import was executed.",
    `- No ${batchId} seed was started.`,
    "- No rollback was executed.",
    "- No promotion was executed.",
    "- No full live backup was created.",
    "",
    "## Planned Writes",
    "",
    `- raw input messages: ${capture.rawCount}`,
    `- capture-equivalent expected L0: ${capture.expectedCount}`,
    `- planned L0 rows: ${capture.expectedCount}`,
    `- planned JSONL rows: ${capture.expectedCount}`,
    `- planned FTS rows: ${capture.expectedCount}`,
    "- planned L0 vector rows: optional/background; not required for L1 extraction",
    `- sanitizer transformed count: ${capture.transformedCount}`,
    `- filtered count: ${capture.filteredCount}`,
    "",
    "## Accepted Baseline Check",
    "",
    `- accepted manifest: ${acceptedManifest ? relativeToHome(manifestPath) : "(missing)"}`,
    `- acceptedTotalL0: ${acceptedManifest?.acceptedTotalL0 ?? "(missing)"}`,
    `- current live L0: ${liveCounts.l0}`,
    `- baseline aligned: ${acceptedAligned === null ? "unknown" : acceptedAligned ? "yes" : "no"}`,
    `- duplicate rows already in live for this batch: ${duplicateKeys.length}`,
    "",
    "## Planned Rows By Session",
    "",
    "| session_key | planned capture-equivalent L0 rows |",
    "|---|---:|",
    ...sessionRows,
    "",
    "## Runtime Estimate",
    "",
    `- full seed batch-002 runtime: 1588.0s (~26.5 min)`,
    `- fast L0 metadata+FTS estimate: ${estimated.metadataOnly}s (~${speedupMetadata}x faster)`,
    `- fast L0 plus optional L0 embeddings estimate: ${estimated.withOptionalL0Embeddings}s (~${speedupWithVec}x faster)`,
    "",
    "The estimate excludes L1/L2/L3/persona waits because fast L0 import deliberately does not run those stages inline.",
    "",
    "## L0-First Check Contract",
    "",
    "- OK: this batch's expected capture-equivalent L0 equals live delta L0.",
    "- REPAIR: L0 delta is OK, but L0/L1 embedding or FTS coverage needs targeted repair.",
    "- ROLLBACK: L0 missing/extra, cross-batch writes, or seed interruption is proven.",
    "- STOP: schema/API mismatch, unknown tool error, or inconclusive validation.",
    "",
  ].join("\n");
}

function sqlite(db, sql) {
  const result = spawnSync("sqlite3", [`file:${db}?mode=ro`, "-readonly", "-noheader", "-batch", sql], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "sqlite3 failed");
  return result.stdout;
}

function sqliteJson(db, sql) {
  const result = spawnSync("sqlite3", [`file:${db}?mode=ro`, "-readonly", "-json", "-batch", sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "sqlite3 failed");
  return JSON.parse(result.stdout || "[]");
}

function sqliteWrite(db, sql) {
  const result = spawnSync("sqlite3", [db, "-batch", sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "sqlite3 write failed");
  return result.stdout;
}
