import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

export const WORKSPACE_ROOT = path.resolve(expandHome(process.env.TDB_HISTORY_WORKSPACE || process.cwd()));
export const STATE_ROOT = path.resolve(expandHome(process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw")));
export const LIVE_TDB_DIR = path.join(STATE_ROOT, "memory-tdai");
export const SHADOW_ROOT = path.resolve(expandHome(process.env.TDB_SHADOW_ROOT || path.join(STATE_ROOT, "tmp", "tdb-shadow-seed")));
export const TMP_ROOT = path.resolve(expandHome(process.env.TDB_HISTORY_TMP || path.join(WORKSPACE_ROOT, "tmp", "tdb-history")));
export const INPUTS_DIR = path.join(TMP_ROOT, "inputs");
export const AUDITS_DIR = path.join(TMP_ROOT, "audits");
export const INVENTORY_PATH = path.join(TMP_ROOT, "inventory.json");
export const MONTHS = new Set((process.env.TDB_HISTORY_MONTHS || "").split(",").map((s) => s.trim()).filter(Boolean));

export function expandHome(p) {
  if (!p) return p;
  return p === "~" ? os.homedir() : p.replace(/^~(?=\/)/, os.homedir());
}

export function relativeToHome(p) {
  return p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p;
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith("--")) {
      args._ = args._ || [];
      args._.push(raw);
      continue;
    }
    const eq = raw.indexOf("=");
    if (eq !== -1) {
      args[raw.slice(2, eq)] = raw.slice(eq + 1);
      continue;
    }
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

export function assertValidMonth(month, label = "month") {
  const value = String(month || "");
  if (!/^\d{4}-\d{2}$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  return value;
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

export function assertWritableTarget(fileOrDir, allowedRoots = [TMP_ROOT, SHADOW_ROOT]) {
  const resolved = path.resolve(expandHome(fileOrDir));
  for (const root of allowedRoots.map((r) => path.resolve(expandHome(r)))) {
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) return resolved;
  }
  throw new Error(`Refusing to write outside allowed roots: ${resolved}`);
}

export function assertNotLiveTdbOutput(dir) {
  const resolved = path.resolve(expandHome(dir));
  const live = path.resolve(LIVE_TDB_DIR);
  if (resolved === live || resolved.startsWith(`${live}${path.sep}`)) {
    throw new Error(`Refusing output-dir inside live TDB: ${resolved}`);
  }
  return resolved;
}

export function monthFromTimestamp(ts) {
  const d = parseTimestamp(ts);
  if (!d) return null;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function parseTimestamp(ts) {
  if (ts == null || ts === "") return null;
  if (typeof ts === "number" && Number.isFinite(ts)) {
    const n = ts < 10_000_000_000 ? ts * 1000 : ts;
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof ts === "string") {
    const n = Number(ts);
    if (Number.isFinite(n) && /^\d+(\.\d+)?$/.test(ts.trim())) return parseTimestamp(n);
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function timestampValue(ts) {
  const d = parseTimestamp(ts);
  return d ? d.getTime() : null;
}

export async function listCandidateFiles() {
  const dirs = [
    { root: path.join(STATE_ROOT, "discord", "sessions"), kind: "discord" },
    { root: path.join(STATE_ROOT, "agents"), kind: "agent" },
  ];
  const out = new Map();
  for (const spec of dirs) await walk(spec.root, spec.kind, out);
  return [...out.values()].sort((a, b) => a.file.localeCompare(b.file));
}

async function walk(root, kind, out) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(full, kind, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".trajectory.jsonl")) continue;
    if (kind === "discord" && entry.name !== "history.jsonl") continue;
    if (kind === "agent" && !entry.name.endsWith(".jsonl")) continue;
    const meta = sourceMeta(full);
    if (meta) out.set(full, meta);
  }
}

export function sourceMeta(file) {
  const discordPrefix = path.join(STATE_ROOT, "discord", "sessions") + path.sep;
  const agentsPrefix = path.join(STATE_ROOT, "agents") + path.sep;
  if (file.startsWith(discordPrefix) && path.basename(file) === "history.jsonl") {
    const sessionId = path.basename(path.dirname(file));
    return {
      sourceType: "discord",
      file,
      sessionId,
      sessionKey: `discord:${sessionId}`,
    };
  }
  if (file.startsWith(agentsPrefix) && file.endsWith(".jsonl") && !file.endsWith(".trajectory.jsonl")) {
    const rel = path.relative(agentsPrefix, file);
    const parts = rel.split(path.sep);
    if (parts.length >= 3 && parts[1] === "sessions") {
      const agent = parts[0];
      const sessionId = path.basename(file, ".jsonl");
      return {
        sourceType: `agent:${agent}`,
        file,
        sessionId,
        sessionKey: `agent:${agent}:${sessionId}`,
      };
    }
  }
  return null;
}

export async function readJsonl(file, onObject) {
  const resolved = expandHome(file);
  const stream = fs.createReadStream(resolved, { encoding: "utf8", highWaterMark: 64 * 1024 });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const rawLine of rl) {
    lineNo++;
    const line = rawLine.trim();
    if (!line) continue;
    try {
      await onObject(JSON.parse(line), lineNo, line);
    } catch (err) {
      await onObject(null, lineNo, line, err);
    }
  }
}

export function extractMessage(raw, meta) {
  if (!raw || typeof raw !== "object") return null;
  if (meta.sourceType === "discord") {
    return normalizeMessage({
      role: raw.role,
      content: raw.content,
      timestamp: raw.ts ?? raw.timestamp ?? raw.created_at,
      metadata: pickMetadata(raw, ["author", "author_id", "message_id", "channel_id", "guild_id", "thread_id"]),
      raw,
    });
  }
  const msg = raw.message && typeof raw.message === "object" ? raw.message : raw;
  return normalizeMessage({
    role: msg.role ?? raw.role,
    content: msg.content ?? raw.content ?? msg.text ?? raw.text,
    timestamp: raw.timestamp ?? msg.timestamp ?? raw.ts ?? msg.ts,
    metadata: {
      openclawType: raw.type,
      openclawId: raw.id,
      parentId: raw.parentId,
      provider: msg.provider,
      model: msg.model,
    },
    raw,
  });
}

function normalizeMessage({ role, content, timestamp, metadata, raw }) {
  if (role !== "user" && role !== "assistant") return null;
  const parsed = parseConversationContent(contentToText(content), role);
  const text = parsed.content;
  const ts = timestampValue(timestamp);
  if (!ts) return null;
  const combinedMetadata = compactObject({
    ...(metadata ?? {}),
    ...(parsed.metadata ?? {}),
    sourceMessageId: parsed.metadata?.message_id ?? metadata?.message_id,
  });
  return {
    role,
    content: text,
    timestamp: ts,
    metadata: combinedMetadata,
    dirtyFlags: parsed.dirtyFlags,
    raw,
  };
}

export function contentToText(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if (part.type === "text" && typeof part.text === "string") return part.text;
        if (typeof part.content === "string" && part.type !== "tool_use" && part.type !== "tool_result") return part.content;
        return "";
      })
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text.trim();
    if (typeof content.content === "string") return content.content.trim();
  }
  return "";
}

