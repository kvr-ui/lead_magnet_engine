#!/usr/bin/env python3
"""
app.py  —  htmx + Tailwind web UI for the Bigin -> WATI CSV cleaner.

Standard library only. Reuses the cleaning logic from wati_cleanup.py and
serves HTML fragments that htmx swaps into the page.

State is per-browser (cookie session), so many people can use it at once
without clobbering each other. Sessions live in memory and are evicted
after SESSION_TTL of inactivity.

Config via environment:
    HOST   bind address   (default 127.0.0.1  — keep this behind a reverse proxy)
    PORT   bind port      (default 8000)

Run:
    python3 app.py
"""

import csv
import html
import io
import os
import re
import secrets
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from wati_cleanup import (
    WATI_HEADER,
    NAME_HINTS,
    LAST_NAME_HINTS,
    PHONE_HINTS,
    DEFAULT_COUNTRY_CODE,
    clean_phone,
    suggest_column,
)

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))

MAX_BODY = 50 * 1024 * 1024   # 50 MB upload cap
SESSION_TTL = 2 * 60 * 60     # evict idle sessions after 2h
MAX_SESSIONS = 500            # hard cap on concurrent sessions

esc = html.escape

# --------------------------------------------------------------------------- #
# per-browser sessions
# --------------------------------------------------------------------------- #
SESSIONS = {}          # sid -> session dict
LOCK = threading.Lock()


def new_session():
    return {
        "headers": [],
        "rows": [],
        "filters": [],     # list of {"col", "values": set, "mode"}
        "suppress": [],    # manually entered numbers to remove (cleaned, 10-digit)
        "total_in": 0,
        "files": {},       # filename -> csv text (for download)
        "last_seen": time.time(),
    }


def _evict(now):
    """Called under LOCK. Drop idle sessions, then cap total count."""
    stale = [k for k, v in SESSIONS.items() if now - v["last_seen"] > SESSION_TTL]
    for k in stale:
        del SESSIONS[k]
    if len(SESSIONS) > MAX_SESSIONS:
        for k in sorted(SESSIONS, key=lambda k: SESSIONS[k]["last_seen"])[:len(SESSIONS) - MAX_SESSIONS]:
            del SESSIONS[k]


# --------------------------------------------------------------------------- #
# core helpers
# --------------------------------------------------------------------------- #
def filtered_rows(sess):
    rows = sess["rows"]
    for f in sess["filters"]:
        col, vals, mode = f["col"], f["values"], f["mode"]
        keep = mode == "keep"
        rows = [r for r in rows if (((r.get(col) or "").strip() in vals) == keep)]
    return rows


def build_wati_rows(rows, name_cols, phone_col, country, suppress=None):
    """
    Like wati_cleanup.build_wati_rows, but also drops numbers in `suppress`
    (a manual do-not-contact list). Returns (good, skipped).
    """
    suppress = suppress or set()
    good, skipped, seen = [], [], set()
    for r in rows:
        name = " ".join((r.get(c) or "").strip() for c in name_cols).strip()
        phone = clean_phone(r.get(phone_col))
        if not phone:
            skipped.append({**r, "_skip_reason": "invalid/missing phone"})
            continue
        if phone in suppress:
            skipped.append({**r, "_skip_reason": "suppressed (manual)"})
            continue
        if phone in seen:
            skipped.append({**r, "_skip_reason": "duplicate phone"})
            continue
        seen.add(phone)
        good.append({
            "Name": name if name else "Contact",
            "CountryCode": country,
            "Phone": phone,
            "AllowCampaign": "True",
            "AllowSMS": "True",
        })
    return good, skipped


def parse_multipart(body, boundary):
    """Minimal multipart/form-data parser. Returns {name: bytes-or-str}."""
    result = {}
    delim = b"--" + boundary
    for part in body.split(delim):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        if b"\r\n\r\n" not in part:
            continue
        head, data = part.split(b"\r\n\r\n", 1)
        head_txt = head.decode("utf-8", "replace")
        m = re.search(r'name="([^"]*)"', head_txt)
        if not m:
            continue
        name = m.group(1)
        is_file = "filename=" in head_txt
        result[name] = data if is_file else data.decode("utf-8", "replace").strip()
    return result


