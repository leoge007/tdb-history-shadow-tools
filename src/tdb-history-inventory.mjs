#!/usr/bin/env node
import {
  INVENTORY_PATH,
  MONTHS,
  ensureDir,
  extractMessage,
  listCandidateFiles,
  monthFromTimestamp,
  readJsonl,
  rejectReason,
  relativeToHome,
  writeJson,
} from "./tdb-history-lib.mjs";

const byKey = new Map();
const files = await listCandidateFiles();

for (const meta of files) {
  await readJsonl(meta.file, async (raw) => {
    const msg = extractMessage(raw, meta);
    if (!msg) return;
    const month = monthFromTimestamp(msg.timestamp);
    if (MONTHS.size > 0 && !MONTHS.has(month)) return;
    const key = `${month}\t${meta.sourceType}\t${meta.file}\t${meta.sessionId}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        month,
        sourceType: meta.sourceType,
        file: relativeToHome(meta.file),
        sessionId: meta.sessionId,
        sessionKey: meta.sessionKey,
        messageCount: 0,
        userCount: 0,
        assistantCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        dirtyCount: 0,
        dirtyRatio: 0,
        rejectedRatio: 0,
        firstTs: null,
        lastTs: null,
        sampleUserText: null,
      };
      byKey.set(key, row);
    }
    row.messageCount++;
    const reason = rejectReason(msg);
    if (reason) {
      row.rejectedCount++;
    } else if (msg.role === "assistant") {
      row.acceptedCount++;
      row.assistantCount++;
    } else if (msg.role === "user") {
      row.acceptedCount++;
      row.userCount++;
      if (msg.dirtyFlags?.length) row.dirtyCount++;
      if (!row.sampleUserText) row.sampleUserText = msg.content.slice(0, 300);
    }
    if (msg.role === "assistant" && msg.dirtyFlags?.length) row.dirtyCount++;
    const iso = new Date(msg.timestamp).toISOString();
    if (!row.firstTs || iso < row.firstTs) row.firstTs = iso;
    if (!row.lastTs || iso > row.lastTs) row.lastTs = iso;
  });
}

for (const row of byKey.values()) {
  row.dirtyRatio = row.messageCount ? Number((row.dirtyCount / row.messageCount).toFixed(4)) : 0;
  row.rejectedRatio = row.messageCount ? Number((row.rejectedCount / row.messageCount).toFixed(4)) : 0;
}

const rows = [...byKey.values()].sort((a, b) =>
  a.month.localeCompare(b.month) ||
  a.sourceType.localeCompare(b.sourceType) ||
  a.file.localeCompare(b.file)
);

const summary = {
  generatedAt: new Date().toISOString(),
  months: Object.fromEntries(
    [...(MONTHS.size > 0 ? MONTHS : new Set(rows.map((row) => row.month)))].sort().map((month) => {
      const monthRows = rows.filter((r) => r.month === month);
      return [month, {
        sessions: monthRows.length,
        messages: monthRows.reduce((sum, r) => sum + r.messageCount, 0),
        users: monthRows.reduce((sum, r) => sum + r.userCount, 0),
        assistants: monthRows.reduce((sum, r) => sum + r.assistantCount, 0),
        rejected: monthRows.reduce((sum, r) => sum + r.rejectedCount, 0),
      }];
    })
  ),
  sourcesScanned: files.length,
  rows,
};

await ensureDir(new URL(".", `file://${INVENTORY_PATH}`).pathname);
const out = await writeJson(INVENTORY_PATH, summary);
console.log(JSON.stringify({ output: out, rows: rows.length, months: summary.months }, null, 2));
