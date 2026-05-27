# TDB History Shadow Tools

[English introduction](#tdb-history-shadow-tools) | [中文说明](#中文说明)

Utilities for safely preparing, running, and auditing historical conversation backfills for TencentDB Agent Memory.

This repository is built for teams that already use TencentDB Agent Memory as an agent memory layer and want to import older conversation transcripts without blindly polluting the live memory database. It focuses on a staged workflow: build clean seed inputs, run the official seed command into an isolated shadow output directory, audit the result, then feed the audited input into the live TencentDB Agent Memory capture path when you explicitly choose to do so.

This project is not TencentDB Agent Memory itself. It is an operational toolchain around TencentDB Agent Memory's seed workflow.

**Required prerequisite:** the host OpenClaw runtime must already expose the TencentDB Agent Memory seed CLI:

~~~bash
openclaw memory-tdai --help
openclaw memory-tdai seed --help
~~~

If those commands are unavailable, install/upgrade/fix the OpenClaw plugin registration layer first. This repository does not patch OpenClaw or bundle private registration fixes.

## OpenClaw Large-History Focus

The first-class use case is adapting **large OpenClaw historical conversation archives** for TencentDB Agent Memory.

OpenClaw can accumulate a large number of agent/session transcript JSONL files over time: direct chats, channel conversations, agent sessions, long-running task sessions, tool-heavy turns, and reset/archive sidecars. Those records are useful for memory backfill, but they are not safe to feed directly into a memory seed pipeline.

This project is specifically designed for that situation:

- many months of OpenClaw transcript history
- thousands to tens of thousands of messages
- multiple agents and session files
- repeated local message IDs across sessions
- mixed user/assistant/tool/system records
- untrusted channel metadata and delivery envelopes
- large batch processing that must be resumable and auditable

The tools convert that historical OpenClaw-style data into strict TencentDB Agent Memory seed inputs, run the seed process in shadow mode, and audit the result before any live-memory decision is considered.

It can be adapted to other transcript sources, but its original design target is not a small generic importer. It is an operational safety layer for **large-scale OpenClaw history backfill into TencentDB Agent Memory**.

## What This Solves

TencentDB Agent Memory can capture and extract memory from ongoing agent conversations. Historical transcripts are harder:

- old transcripts may contain system prompts, tool outputs, channel metadata, or untrusted envelopes
- local message IDs may repeat across sessions
- duplicate content can create fake overlap or noisy memory records
- seed runs can accidentally write to a live memory directory if paths are wrong
- generated seed configs may contain API keys if copied from a live runtime config
- large historical imports need batch-level stop conditions, not blind all-in execution

This toolchain addresses those risks with a conservative workflow:

- inventory transcript files by month and source
- clean and normalize user/assistant messages
- build strict user/assistant rounds for TencentDB Agent Memory seed input
- namespace source keys to reduce cross-session false overlap
- run seed output into a shadow directory
- audit L0/L1 counts, L1 types, overlap, suspicious records, FTS coverage, embedding coverage, and live pollution
- optionally feed audited batches into live TencentDB Agent Memory via its capture API
- verify that live L0/L1 records appeared under the expected seed session keys
- keep generated private data out of Git


## v0.4 L0-first Fast Import + Externalized Import State

The live backfill workflow remains intentionally L0-first, and v0.4 adds lightweight externalized import state for faster resume/review:

```text
prepare seed input -> import L0 rows -> verify L0 delta -> let TencentDB Agent Memory build L1/L2/L3 later
```

Use this when historical inputs are already cleaned into TencentDB-compatible seed batches and you want a lightweight live import without waiting for the full seed pipeline.

```bash
node src/tdb-fast-l0-import.mjs --month 2026-04 --batch-id batch-003          # dry-run
node src/tdb-fast-l0-import.mjs --month 2026-04 --batch-id batch-003 --execute # live L0 import with guardrails
```

The direct importer writes only the L0 surfaces needed for baseline verification:

- `conversations/YYYY-MM-DD.jsonl`
- `l0_conversations`
- `l0_fts`

It deliberately does **not** write L1/L2/L3/persona records, does not run promotion, and does not wait for memory extraction. TencentDB Agent Memory remains responsible for its own higher-level memory pipeline.

The importer requires an accepted-batch manifest under `tmp/tdb-history/live-runs/<month>-accepted-batches.json` and verifies each batch by L0 delta:

```text
expected capture-equivalent L0 == after live L0 - before live L0
```

If the baseline is misaligned or duplicate rows already exist, it stops before writing.

v0.4 also emits non-live sidecar artifacts for every dry-run / execute / accept-existing path:

- `tmp/tdb-history/offload/<month>-<batchId>.import-summary.jsonl` — per-row import summary with stable record IDs and hashes.
- `tmp/tdb-history/mmds/<month>.mmd` — Mermaid batch canvas for month-level progress/state review.
- `tmp/tdb-history/import-index.json` — compact month/batch index for O(1) status lookup.

These artifacts are operational state only. They do not modify live TencentDB Agent Memory L1/L2/L3/persona records and do not replace live SQLite guardrails.

## L1 Catch-up Dashboard

For ongoing L1 catch-up runs over large existing L0 bases (e.g. thousands of sessions across multiple months), the `tdb-l1-dashboard.py` script provides a local web UI so you can monitor progress and resume interrupted batches without relying on terminal output.

### Starting the dashboard

```bash
python3 scripts/tdb-l1-dashboard.py
# → TDB L1 Dashboard → http://localhost:7842
```

No npm dependencies required. Requires only Python 3 and a readable `vectors.db`.

### What it shows

For each tracked month, the dashboard displays:

- **Sessions Done / In Progress / Remaining** — per-month session completion breakdown
- **L1 / FTS / Vec counts** — live from the database
- **L1 type distribution** — episodic / instruction / persona breakdown
- **Progress bar** — percentage of completed sessions
- **Session list** — ✅ done / 🔄 running / ⬜ queued with offset details
- **▶ Resume Next Batch button** — triggers the next batch without typing a command

The page auto-refreshes every 30 seconds.

### Resuming a batch

If a run is interrupted, open the dashboard and click **▶ Resume Next Batch** for that month. The button fires the same batch parameters that were in use (max-sessions=20, max-chunks=20, chunk-size=20, bg-size=5, --apply) and the runner resumes from its checkpoint (recorded in `<month>-progress.json`).

```bash
# Manual equivalent of the Resume button:
node --import ~/.openclaw/npm/node_modules/tsx/dist/loader.mjs \
  scripts/tdb-history/tdb-l1-catchup-existing-l0.mjs \
  --month 2026-04 \
  --max-sessions 20 --max-chunks 20 --chunk-size 20 --bg-size 5 \
  --apply
```

### Environment variables

The dashboard reads the same environment variables as the other tools:

```bash
# Default paths (override if your workspace differs)
export OPENCLAW_STATE_DIR="$HOME/.openclaw"
export TDB_HISTORY_WORKSPACE="$PWD"
export TDB_HISTORY_TMP="$PWD/tmp/tdb-history"

python3 scripts/tdb-l1-dashboard.py
```

The dashboard is **read-only** against the database and progress files. It does not modify any records.

## Product Target

Primary target:

- TencentDB Agent Memory
- Specifically, its historical seed flow and local memory artifacts such as L0 conversations, L1 records, FTS, and vector indexes.

Typical host environment:

- OpenClaw or another agent runtime using TencentDB Agent Memory
- Local transcript files in JSONL format
- A working openclaw memory-tdai seed command or equivalent TencentDB Agent Memory seed CLI
- SQLite available for audit checks

The code has OpenClaw-oriented adapters because it was first built around OpenClaw transcript layouts. The privacy boundary is intentionally strict: real transcripts and real generated seed outputs are not included in this repository.

## OpenClaw CLI Prerequisite

This repository does not patch OpenClaw itself.

It assumes the host environment already exposes a working TencentDB Agent Memory seed command, for example:

~~~bash
openclaw memory-tdai --help
openclaw memory-tdai seed --help
~~~

If those commands are unavailable, fix or upgrade the OpenClaw / plugin registration layer first. This toolchain intentionally does not include private local OpenClaw dist patches, plugin registration fixes, or fallback runtime imports.

## Repository Contents

- src/tdb-history-inventory.mjs: scans local transcript files and creates a month/session inventory.
- src/tdb-seed-input-builder.mjs: builds strict TencentDB Agent Memory seed input JSON from the inventory.
- src/tdb-shadow-seed-runner.mjs: runs the official seed command into a shadow output directory. It requires an explicit --config and never generates config from live OpenClaw state.
- src/tdb-shadow-audit.mjs: audits shadow output and generates a Markdown report.
- src/tdb-history-shadow.mjs: optional one-command wrapper for inventory → input → shadow seed → audit.
- src/tdb-live-seed-runner.mjs: feeds an already-audited input batch into the live TencentDB Agent Memory capture API. It requires --yes-live.
- src/tdb-live-verify.mjs: verifies live L0/L1 rows, L1 types, embedding coverage, and FTS coverage for a seeded month.
- src/tdb-capture-equivalent.mjs: mirrors TencentDB L0 capture sanitization for expected-L0 planning.
- src/tdb-fast-l0-import.mjs: L0-first live importer with baseline/delta guardrails.
- src/tdb-history-lib.mjs: shared cleaning, parsing, dedupe, audit, and safety helpers.
- scripts/scan-secrets.mjs: lightweight pre-commit safety scan for common secret and privacy leaks.
- examples/minimal-inventory.json: fake sample data only. No real transcript data is included.

## Safety Model

This repository contains tooling only. Keep all real runtime data, generated artifacts, and local configuration out of Git.

Before every commit, run:

~~~bash
npm run scan:secrets
~~~

The scan is intentionally lightweight. For sensitive deployments, also run your own organization-specific secret scanner before publishing.

## Important Security Decisions

1. Seed config must be explicit

tdb-shadow-seed-runner.mjs requires --config.

It does not read a live OpenClaw config and does not generate seed config automatically, because live memory configs often contain LLM provider keys, embedding keys, base URLs, and private model routing details.

2. Shadow output must not be live output

The runner refuses to write into the live TencentDB Agent Memory directory. Use a separate shadow path such as:

~~~bash
$HOME/.openclaw/tmp/tdb-shadow-seed/2026-04/batch-001
~~~

3. Live import is a separate explicit step

Live import is never part of shadow validation. Use either the official live seed runner or the L0-first direct importer with explicit live flags. The L0-first importer only writes L0 JSONL/SQLite/FTS surfaces and leaves L1/L2/L3/persona generation to TencentDB Agent Memory.

4. Inputs are private by default

Seed input JSON files are derived from real transcripts and should be treated as private data. Do not commit them.

5. Audits may still be private

Audit reports can contain scene names, excerpts, memory content, and operational details. Treat generated audits as private unless separately redacted.

6. No fallback runtime is bundled

The public version only calls the official CLI path. It does not include local fallback code that imports a private local plugin checkout.

## Installation

Clone the repo:

~~~bash
git clone https://github.com/<owner>/tdb-history-shadow-tools.git
cd tdb-history-shadow-tools
~~~

Check Node.js:

~~~bash
node --version
~~~

Node.js 20 or newer is recommended.

No npm dependencies are required for the current scripts.

## Environment Variables

Defaults can be overridden:

~~~bash
export OPENCLAW_STATE_DIR="$HOME/.openclaw"
export TDB_HISTORY_WORKSPACE="$PWD"
export TDB_HISTORY_TMP="$PWD/tmp/tdb-history"
export TDB_SHADOW_ROOT="$HOME/.openclaw/tmp/tdb-shadow-seed"
export TDB_HISTORY_MONTHS="2026-02,2026-03,2026-04"
~~~

Meaning:

- OPENCLAW_STATE_DIR: root for local OpenClaw-style state
- TDB_HISTORY_WORKSPACE: workspace root for generated inventory/input/audit files
- TDB_HISTORY_TMP: generated working directory
- TDB_SHADOW_ROOT: shadow seed output root
- TDB_HISTORY_MONTHS: optional comma-separated month allowlist for inventory reports

## End-to-End Workflow

### One-command shadow run

Use the wrapper when you want the standard sequence in one command:

~~~bash
tdb-history-shadow run \
  --month 2026-04 \
  --batch-size 300 \
  --batch-index 1 \
  --config /secure/local/path/seed-config.json
~~~

Use `--dry-run` to print the planned commands without executing them.

### 1. Inventory transcripts

~~~bash
node src/tdb-history-inventory.mjs \
  --output tmp/tdb-history/inventory.json
~~~

This scans supported transcript sources and writes an inventory grouped by month/session.

### 2. Build one batch of strict seed input

~~~bash
node src/tdb-seed-input-builder.mjs \
  --inventory tmp/tdb-history/inventory.json \
  --month 2026-04 \
  --batch-size 300 \
  --batch-index 1 \
  --batch-id batch-001
~~~

Output:

- tmp/tdb-history/inputs/2026-04-batch-001.json
- tmp/tdb-history/inputs/2026-04-batch-001.rejects.jsonl

The input contains strict conversation rounds. Rejects explain what was filtered out.
Cross-session duplicate normalized content is recorded as a warning by default, not dropped. Use
`--reject-batch-duplicates` only when you explicitly want cross-session duplicates removed from a
batch.

### 3. Run TencentDB Agent Memory seed in shadow mode

Prepare a seed config outside this repo, then run:

~~~bash
node src/tdb-shadow-seed-runner.mjs \
  --input tmp/tdb-history/inputs/2026-04-batch-001.json \
  --month 2026-04 \
  --batch-id batch-001 \
  --config /secure/local/path/seed-config.json
~~~

Expected behavior:

- calls openclaw memory-tdai seed
- writes output under TDB_SHADOW_ROOT
- records live-before/live-after snapshots
- refuses to reuse an output directory that already contains seed artifacts
- writes run summary into the shadow output directory

### 4. Audit the shadow output

~~~bash
node src/tdb-shadow-audit.mjs \
  --shadow-dir "$HOME/.openclaw/tmp/tdb-shadow-seed/2026-04/batch-001" \
  --input tmp/tdb-history/inputs/2026-04-batch-001.json
~~~

The audit checks:

- input message counts
- strict round counts
- duplicate source keys
- normalized content overlap
- metadata/system envelope leakage
- L0 and L1 row counts
- L1 type distribution
- suspicious L1 content
- live session-key pollution
- LLM extraction warnings
- embedding warnings
- FTS/vector coverage where available

### 5. Repeat by batch

For a 300-round batch size:

~~~bash
node src/tdb-seed-input-builder.mjs \
  --inventory tmp/tdb-history/inventory.json \
  --month 2026-04 \
  --batch-size 300 \
  --batch-index 2 \
  --batch-id batch-002
~~~

Continue until the selected month has no more strict rounds.

### 6. Feed an audited batch into live TencentDB Agent Memory

After the shadow audit passes, feed the same audited input into the live TDB capture path:

~~~bash
node src/tdb-live-seed-runner.mjs \
  --input tmp/tdb-history/inputs/2026-04-batch-001.json \
  --month 2026-04 \
  --batch-id batch-001 \
  --gateway-url http://127.0.0.1:8420 \
  --yes-live
~~~

This is the final "make TDB use it" step. It sends the cleaned historical user/assistant rounds to TencentDB Agent Memory's live capture API. It does not manually promote L1 records and does not replace TDB's own memory pipeline.

### 7. Verify the live import

~~~bash
node src/tdb-live-verify.mjs --month 2026-04
~~~

Expected result:

- live L0 rows exist for session keys ending in `:seed:2026-04`
- live L1 rows exist for the same month
- L1 FTS coverage matches L1 row count when the FTS table is available
- missing L1 embeddings are visible in the summary

## Batch Strategy

Recommended defaults:

- batch size: 300 clean strict rounds
- process one month at a time
- run audit after every batch
- stop immediately on audit failure
- generate a month-level aggregate summary before any live action

A good month-level summary should include:

- clean strict round coverage
- batch count
- L0 total
- L1 total
- L1 type distribution
- overlap summary
- suspicious L1 summary
- live pollution summary
- LLM warning summary
- embedding/FTS coverage summary
- final go/no-go verdict for continuing shadow-only backfill

## Stop Conditions

Stop the workflow if any batch shows:

- system/developer/tool metadata contamination
- untrusted envelope leakage in L1
- source-key overlap after namespacing
- normalized content overlap with previous accepted batches
- suspicious L1 records
- live memory session-key pollution
- official seed CLI failure
- unexpected fallback execution
- clustered LLM extraction failures
- materially high missing-embedding rate
- seed output written to a live memory directory
- live capture API failure
- live verification returns zero L0 or zero L1 rows after a live import

## Operational Notes

### Source keys

Historical transcripts often have local message IDs that repeat across sessions. A safe source key should include source identity and session identity, not just a local message ID.

Good shape:

~~~text
agent:<agent-id>:<session-id>:message_id:<message-id>
~~~

Bad shape:

~~~text
message_id:<message-id>
~~~

### FTS versus vector coverage

A missing embedding does not always mean a missing memory record. Check both:

- L1 record count
- L1 FTS count
- L1 vector row count

If FTS is complete but vector coverage has a small scattered gap, keyword recall may still work while semantic recall is partially degraded.

### Generated configs

Do not store real seed configs in this repo. Keep generated local configuration outside the repository.

## FAQ

### Is this a replacement for TencentDB Agent Memory?

No. It is a companion toolchain for historical backfill operations around TencentDB Agent Memory.

### Does this write to live memory?

The shadow runner does not. The live runner does, but only when called separately with --yes-live. The live runner uses TencentDB Agent Memory's capture API; it does not copy shadow databases into live storage.

### Can I publish generated audit reports?

Usually no. Audit reports may contain private memory text. Redact them first.

### Can this support non-OpenClaw transcript layouts?

Yes, but adapters may need to be added. The current code includes OpenClaw-oriented source detection and normalization.

### Why not auto-read OpenClaw config?

Because live configs may contain secrets. The public tool requires an explicit seed config path.

### Can I run the whole month at once?

You can, but you should not. Batch the month, audit after each batch, and stop on failures.

---

# 中文说明

## 这个仓库是做什么的

这个仓库是一套围绕 TencentDB Agent Memory 的历史对话回填工具。

它不是 TencentDB Agent Memory 本体，而是帮助你把旧的 agent 对话记录整理成 TencentDB Agent Memory seed 输入，先在隔离 shadow 目录里跑一遍、审计质量；通过后，再把同一份已审计 input 喂进 live TencentDB Agent Memory capture pipeline。

核心目标是：把历史记忆回填做得可审计、可暂停、可回滚；只有通过审计的数据才进入 live TDB。

**使用前提：**运行环境必须已经能调用 TencentDB Agent Memory 的 seed CLI：

~~~bash
openclaw memory-tdai --help
openclaw memory-tdai seed --help
~~~

如果这两个命令不可用，需要先安装、升级或修复 OpenClaw 的插件注册层。这个仓库不修改 OpenClaw 本体，也不内置私有注册修补代码。

## 针对 OpenClaw 超大历史对话记录

这个工具的第一目标场景，是把 **OpenClaw 长期积累的大规模历史对话记录** 适配成 TencentDB Agent Memory 可安全 seed 的输入。

OpenClaw 的历史记录通常不是干净的“用户一句、助手一句”：

- 有大量 agent/session JSONL 文件
- 有 direct chat、channel、agent task、长任务会话等不同来源
- 有工具调用、系统消息、外部频道 metadata、delivery envelope
- 有 reset/archive sidecar
- 不同 session 里的局部 message ID 可能重复
- 单月可能有几千到几万条消息

这些数据有价值，但不能直接喂给 TencentDB Agent Memory。直接导入会有污染 live memory、重复写入、错误 overlap、系统提示词进入记忆、API 配置泄漏等风险。

所以这个仓库做的是一层安全适配：

1. 扫描 OpenClaw 历史 transcript
2. 清洗出严格 user/assistant rounds
3. 给 sourceKey 加 session/source 命名空间
4. 按月份和批次生成 seed input
5. 先跑 shadow seed，不写 live
6. 审计 L0/L1、污染、重复、overlap、embedding/FTS 覆盖
7. 通过审计后，用 live runner 把已清洗 rounds 发送到 TDB live capture API
8. 再验证 live L0/L1 是否按 seed session key 出现

它可以扩展到别的 transcript 来源，但原始设计目标不是“小型通用 JSONL 导入器”，而是 **OpenClaw 超大历史记录到 TencentDB Agent Memory 的安全 shadow backfill 工具链**。

## 适用场景

适合这些情况：

- 你已经在用 TencentDB Agent Memory 做 agent 记忆
- 你手里有大量历史 conversation transcript
- 你想把历史数据喂给 TDB 的 seed pipeline
- 你不想一上来就写 live memory
- 你需要按月、按批次审计 L0/L1 产出质量
- 你担心历史数据里有系统提示词、工具输出、聊天元数据、重复消息或隐私泄漏
- 你需要在质量门通过后，把历史数据真正喂进 TencentDB Agent Memory live 候选池

不适合这些情况：

- 你想跳过 shadow 审计，直接把所有历史数据一次性写进 live
- 你没有 TencentDB Agent Memory seed CLI
- 你不准备做人工审计
- 你想把真实 transcript、seed input、audit 直接开源

## OpenClaw CLI 前提

这个仓库不修改 OpenClaw 本体。

它假设你的运行环境里已经有可用的 TencentDB Agent Memory seed 命令，例如：

~~~bash
openclaw memory-tdai --help
openclaw memory-tdai seed --help
~~~

如果这两个命令不可用，需要先修复或升级 OpenClaw / 插件注册层。这个工具链不会包含私有的 OpenClaw dist patch、插件注册修补，或本机 fallback runtime import。

## 安全原则

这个仓库只放工具代码。真实运行数据、生成产物和本地配置不要进入 Git。

每次提交前运行：

~~~bash
npm run scan:secrets
~~~

如需公开发布，再额外使用自己的隐私词表或组织级 secret scanner 复查。

## 工具组成

- tdb-history-inventory.mjs：扫描历史 transcript，按月份和 session 建 inventory
- tdb-seed-input-builder.mjs：从 inventory 构建严格 user/assistant round 的 seed input
- tdb-shadow-seed-runner.mjs：调用官方 seed CLI，把结果写到 shadow 目录
- tdb-shadow-audit.mjs：审计 shadow 输出质量
- tdb-history-shadow.mjs：可选的一键入口，串起 inventory → input → shadow seed → audit
- tdb-live-seed-runner.mjs：把已通过审计的 input 喂给 live TencentDB Agent Memory capture API
- tdb-live-verify.mjs：检查 live L0/L1、L1 类型、embedding 和 FTS 覆盖
- tdb-history-lib.mjs：共享的清洗、去重、解析和审计逻辑
- scan-secrets.mjs：提交前安全扫描

## 推荐使用流程

### 一键 shadow run

标准流程可以直接用一个命令串起来：

~~~bash
tdb-history-shadow run \
  --month 2026-04 \
  --batch-size 300 \
  --batch-index 1 \
  --config /secure/local/path/seed-config.json
~~~

想先看计划、不执行，就加 `--dry-run`。

### 1. 生成 inventory

~~~bash
node src/tdb-history-inventory.mjs \
  --output tmp/tdb-history/inventory.json
~~~

### 2. 构建某个月的某一批 seed input

~~~bash
node src/tdb-seed-input-builder.mjs \
  --inventory tmp/tdb-history/inventory.json \
  --month 2026-04 \
  --batch-size 300 \
  --batch-index 1 \
  --batch-id batch-001
~~~

建议每批 300 个 clean strict rounds。最后不足 300 的尾批照常处理。

### 3. shadow-only 跑 seed

~~~bash
node src/tdb-shadow-seed-runner.mjs \
  --input tmp/tdb-history/inputs/2026-04-batch-001.json \
  --month 2026-04 \
  --batch-id batch-001 \
  --config /secure/local/path/seed-config.json
~~~

注意：

- 必须显式传 --config
- 工具不会自动读取 live OpenClaw config
- 这样是为了避免把 API key 写进仓库或产物

### 4. 审计结果

~~~bash
node src/tdb-shadow-audit.mjs \
  --shadow-dir "$HOME/.openclaw/tmp/tdb-shadow-seed/2026-04/batch-001" \
  --input tmp/tdb-history/inputs/2026-04-batch-001.json
~~~

重点看：

- L0 行数
- L1 行数
- L1 类型分布
- 是否有 metadata/system noise
- 是否有 suspicious L1
- 是否有 live session-key 污染
- 是否有 overlap
- embedding/FTS 覆盖情况
- LLM extraction warning 是否集中爆发

### 5. 通过审计后喂给 live TDB

~~~bash
node src/tdb-live-seed-runner.mjs \
  --input tmp/tdb-history/inputs/2026-04-batch-001.json \
  --month 2026-04 \
  --batch-id batch-001 \
  --gateway-url http://127.0.0.1:8420 \
  --yes-live
~~~

这一步才是“让 TDB 用起来”。

它不是把 shadow DB 迁移过去，也不是手工挑 L1。它是把已经清洗过、审计通过的历史 user/assistant rounds 重新送进 TencentDB Agent Memory 的 live capture API，由 TDB 自己完成 L0 记录、L1 抽取、scene/persona 更新和 recall 索引。

### 6. 验证 live 是否吃进去

~~~bash
node src/tdb-live-verify.mjs --month 2026-04
~~~

重点看：

- live L0 是否出现 `:seed:2026-04` session key
- live L1 是否出现同月记录
- L1 FTS 是否覆盖同月 L1
- L1 embedding 缺失率是否可接受

## L1 回填可视化看板

在跑 L1 catch-up 时（已有大量 L0 待抽取），`tdb-l1-dashboard.py` 提供一个本地 Web 页面来监控进度和恢复中断的批次。

### 启动看板

```bash
python3 scripts/tdb-l1-dashboard.py
# → TDB L1 Dashboard → http://localhost:7842
```

无需 npm 依赖，只依赖 Python 3 和可读的 `vectors.db`。

### 看板内容

每个月份显示：

- **Sessions Done / In Progress / Remaining** — 该月 session 完成情况
- **L1 / FTS / Vec 计数** — 实时从数据库读
- **L1 类型分布** — episodic / instruction / persona
- **进度条** — 已完成 session 百分比
- **Session 列表** — ✅ 完成 / 🔄 处理中 / ⬜ 排队，含 offset 明细
- **▶ Resume Next Batch 按钮** — 点一下触发下一批，不需要敲命令

页面每 30 秒自动刷新。

### 恢复中断的批次

运行中断后，打开看板，点对应月份的 **▶ Resume Next Batch** 即可继续。

runner 会从 checkpoint（`<month>-progress.json`）自动恢复，不需要重新跑整批。

```bash
# 手动等效命令（看板按钮背后就是这个）：
node --import ~/.openclaw/npm/node_modules/tsx/dist/loader.mjs \
  scripts/tdb-history/tdb-l1-catchup-existing-l0.mjs \
  --month 2026-04 \
  --max-sessions 20 --max-chunks 20 --chunk-size 20 --bg-size 5 \
  --apply
```

### 环境变量

看板读取与其他工具相同的环境变量：

```bash
export OPENCLAW_STATE_DIR="$HOME/.openclaw"
export TDB_HISTORY_WORKSPACE="$PWD"
export TDB_HISTORY_TMP="$PWD/tmp/tdb-history"

python3 scripts/tdb-l1-dashboard.py
```

看板**只读**数据库和 progress 文件，不会写入任何记录。

## 停机线

出现以下情况就停，不要继续跑后续批次：

- 系统提示词、developer message、tool output 进入 L1
- untrusted metadata 或聊天 envelope 进入 L1
- source key overlap
- normalized content overlap
- suspicious L1 > 0
- live memory 里出现 seed session key
- official seed CLI 失败
- LLM extraction failure 集中爆发
- missing embedding rate 明显过高
- shadow output 写到了 live memory 目录
- live capture API 失败
- live 导入后 L0 或 L1 仍然是 0

## 批量处理建议

推荐顺序：

1. 先跑一个小批次
2. 审计通过后扩大到整月
3. 每批 seed 后立刻 audit
4. 一个自然月跑完后生成 aggregate summary
5. 质量门通过后，用 live runner 按批次喂给 TDB
6. 每批 live 后立刻 verify

不要跳过 shadow 审计；但审计通过后，不需要再搞一套手工 promotion，直接走 live runner。

## 一句话总结

TDB History Shadow Tools 是一套给 TencentDB Agent Memory 历史记忆回填用的安全操作工具。它不替代 TDB，也不接管 TDB 的 L1/recall/晋升逻辑；它负责把历史数据清洗、审计，然后用 live capture API 喂给 TDB，让 TDB 自己继续跑记忆 pipeline。
