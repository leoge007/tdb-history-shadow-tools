#!/usr/bin/env python3
"""
TDB L1 Catch-up Dashboard
Serving on http://localhost:7842

Reads:
  - ~/.openclaw/workspace/tmp/tdb-history/l1-catchup-runs/<month>-progress.json
  - ~/.openclaw/memory-tdai/vectors.db (read-only)

Actions:
  - POST /resume?month=2026-04  →  trigger next batch via node script
"""

import http.server, json, pathlib, subprocess, urllib.parse, sqlite3
from pathlib import Path

PORT = 7842
WORKSPACE = Path.home() / ".openclaw/workspace"
PROGRESS_DIR = WORKSPACE / "tmp/tdb-history/l1-catchup-runs"
DB_PATH = Path.home() / ".openclaw/memory-tdai/vectors.db"
MONTHS = ["2026-02", "2026-03", "2026-04", "2026-05"]

STYLE = """
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
       background: #0d1117; color: #e6edf3; min-height: 100vh; padding: 24px; }
h1 { font-size: 18px; color: #58a6ff; margin-bottom: 20px; }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em;
     color: #8b949e; margin: 20px 0 10px; }
.month-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px;
              padding: 16px; margin-bottom: 16px; max-width: 720px; }
.month-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.month-name { font-size: 16px; font-weight: 600; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; }
.badge-done    { background: #238636; color: #fff; }
.badge-running { background: #a37100; color: #fff; }
.badge-queued  { background: #30363d; color: #8b949e; }
.badge-idle    { background: #21262d; color: #484f58; }
.stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
          gap: 8px; margin-bottom: 14px; }
.stat { background: #0d1117; border: 1px solid #21262d; border-radius: 6px; padding: 10px 12px; }
.stat-label { font-size: 10px; color: #8b949e; text-transform: uppercase; letter-spacing: .05em; }
.stat-value { font-size: 20px; font-weight: 700; color: #e6edf3; margin-top: 3px; }
.stat-value.green { color: #3fb950; }
.stat-value.blue  { color: #58a6ff; }
.progress-bar { background: #21262d; border-radius: 4px; height: 6px;
                 overflow: hidden; margin-bottom: 14px; }
.progress-fill { background: linear-gradient(90deg, #238636, #3fb950); height: 100%;
                 border-radius: 4px; transition: width .6s ease; }
.sessions { display: flex; flex-direction: column; gap: 3px;
             max-height: 280px; overflow-y: auto; }
.sessions::-webkit-scrollbar { width: 4px; }
.sessions::-webkit-scrollbar-thumb { background: #30363d; border-radius: 2px; }
.session-row { display: flex; align-items: center; gap: 8px; padding: 4px 8px;
                border-radius: 4px; font-size: 12px; font-family: 'SF Mono', monospace; }
.session-row.done    { color: #3fb950; background: rgba(35,134,54,.1); }
.session-row.running { background: rgba(163,113,0,.15); color: #d29922; }
.session-row.queued  { color: #6e7681; }
.icon { flex-shrink: 0; width: 14px; text-align: center; }
.session-key { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-pct { font-size: 11px; color: #6e7681; white-space: nowrap; }
.controls { margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap; }
button { padding: 7px 16px; border-radius: 6px; border: 1px solid #30363d;
          cursor: pointer; font-size: 13px; transition: background .15s; }
button.primary   { background: #238636; color: #fff; border-color: #238636; }
button.primary:hover { background: #2ea043; }
button.secondary  { background: #21262d; color: #c9d1d9; }
button.secondary:hover { background: #30363d; }
button:disabled  { opacity: .4; cursor: default; }
.msg { font-size: 12px; padding: 8px 12px; border-radius: 6px; margin-top: 10px;
       font-family: monospace; }
.msg-ok    { background: #0d2818; color: #3fb950; }
.msg-error { background: #2d1515; color: #f85149; }
.msg-info  { background: #1c2a3a; color: #58a6ff; }
.footer { margin-top: 28px; font-size: 11px; color: #484f58; }
.l1-types { font-size: 11px; color: #8b949e; margin-top: 4px; }
"""


