# TDB History Shadow Tools

Shadow-only utilities for preparing, running, and auditing historical conversation backfills for TencentDB Agent Memory.

The tools are intentionally conservative:

- They build strict user/assistant rounds from local transcript exports.
- They write shadow output outside the live memory directory.
- They audit overlap, metadata leakage, suspicious memories, and live pollution.
- They never generate seed configs from a live OpenClaw config, because those configs may contain API keys.

## Safety Model

Do not commit real transcripts, generated seed inputs, run logs, SQLite databases, seed configs, or shadow output. The repository .gitignore blocks the common dangerous paths and file types, but you should still run:

~~~bash
npm run scan:secrets
~~~

before every commit.

## Environment

Defaults can be overridden with environment variables:

~~~bash
export OPENCLAW_STATE_DIR="$HOME/.openclaw"
export TDB_HISTORY_WORKSPACE="$PWD"
export TDB_HISTORY_TMP="$PWD/tmp/tdb-history"
export TDB_SHADOW_ROOT="$HOME/.openclaw/tmp/tdb-shadow-seed"
export TDB_HISTORY_MONTHS="2026-02,2026-03,2026-04"
~~~

## Workflow

1. Inventory local transcripts:

~~~bash
node src/tdb-history-inventory.mjs --output tmp/tdb-history/inventory.json
~~~

2. Build a strict seed input:

~~~bash
node src/tdb-seed-input-builder.mjs \
  --inventory tmp/tdb-history/inventory.json \
  --month 2026-04 \
  --batch-size 300 \
  --batch-index 1 \
  --batch-id batch-001
~~~

3. Run shadow seed with an explicit local config:

~~~bash
node src/tdb-shadow-seed-runner.mjs \
  --input tmp/tdb-history/inputs/2026-04-batch-001.json \
  --month 2026-04 \
  --batch-id batch-001 \
  --config /path/outside/repo/seed-config.json
~~~

4. Audit the shadow output:

~~~bash
node src/tdb-shadow-audit.mjs \
  --shadow-dir "$HOME/.openclaw/tmp/tdb-shadow-seed/2026-04/batch-001" \
  --input tmp/tdb-history/inputs/2026-04-batch-001.json
~~~

## Stop Conditions

Stop a backfill run when any audit shows:

- system/developer/tool envelope contamination
- source-key or normalized-content overlap after namespacing
- suspicious L1 memories
- live memory session-key pollution
- a high missing-embedding rate
- clustered LLM extraction failures
- fallback execution when official CLI execution is required

## What Is Not Included

This repo intentionally does not include:

- real transcript files
- real seed inputs
- generated audits from private data
- SQLite memory databases
- OpenClaw config files
- API keys or provider endpoints
