#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  AUDITS_DIR,
  INPUTS_DIR,
  SHADOW_ROOT,
  assertNotLiveTdbOutput,
  ensureDir,
  expandHome,
  classifySystemNoise,
  isAssistantProgressUpdate,
  isSystemNoiseText,
  normalizeContentForDedupe,
  normalizedContentHash,
  parseArgs,
  queryShadowCounts,
  readJson,
  relativeToHome,
  scanLiveForSeedKeys,
  sqliteReadOnlyUri,
} from "./tdb-history-lib.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args["shadow-dir"]) {
  console.error("Usage: node scripts/tdb-history/tdb-shadow-audit.mjs --shadow-dir ~/.openclaw/tmp/tdb-shadow-seed/2026-04/batch-001 [--input tmp/tdb-history/inputs/2026-04-batch-001.json]");
  process.exit(2);
}

const shadowDir = assertNotLiveTdbOutput(path.resolve(expandHome(args["shadow-dir"])));
if (!(shadowDir === SHADOW_ROOT || shadowDir.startsWith(`${SHADOW_ROOT}${path.sep}`))) {
  throw new Error(`Refusing to audit outside shadow root: ${shadowDir}`);
}
const month = String(args.month || shadowDir.match(/tdb-shadow-seed\/(2026-\d\d)\//)?.[1] || "");
const batchId = String(args["batch-id"] || path.basename(shadowDir));
const inputPath = args.input
  ? path.resolve(expandHome(args.input))
  : path.join(INPUTS_DIR, `${month}-${batchId}.json`);

const input = fs.existsSync(inputPath) ? await readJson(inputPath) : { sessions: [] };
const inputStats = summarizeInput(input);
const inputQuality = analyzeInputQuality(input);
const inputOverlap = analyzeInputOverlap(input, inputPath);
const outputCounts = queryShadowCounts(shadowDir);
const l1Rows = readL1Rows(shadowDir);
const l0Rows = readL0Rows(shadowDir);
const outputQuality = analyzeOutputQuality(l0Rows);
const typeDistribution = {};
for (const row of l1Rows) typeDistribution[row.type || "unknown"] = (typeDistribution[row.type || "unknown"] || 0) + 1;
const l1LengthStats = analyzeL1LengthStats(l1Rows);
const samples = l1Rows.slice(0, 20);
const sessionKeys = (input.sessions || []).map((s) => s.sessionKey).filter(Boolean);
const sessionKeyHits = findSessionKeyHits(shadowDir, sessionKeys);
const suspicious = l1Rows
  .filter((row) => isSuspiciousMemory(row.content))
  .slice(0, 50)
  .map((row) => ({ type: row.type, recordId: row.record_id, content: row.content.slice(0, 240) }));
const liveCheck = readLiveCheck(shadowDir, sessionKeys);
const warningSummary = readRunWarningSummary(shadowDir);

await ensureDir(AUDITS_DIR);
const reportPath = path.join(AUDITS_DIR, `${month}-${batchId}.md`);
const md = renderReport({
  month,
  batchId,
  shadowDir,
  inputPath,
  inputStats,
  inputQuality,
  inputOverlap,
  outputCounts,
  outputQuality,
  l0Rows,
  l1Rows,
  l1LengthStats,
  typeDistribution,
  samples,
  sessionKeyHits,
  suspicious,
  liveCheck,
  warningSummary,
});
await fsp.writeFile(reportPath, md, { encoding: "utf8", mode: 0o600 });
await fsp.chmod(reportPath, 0o600);
console.log(JSON.stringify({ output: reportPath, inputStats, inputQuality, inputOverlap, outputCounts, outputQuality, l1Types: typeDistribution, l1LengthStats, suspicious: suspicious.length, warningSummary, liveCheck }, null, 2));

function summarizeInput(inputJson) {
  const sessions = inputJson.sessions || [];
  let rounds = 0;
  let messages = 0;
  for (const session of sessions) {
    rounds += session.conversations?.length || 0;
    for (const round of session.conversations || []) messages += round.length;
  }
  return { sessions: sessions.length, rounds, messages };
}

function analyzeInputQuality(inputJson) {
  const messages = [];
  for (const session of inputJson.sessions || []) {
    for (const round of session.conversations || []) {
      for (const msg of round) messages.push(msg);
    }
  }
  const userMessages = messages.filter((m) => m.role === "user");
  const duplicateKeys = countDuplicates(userMessages.map((m) => m.sourceKey || fallbackKey(m)));
  const normalized = duplicateStats(messages);
  const userNormalized = duplicateStats(userMessages);
  const systemNoise = messages.filter((m) => isSystemNoiseText(m.content)).length;
  const metadataEnvelope = messages.filter((m) =>
    /Conversation info \(untrusted metadata\)|Sender \(untrusted metadata\)|Untrusted context \(metadata/i.test(m.content || "")
  ).length;
  const assistantProgress = messages.filter((m) => m.role === "assistant" && isAssistantProgressUpdate(m.content)).length;
  return rates({
    totalMessages: messages.length,
    userMessages: userMessages.length,
    duplicateUserMessages: duplicateKeys,
    duplicateNormalizedContentMessages: normalized.duplicates,
    userDuplicateNormalizedContentMessages: userNormalized.duplicates,
    topDuplicateNormalizedContent: normalized.top,
    assistantProgressUpdateMessages: assistantProgress,
    systemNoiseMessages: systemNoise,
    metadataEnvelopeMessages: metadataEnvelope,
  });
}

function analyzeInputOverlap(inputJson, currentInputPath) {
  const current = collectInputIdentity(inputJson);
  const currentResolved = path.resolve(currentInputPath);
  const historicalFiles = fs.existsSync(INPUTS_DIR)
    ? fs.readdirSync(INPUTS_DIR)
      .filter((name) => name.endsWith(".json") && !name.endsWith(".seed-config.json"))
      .map((name) => path.join(INPUTS_DIR, name))
      .filter((file) => path.resolve(file) !== currentResolved)
      .sort()
    : [];
  const sourceKeyOwners = new Map();
  const hashOwners = new Map();
  for (const file of historicalFiles) {
    let json;
    try { json = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    const identity = collectInputIdentity(json);
    for (const key of identity.sourceKeys) if (!sourceKeyOwners.has(key)) sourceKeyOwners.set(key, relativeToHome(file));
    for (const key of identity.roleHashes) if (!hashOwners.has(key)) hashOwners.set(key, relativeToHome(file));
  }
  const sourceKeyHits = [...current.sourceKeys].filter((key) => sourceKeyOwners.has(key));
  const hashHits = [...current.roleHashes].filter((key) => hashOwners.has(key));
  const overlappingMessages = new Set();
  for (const [idx, msg] of current.messages.entries()) {
    if (msg.sourceKey && sourceKeyOwners.has(msg.sourceKey)) overlappingMessages.add(idx);
    if (msg.roleHash && hashOwners.has(msg.roleHash)) overlappingMessages.add(idx);
  }
  const totalMessages = current.messages.length;
  const overlapRate = totalMessages ? Number((overlappingMessages.size / totalMessages).toFixed(4)) : 0;
  return {
    comparedInputFiles: historicalFiles.map(relativeToHome),
    totalMessages,
    overlappingMessages: overlappingMessages.size,
    overlapRate,
    sourceKeyOverlapCount: sourceKeyHits.length,
    normalizedContentHashOverlapCount: hashHits.length,
    warning: overlapRate > 0,
    topSourceKeyHits: sourceKeyHits.slice(0, 20).map((key) => ({ key, file: sourceKeyOwners.get(key) })),
    topNormalizedContentHashHits: hashHits.slice(0, 20).map((key) => ({ key, file: hashOwners.get(key) })),
  };
}

function collectInputIdentity(inputJson) {
  const messages = [];
  const sourceKeys = new Set();
  const roleHashes = new Set();
  for (const session of inputJson.sessions || []) {
    for (const round of session.conversations || []) {
      for (const msg of round) {
        const sourceKey = msg.sourceKey || "";
        const hash = msg.normalizedContentHash || normalizedContentHash(msg.content);
        const roleHash = hash ? `${msg.role || ""}:${hash}` : "";
        const item = { sourceKey, roleHash };
        messages.push(item);
        if (sourceKey) sourceKeys.add(sourceKey);
        if (roleHash) roleHashes.add(roleHash);
      }
    }
  }
  return { messages, sourceKeys, roleHashes };
}

function analyzeOutputQuality(rows) {
  const normalized = duplicateStats(rows);
  const userNormalized = duplicateStats(rows.filter((r) => r.role === "user"));
  const duplicateRows = normalized.duplicates;
  const systemNoise = rows.filter((r) => isSystemNoiseText(r.content)).length;
  const metadataEnvelope = rows.filter((r) =>
    /Conversation info \(untrusted metadata\)|Sender \(untrusted metadata\)|Untrusted context \(metadata/i.test(r.content || "")
  ).length;
  const assistantProgress = rows.filter((r) => r.role === "assistant" && isAssistantProgressUpdate(r.content)).length;
  return rates({
    totalMessages: rows.length,
    duplicateMessages: duplicateRows,
    duplicateNormalizedContentMessages: normalized.duplicates,
    userDuplicateNormalizedContentMessages: userNormalized.duplicates,
    topDuplicateNormalizedContent: normalized.top,
    assistantProgressUpdateMessages: assistantProgress,
    systemNoiseMessages: systemNoise,
    metadataEnvelopeMessages: metadataEnvelope,
  });
}

function analyzeL1LengthStats(rows) {
  const lengths = rows.map((row) => String(row.content || "").length);
  const total = lengths.reduce((sum, value) => sum + value, 0);
  return {
    count: lengths.length,
    avgLength: lengths.length ? Number((total / lengths.length).toFixed(1)) : 0,
    maxLength: lengths.length ? Math.max(...lengths) : 0,
    countOver800Chars: lengths.filter((value) => value > 800).length,
    countOver1200Chars: lengths.filter((value) => value > 1200).length,
  };
}

function rates(base) {
  const total = base.totalMessages || 0;
  return {
    ...base,
    duplicateRate: total ? Number(((base.duplicateUserMessages ?? base.duplicateMessages ?? 0) / total).toFixed(4)) : 0,
    duplicateNormalizedContentRate: total ? Number(((base.duplicateNormalizedContentMessages ?? 0) / total).toFixed(4)) : 0,
    assistantProgressUpdateRate: total ? Number(((base.assistantProgressUpdateMessages ?? 0) / total).toFixed(4)) : 0,
    userDuplicateNormalizedContentRate: base.userMessages ? Number(((base.userDuplicateNormalizedContentMessages ?? 0) / base.userMessages).toFixed(4)) : 0,
    systemNoiseRate: total ? Number((base.systemNoiseMessages / total).toFixed(4)) : 0,
    metadataEnvelopeRate: total ? Number((base.metadataEnvelopeMessages / total).toFixed(4)) : 0,
  };
}

function duplicateStats(messages) {
  const counts = new Map();
  const samples = new Map();
  for (const msg of messages) {
    const hash = msg.normalizedContentHash || normalizedContentHash(msg.content);
    if (!hash) continue;
    counts.set(hash, (counts.get(hash) || 0) + 1);
    if (!samples.has(hash)) samples.set(hash, normalizeContentForDedupe(msg.content).slice(0, 180));
  }
  let duplicates = 0;
  for (const count of counts.values()) if (count > 1) duplicates += count - 1;
  const top = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([hash, count]) => ({ hash, count, duplicateCount: count - 1, content: samples.get(hash) || "" }));
  return { duplicates, top };
}

function countDuplicates(keys) {
  const seen = new Set();
  let duplicates = 0;
  for (const key of keys.filter(Boolean)) {
    if (seen.has(key)) duplicates++;
    else seen.add(key);
  }
  return duplicates;
}

function fallbackKey(msg) {
  return `${msg.role || ""}\t${msg.timestamp || ""}\t${String(msg.content || "").replace(/\s+/g, " ").trim()}`;
}

function readL1Rows(dir) {
  const db = path.join(dir, "vectors.db");
  if (!fs.existsSync(db)) return readRecordJsonl(dir);
  const sql = "select record_id, type, session_key, session_id, replace(replace(content, char(10), ' '), char(13), ' ') from l1_records order by created_time, record_id;";
  const result = spawnSync("sqlite3", [sqliteReadOnlyUri(db), "-readonly", "-separator", "\t", "-batch", sql], { encoding: "utf8" });
  if (result.status !== 0) return readRecordJsonl(dir);
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [record_id, type, session_key, session_id, content] = line.split("\t");
    return { record_id, type, session_key, session_id, content: content || "" };
  });
}

function readL0Rows(dir) {
  const db = path.join(dir, "vectors.db");
  if (!fs.existsSync(db)) return [];
  const sql = "select record_id, role, session_key, session_id, replace(replace(message_text, char(10), ' '), char(13), ' ') from l0_conversations order by timestamp, record_id;";
  const result = spawnSync("sqlite3", [sqliteReadOnlyUri(db), "-readonly", "-separator", "\t", "-batch", sql], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [record_id, role, session_key, session_id, content] = line.split("\t");
    return { record_id, role, session_key, session_id, content: content || "" };
  });
}

function readRecordJsonl(dir) {
  const recordsDir = path.join(dir, "records");
  const rows = [];
  if (!fs.existsSync(recordsDir)) return rows;
  for (const name of fs.readdirSync(recordsDir).filter((n) => n.endsWith(".jsonl")).sort()) {
    const lines = fs.readFileSync(path.join(recordsDir, name), "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        rows.push({
          record_id: obj.record_id || obj.id || "",
          type: obj.type || "unknown",
          session_key: obj.session_key || obj.sessionKey || "",
          session_id: obj.session_id || obj.sessionId || "",
          content: obj.content || obj.text || "",
        });
      } catch {
        rows.push({ record_id: "", type: "parse_error", session_key: "", session_id: "", content: line.slice(0, 300) });
      }
    }
  }
  return rows;
}