export function sanitizeConversationText(text) {
  return parseConversationContent(text).content;
}

export function parseConversationContent(text, role = "") {
  let out = String(text || "").trim();
  const metadata = {};
  const dirtyFlags = [];
  if (!out) return { content: "", metadata, dirtyFlags };

  out = out.replace(/^\[\[reply_to_current\]\]\s*/i, "");

  const conversationMatch = out.match(/^Conversation info \(untrusted metadata\):\s*```json\s*([\s\S]*?)\s*```\s*/i);
  if (conversationMatch) {
    Object.assign(metadata, parseJsonEnvelope(conversationMatch[1]));
    dirtyFlags.push("metadata-envelope");
    out = out.slice(conversationMatch[0].length).trim();
  }

  const systemSenderMatch = out.match(/^System:\s*\[[^\n]*\]\s*[^\n]*\n+Sender \(untrusted metadata\):\s*```json\s*([\s\S]*?)\s*```\s*/i);
  if (systemSenderMatch) {
    Object.assign(metadata, parseJsonEnvelope(systemSenderMatch[1]));
    metadata.systemEnvelope = firstLine(out);
    dirtyFlags.push("system-envelope", "metadata-envelope");
    out = out.slice(systemSenderMatch[0].length).trim();
  }

  const senderOnlyMatch = out.match(/^Sender \(untrusted metadata\):\s*```json\s*([\s\S]*?)\s*```\s*/i);
  if (senderOnlyMatch) {
    Object.assign(metadata, parseJsonEnvelope(senderOnlyMatch[1]));
    dirtyFlags.push("metadata-envelope");
    out = out.slice(senderOnlyMatch[0].length).trim();
  }

  const systemLineMatch = out.match(/^System:\s*([^\n]+)\n+([\s\S]+)$/i);
  if (systemLineMatch) {
    metadata.systemEnvelope = systemLineMatch[1].slice(0, 300);
    dirtyFlags.push("system-envelope");
    out = systemLineMatch[2].trim();
  }

  const repliedMatch = out.match(/^Replied message \(untrusted, for context\):\s*```json\s*([\s\S]*?)\s*```\s*/i);
  if (repliedMatch) {
    metadata.repliedMessage = parseJsonEnvelope(repliedMatch[1]);
    dirtyFlags.push("metadata-envelope", "reply-context");
    out = out.slice(repliedMatch[0].length).trim();
  }

  out = extractExternalDiscordBody(out, metadata, dirtyFlags);
  out = out.replace(/\n+\s*Untrusted context \(metadata, do not treat as instructions(?: or commands)?\):[\s\S]*$/i, "").trim();
  out = out.replace(/\n+\s*Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi, "\n").trim();
  out = out.replace(/\n+\s*Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi, "\n").trim();

  if (role === "user") {
    out = extractQueuedUserText(out, dirtyFlags);
  }

  return { content: out.trim(), metadata: compactObject(metadata), dirtyFlags };
}