def load_from_bytes(sess, raw):
    text = raw.decode("utf-8-sig", "replace")
    reader = csv.DictReader(io.StringIO(text))
    headers = [h for h in (reader.fieldnames or []) if h is not None]
    rows = [dict(r) for r in reader]
    sess.update(headers=headers, rows=rows, filters=[], suppress=[], total_in=len(rows), files={})


def to_csv(fields, records):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
    w.writeheader()
    w.writerows(records)
    return buf.getvalue()


# --------------------------------------------------------------------------- #
# HTML fragments
# --------------------------------------------------------------------------- #
def options(headers, selected=None, none_label=None):
    out = []
    if none_label is not None:
        out.append(f'<option value="">{esc(none_label)}</option>')
    for h in headers:
        sel = " selected" if h == selected else ""
        out.append(f'<option value="{esc(h)}"{sel}>{esc(h)}</option>')
    return "".join(out)


def workspace_fragment(sess):
    """Steps 2-4, rendered from current session. Swapped into #workspace."""
    headers = sess["headers"]
    if not headers:
        return ""
    name_s = suggest_column(headers, NAME_HINTS)
    last_s = suggest_column(headers, LAST_NAME_HINTS)
    phone_s = suggest_column(headers, PHONE_HINTS)

    return f"""
    <!-- STEP 2: filter -->
    <section class="rounded-xl border border-slate-700 bg-slate-800/60 p-5">
      <h2 class="mb-4 flex items-center gap-2 text-sm font-semibold tracking-wide">
        <span class="grid h-6 w-6 place-items-center rounded-full bg-sky-500 text-xs font-bold text-white">2</span>
        Filter contacts
        <span id="filter-count" class="ml-1 rounded-full border border-slate-600 bg-slate-900 px-2 py-0.5 text-xs text-slate-300">
          {len(filtered_rows(sess))} contacts
        </span>
      </h2>

      <div class="flex flex-wrap items-end gap-3">
        <div class="min-w-[220px] flex-1">
          <label class="mb-1 block text-xs text-slate-400">Field</label>
          <select name="col" class="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
                  hx-get="/filter-values" hx-target="#value-picker" hx-swap="innerHTML" hx-trigger="change">
            {options(headers)}
          </select>
        </div>
        <button class="rounded-lg bg-slate-700 px-4 py-2 text-sm font-semibold hover:bg-slate-600"
                hx-get="/filter-values" hx-include="previous select" hx-target="#value-picker" hx-swap="innerHTML">
          Load values
        </button>
      </div>

      <div id="value-picker" class="mt-4"></div>
      <div id="active-filters" class="mt-4">{active_filters_fragment(sess)}</div>
    </section>

    <!-- STEP 3 + 4: map / generate -->
    <form hx-post="/generate" hx-target="#result" hx-swap="innerHTML"
          class="rounded-xl border border-slate-700 bg-slate-800/60 p-5 space-y-4">
      <h2 class="flex items-center gap-2 text-sm font-semibold tracking-wide">
        <span class="grid h-6 w-6 place-items-center rounded-full bg-sky-500 text-xs font-bold text-white">3</span>
        Map columns &amp; generate
      </h2>

      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <label class="mb-1 block text-xs text-slate-400">Name column</label>
          <select name="name_col" class="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm">
            {options(headers, name_s)}
          </select>
        </div>
        <div>
          <label class="mb-1 block text-xs text-slate-400">Append (optional last name)</label>
          <select name="name_col2" class="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm">
            {options(headers, last_s, none_label="— none —")}
          </select>
        </div>
        <div>
          <label class="mb-1 block text-xs text-slate-400">Phone column</label>
          <select name="phone_col" class="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm">
            {options(headers, phone_s)}
          </select>
        </div>
        <div>
          <label class="mb-1 block text-xs text-slate-400">Country code</label>
          <input name="country" value="{DEFAULT_COUNTRY_CODE}"
                 class="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm">
        </div>
        <div>
          <label class="mb-1 block text-xs text-slate-400">Batch size</label>
          <select name="size" class="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm">
            <option value="100">100</option>
            <option value="250" selected>250</option>
            <option value="500">500</option>
          </select>
        </div>
      </div>

      <div>
        <label class="mb-1 block text-xs text-slate-400">
          Remove these numbers — type a number and click Add
        </label>
        <div class="flex gap-2" hx-on:htmx:after-request="this.querySelector('input[name=number]').value=''">
          <input name="number" placeholder="e.g. 9876543210 or +91 98765 43210"
                 class="flex-1 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 font-mono text-sm"
                 hx-post="/suppress-add" hx-include="this" hx-target="#suppress-chips" hx-swap="innerHTML"
                 hx-trigger="keyup[key=='Enter']">
          <button type="button"
                  class="rounded-lg bg-slate-700 px-4 py-2 text-sm font-semibold hover:bg-slate-600"
                  hx-post="/suppress-add" hx-include="previous input" hx-target="#suppress-chips" hx-swap="innerHTML">
            Add
          </button>
        </div>
        <div id="suppress-chips" class="mt-2">{suppress_chips_html(sess)}</div>
        <p class="mt-1 text-xs text-slate-500">
          Each number is cleaned the same way; any CSV contact matching one is dropped
          (shown as <span class="text-amber-400">suppressed</span> in the result &amp; skipped.csv).
        </p>
      </div>

      <p class="text-xs text-slate-400">
        Output: <code class="rounded bg-slate-900 px-1.5 py-0.5">Name,CountryCode,Phone,AllowCampaign,AllowSMS</code> —
        phones cleaned to 10-digit Indian numbers &amp; de-duplicated.
      </p>

      <button class="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-400">
        Generate WATI files
      </button>
    </form>

    <div id="result"></div>
    """