function findSessionKeyHits(dir, keys) {
  const hits = [];
  const files = [];
  for (const sub of ["conversations", "records"]) {
    const base = path.join(dir, sub);
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base).filter((n) => n.endsWith(".jsonl"))) files.push(path.join(base, name));
  }
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const key of keys) {
      if (text.includes(key)) hits.push({ file: relativeToHome(file), sessionKey: key });
    }
  }
  return hits;
}

function isSuspiciousMemory(text) {
  return /\b(tool_result|tool_use|function_call|traceback|stderr|stdout|exit code|json_parse_error|metadata|openclaw cron|scheduled task|healthcheck)\b/i.test(text || "") ||
    /<\/?(tool_use|tool_result|system|developer)\b/i.test(text || "");
}

function readLiveCheck(dir, sessionKeys) {
  const beforePath = path.join(dir, "live-before.json");
  const afterPath = path.join(dir, "live-after.json");
  let before = null;
  let after = null;
  try { before = JSON.parse(fs.readFileSync(beforePath, "utf8")); } catch {}
  try { after = JSON.parse(fs.readFileSync(afterPath, "utf8")); } catch {}
  const comparison = before && after ? {
    countsUnchanged: JSON.stringify(before.counts) === JSON.stringify(after.counts),
    filesUnchanged: JSON.stringify(before.files) === JSON.stringify(after.files),
    beforeCounts: before.counts,
    afterCounts: after.counts,
  } : null;
  const batchId = path.basename(dir);
  const pollutionKeys = [...sessionKeys, batchId].filter(Boolean);
  const seedKeyHitsInLive = scanLiveForSeedKeys(pollutionKeys);
  const fieldHits = seedKeyHitsInLive.filter((hit) => hit.matchKind === "session_field");
  const contentMentions = seedKeyHitsInLive.filter((hit) => hit.matchKind !== "session_field");
  return {
    comparison,
    pollutionKeys,
    pollutionDetected: fieldHits.length > 0,
    fieldHits,
    contentMentions,
    seedKeyHitsInLive,
  };
}

