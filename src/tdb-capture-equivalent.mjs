import crypto from "node:crypto";
import { normalizedContentHash, normalizeContentForDedupe } from "./tdb-history-lib.mjs";

// Mirrors memory-tencentdb/src/utils/sanitize.ts and the L0 recorder's
// sanitize -> assistant stripCodeBlocks -> shouldCaptureL0 order.
export function sanitizeText(text) {
  let cleaned = String(text || "");
  cleaned = cleaned.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/g, "");
  cleaned = cleaned.replace(/<user-persona>[\s\S]*?<\/user-persona>/g, "");
  cleaned = cleaned.replace(/<relevant-scenes>[\s\S]*?<\/relevant-scenes>/g, "");
  cleaned = cleaned.replace(/<scene-navigation>[\s\S]*?<\/scene-navigation>/g, "");
  cleaned = cleaned.replace(/<current_task_context>[\s\S]*?<\/current_task_context>/g, "");
  cleaned = cleaned.replace(/<history_task_context[\s\S]*?<\/history_task_context>/g, "");
  cleaned = cleaned.replace(
    /(?:Conversation info|Sender|Thread starter|Replied message|Forwarded message context|Chat history since last reply)\s*\(untrusted[\s\S]*?\):\s*```json\s*[\s\S]*?```/g,
    "",
  );
  cleaned = cleaned.replace(/```json\s*\{[\s\S]*?"session[\s\S]*?\}\s*```/g, "");
  cleaned = cleaned.replace(/\[\[reply_to[^\]]*\]\]\s*/g, "");
  cleaned = cleaned.replace(/¥¥\[[\s\S]*?\]¥¥/g, "");
  cleaned = cleaned.replace(/^\[[\w\d\-:+ ]+\]\s*/gm, "");
  cleaned = cleaned.replace(/\[media attached:[^\]]*\]\s*/g, "");
  cleaned = cleaned.replace(/To send an image back,[\s\S]*?(?:Keep caption in the text body\.)\s*/g, "");
  cleaned = cleaned.replace(/^System:\s*\[[\s\S]*?$/gm, "");
  cleaned = cleaned.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/gi, "");
  cleaned = cleaned.replace(/\0/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
}