def suppress_chips_html(sess, error=None):
    """Renders the list of manually-added numbers as removable chips."""
    err = ""
    if error:
        err = f'<p class="mb-2 text-xs text-rose-400">{esc(error)}</p>'
    items = sess["suppress"]
    if not items:
        return err + '<p class="text-xs text-slate-500">No numbers added yet.</p>'
    chips = []
    for i, n in enumerate(items):
        chips.append(
            f'<span class="inline-flex items-center gap-1.5 rounded-full bg-slate-700 px-3 py-1 font-mono text-sm">'
            f'{esc(n)}'
            f'<button type="button" class="text-rose-400 hover:text-rose-300" title="remove"'
            f' hx-post="/suppress-remove?i={i}" hx-target="#suppress-chips" hx-swap="innerHTML">&times;</button>'
            f'</span>'
        )
    return err + '<div class="flex flex-wrap gap-2">' + "".join(chips) + '</div>'


def filter_values_fragment(sess, col):
    rows = filtered_rows(sess)
    counts = {}
    for r in rows:
        v = (r.get(col) or "").strip()
        counts[v] = counts.get(v, 0) + 1
    distinct = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0].lower()))

    boxes = []
    for v, c in distinct[:500]:
        shown = esc(v) if v != "" else "(blank)"
        boxes.append(f"""
          <label class="flex items-center gap-2 rounded px-2 py-1 hover:bg-slate-700/50">
            <input type="checkbox" name="values" value="{esc(v)}" class="accent-sky-500">
            <span class="text-sm">{shown}</span>
            <span class="ml-auto text-xs text-slate-500">{c}</span>
          </label>""")

    more = "" if len(distinct) <= 500 else f'<p class="p-2 text-xs text-amber-400">Showing first 500 of {len(distinct)} values.</p>'

    return f"""
    <form hx-post="/add-filter" hx-target="#workspace" hx-swap="innerHTML"
          class="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
      <input type="hidden" name="col" value="{esc(col)}">
      <div class="mb-2 flex flex-wrap items-center gap-3">
        <select name="mode" class="rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 text-sm">
          <option value="keep">Keep matching rows</option>
          <option value="remove">Remove matching rows</option>
        </select>
        <span class="text-xs text-slate-400">Field: <b>{esc(col)}</b> · {len(distinct)} distinct value(s)</span>
      </div>
      <div class="max-h-56 overflow-auto rounded border border-slate-700 p-1">
        {''.join(boxes)}{more}
      </div>
      <button class="mt-3 rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-400">
        Apply filter
      </button>
    </form>
    """