def get_state():
    months = {}
    for month in MONTHS:
        pf = PROGRESS_DIR / f"{month}-progress.json"
        sessions = []
        l1 = fts = vec = 0
        types = {}
        if pf.exists():
            try:
                d = json.loads(pf.read_text())
                for k, v in d.get("sessions", {}).items():
                    offset = v.get("nextOffset", 0)
                    total = v.get("totalL0", 0) or 0
                    done = bool(v.get("completed"))
                    sessions.append({
                        "key": k, "offset": offset, "total": total,
                        "done": done, "running": not done and offset > 0
                    })
            except Exception:
                pass
        if DB_PATH.exists():
            try:
                con = sqlite3.connect(str(DB_PATH))
                cur = con.cursor()
                for col, var in [("count(*)", "l1"),
                                 ("count(*)", "fts"),
                                 ("count(*)", "vec")]:
                    if var == "fts":
                        cur.execute(
                            "SELECT COUNT(*) FROM l1_records r JOIN l1_fts f ON f.record_id=r.record_id "
                            "WHERE r.session_key LIKE ?", (f"%seed:{month}%",))
                    elif var == "vec":
                        cur.execute(
                            "SELECT COUNT(*) FROM l1_records r JOIN l1_vec_rowids v ON v.id=r.record_id "
                            "WHERE r.session_key LIKE ?", (f"%seed:{month}%",))
                    else:
                        cur.execute(
                            "SELECT COUNT(*) FROM l1_records WHERE session_key LIKE ?",
                            (f"%seed:{month}%",))
                    locals()[var] = cur.fetchone()[0]
                cur.execute(
                    "SELECT type, COUNT(*) FROM l1_records WHERE session_key LIKE ? GROUP BY type",
                    (f"%seed:{month}%",))
                types = dict(cur.fetchall())
                con.close()
            except Exception:
                pass
        completed = sum(1 for s in sessions if s["done"])
        running   = sum(1 for s in sessions if s["running"])
        queued    = len(sessions) - completed - running
        sessions.sort(key=lambda x: (x["done"], -(x["offset"] or 0)))
        months[month] = {
            "sessions": sessions,
            "l1": l1, "fts": fts, "vec": vec,
            "completed": completed, "running": running, "queued": queued,
            "remaining": max(0, len(sessions) - completed - running),
            "types": types,
        }
    return months


def render_html(state):
    html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>TDB L1 Dashboard</title><style>{STYLE}</style></head>
<body><h1>🔥 TDB L1 Catch-up Dashboard</h1>"""
    for month, m in state.items():
        done = m["completed"]; running = m["running"]
        total = done + running + m["queued"]
        pct = round(done / total * 100) if total else 0
        badge_cls = "badge-done" if running == 0 and done == total and total > 0 \
            else ("badge-running" if running > 0 else "badge-idle")
        badge_txt = "Done" if running == 0 and done == total and total > 0 \
            else ("Running" if running > 0 else ("Queued" if m["remaining"] > 0 else "Idle"))
        types_str = "  ".join(f"{k}:{v}" for k, v in sorted(m["types"].items()))
        html += f"""