export function stripCodeBlocks(text) {
  return String(text || "").replace(/```[^\n]*\n[\s\S]*?```/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function shouldCaptureL0(text) {
  const t = String(text || "");
  if (!t.trim()) return false;
  if (isFrameworkNoise(t)) return false;
  if (t.startsWith("/")) return false;
  return true;
}

export function captureEquivalentContent(role, content) {
  let out = sanitizeText(content);
  if (role === "assistant") out = stripCodeBlocks(out);
  return out;
}

export function flattenRawInput(seedInput) {
  const out = [];
  for (const session of seedInput.sessions || []) {
    const sessionKey = session.sessionKey;
    for (const round of session.conversations || []) {
      for (const msg of round || []) {
        out.push(toComparableMessage({
          sessionKey,
          sessionId: session.sessionId || "",
          role: msg.role,
          timestamp: Number(msg.timestamp) || 0,
          content: msg.content || "",
          sourceKey: msg.sourceKey || "",
          normalizedContentHash: msg.normalizedContentHash || normalizedContentHash(msg.content),
        }));
      }
    }
  }
  return out;
}

export function buildCaptureEquivalentExpected(seedInput) {
  const raw = flattenRawInput(seedInput);
  const kept = [];
  const filtered = [];
  const transformed = [];
  for (const msg of raw) {
    const content = captureEquivalentContent(msg.role, msg.content);
    const afterHash = normalizedContentHash(content);
    const afterLength = normalizeContentForDedupe(content).length;
    const changed = content !== msg.content || afterHash !== msg.normalizedContentHash;
    const base = {
      ...msg,
      rawContent: msg.content,
      content,
      rawNormalizedContentHash: msg.normalizedContentHash,
      normalizedContentHash: afterHash,
      normalizedLength: afterLength,
      sanitizerTransformed: changed,
    };
    if (!shouldCaptureL0(content)) {
      filtered.push({ ...base, filterReason: filterReason(content) });
      continue;
    }
    const comparable = toComparableMessage(base);
    kept.push(comparable);
    if (changed) transformed.push(comparable);
  }
  return {
    raw,
    kept,
    filtered,
    transformed,
    rawCount: raw.length,
    expectedCount: kept.length,
    filteredCount: filtered.length,
    transformedCount: transformed.length,
    expectedHash: datasetHash(kept),
    rawHash: datasetHash(raw),
  };
}

export function toLiveComparable(row) {
  return toComparableMessage({
    sessionKey: row.session_key ?? row.sessionKey,
    sessionId: row.session_id ?? row.sessionId ?? "",
    role: row.role,
    timestamp: Number(row.timestamp) || 0,
    content: row.message_text ?? row.content ?? "",
    normalizedContentHash: normalizedContentHash(row.message_text ?? row.content ?? ""),
  });
}

export function compareCaptureEquivalentL0(expected, liveL0) {
  const expectedKeyCounts = countBy(expected, (m) => m.compareKey);
  const liveKeyCounts = countBy(liveL0, (m) => m.compareKey);
  const expectedRelaxedKeyCounts = countBy(expected, (m) => m.relaxedCompareKey);
  const liveRelaxedKeyCounts = countBy(liveL0, (m) => m.relaxedCompareKey);
  const missing = subtractCounts(expectedKeyCounts, liveKeyCounts);
  const extra = subtractCounts(liveKeyCounts, expectedKeyCounts);
  const relaxedMissing = subtractCounts(expectedRelaxedKeyCounts, liveRelaxedKeyCounts, safeRelaxedSample);
  const relaxedExtra = subtractCounts(liveRelaxedKeyCounts, expectedRelaxedKeyCounts, safeRelaxedSample);
  return {
    missing,
    extra,
    relaxedMissing,
    relaxedExtra,
    complete: expected.length === liveL0.length && missing.total === 0 && extra.total === 0,
    liveHash: datasetHash(liveL0),
  };
}

export function datasetHash(items) {
  const parts = items.map((m) => m.compareKey).sort();
  return crypto.createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 24);
}

export function countBy(items, fn) {
  const counts = new Map();
  for (const item of items) {
    const key = fn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

export function subtractCounts(left, right, sampler = safeSample) {
  const samples = [];
  let total = 0;
  for (const [key, count] of left.entries()) {
    const delta = count - (right.get(key) || 0);
    if (delta <= 0) continue;
    total += delta;
    if (samples.length < 20) samples.push(sampler(key, delta));
  }
  return { total, samples };
}

function toComparableMessage(msg) {
  const normalized = normalizeContentForDedupe(msg.content);
  const hash = msg.normalizedContentHash || normalizedContentHash(msg.content);
  return {
    sessionKey: msg.sessionKey,
    sessionId: msg.sessionId || "",
    role: msg.role,
    timestamp: Number(msg.timestamp) || 0,
    sourceKey: msg.sourceKey || "",
    content: msg.content,
    normalizedContentHash: hash,
    normalizedLength: normalized.length,
    compareKey: `${msg.sessionKey}\t${msg.role}\t${Number(msg.timestamp) || 0}\t${hash}`,
    relaxedCompareKey: `${msg.sessionKey}\t${msg.role}\t${hash}`,
    rawNormalizedContentHash: msg.rawNormalizedContentHash,
    sanitizerTransformed: Boolean(msg.sanitizerTransformed),
  };
}

function safeSample(key, count) {
  const [sessionKey, role, timestamp, hash] = String(key).split("\t");
  return { sessionKey, role, timestamp: Number(timestamp), normalizedContentHash: hash, count };
}

function safeRelaxedSample(key, count) {
  const [sessionKey, role, hash] = String(key).split("\t");
  return { sessionKey, role, normalizedContentHash: hash, count };
}

function isFrameworkNoise(text) {
  const t = String(text || "").trim();
  if (t === "(session bootstrap)") return true;
  if (t.startsWith("A new session was started via")) return true;
  if (/^✅\s*New session started/.test(t)) return true;
  if (t.startsWith("Pre-compaction memory flush")) return true;
  if (/^NO_REPLY\s*$/.test(t)) return true;
  return false;
}

function filterReason(text) {
  const t = String(text || "");
  if (!t.trim()) return "empty after sanitize/stripCodeBlocks";
  if (isFrameworkNoise(t)) return "framework noise";
  if (t.startsWith("/")) return "slash command";
  return "shouldCaptureL0=false";
}