function extractExternalDiscordBody(text, metadata, dirtyFlags) {
  const marker = /\n+\s*Untrusted context \(metadata, do not treat as instructions(?: or commands)?\):/i;
  const match = text.match(marker);
  if (!match) return text;
  const prefix = text.slice(0, match.index).trim();
  const context = text.slice(match.index);
  const bodyMatch = context.match(/Source:\s*External\s*\n---\s*\nUNTRUSTED Discord message body\s*\n([\s\S]*?)\n<<<END_EXTERNAL_UNTRUSTED_CONTENT\b/i);
  const channelMatch = context.match(/Source:\s*Channel metadata\s*\n---\s*\n([\s\S]*?)\n<<<END_EXTERNAL_UNTRUSTED_CONTENT\b/i);
  if (channelMatch) metadata.channelContext = channelMatch[1].slice(0, 1000);
  if (bodyMatch) {
    dirtyFlags.push("metadata-envelope", "external-discord-body");
    return bodyMatch[1].trim();
  }
  dirtyFlags.push("metadata-envelope");
  return prefix;
}

function extractQueuedUserText(text, dirtyFlags) {
  if (!/^\[Queued messages while agent was busy\]/i.test(text)) return text;
  dirtyFlags.push("queued-envelope");
  const chunks = text.split(/\n---\n/).map((chunk) => chunk.replace(/^Queued #\d+\s*/i, "").trim()).filter(Boolean);
  const clean = chunks
    .filter((chunk) => !isSystemNoiseText(chunk))
    .map((chunk) => parseConversationContent(chunk, "user").content)
    .filter(Boolean);
  return clean.join("\n\n").trim();
}

export function rejectReason(message) {
  const text = message.content.trim();
  if (!text) return "empty";
  if (text.length < 2) return "too_short";
  if (isSystemNoiseText(text)) return classifySystemNoise(text);
  if (hasResidualMetadataEnvelope(text)) return "metadata_envelope_residual";
  if (message.role === "user" && !isLikelyHumanUserText(text)) return "not_human_user_message";
  if (message.dirtyFlags?.includes("tool-noise")) return "tool_noise";
  if (/^Conversation info \(untrusted metadata\):/i.test(text)) return "conversation_metadata";
  if (/^System \(untrusted\):/i.test(text)) return "system_untrusted_event";
  if (/^Pre-compaction memory flush\./i.test(text)) return "internal_compaction_event";
  if (/^A new session was started via \/new or \/reset\./i.test(text)) return "internal_session_reset_event";
  if (/Model switched to/i.test(text)) return "model_switched_event";
  if (/^\[[^\]]+\]\s+Claude Code ACP mode - run the following task as requested by the user\./i.test(text)) {
    return "internal_acp_bootstrap";
  }
  if (/^(system|developer|tool|function)\s*:/i.test(text)) return "system_or_tool_envelope";
  if (/<\/?(tool_use|tool_result|function_call|system|developer)\b/i.test(text)) return "tool_or_system_markup";
  if (/^\s*(tool_result|tool_use|function_call|assistant_tool)\b/i.test(text)) return "tool_noise";
  if (/^\s*\{[\s\S]*\}\s*$/.test(text)) {
    try {
      const obj = JSON.parse(text);
      const keys = Object.keys(obj);
      const hasEnvelope = ["type", "version", "id", "timestamp", "event", "tool", "metadata"].some((k) => keys.includes(k));
      const hasConversationText = ["content", "text", "message"].some((k) => typeof obj[k] === "string");
      if (hasEnvelope && !hasConversationText) return "json_envelope_metadata";
    } catch {
      return null;
    }
  }
  if (/\b(openclaw\s+cron|cron\s+job|scheduled\s+task|background\s+task|heartbeat|healthcheck)\b/i.test(text)) {
    return "cron_or_automation";
  }
  if (/^\s*(stdout|stderr|exit code|command failed|traceback|error:\s+spawn)\b/i.test(text)) return "tool_log_or_error";
  return null;
}

export function isSystemNoiseText(text) {
  return Boolean(classifySystemNoise(text));
}

export function classifySystemNoise(text) {
  const t = String(text || "").trim();
  if (!t) return "empty";
  if (/^\[Startup context loaded by runtime\]/i.test(t)) return "runtime_startup_context";
  if (/\[Untrusted daily memory:\s*[^\]]+\]/i.test(t)) return "runtime_untrusted_daily_memory";
  if (/\bBEGIN_QUOTED_NOTES\b/i.test(t) || /\bEND_QUOTED_NOTES\b/i.test(t)) return "runtime_embedded_quoted_notes";
  if (/Bootstrap files like SOUL\.md, USER\.md, and MEMORY\.md are already provided separately/i.test(t)) return "runtime_startup_context";
  if (/^System \(untrusted\):/i.test(t)) return "system_untrusted_event";
  if (/^System:/i.test(t) && /Model switched to/i.test(t)) return "model_switched_event";
  if (/^System:/i.test(t) && !/\n\n\S/.test(t)) return "system_prompt_event";
  if (/^Pre-compaction memory flush\./i.test(t)) return "internal_compaction_event";
  if (/^A new session was started via \/new or \/reset\./i.test(t)) return "internal_session_reset_event";
  if (/<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>/i.test(t)) return "openclaw_internal_context";
  if (/\bExec completed\b/i.test(t)) return "exec_completed_tool_result";
  if (/\b(tool_result|tool_use|function_call|after-tool-call|before-tool-call)\b/i.test(t)) return "tool_noise";
  if (/^\s*(stdout|stderr|exit code|command failed|traceback|error:\s+spawn)\b/i.test(t)) return "tool_log_or_error";
  return null;
}