function readRunWarningSummary(dir) {
  const runLogPath = path.join(dir, "run.log");
  const runSummaryPath = path.join(dir, "run-summary.json");
  const runLog = fs.existsSync(runLogPath) ? fs.readFileSync(runLogPath, "utf8") : "";
  let runSummary = {};
  try { runSummary = JSON.parse(fs.readFileSync(runSummaryPath, "utf8")); } catch {}
  return {
    llmExtractionFailedCount: countMatches(runLog, /\bLLM extraction failed\b/gi),
    safetyRefusalCount: countMatches(runLog, /flagged for potentially high-risk cyber activity|safety checks\/cybersecurity/gi),
    embeddingFailedCount: countMatches(runLog, /\bEmbedding FAILED\b|Background embedding failed/gi),
    metadataOnlyWriteCount: countMatches(runLog, /metadata-only/gi),
    l0SafetyValveCount: countMatches(runLog, /\bSafety valve\b/gi),
    officialCliFallbackUsed: Boolean(runSummary.fallbackUsed),
    officialExitCode: runSummary.officialExitCode ?? null,
    fallbackUsed: runSummary.fallbackUsed ?? null,
    processExitCode: runSummary.processExitCode ?? null,
  };
}

function countMatches(text, pattern) {
  return [...String(text || "").matchAll(pattern)].length;
}