def active_filters_fragment(sess):
    if not sess["filters"]:
        return '<p class="text-sm text-slate-500">No filters applied.</p>'
    rows = []
    for i, f in enumerate(sess["filters"]):
        cls = "text-emerald-400" if f["mode"] == "keep" else "text-rose-400"
        label = "KEEP" if f["mode"] == "keep" else "REMOVE"
        vals = ", ".join((v if v != "" else "(blank)") for v in f["values"])
        rows.append(f"""
          <div class="flex items-center gap-2 border-b border-slate-700 py-2 last:border-0">
            <span class="flex-1 text-sm">
              <b class="{cls}">{label}</b> where <b>{esc(f['col'])}</b> ∈ {{{esc(vals)}}}
            </span>
            <button class="rounded bg-slate-700 px-2.5 py-1 text-xs hover:bg-slate-600"
                    hx-post="/remove-filter?i={i}" hx-target="#workspace" hx-swap="innerHTML">remove</button>
          </div>""")
    return "".join(rows)


def result_fragment(sess, name_cols, phone_col, country, size, suppress=None):
    suppress = suppress or set()
    good, skipped = build_wati_rows(filtered_rows(sess), name_cols, phone_col, country, suppress)
    n_suppressed = sum(1 for s in skipped if s.get("_skip_reason") == "suppressed (manual)")

    # batches -> store CSV text in the session
    sess["files"] = {}
    batches = []
    for i in range(0, len(good), size):
        chunk = good[i:i + size]
        fname = f"wati_batch_{i // size + 1}.csv"
        sess["files"][fname] = to_csv(WATI_HEADER, chunk)
        batches.append((fname, len(chunk)))
    if skipped:
        fields = list(skipped[0].keys())
        sess["files"]["skipped.csv"] = to_csv(fields, skipped)

    links = []
    for fname, n in batches:
        links.append(f'<li><a class="text-sky-400 hover:underline" href="/download/{fname}" download>{fname}</a> '
                     f'<span class="text-slate-500">({n})</span></li>')
    if skipped:
        links.append(f'<li><a class="text-sky-400 hover:underline" href="/download/skipped.csv" download>skipped.csv</a> '
                     f'<span class="text-amber-400">({len(skipped)})</span></li>')
    if not batches:
        links.append('<li class="text-slate-500">No valid contacts to write.</li>')

    # preview first batch
    prev = good[:50]
    head = "".join(f'<th class="px-2 py-1 text-left text-slate-400">{h}</th>' for h in WATI_HEADER)
    body = ""
    for r in prev:
        body += "<tr class='border-t border-slate-700'>" + "".join(
            f'<td class="px-2 py-1">{esc(str(r[h]))}</td>' for h in WATI_HEADER) + "</tr>"
    if not prev:
        body = '<tr><td colspan="5" class="px-2 py-2 text-slate-500">nothing to preview</td></tr>'

    def stat(k, v, color=""):
        return f'<div class="flex justify-between border-b border-dashed border-slate-700 py-1"><span class="text-slate-400">{k}</span><span class="font-bold {color}">{v}</span></div>'

    return f"""
    <section class="rounded-xl border border-emerald-700/50 bg-slate-800/60 p-5">
      <h2 class="mb-4 flex items-center gap-2 text-sm font-semibold tracking-wide">
        <span class="grid h-6 w-6 place-items-center rounded-full bg-emerald-500 text-xs font-bold text-white">✓</span>
        Result
      </h2>
      <div class="grid gap-6 sm:grid-cols-2">
        <div>
          {stat("Loaded from CSV", sess["total_in"])}
          {stat("After filtering", len(filtered_rows(sess)))}
          {stat("Suppressed (manual list)", n_suppressed, "text-amber-400")}
          {stat("Skipped (bad/dupe/suppressed)", len(skipped), "text-amber-400")}
          {stat("Valid WATI contacts", len(good), "text-emerald-400")}
          {stat("Batches", len(batches))}
        </div>
        <div>
          <p class="mb-1 text-xs text-slate-400">Download files</p>
          <ul class="ml-4 list-disc space-y-1 text-sm">{''.join(links)}</ul>
        </div>
      </div>
      <p class="mt-5 mb-1 text-xs text-slate-400">Preview — first valid batch</p>
      <div class="max-h-80 overflow-auto rounded-lg border border-slate-700">
        <table class="w-full text-sm"><thead class="bg-slate-900/60"><tr>{head}</tr></thead><tbody>{body}</tbody></table>
      </div>
    </section>
    """