export function isLikelyHumanUserText(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (classifySystemNoise(t)) return false;
  if (hasResidualMetadataEnvelope(t)) return false;
  if (/^Conversation info \(untrusted metadata\):/i.test(t)) return false;
  if (/^Sender \(untrusted metadata\):/i.test(t)) return false;
  if (/^\[[A-Z][a-z]{2}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[+-]\d+\]/.test(t)) return false;
  return true;
}

function hasResidualMetadataEnvelope(text) {
  return /Conversation info \(untrusted metadata\)|Sender \(untrusted metadata\)|Untrusted context \(metadata/i.test(String(text || ""));
}

export function createContentDedupeContext() {
  return {
    batchSeen: new Map(),
    sourceSeen: new Map(),
    rejectBatchDuplicates: false,
  };
}

export async function loadCleanMessages(file, meta, month, rejectWriter, dedupeContext = null) {
  const messages = [];
  await readJsonl(file, async (raw, lineNo, line, parseErr) => {
    if (parseErr) {
      rejectWriter?.({ reason: "json_parse_error", file, lineNo, line: line.slice(0, 300) });
      return;
    }
    const msg = extractMessage(raw, meta);
    if (!msg) return;
    const msgMonth = monthFromTimestamp(msg.timestamp);
    if (month && msgMonth !== month) return;
    const reason = rejectReason(msg);
    if (reason) {
      rejectWriter?.(rejectRecord(reason, file, meta, lineNo, msg));
      return;
    }
    if (msg.role === "assistant" && isAssistantProgressUpdate(msg.content)) {
      rejectWriter?.(rejectRecord("assistant_progress_update", file, meta, lineNo, msg));
      return;
    }
    msg.normalizedContentHash = normalizedContentHash(msg.content);
    msg.normalizedContent = normalizeContentForDedupe(msg.content);
    if (dedupeContext && msg.normalizedContentHash) {
      const roleHash = `${msg.role}:${msg.normalizedContentHash}`;
      const sourceScope = meta.sessionKey || meta.sessionId || file;
      const sourceKey = `${sourceScope}:${roleHash}`;
      const existingSource = dedupeContext.sourceSeen.get(sourceKey);
      if (existingSource) {
        rejectWriter?.(rejectRecord("duplicate_normalized_content", file, meta, lineNo, msg, {
          duplicateScope: "source_session",
          duplicateOf: existingSource,
        }));
        return;
      }
      const existingBatch = dedupeContext.batchSeen.get(roleHash);
      if (existingBatch) {
        rejectWriter?.(rejectRecord("duplicate_normalized_content_warning", file, meta, lineNo, msg, {
          duplicateScope: "batch",
          duplicateOf: existingBatch,
        }));
        if (dedupeContext.rejectBatchDuplicates) return;
      }
      const marker = {
        file: relativeToHome(file),
        sessionId: meta.sessionId,
        sessionKey: meta.sessionKey,
        lineNo,
        role: msg.role,
        timestamp: msg.timestamp,
        normalizedContentHash: msg.normalizedContentHash,
        contentPreview: msg.content.slice(0, 160),
      };
      dedupeContext.sourceSeen.set(sourceKey, marker);
      dedupeContext.batchSeen.set(roleHash, marker);
    }
    for (const strippedReason of strippedEnvelopeReasons(msg)) {
      rejectWriter?.(rejectRecord(strippedReason, file, meta, lineNo, msg));
    }
    messages.push({
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      metadata: msg.metadata,
      dirtyFlags: msg.dirtyFlags,
      dedupeKey: messageDedupeKey(msg, meta, file),
      normalizedContentHash: msg.normalizedContentHash,
      normalizedContent: msg.normalizedContent,
      file,
      lineNo,
    });
  });
  messages.sort((a, b) => a.timestamp - b.timestamp || a.lineNo - b.lineNo);
  return messages;
}

function strippedEnvelopeReasons(msg) {
  const flags = new Set(msg.dirtyFlags || []);
  const reasons = [];
  if (flags.has("system-envelope")) reasons.push("stripped_system_envelope");
  if (flags.has("metadata-envelope")) reasons.push("stripped_metadata_envelope");
  if (flags.has("external-discord-body")) reasons.push("stripped_external_discord_envelope");
  if (flags.has("reply-context")) reasons.push("stripped_reply_context");
  return reasons;
}

export function buildStrictRounds(messages, rejectWriter, file, meta) {
  const rounds = [];
  const seenUsers = new Set();
  let currentUser = null;
  let assistants = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      flushRound();
      if (seenUsers.has(msg.dedupeKey)) {
        rejectWriter?.(rejectRecord("duplicate_user_message", file, meta, msg.lineNo, msg));
        currentUser = null;
        assistants = [];
        continue;
      }
      seenUsers.add(msg.dedupeKey);
      currentUser = msg;
      assistants = [];
      continue;
    }
    if (!currentUser) {
      rejectWriter?.(rejectRecord("assistant_only_without_user", file, meta, msg.lineNo, msg));
      continue;
    }
    assistants.push(msg);
  }
  flushRound();
  return rounds;

  function flushRound() {
    if (!currentUser) return;
    if (assistants.length === 0) {
      rejectWriter?.(rejectRecord("unpaired_user_without_assistant", file, meta, currentUser.lineNo, currentUser));
    } else {
      rounds.push([currentUser, ...assistants].map(seedMessage));
    }
    currentUser = null;
    assistants = [];
  }
}