function renderReport(data) {
  return `# TDB Shadow Seed Audit: ${data.month} ${data.batchId}

Generated: ${new Date().toISOString()}

## Scope

- Input: \`${relativeToHome(data.inputPath)}\`
- Shadow dir: \`${relativeToHome(data.shadowDir)}\`
- Mode: read-only audit, no promotion or live merge

## Input

- Sessions: ${data.inputStats.sessions}
- Rounds: ${data.inputStats.rounds}
- Messages: ${data.inputStats.messages}
- Duplicate user messages: ${data.inputQuality.duplicateUserMessages} (${fmtRate(data.inputQuality.duplicateRate)})
- Duplicate normalized content: ${data.inputQuality.duplicateNormalizedContentMessages} (${fmtRate(data.inputQuality.duplicateNormalizedContentRate)})
- User duplicate normalized content: ${data.inputQuality.userDuplicateNormalizedContentMessages} (${fmtRate(data.inputQuality.userDuplicateNormalizedContentRate)})
- Assistant progress updates: ${data.inputQuality.assistantProgressUpdateMessages} (${fmtRate(data.inputQuality.assistantProgressUpdateRate)})
- System-noise messages: ${data.inputQuality.systemNoiseMessages} (${fmtRate(data.inputQuality.systemNoiseRate)})
- Metadata-envelope messages: ${data.inputQuality.metadataEnvelopeMessages} (${fmtRate(data.inputQuality.metadataEnvelopeRate)})

Top duplicate normalized content:
${formatTopDuplicates(data.inputQuality.topDuplicateNormalizedContent)}

## Input Overlap Check

- Compared historical input files: ${data.inputOverlap.comparedInputFiles.length}
- Overlapping messages: ${data.inputOverlap.overlappingMessages}/${data.inputOverlap.totalMessages} (${fmtRate(data.inputOverlap.overlapRate)})
- SourceKey overlap count: ${data.inputOverlap.sourceKeyOverlapCount}
- Normalized content hash overlap count: ${data.inputOverlap.normalizedContentHashOverlapCount}
- Status: ${data.inputOverlap.warning ? "WARNING: input overlaps previous batch content" : "PASS: no overlap detected"}

Top sourceKey overlaps:
${data.inputOverlap.topSourceKeyHits.map((hit) => `- ${hit.key} in \`${hit.file}\``).join("\n") || "- none"}

