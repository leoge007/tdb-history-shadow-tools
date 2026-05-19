#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const patterns = [
  "sk-[A-Za-z0-9_-]{20,}",
  "AIza[0-9A-Za-z_-]{20,}",
  "AKIA[0-9A-Z]{16}",
  "-----BEGIN [A-Z ]*PRIVATE KEY-----",
  "[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}",
  "/Users/[A-Za-z0-9._-]+",
  "TODO_PRIVATE_NAME",
  "TODO_PRIVATE_ID",
  "TODO_PRIVATE_DOMAIN",
  "192\.168\.",
  "119\.29\."
];

const tracked = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8"
});
if (tracked.status !== 0) {
  process.stderr.write(tracked.stderr || "git ls-files failed\n");
  process.exit(tracked.status || 1);
}

const files = tracked.stdout.split(/\r?\n/).filter(Boolean)
  .filter((file) => !file.startsWith(".git/"))
  .filter((file) => file !== "scripts/scan-secrets.mjs")
  .filter((file) => !file.endsWith(".db"))
  .filter((file) => !file.endsWith(".jsonl"));

const findings = [];
for (const file of files) {
  const full = path.join(root, file);
  let text;
  try {
    if (fs.statSync(full).size > 1_000_000) continue;
    text = fs.readFileSync(full, "utf8");
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of patterns) {
      const re = new RegExp(pattern, "i");
      if (re.test(line)) findings.push(file + ":" + (i + 1) + ": " + pattern);
    }
  }
}

if (findings.length) {
  console.error("Potential secret/privacy findings:");
  for (const finding of findings) console.error("- " + finding);
  process.exit(1);
}

console.log("No secret/privacy findings in git-visible files.");