function seedMessage(msg) {
  const out = { role: msg.role, content: msg.content, timestamp: msg.timestamp };
  if (msg.metadata && Object.keys(msg.metadata).length > 0) out.metadata = msg.metadata;
  if (msg.dedupeKey) out.sourceKey = msg.dedupeKey;
  if (msg.normalizedContentHash) out.normalizedContentHash = msg.normalizedContentHash;
  return out;
}

export function rejectRecord(reason, file, meta, lineNo, msg, extra = {}) {
  return {
    reason,
    file: relativeToHome(file),
    sessionId: meta.sessionId,
    sessionKey: meta.sessionKey,
    lineNo,
    role: msg?.role,
    timestamp: msg?.timestamp,
    metadata: msg?.metadata,
    dirtyFlags: msg?.dirtyFlags,
    dedupeKey: msg?.dedupeKey,
    normalizedContentHash: msg?.normalizedContentHash,
    normalizedContent: msg?.normalizedContent,
    contentPreview: msg?.content ? msg.content.slice(0, 300) : undefined,
    ...extra,
  };
}

export function messageDedupeKey(msg, meta = null, file = "") {
  const scope = sourceIdentityScope(meta, file);
  const id = msg.metadata?.message_id ?? msg.metadata?.messageId ?? msg.metadata?.sourceMessageId;
  if (id) return `${scope}:message_id:${id}`;
  const h = crypto.createHash("sha256").update(`${msg.role}\n${msg.timestamp}\n${normalizeForHash(msg.content)}`).digest("hex").slice(0, 24);
  return `${scope}:hash:${h}`;
}