Top normalized content hash overlaps:
${data.inputOverlap.topNormalizedContentHashHits.map((hit) => `- ${hit.key} in \`${hit.file}\``).join("\n") || "- none"}

## Output

- L0 rows: ${data.outputCounts.l0 ?? "n/a"}
- L1 rows: ${data.outputCounts.l1 ?? "n/a"}
- L0 rows read for spot checks: ${data.l0Rows.length}
- L1 rows read for spot checks: ${data.l1Rows.length}
- L0 duplicate rows: ${data.outputQuality.duplicateMessages} (${fmtRate(data.outputQuality.duplicateRate)})
- L0 duplicate normalized content: ${data.outputQuality.duplicateNormalizedContentMessages} (${fmtRate(data.outputQuality.duplicateNormalizedContentRate)})
- L0 user duplicate normalized content: ${data.outputQuality.userDuplicateNormalizedContentMessages} (${fmtRate(data.outputQuality.userDuplicateNormalizedContentRate)})
- L0 assistant progress updates: ${data.outputQuality.assistantProgressUpdateMessages} (${fmtRate(data.outputQuality.assistantProgressUpdateRate)})
- L0 system-noise rows: ${data.outputQuality.systemNoiseMessages} (${fmtRate(data.outputQuality.systemNoiseRate)})
- L0 metadata-envelope rows: ${data.outputQuality.metadataEnvelopeMessages} (${fmtRate(data.outputQuality.metadataEnvelopeRate)})

