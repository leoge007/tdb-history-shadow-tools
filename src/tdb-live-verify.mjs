#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  LIVE_TDB_DIR,
  expandHome,
  parseArgs,
  sqliteReadOnlyUri,
} from "./tdb-history-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const month = String(args.month || "");
if (!/^\d{4}-\d{2}$/.test(month)) {
  console.error("Usage: node src/tdb-live-verify.mjs --month 2026-04 [--db ~/.openclaw/memory-tdai/vectors.db]");
  process.exit(2);
}

const db = path.resolve(expandHome(args.db || path.join(LIVE_TDB_DIR, "vectors.db")));
if (!fs.existsSync(db)) throw new Error(`vectors.db not found: ${db}`);

const like = `%:seed:${month}`;
const l0 = queryOne(db, "select count(*) from l0_conversations where session_key like ?;", [like]);
const l1 = queryOne(db, "select count(*) from l1_records where session_key like ?;", [like]);
const l1Types = queryRows(db, "select coalesce(type,'unknown'), count(*) from l1_records where session_key like ? group by coalesce(type,'unknown') order by 2 desc;", [like]);
const l1MissingEmbeddings = columnExists(db, "l1_records", "embedding")
  ? queryOne(db, "select count(*) from l1_records where session_key like ? and (embedding is null or length(embedding)=0);", [like])
  : null;
const fts = tableExists(db, "l1_records_fts")
  ? queryOne(db, "select count(*) from l1_records_fts where rowid in (select rowid from l1_records where session_key like ?);", [like])
  : null;

const summary = {
  month,
  db,
  l0,
  l1,
  l1Types: Object.fromEntries(l1Types.map(([type, count]) => [type, Number(count)])),
  l1MissingEmbeddings,
  l1FtsRows: fts,
  passed: l0 > 0 && l1 > 0 && (fts == null || fts === l1),
};

console.log(JSON.stringify(summary, null, 2));
if (!summary.passed) process.exit(1);

function queryOne(dbPath, sql, params = []) {
  const rows = queryRows(dbPath, sql, params);
  return Number(rows[0]?.[0] || 0);
}

function queryRows(dbPath, sql, params = []) {
  const rendered = renderSql(sql, params);
  const result = spawnSync("sqlite3", [sqliteReadOnlyUri(dbPath), "-readonly", "-noheader", "-batch", rendered], { encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "sqlite3 failed").trim());
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => line.split("|"));
}

function tableExists(dbPath, name) {
  return queryOne(dbPath, "select count(*) from sqlite_master where type='table' and name=?;", [name]) > 0;
}

function columnExists(dbPath, table, column) {
  const result = spawnSync("sqlite3", [sqliteReadOnlyUri(dbPath), "-readonly", "-noheader", "-batch", `pragma table_info(${quoteIdent(table)});`], { encoding: "utf8" });
  if (result.status !== 0) return false;
  return result.stdout.split(/\r?\n/).some((line) => line.split("|")[1] === column);
}

function renderSql(sql, params) {
  let i = 0;
  return sql.replace(/\?/g, () => quoteSql(params[i++]));
}

function quoteSql(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteIdent(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid SQL identifier: ${value}`);
  return value;
}