function sourceIdentityScope(meta, file) {
  const session = meta?.sessionKey || meta?.sessionId || "";
  if (session) return session;
  const rel = file ? relativeToHome(path.resolve(expandHome(file))) : "unknown-source";
  return rel.replace(/[^\w:./~=-]+/g, "_");
}

function normalizeForHash(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function normalizedContentHash(text) {
  const normalized = normalizeContentForDedupe(text);
  if (!normalized) return "";
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

export function normalizeContentForDedupe(text) {
  let out = String(text || "").trim();
  if (!out) return "";
  out = out.replace(/^\[\[reply_to_current\]\]\s*/i, "");
  out = out.replace(/^>\s*/gm, "");
  out = out.replace(/^(?:↪|⤷|回复|Reply(?:ing)? to|Replied message)[:：][^\n]*\n+/i, "");
  out = out.replace(/^\s*(?:收到|好的|好|行|明白|可以|OK|ok)[，,。.!！\s]+/i, "");
  out = out.replace(/^\s*(?:我先|我来|我会|我把|我直接|我继续|我再|我现在|我马上)(?:先)?(?:把|来|去)?\s*/i, "");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

export function isAssistantProgressUpdate(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/^我把\s*Steam\s*这块的现状捞出来了/i.test(t)) return true;
  if (/^(?:我直接|我先|我来|我会|我继续|我再|我现在|我马上|在跑了|开始做|继续|等我|我看一下|我查一下|我处理一下)/i.test(t) && t.length <= 220) {
    if (!/(?:已经完成|完成了|跑完了|成功|失败|验证通过|###\s*已完成|##\s*结论|总结版|结果是(?:[:：，,。]|\s|$)|当前总状态)/i.test(t)) return true;
  }
  if (/^(?:收到|好的|好|行|明白|可以|OK|ok)[，,。.!！\s]+/i.test(t) && t.length <= 260) {
    if (!/(?:已经完成|完成了|跑完了|成功|失败|验证通过|###\s*已完成|##\s*结论|总结版|结果是(?:[:：，,。]|\s|$)|当前总状态)/i.test(t)) return true;
  }
  const hasFinalSignal =
    /(?:结论|总结版|结果是(?:[:：，,。]|\s|$)|已完成|已经完成|完成了|完成：|跑完|成功|失败|验证通过|验收|最终|当前总状态|清单|方案|原因|问题|风险|剩余)/i.test(t) ||
    /(?:^|\s)(?:done|completed|success|failed|summary|result)(?:\s|$)/i.test(t);
  if (hasFinalSignal) return false;
  if (/^(?:我先|我来|我会|我直接|我继续|我再|我现在|我马上)\b/i.test(t) && t.length <= 180) return true;
  if (/^(?:收到|好的|好|行|明白|可以|OK|ok)[，,。.!！\s]+/i.test(t) && t.length <= 220) return true;
  if (/^(?:在跑了|开始做|继续|等我|我看一下|我查一下|我处理一下)/i.test(t) && t.length <= 160) return true;
  return false;
}

function pickMetadata(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (obj?.[key] != null) out[key] = obj[key];
  }
  return out;
}

function parseJsonEnvelope(raw) {
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

function compactObject(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value == null || value === "") continue;
    out[key] = value;
  }
  return out;
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/, 1)[0]?.slice(0, 300);
}

export function snapshotLiveTdb() {
  const db = path.join(LIVE_TDB_DIR, "vectors.db");
  const counts = querySqliteCounts(db);
  return {
    db,
    counts,
    files: listLiveFileStats(),
    checkedAt: new Date().toISOString(),
  };
}

export function querySqliteCounts(db) {
  if (!fs.existsSync(db)) return { l0: null, l1: null, error: "vectors.db missing" };
  const sql = "select 'l0', count(*) from l0_conversations union all select 'l1', count(*) from l1_records;";
  let result = spawnSync("sqlite3", [`file:${db}?mode=ro`, "-readonly", "-noheader", "-batch", sql], { encoding: "utf8" });
  if (result.status !== 0) {
    result = spawnSync("sqlite3", [sqliteReadOnlyUri(db), "-readonly", "-noheader", "-batch", sql], { encoding: "utf8" });
  }
  if (result.status !== 0) {
    return { l0: null, l1: null, error: (result.stderr || result.stdout || "sqlite3 failed").trim() };
  }
  const counts = { l0: 0, l1: 0 };
  for (const line of result.stdout.trim().split(/\r?\n/)) {
    if (!line) continue;
    const [key, value] = line.split("|");
    counts[key] = Number(value);
  }
  return counts;
}

export function sqliteReadOnlyUri(db) {
  return `file:${db}?mode=ro&immutable=1`;
}

export function queryShadowCounts(shadowDir) {
  const db = path.join(shadowDir, "vectors.db");
  return querySqliteCounts(db);
}

export function listLiveFileStats() {
  const stats = {};
  for (const sub of ["conversations", "records"]) {
    const dir = path.join(LIVE_TDB_DIR, sub);
    stats[sub] = {};
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        stats[sub][name] = { size: st.size, mtimeMs: st.mtimeMs };
      }
    } catch {
      stats[sub]._error = "missing";
    }
  }
  return stats;
}

export function compareLiveSnapshots(before, after) {
  return {
    countsUnchanged: JSON.stringify(before.counts) === JSON.stringify(after.counts),
    filesUnchanged: JSON.stringify(before.files) === JSON.stringify(after.files),
    beforeCounts: before.counts,
    afterCounts: after.counts,
  };
}

export function scanLiveForSeedKeys(sessionKeys) {
  const found = [];
  const keys = [...new Set(sessionKeys)].filter(Boolean);
  if (keys.length === 0) return found;
  for (const sub of ["conversations", "records"]) {
    const dir = path.join(LIVE_TDB_DIR, sub);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
    } catch {
      continue;
    }
    for (const file of files) {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        let obj = null;
        try {
          obj = JSON.parse(line);
        } catch {}
        for (const key of keys) {
          const fieldValues = [
            obj?.sessionKey,
            obj?.session_key,
            obj?.source_session,
            obj?.sourceSession,
            obj?.metadata?.sessionKey,
            obj?.metadata?.session_key,
          ].filter(Boolean);
          if (fieldValues.includes(key)) {
            found.push({ file: relativeToHome(file), lineNo: i + 1, sessionKey: key, matchKind: "session_field" });
          } else if (line.includes(key)) {
            found.push({ file: relativeToHome(file), lineNo: i + 1, sessionKey: key, matchKind: "content_mention" });
          }
        }
      }
    }
  }
  return found;
}

export async function readJson(file) {
  return JSON.parse(await fsp.readFile(expandHome(file), "utf8"));
}

export async function writeJson(file, data, mode) {
  const resolved = assertWritableTarget(file);
  await ensureDir(path.dirname(resolved));
  const finalMode = mode ?? 0o600;
  await fsp.writeFile(resolved, `${JSON.stringify(data, null, 2)}\n`, { mode: finalMode });
  await fsp.chmod(resolved, finalMode);
  return resolved;
}