Top duplicate normalized content:
${formatTopDuplicates(data.outputQuality.topDuplicateNormalizedContent)}

## L1 Type Distribution

${Object.entries(data.typeDistribution).sort().map(([k, v]) => `- ${k}: ${v}`).join("\n") || "- none"}

## L1 Length Stats

- Count: ${data.l1LengthStats.count}
- Avg length: ${data.l1LengthStats.avgLength}
- Max length: ${data.l1LengthStats.maxLength}
- Count over 800 chars: ${data.l1LengthStats.countOver800Chars}
- Count over 1200 chars: ${data.l1LengthStats.countOver1200Chars}

## L1 Sample

${data.samples.map((row, idx) => `${idx + 1}. [${row.type || "unknown"}] ${escapeMd(row.content).slice(0, 500)}`).join("\n\n") || "No L1 records found."}

## Seed SessionKey Presence

- Shadow hits: ${data.sessionKeyHits.length}
${data.sessionKeyHits.slice(0, 20).map((hit) => `- ${hit.sessionKey} in \`${hit.file}\``).join("\n") || "- No sessionKey strings found in shadow JSONL files."}

## Tool Noise / Metadata Check

- Suspicious L1 records: ${data.suspicious.length}
${data.suspicious.map((row) => `- [${row.type || "unknown"}] ${escapeMd(row.content)}`).join("\n") || "- No obvious tool logs, errors, or metadata memories detected by heuristic scan."}

## Run Log Warning Summary

- LLM extraction failed count: ${data.warningSummary.llmExtractionFailedCount}
- Safety refusal count: ${data.warningSummary.safetyRefusalCount}
- Embedding failed count: ${data.warningSummary.embeddingFailedCount}
- Metadata-only write count: ${data.warningSummary.metadataOnlyWriteCount}
- L0 safety valve count: ${data.warningSummary.l0SafetyValveCount}
- Official CLI fallback used: ${data.warningSummary.officialCliFallbackUsed}
- Official exit code: ${data.warningSummary.officialExitCode ?? "not available"}
- Fallback used: ${data.warningSummary.fallbackUsed ?? "not available"}
- Process exit code: ${data.warningSummary.processExitCode ?? "not available"}

Safety refusal and LLM extraction failures are high-signal warnings. Metadata-only writes are counted for visibility and are not treated as failures by themselves.

## Live TDB Safety Check

- Pollution keys checked: \`${JSON.stringify(data.liveCheck.pollutionKeys)}\`
- Pollution detected in live session fields: ${data.liveCheck.pollutionDetected}
- Seed sessionKey/batch-id field hits in live conversations/records: ${data.liveCheck.fieldHits.length}
${data.liveCheck.fieldHits.map((hit) => `- ${hit.sessionKey} in \`${hit.file}:${hit.lineNo}\` (${hit.matchKind})`).join("\n") || "- No seed sessionKey strings found in live session fields."}
- Content-only mentions in live conversations/records: ${data.liveCheck.contentMentions.length}
${data.liveCheck.contentMentions.map((hit) => `- ${hit.sessionKey} in \`${hit.file}:${hit.lineNo}\` (${hit.matchKind})`).join("\n") || "- No content-only mentions found."}

Live total-count drift is informational only because the live Gateway may capture unrelated concurrent activity:
- L0/L1 counts unchanged: ${data.liveCheck.comparison?.countsUnchanged ?? "not available"}
- Live conversation/record file stats unchanged: ${data.liveCheck.comparison?.filesUnchanged ?? "not available"}
- Before counts: \`${JSON.stringify(data.liveCheck.comparison?.beforeCounts ?? null)}\`
- After counts: \`${JSON.stringify(data.liveCheck.comparison?.afterCounts ?? null)}\`
`;
}

function escapeMd(text) {
  return String(text || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function fmtRate(v) {
  return `${((v || 0) * 100).toFixed(2)}%`;
}

function formatTopDuplicates(rows) {
  if (!rows || rows.length === 0) return "- none";
  return rows.map((row) => `- ${row.count}x (${row.hash}) ${escapeMd(row.content)}`).join("\n");
}