PAGE = """<!DOCTYPE html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bigin → WATI cleaner</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/htmx.org@1.9.12"></script>
<script>tailwind.config = { darkMode: 'class' }</script>
</head>
<body class="min-h-screen bg-slate-900 text-slate-100">
  <header class="border-b border-slate-700 bg-gradient-to-b from-slate-800 to-slate-900 px-6 py-5">
    <h1 class="text-lg font-semibold">Bigin&nbsp;→&nbsp;WATI campaign CSV cleaner</h1>
    <p class="mt-1 text-sm text-slate-400">htmx + Tailwind · standard-library Python backend.</p>
  </header>

  <main class="mx-auto max-w-3xl space-y-5 p-6">
    <!-- STEP 1: upload -->
    <section class="rounded-xl border border-slate-700 bg-slate-800/60 p-5">
      <h2 class="mb-4 flex items-center gap-2 text-sm font-semibold tracking-wide">
        <span class="grid h-6 w-6 place-items-center rounded-full bg-sky-500 text-xs font-bold text-white">1</span>
        Load the Bigin export CSV
      </h2>
      <form hx-post="/upload" hx-target="#workspace" hx-swap="innerHTML"
            hx-encoding="multipart/form-data" class="flex flex-wrap items-center gap-3">
        <input type="file" name="file" accept=".csv" required
               class="text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-sky-500 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-sky-400">
        <button class="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-400">Load</button>
        <span class="htmx-indicator text-sm text-slate-400">loading…</span>
      </form>
    </section>

    <div id="workspace" class="space-y-5"></div>
  </main>
</body>
</html>"""