<div class="month-card">
  <div class="month-header">
    <span class="month-name">{month}</span>
    <span class="badge {badge_cls}">{badge_txt}</span>
    <span style="margin-left:auto;font-size:12px;color:#6e7681">
      {done}/{total} sessions &nbsp;|&nbsp; {pct}% &nbsp;|&nbsp; L1={m['l1']} &nbsp;|&nbsp; <span id="ts-{month}"></span>
    </span>
  </div>
  <div class="stats">
    <div class="stat"><div class="stat-label">Sessions Done</div><div class="stat-value green">{done}</div></div>
    <div class="stat"><div class="stat-label">In Progress</div><div class="stat-value blue">{running}</div></div>
    <div class="stat"><div class="stat-label">Remaining</div><div class="stat-value">{m['remaining']}</div></div>
    <div class="stat"><div class="stat-label">L1 Stored</div><div class="stat-value">{m['l1']}</div></div>
    <div class="stat"><div class="stat-label">FTS Covered</div><div class="stat-value green">{m['fts']}</div></div>
    <div class="stat"><div class="stat-label">Vec Covered</div><div class="stat-value green">{m['vec']}</div></div>
  </div>
  <div class="progress-bar"><div class="progress-fill" style="width:{pct}%"></div></div>"""
        if types_str:
            html += f'<div class="l1-types">L1 types: {types_str}</div>'
        html += '<div class="sessions">'
        for s in m["sessions"]:
            cls = "done" if s["done"] else ("running" if s["running"] else "queued")
            icon = "✅" if s["done"] else ("🔄" if s["running"] else "⬜")
            pct_str = f"{s['offset']}/{s['total']}" if s["total"] else ""
            html += f'<div class="session-row {cls}">'
            html += f'<span class="icon">{icon}</span>'
            html += f'<span class="session-key" title="{s["key"]}">{s["key"]}</span>'
            html += f'<span class="session-pct">{pct_str}</span>'
            html += '</div>'
        html += '</div>'
        html += '<div class="controls">'
        if m["remaining"] > 0:
            html += f'<button class="primary" id="btn-{month}" onclick="resume(\'{month}\')">▶ Resume Next Batch</button>'
        html += '<button class="secondary" onclick="location.reload()">🔄 Refresh</button>'
        html += '</div>'
        html += f'<div id="msg-{month}"></div>'
        html += '</div>'
    html += """
<div class="footer">
  Auto-refreshes every 30s &nbsp;|&nbsp;
  <a href="/" style="color:#58a6ff;text-decoration:none">Refresh now</a>
</div>
<script>
function showMsg(id, text, type) {
  document.getElementById(id).innerHTML = '<div class="msg msg-' + type + '">' + text + '</div>';
  if (type !== 'error') setTimeout(() => location.reload(), 2500);
}
async function resume(month) {
  const btn = document.getElementById('btn-' + month);
  btn.disabled = true; btn.textContent = '⏳ Starting...';
  try {
    const r = await fetch('/resume?month=' + encodeURIComponent(month), {method:'POST'});
    const t = await r.text();
    if (r.ok) { showMsg('msg-'+month, '✅ Triggered — watch terminal/log', 'ok'); }
    else       { showMsg('msg-'+month, '❌ ' + t, 'error'); btn.disabled = false; }
  } catch(e) { showMsg('msg-'+month, '❌ ' + e.message, 'error'); btn.disabled = false; }
}
async function load() { location.reload(); }
function updateTime() { document.querySelectorAll('span[id^="ts-"]').forEach(el => { el.textContent = new Date().toLocaleTimeString(); }); }
function autoReload() { location.reload(); }
updateTime();
setInterval(updateTime, 1000);
setInterval(autoReload, 30000);
</script>
</body></html>"""
    return html


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/" or self.path.startswith("/index"):
            state = get_state()
            body = render_html(state).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path.startswith("/api/state"):
            state = get_state()
            body = json.dumps({"months": state}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path.startswith("/resume"):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            month = qs.get("month", [""])[0]
            self.send_response(200)
            self.send_header("Content-type", "text/plain")
            self.end_headers()
            cmd = [
                "node", "--import",
                str(Path.home() / ".openclaw/npm/node_modules/tsx/dist/loader.mjs"),
                str(WORKSPACE / "scripts/tdb-history/tdb-l1-catchup-existing-l0.mjs"),
                "--month", month,
                "--max-sessions", "20",
                "--max-chunks", "20",
                "--chunk-size", "20",
                "--bg-size", "5",
                "--apply",
            ]
            subprocess.Popen(cmd, cwd=str(WORKSPACE),
                             stdout=open("/dev/null","w"), stderr=open("/dev/null","w"))
            self.wfile.write(b"OK")
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, fmt, *args): pass


if __name__ == "__main__":
    print(f"TDB L1 Dashboard → http://localhost:{PORT}")
    srv = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
    srv.serve_forever()
