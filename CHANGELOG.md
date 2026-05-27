# Changelog

## v0.5.0

### New Tool

- Added `scripts/tdb-l1-dashboard.py` — a local web dashboard for monitoring L1 catch-up progress across months. Displays session completion status, L1/FTS/Vec counts, type distribution, and a live progress bar. Includes a **Resume Next Batch** button that triggers the next catch-up batch without typing a command. Auto-refreshes every 30 seconds. Python-only, no npm dependencies.

### Security and Safety

- Hardened generated private artifacts by writing seed inputs, audit reports, import SQL, JSONL sidecars, import summaries, import indexes, Mermaid state files, and import journals with owner-only permissions.
- Added early validation for fast L0 import `month` and `batch-id` arguments before live database queries run.
- Added a fast L0 import journal so interrupted imports can be inspected by phase: planned, SQLite committed, JSONL appended, and verification complete.
- Added a private JSONL sidecar for fast L0 live appends to make recovery and manual review easier after partial failures.

### Data Quality

- Changed cross-session duplicate normalized content handling from hard rejection to warning by default, preserving valid repeated history while still surfacing overlap.
- Added `--reject-batch-duplicates` for operators who explicitly want the previous hard-reject behavior.
- Fixed inventory `dirtyRatio` to use `dirtyCount`, and added `rejectedRatio` for reject-rate reporting.

### Tests

- Added coverage for private file permission repair, month validation, and cross-session duplicate warning behavior.
