#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  INPUTS_DIR,
  INVENTORY_PATH,
  assertValidMonth,
  buildStrictRounds,
  createContentDedupeContext,
  ensureDir,
  expandHome,
  loadCleanMessages,
  parseArgs,
  readJson,
  relativeToHome,
  sourceMeta,
  writeJson,
} from "./tdb-history-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const inventoryPath = expandHome(args.inventory || INVENTORY_PATH);
const month = args.month ? assertValidMonth(args.month) : "";
const batchId = String(args["batch-id"] || "batch-001");
const batchSize = args["batch-size"] ? Number(args["batch-size"]) : null;
const batchIndex = args["batch-index"] ? Number(args["batch-index"]) : null;
const limit = args.limit ? Number(args.limit) : batchSize;
const offsetRounds = args["offset-rounds"] ? Number(args["offset-rounds"]) : (
  batchSize != null && batchIndex != null ? (batchIndex - 1) * batchSize : 0
);

if (!month) {
  console.error("Usage: node scripts/tdb-history/tdb-seed-input-builder.mjs --month 2026-04 [--sourceType discord] [--file <path>] [--sessionId <id>] [--limit 100] [--offset-rounds 300] [--batch-size 300 --batch-index 2] [--batch-id batch-001]");
  process.exit(2);
}
if (limit != null && (!Number.isInteger(limit) || limit <= 0)) {
  console.error("--limit must be a positive integer round count.");
  process.exit(2);
}
if (!Number.isInteger(offsetRounds) || offsetRounds < 0) {
  console.error("--offset-rounds must be a non-negative integer round count.");
  process.exit(2);
}
if (batchSize != null && (!Number.isInteger(batchSize) || batchSize <= 0)) {
  console.error("--batch-size must be a positive integer round count.");
  process.exit(2);
}
if (batchIndex != null && (!Number.isInteger(batchIndex) || batchIndex <= 0)) {
  console.error("--batch-index must be a positive 1-based integer.");
  process.exit(2);
}

const inventory = await readJson(inventoryPath);
let rows = (inventory.rows || []).filter((row) => row.month === month);
if (args.sourceType) rows = rows.filter((row) => row.sourceType === args.sourceType);
if (args.file) {
  const wanted = path.resolve(expandHome(args.file));
  rows = rows.filter((row) => path.resolve(expandHome(row.file)) === wanted);
}
if (args.sessionId) rows = rows.filter((row) => row.sessionId === args.sessionId);
if (args.sessionKey) rows = rows.filter((row) => row.sessionKey === args.sessionKey);

rows.sort((a, b) => {
  const sourceRank = (s) => s === "discord" ? 0 : 1;
  return sourceRank(a.sourceType) - sourceRank(b.sourceType) ||
    b.messageCount - a.messageCount ||
    a.file.localeCompare(b.file);
});

if (rows.length === 0) {
  console.error(`No inventory rows matched month=${month}. Run tdb-history-inventory.mjs first or adjust filters.`);
  process.exit(1);
}

await ensureDir(INPUTS_DIR);
const output = path.join(INPUTS_DIR, `${month}-${batchId}.json`);
const rejectsPath = path.join(INPUTS_DIR, `${month}-${batchId}.rejects.jsonl`);
const rejectStream = fs.createWriteStream(rejectsPath, { flags: "w", mode: 0o600 });
const writeReject = (record) => rejectStream.write(`${JSON.stringify(record)}\n`);

const allRounds = [];
const contentDedupe = createContentDedupeContext();
contentDedupe.rejectBatchDuplicates = Boolean(args["reject-batch-duplicates"]);

for (const row of rows) {
  const file = expandHome(row.file);
  const meta = sourceMeta(file);
  if (!meta) {
    writeReject({ reason: "unsupported_source_path", file: row.file, sessionId: row.sessionId });
    continue;
  }
  const messages = await loadCleanMessages(file, meta, month, writeReject, contentDedupe);
  const rounds = buildStrictRounds(messages, writeReject, file, meta);
  if (rounds.length === 0) continue;
  for (const round of rounds) {
    allRounds.push({
      meta,
      file,
      sessionKey: `${meta.sessionKey}:seed:${month}`,
      sessionId: meta.sessionId,
      sourceFile: relativeToHome(file),
      round,
    });
  }
}

const totalAvailableRounds = allRounds.length;
const selectedRounds = allRounds.slice(offsetRounds, limit == null ? undefined : offsetRounds + limit);
const sessionsByKey = new Map();
for (const item of selectedRounds) {
  const key = `${item.sessionKey}\t${item.sessionId}\t${item.sourceFile}`;
  if (!sessionsByKey.has(key)) {
    sessionsByKey.set(key, {
      sessionKey: item.sessionKey,
      sessionId: item.sessionId,
      sourceFile: item.sourceFile,
      conversations: [],
    });
  }
  sessionsByKey.get(key).conversations.push(item.round);
}
const sessions = [...sessionsByKey.values()];
const totalRounds = selectedRounds.length;
const totalMessages = selectedRounds.reduce((sum, item) => sum + item.round.length, 0);
const rangeStartRound = totalRounds > 0 ? offsetRounds + 1 : null;
const rangeEndRound = totalRounds > 0 ? offsetRounds + totalRounds : null;
const sourceType = args.sourceType || null;
const metadata = {
  month,
  sourceType,
  batchId,
  offsetRounds,
  limitRounds: limit ?? null,
  rangeStartRound,
  rangeEndRound,
  totalAvailableRounds,
  filters: {
    file: args.file ? relativeToHome(path.resolve(expandHome(args.file))) : null,
    sessionId: args.sessionId || null,
    sessionKey: args.sessionKey || null,
    batchSize,
    batchIndex,
    rejectBatchDuplicates: contentDedupe.rejectBatchDuplicates,
  },
};

if (totalAvailableRounds > 0 && offsetRounds >= totalAvailableRounds) {
  writeReject({
    reason: "offset_beyond_available_rounds",
    month,
    batchId,
    offsetRounds,
    totalAvailableRounds,
  });
}

rejectStream.end();
await new Promise((resolve) => rejectStream.on("finish", resolve));

if (sessions.length === 0) {
  console.error("No strict user/assistant rounds were built from the selected rows.");
  process.exit(1);
}

await writeJson(output, { metadata, sessions });
console.log(JSON.stringify({
  output,
  rejects: rejectsPath,
  sessions: sessions.length,
  rounds: totalRounds,
  messages: totalMessages,
  metadata,
}, null, 2));