# --------------------------------------------------------------------------- #
# HTTP handler
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "watihttpd/1.0"

    def get_session(self):
        """Return this browser's session, creating one (and queuing a Set-Cookie) if needed."""
        sid = None
        for part in self.headers.get("Cookie", "").split(";"):
            part = part.strip()
            if part.startswith("sid="):
                sid = part[4:]
        now = time.time()
        with LOCK:
            if sid and sid in SESSIONS:
                SESSIONS[sid]["last_seen"] = now
                _evict(now)
                self._new_sid = None
                return SESSIONS[sid]
            sid = secrets.token_hex(16)
            sess = new_session()
            SESSIONS[sid] = sess
            _evict(now)
            self._new_sid = sid
            return sess

    def _send(self, body, ctype="text/html; charset=utf-8", status=200, extra=None):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if getattr(self, "_new_sid", None):
            self.send_header("Set-Cookie", f"sid={self._new_sid}; Path=/; HttpOnly; SameSite=Lax")
            self._new_sid = None
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length > MAX_BODY:
            return None
        return self.rfile.read(length) if length else b""

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path, qs = parsed.path, urllib.parse.parse_qs(parsed.query)

        if path == "/":
            self.get_session()  # ensures a cookie is set on first visit
            return self._send(PAGE)

        if path == "/health":
            return self._send("ok", ctype="text/plain")

        sess = self.get_session()

        if path == "/filter-values":
            col = (qs.get("col") or [""])[0]
            if col not in sess["headers"]:
                return self._send("")
            return self._send(filter_values_fragment(sess, col))

        if path.startswith("/download/"):
            name = urllib.parse.unquote(path[len("/download/"):])
            if name in sess["files"]:
                return self._send(sess["files"][name], ctype="text/csv; charset=utf-8",
                                  extra={"Content-Disposition": f'attachment; filename="{name}"'})
            return self._send("Not found", status=404, ctype="text/plain")

        return self._send("Not found", status=404, ctype="text/plain")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path, qs = parsed.path, urllib.parse.parse_qs(parsed.query)
        sess = self.get_session()
        body = self._body()
        if body is None:
            return self._send('<p class="text-rose-400">File too large (max 50 MB).</p>', status=413)
        ctype = self.headers.get("Content-Type", "")

        if path == "/upload":
            m = re.search(r"boundary=(.+)", ctype)
            if not m:
                return self._send('<p class="text-rose-400">Bad upload.</p>')
            fields = parse_multipart(body, m.group(1).strip().strip('"').encode())
            raw = fields.get("file")
            if not raw:
                return self._send('<p class="text-rose-400">No file received.</p>')
            load_from_bytes(sess, raw if isinstance(raw, bytes) else raw.encode())
            if not sess["headers"]:
                return self._send('<p class="text-rose-400">The file appears to be empty.</p>')
            return self._send(workspace_fragment(sess))

        form = urllib.parse.parse_qs(body.decode("utf-8", "replace"), keep_blank_values=True)

        if path == "/add-filter":
            col = (form.get("col") or [""])[0]
            mode = (form.get("mode") or ["keep"])[0]
            values = set(form.get("values") or [])
            if col in sess["headers"] and values:
                sess["filters"].append({"col": col, "values": values, "mode": mode})
            return self._send(workspace_fragment(sess))

        if path == "/suppress-add":
            raw = (form.get("number") or [""])[0]
            cleaned = clean_phone(raw)
            if not cleaned:
                return self._send(suppress_chips_html(sess,
                    error=f"'{raw.strip()}' is not a valid 10-digit Indian number." if raw.strip()
                    else "Enter a number first."))
            if cleaned in sess["suppress"]:
                return self._send(suppress_chips_html(sess, error=f"{cleaned} is already in the list."))
            sess["suppress"].append(cleaned)
            return self._send(suppress_chips_html(sess))

        if path == "/suppress-remove":
            i = int((qs.get("i") or ["-1"])[0])
            if 0 <= i < len(sess["suppress"]):
                sess["suppress"].pop(i)
            return self._send(suppress_chips_html(sess))

        if path == "/remove-filter":
            i = int((qs.get("i") or ["-1"])[0])
            if 0 <= i < len(sess["filters"]):
                sess["filters"].pop(i)
            return self._send(workspace_fragment(sess))

        if path == "/generate":
            name_col = (form.get("name_col") or [""])[0]
            name_col2 = (form.get("name_col2") or [""])[0]
            phone_col = (form.get("phone_col") or [""])[0]
            country = (form.get("country") or [DEFAULT_COUNTRY_CODE])[0].strip() or DEFAULT_COUNTRY_CODE
            try:
                size = max(1, int((form.get("size") or ["250"])[0]))
            except ValueError:
                size = 250
            name_cols = [name_col] + ([name_col2] if name_col2 and name_col2 != name_col else [])
            suppress = set(sess["suppress"])
            return self._send(result_fragment(sess, name_cols, phone_col, country, size, suppress))

        return self._send("Not found", status=404, ctype="text/plain")

    def log_message(self, *args):
        pass  # quiet


if __name__ == "__main__":
    print(f"Bigin -> WATI cleaner listening on http://{HOST}:{PORT}")
    print("Press Ctrl+C to stop.")
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
