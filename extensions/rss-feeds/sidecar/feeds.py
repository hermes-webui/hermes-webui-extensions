"""Feeds — RSS/Atom subscription panel for the WebUI.

Token-free by default: fetching, parsing, and reading feeds never invokes
the LLM. Summarization is a separate explicit user action that posts to
/api/feeds/summarize.

Storage: SQLite at STATE_DIR/feeds.db. Two tables:
  feeds(id PK, category, name, url UNIQUE, enabled, fetch_interval_minutes,
        last_fetched_at, last_status, last_error, consecutive_failures,
        created_at, updated_at)
  entries(id PK, feed_id FK, guid, title, link, summary, published_at,
          fetched_at, UNIQUE(feed_id, guid))

Routes wired from api/routes.py:
  GET    /api/feeds                  → list feeds (with last-status counts)
  POST   /api/feeds                  → create feed {name, url, category?}
  PATCH  /api/feeds/{id}             → update feed (enable/disable, name, etc)
  DELETE /api/feeds/{id}             → delete feed + its entries
  GET    /api/feeds/entries          → list entries (?feed_id=, ?category=,
                                       ?limit=, ?since=)
  POST   /api/feeds/refresh          → refresh all (or {feed_ids: [...]})
  POST   /api/feeds/summarize        → summarize body {scope, target, model?}
                                       where scope ∈ {entry, feed, category,
                                       all} — only this endpoint uses tokens

Naming convention follows the rest of the suite: no `rss_` prefix, no
TypeScript camelCase carry-over from the reference scripts at tests/RSS/.
"""
from __future__ import annotations

import hashlib
import html
import http.client
import ipaddress
import json
import logging
import os
import re
import socket
import sqlite3
import ssl
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as _ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

from shim import STATE_DIR
from shim import j


logger = logging.getLogger(__name__)

_FEEDS_DB = STATE_DIR / "feeds.db"
_USER_AGENT = (
    # A realistic browser UA — the old "compatible; Hermes-WebUI-Feeds" string
    # got 403'd by several publishers (Politico, etc.).
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
_FETCH_TIMEOUT = 10        # per-feed socket timeout
_REFRESH_WORKERS = 8       # parallel fetches; servers tolerate a few in-flight
_MAX_ENTRIES_PER_FETCH = 80
_MAX_FEED_BYTES = 5 * 1024 * 1024   # cap per-feed response so one huge/hostile feed can't OOM us
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")

# Bundled seed list — populated from tests/RSS/RSSfeed.txt on first load.
# Path is relative to this file so it travels with the webui submodule.
_SEED_FILE = (
    __import__("pathlib").Path(__file__).parent / "feeds_seed.txt"
)
_URL_RE = re.compile(r"(https?://\S+)")

# ── Summarize: FREE-ONLY backends ──────────────────────────────────────────
# Primary = local ollama at localhost:11434 (set up your own port-forward if remote).
# Fallback = an OpenRouter ':free' model ($0). NEVER a paid endpoint. The
# active profile's paid model is intentionally NOT used here.
_OLLAMA_URL = "http://127.0.0.1:11434/api/generate"
_OLLAMA_MODEL = "qwen2.5:14b"  # heavier local model — better synthesis for news

# Summary-model config (persisted in feed_settings.summary_config, editable from
# the RSS settings gear). `backend`: auto (local→openrouter→gemini) | local |
# openrouter | gemini. `local` hits ollama at local_port directly.
_DEFAULT_SUMMARY_CONFIG = {
    "backend": "auto",
    "ollama_model": _OLLAMA_MODEL,
    "local_port": 11434,
}
_SUMMARY_BACKENDS = {"auto", "local", "openrouter", "gemini"}


def _normalize_summary_config(raw) -> dict:
    cfg = dict(_DEFAULT_SUMMARY_CONFIG)
    if isinstance(raw, dict):
        b = str(raw.get("backend", "")).strip().lower()
        if b in _SUMMARY_BACKENDS:
            cfg["backend"] = b
        if str(raw.get("ollama_model", "")).strip():
            cfg["ollama_model"] = str(raw["ollama_model"]).strip()[:120]
        try:
            p = int(raw.get("local_port", cfg["local_port"]))
            if 1 <= p <= 65535:
                cfg["local_port"] = p
        except (TypeError, ValueError):
            pass
    return cfg
_OLLAMA_TIMEOUT = 240          # 14b on a full article can take a while; it's a bg job
# Full-article fetch (local, free) so the model summarizes the REAL article, not
# the 1-line RSS teaser. Best-effort; falls back to the snippet on any failure.
_ARTICLE_TIMEOUT = 12
_ARTICLE_MAX_BYTES = 3 * 1024 * 1024
_ARTICLE_MAX_CHARS = 8000
# Cap every model-backend / API response read so a hostile or oversized peer
# can't exhaust memory (summaries are small text; 2 MiB is generous).
_MODEL_RESP_BYTES = 2 * 1024 * 1024


def _read_capped(resp, max_bytes: int) -> bytes:
    """Read at most ``max_bytes`` from a response, raising if the peer exceeds it.
    Shared by every backend/redirect read so no path does an unbounded resp.read()."""
    body = resp.read(max_bytes + 1)
    if len(body) > max_bytes:
        raise ValueError(f"response exceeds {max_bytes} byte cap")
    return body
_OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
_OPENROUTER_MODEL = "meta-llama/llama-3.3-70b-instruct:free"
_OPENROUTER_TIMEOUT = 90


def _openrouter_key() -> str | None:
    """OPENROUTER_API_KEY from the PROCESS ENVIRONMENT only. We deliberately do
    NOT read ~/.hermes/.env or any other file — the sidecar declares
    filesystem.arbitrary:false, so credentials must be supplied via the
    environment (e.g. an EnvironmentFile= on the systemd unit, the operator's
    choice). Returns None if absent."""
    k = os.environ.get("OPENROUTER_API_KEY")
    return k.strip() if k else None


def _port_open(host: str, port: int, timeout: float = 0.6) -> bool:
    import socket
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


def _ollama_summarize(prompt: str, model: str = None, local_port: int = 11434) -> str:
    """Call the local ollama generate endpoint. Raises on any failure."""
    payload = json.dumps({
        "model": model or _OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.3},
    }).encode("utf-8")
    url = f"http://127.0.0.1:{local_port}/api/generate"
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=_OLLAMA_TIMEOUT) as resp:
        data = json.loads(_read_capped(resp, _MODEL_RESP_BYTES).decode("utf-8"))
    out = (data.get("response") or "").strip()
    if not out:
        raise RuntimeError("ollama returned empty response")
    return out


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow redirects on a credentialed request — otherwise urllib
    re-sends the Authorization header to the redirect target (another origin),
    leaking the API key."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_NOREDIR_OPENER = urllib.request.build_opener(_NoRedirect())


def _openrouter_summarize(prompt: str) -> str:
    """Fallback: OpenRouter ':free' model. Raises if no key or on failure."""
    key = _openrouter_key()
    if not key:
        raise RuntimeError("no OPENROUTER_API_KEY for fallback")
    payload = json.dumps({
        "model": _OPENROUTER_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.3,
    }).encode("utf-8")
    req = urllib.request.Request(
        _OPENROUTER_URL, data=payload, method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
            # OpenRouter asks for these for free-tier attribution.
            "HTTP-Referer": "https://hermes-webui.local",
            "X-Title": "Hermes WebUI RSS",
        },
    )
    with _NOREDIR_OPENER.open(req, timeout=_OPENROUTER_TIMEOUT) as resp:
        data = json.loads(_read_capped(resp, _MODEL_RESP_BYTES).decode("utf-8"))
    out = (data.get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
    if not out:
        raise RuntimeError("openrouter returned empty response")
    return out


_GEMINI_MODEL = "gemini-2.5-flash"  # free tier — third fallback, independent of the ollama Mac


def _gemini_key() -> str | None:
    """GEMINI_API_KEY / GOOGLE_API_KEY from the PROCESS ENVIRONMENT only (see
    _openrouter_key — no file reads, keeps filesystem.arbitrary:false honest)."""
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        k = os.environ.get(name)
        if k:
            return k.strip()
    return None


def _gemini_summarize(prompt: str) -> str:
    """Fallback: Google Gemini free tier (no dependency on the local ollama Mac).
    Raises if no key or on failure."""
    key = _gemini_key()
    if not key:
        raise RuntimeError("no GEMINI_API_KEY for fallback")
    # Key goes in the x-goog-api-key header on a fixed URL — never in the query
    # string (which lands in logs/referers/history).
    url = ("https://generativelanguage.googleapis.com/v1beta/models/"
           + _GEMINI_MODEL + ":generateContent")
    payload = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.3},
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload, method="POST",
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
    )
    with _NOREDIR_OPENER.open(req, timeout=_OPENROUTER_TIMEOUT) as resp:
        data = json.loads(_read_capped(resp, _MODEL_RESP_BYTES).decode("utf-8"))
    try:
        out = (data["candidates"][0]["content"]["parts"][0]["text"] or "").strip()
    except Exception:
        out = ""
    if not out:
        raise RuntimeError("gemini returned empty response")
    return out


def _local_summarize(prompt: str, cfg: dict) -> tuple[str, str]:
    """Local model via ollama at the configured local_port (no auto-tunnel; set
    up your own port-forward if the model runs on another host)."""
    model = cfg.get("ollama_model") or _OLLAMA_MODEL
    return _ollama_summarize(prompt, model=model, local_port=int(cfg.get("local_port", 11434))), \
        model + " (local)"


def _summarize_llm(prompt: str) -> tuple[str, str]:
    """Summarize with the user-chosen backend (RSS settings → Summary model):
      - local:      only the local model (ollama at local_port) — raises if down
      - openrouter: only the OpenRouter ':free' model
      - gemini:     only Gemini free
      - auto:       local → OpenRouter → Gemini (resilient default)
    Returns (content, model_label)."""
    try:
        cfg = _normalize_summary_config(get_settings().get("summary_config"))
    except Exception:
        cfg = dict(_DEFAULT_SUMMARY_CONFIG)
    backend = cfg.get("backend", "auto")

    if backend == "local":
        return _local_summarize(prompt, cfg)
    if backend == "openrouter":
        return _openrouter_summarize(prompt), _OPENROUTER_MODEL + " (openrouter free)"
    if backend == "gemini":
        return _gemini_summarize(prompt), _GEMINI_MODEL + " (gemini free)"

    # auto: local → openrouter → gemini
    errs = []
    try:
        return _local_summarize(prompt, cfg)
    except Exception as e:
        errs.append(f"local: {e}")
    try:
        return _openrouter_summarize(prompt), _OPENROUTER_MODEL + " (openrouter free)"
    except Exception as e:
        errs.append(f"openrouter: {e}")
    try:
        return _gemini_summarize(prompt), _GEMINI_MODEL + " (gemini free)"
    except Exception as e:
        errs.append(f"gemini: {e}")
    raise RuntimeError("all summarizers failed — " + "; ".join(errs))


def _summary_status() -> dict:
    """Cheap live snapshot for the RSS-settings 'Summary model' section: the
    persisted config plus reachability probes (port check, ollama model list,
    API-key presence — NO LLM call) so the UI can show which backend/model a
    Summarize would actually use right now."""
    try:
        cfg = _normalize_summary_config(get_settings().get("summary_config"))
    except Exception:
        cfg = dict(_DEFAULT_SUMMARY_CONFIG)
    lp = int(cfg.get("local_port", 11434))
    model = cfg.get("ollama_model") or _OLLAMA_MODEL
    port_open = _port_open("127.0.0.1", lp)
    model_present = None  # unknown unless we can list ollama tags
    models: list[str] = []  # every model installed on the local ollama
    if port_open:
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{lp}/api/tags")
            with urllib.request.urlopen(req, timeout=3) as resp:
                tags = [m.get("name", "") for m in
                        json.loads(_read_capped(resp, _MODEL_RESP_BYTES).decode("utf-8")).get("models", [])]
            models = sorted(t for t in tags if t)
            model_present = any(t == model or t.split(":")[0] == model for t in tags)
        except Exception:
            model_present = None
    path = f"localhost:{lp}" + (" (ollama)" if port_open else " (not running)")
    local = {
        "model": model, "local_port": lp,
        "path": path, "models": models,
        "port_open": port_open, "model_present": model_present,
    }
    orouter = {"model": _OPENROUTER_MODEL, "key": bool(_openrouter_key())}
    gem = {"model": _GEMINI_MODEL, "key": bool(_gemini_key())}
    backend = cfg.get("backend", "auto")
    # Predict which backend a summarize would use RIGHT NOW (auto = same
    # fallback order as _summarize_llm).
    if backend == "local":
        active = {"backend": "local", "model": model,
                  "ok": port_open and model_present is not False}
    elif backend == "openrouter":
        active = {"backend": "openrouter", "model": _OPENROUTER_MODEL, "ok": orouter["key"]}
    elif backend == "gemini":
        active = {"backend": "gemini", "model": _GEMINI_MODEL, "ok": gem["key"]}
    elif port_open and model_present is not False:
        active = {"backend": "local", "model": model, "ok": True}
    elif orouter["key"]:
        active = {"backend": "openrouter", "model": _OPENROUTER_MODEL, "ok": True}
    elif gem["key"]:
        active = {"backend": "gemini", "model": _GEMINI_MODEL, "ok": True}
    else:
        active = {"backend": None, "model": None, "ok": False}
    return {"config": cfg, "local": local, "openrouter": orouter,
            "gemini": gem, "active": active}


_BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
_BLOCK_TAGS_RE = re.compile(
    r"(?is)<(script|style|noscript|svg|head|nav|footer|aside|form|figure)[^>]*>.*?</\1>")
_P_BLOCK_RE = re.compile(r"(?is)<(p|h1|h2|h3|li|blockquote)[^>]*>(.*?)</\1>")
_TAG_RE = re.compile(r"(?s)<[^>]+>")


def _html_to_text(htmltext: str) -> str | None:
    """Strip HTML → readable article text (no LLM, free). Extracts paragraph/
    heading blocks; picks the LARGEST <article> region (pages often have several
    small teaser <article>s plus the real one) and falls back to the whole
    document, then a full tag strip. Returns None if too thin to be an article."""
    t = _BLOCK_TAGS_RE.sub(" ", htmltext)

    def _extract(region: str) -> str:
        chunks: list[str] = []
        for _tag, inner in _P_BLOCK_RE.findall(region):
            txt = _WHITESPACE_RE.sub(" ", html.unescape(_TAG_RE.sub(" ", inner))).strip()
            if len(txt) >= 40:              # skip nav crumbs / share widgets
                chunks.append(txt)
        return "\n".join(chunks)

    # Best of all <article> regions (by extracted length), not just the first.
    best = ""
    for m in re.finditer(r"(?is)<article[^>]*>(.*?)</article>", t):
        x = _extract(m.group(1))
        if len(x) > len(best):
            best = x
    # If no article region produced enough, try the whole (block-stripped) doc.
    if len(best) < 200:
        x = _extract(t)
        if len(x) > len(best):
            best = x
    # Last resort: strip every tag from the whole doc.
    if len(best) < 200:
        best = _WHITESPACE_RE.sub(" ", html.unescape(_TAG_RE.sub(" ", t))).strip()

    text = best.strip()
    if len(text) < 200:
        return None
    return text[:_ARTICLE_MAX_CHARS]


def _fetch_article_text(url: str) -> str | None:
    """Best-effort local fetch of an article's readable text. Reuses the feed
    SSRF guard + redirect re-validation. Returns None on any failure (caller
    then falls back to the RSS snippet)."""
    if not url:
        return None
    try:
        _status, hdrs, raw = _safe_fetch(url, {
            "User-Agent": _BROWSER_UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }, _ARTICLE_TIMEOUT, _ARTICLE_MAX_BYTES, truncate=True)
        ctype = (hdrs.get("content-type") or "").lower()
        if "html" not in ctype and "text" not in ctype and ctype:
            return None
        return _html_to_text(raw.decode("utf-8", "replace"))
    except Exception as e:
        logger.info("article fetch failed for %s: %s", url, e)
        return None


# News-editor system rules — shared by single + digest prompts. The anti-
# hallucination + adaptive-length guidance is the whole point: a thin source
# must NOT be padded with invented context.
_SUMMARY_RULES = (
    "You are a careful news editor. Summarize for a reader who hasn't seen the source.\n"
    "STRICT RULES:\n"
    "- Use ONLY facts stated in the provided text. Do NOT add background, context, "
    "analysis, or anything not in the text. If a detail isn't stated, leave it out.\n"
    "- Never speculate, infer motives, or invent quotes/numbers. Keep names, "
    "figures, dates, places and direct quotes EXACTLY as written.\n"
    "- Be concrete: capture the who / what / when / where / why that ARE present.\n"
    "- Plain English, neutral tone, no editorializing, no preamble, no marketing fluff.\n"
)


def _build_summary_prompt(entries: list[dict], scope: str) -> str:
    """Build the LLM prompt. Single-article: fetch the FULL article text (local)
    and summarize that, not the teaser. Digest: use the (longer) RSS snippets."""
    if len(entries) == 1:
        e = entries[0]
        title = e.get("title") or "(untitled)"
        feed = e.get("feed_name") or "?"
        snippet = e.get("summary") or ""
        full = _fetch_article_text(e.get("link") or "")
        body = full or snippet
        thin = not full and len(snippet) < 200
        lines = [
            _SUMMARY_RULES,
            "- Lead with a 1-sentence TL;DR of the single most important point.",
            "- Then 2-5 bullets of the concrete key facts — only as many as the "
            "text genuinely supports. Do NOT pad to reach a number.",
        ]
        if thin:
            lines.append(
                "- The source below is very short. Output ONLY a 1-2 sentence "
                "factual summary of what it states. Do not add bullets or detail "
                "that isn't there.")
        lines += ["", f"ARTICLE TITLE: {title}", f"SOURCE: {feed}", "", "ARTICLE TEXT:", body]
        return "\n".join(lines)

    # Digest of multiple articles (use snippets; fetching every URL is too slow).
    lines = [
        _SUMMARY_RULES,
        f"There are {len(entries)} articles. Produce a digest:",
        "- TL;DR: 2-3 bullets of the biggest themes actually present.",
        "- Then one tight bullet per item, each ending with [Source](URL).",
        "- Skip duplicates / near-duplicates. Only as many bullets as the items support.",
        "",
        "ARTICLES:",
    ]
    for e in entries:
        title = e.get("title") or "(untitled)"
        link = e.get("link") or ""
        feed = e.get("feed_name") or "?"
        summary = e.get("summary") or ""
        snippet = (summary[:600] + "…") if len(summary) > 600 else summary
        lines.append(f"- [{feed}] {title} — {link}\n  {snippet}".rstrip())
    return "\n".join(lines)


# ── DB plumbing ────────────────────────────────────────────────────────────
def _ensure_db() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(_FEEDS_DB)
    try:
        # WAL so a ~10s full refresh (writer) never blocks the feeds panel
        # reads — in the default 'delete' mode the exclusive write lock made
        # /api/feeds/entries hang until the refresh finished. WAL is a
        # persistent DB property; set once here.
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
        except Exception:
            pass
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS feeds (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category TEXT NOT NULL DEFAULT 'general',
                name TEXT NOT NULL,
                url TEXT NOT NULL UNIQUE,
                enabled INTEGER NOT NULL DEFAULT 1,
                fetch_interval_minutes INTEGER NOT NULL DEFAULT 60,
                last_fetched_at REAL,
                last_status TEXT,
                last_error TEXT,
                consecutive_failures INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_feeds_category ON feeds(category);

            CREATE TABLE IF NOT EXISTS entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
                guid TEXT NOT NULL,
                title TEXT NOT NULL,
                link TEXT NOT NULL,
                summary TEXT,
                published_at REAL,
                fetched_at REAL NOT NULL,
                UNIQUE(feed_id, guid)
            );
            CREATE INDEX IF NOT EXISTS idx_entries_feed ON entries(feed_id);
            CREATE INDEX IF NOT EXISTS idx_entries_published ON entries(published_at);

            -- Global feed settings: keywords filter + filter on/off + auto-fetch interval.
            -- Singleton row keyed by id=1.
            CREATE TABLE IF NOT EXISTS feed_settings (
                id INTEGER PRIMARY KEY,
                keywords TEXT NOT NULL DEFAULT '[]',
                filter_enabled INTEGER NOT NULL DEFAULT 0,
                updated_at REAL NOT NULL
            );

            -- persisted AI summaries (digests). A summarize action inserts
            -- a 'running' row and a background thread fills content + flips to
            -- 'done'/'error'. Survives navigation/reload/device — the user finds
            -- it later in the 🧠 Summaries view (and inline on the article card
            -- for single-entry summaries via entry_id).
            CREATE TABLE IF NOT EXISTS summaries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scope TEXT NOT NULL,
                target TEXT,
                entry_id INTEGER,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'running',
                model TEXT,
                content TEXT,
                error TEXT,
                entry_count INTEGER NOT NULL DEFAULT 0,
                sources TEXT,
                created_at REAL NOT NULL,
                completed_at REAL
            );
            CREATE INDEX IF NOT EXISTS idx_summaries_entry ON summaries(entry_id);
            CREATE INDEX IF NOT EXISTS idx_summaries_created ON summaries(created_at);
        """)
        # idempotent ADD COLUMN for summaries.sources (JSON list of the
        # summarized articles: feed/title/link → the 'Source' hyperlink).
        scols = {row[1] for row in conn.execute("PRAGMA table_info(summaries)").fetchall()}
        if 'sources' not in scols:
            conn.execute("ALTER TABLE summaries ADD COLUMN sources TEXT")
        # idempotent ADD COLUMN for auto_fetch_minutes (0 = off).
        # SQLite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS so we sniff
        # PRAGMA table_info to keep this a no-op on subsequent boots.
        cols = {row[1] for row in conn.execute("PRAGMA table_info(feed_settings)").fetchall()}
        if 'auto_fetch_minutes' not in cols:
            conn.execute("ALTER TABLE feed_settings ADD COLUMN auto_fetch_minutes INTEGER NOT NULL DEFAULT 0")
        # idempotent cross-device feed UI prefs (entries-per-page, read-history cap,
        # agency multi-select). Stored server-side so they sync across iPhone/iPad/Mac.
        for _col, _ddl in (
            ('entries_per_page', "ALTER TABLE feed_settings ADD COLUMN entries_per_page INTEGER NOT NULL DEFAULT 100"),
            ('read_retain',      "ALTER TABLE feed_settings ADD COLUMN read_retain INTEGER NOT NULL DEFAULT 200"),
            ('visible_feeds',    "ALTER TABLE feed_settings ADD COLUMN visible_feeds TEXT NOT NULL DEFAULT '[]'"),
            ('summary_config',   "ALTER TABLE feed_settings ADD COLUMN summary_config TEXT NOT NULL DEFAULT '{}'"),
        ):
            if _col not in cols:
                conn.execute(_ddl)
        # idempotent read_at on entries — server-side read state so "clicked"
        # marks follow the user across devices (was localStorage-only, per-browser).
        ecols = {row[1] for row in conn.execute("PRAGMA table_info(entries)").fetchall()}
        if 'read_at' not in ecols:
            conn.execute("ALTER TABLE entries ADD COLUMN read_at REAL")
        # Ensure the singleton row exists
        conn.execute(
            "INSERT OR IGNORE INTO feed_settings (id, keywords, filter_enabled, auto_fetch_minutes, updated_at) VALUES (1, '[]', 0, 0, ?)",
            (time.time(),),
        )
        conn.commit()
    finally:
        conn.close()


def get_settings() -> dict:
    # lazy start of the auto-fetch background thread on
    # first settings read. Idempotent — guarded by a lock inside.
    _ensure_auto_fetch_thread()
    conn = _open()
    try:
        row = conn.execute(
            "SELECT keywords, filter_enabled, auto_fetch_minutes, entries_per_page, read_retain, visible_feeds, summary_config, updated_at FROM feed_settings WHERE id = 1"
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return {
            "keywords": [], "filter_enabled": False,
            "auto_fetch_minutes": 0,
            "auto_fetch_last_at": _auto_fetch_last_run,
            "entries_per_page": 100, "read_retain": 200, "visible_feeds": [],
            "summary_config": dict(_DEFAULT_SUMMARY_CONFIG),
        }
    try:
        kws = json.loads(row["keywords"]) if row["keywords"] else []
        if not isinstance(kws, list):
            kws = []
    except Exception:
        kws = []
    try:
        vf = json.loads(row["visible_feeds"]) if row["visible_feeds"] else []
        if not isinstance(vf, list):
            vf = []
    except Exception:
        vf = []
    try:
        sc = json.loads(row["summary_config"]) if row["summary_config"] else {}
    except Exception:
        sc = {}
    return {
        "keywords": [str(k) for k in kws if str(k).strip()],
        "filter_enabled": bool(row["filter_enabled"]),
        "auto_fetch_minutes": int(row["auto_fetch_minutes"] or 0),
        "auto_fetch_last_at": _auto_fetch_last_run,
        "entries_per_page": int(row["entries_per_page"] or 100),
        "read_retain": int(row["read_retain"] or 200),
        "visible_feeds": [int(x) for x in vf if str(x).strip().lstrip('-').isdigit()],
        "summary_config": _normalize_summary_config(sc),
        "updated_at": row["updated_at"],
    }


# Allowed auto-fetch intervals in minutes. 0 = disabled. Other values map to
# the UI picker options. We clamp the floor to 5 min to avoid hammering feeds.
_AUTO_FETCH_ALLOWED = {0, 15, 30, 60, 180, 360, 720, 1440}


def update_settings(keywords: list[str] | None = None,
                    filter_enabled: bool | None = None,
                    auto_fetch_minutes: int | None = None,
                    entries_per_page: int | None = None,
                    read_retain: int | None = None,
                    visible_feeds: list | None = None,
                    summary_config: dict | None = None) -> dict:
    current = get_settings()
    # Keywords are canonicalized to UPPERCASE (typed in any case → stored capital).
    # Matching is case-insensitive (\b…\b re.IGNORECASE) so filtering is unchanged.
    new_kws = current["keywords"] if keywords is None else [
        str(k).strip().upper() for k in keywords if str(k).strip()
    ]
    new_fe = current["filter_enabled"] if filter_enabled is None else bool(filter_enabled)
    new_afm = current.get("auto_fetch_minutes", 0)
    if auto_fetch_minutes is not None:
        try:
            cand = int(auto_fetch_minutes)
        except (TypeError, ValueError):
            cand = 0
        # Clamp to allowed set; fall back to 0 (off) if value isn't in the set
        new_afm = cand if cand in _AUTO_FETCH_ALLOWED else 0
    new_epp = current.get("entries_per_page", 100)
    if entries_per_page is not None:
        try:
            new_epp = max(10, min(500, int(entries_per_page)))
        except (TypeError, ValueError):
            pass
    new_rr = current.get("read_retain", 200)
    if read_retain is not None:
        try:
            new_rr = max(10, min(2000, int(read_retain)))
        except (TypeError, ValueError):
            pass
    new_vf = current.get("visible_feeds", [])
    if visible_feeds is not None:
        try:
            new_vf = [int(x) for x in visible_feeds]
        except (TypeError, ValueError):
            new_vf = []
    new_sc = current.get("summary_config", dict(_DEFAULT_SUMMARY_CONFIG))
    if summary_config is not None:
        new_sc = _normalize_summary_config(summary_config)
    conn = _open()
    try:
        conn.execute(
            "UPDATE feed_settings SET keywords = ?, filter_enabled = ?, "
            "auto_fetch_minutes = ?, entries_per_page = ?, read_retain = ?, "
            "visible_feeds = ?, summary_config = ?, updated_at = ? WHERE id = 1",
            (json.dumps(new_kws), 1 if new_fe else 0, int(new_afm),
             int(new_epp), int(new_rr), json.dumps(new_vf), json.dumps(new_sc), time.time()),
        )
        conn.commit()
    finally:
        conn.close()
    # Make sure the background thread is alive (it will read the new value
    # on its next 60-second tick).
    _ensure_auto_fetch_thread()
    return get_settings()


# ── Background auto-fetch ──────────────────────────────────────────────────
# Single daemon thread per webui process. Polls feed_settings every 60s.
# Fires refresh_all() when (now - last_run) >= auto_fetch_minutes * 60.
# Runs only when auto_fetch_minutes > 0; otherwise sleeps cheaply.
import threading as _threading_af  # avoid shadowing other 'threading' imports

_auto_fetch_thread: "_threading_af.Thread | None" = None
_auto_fetch_lock = _threading_af.Lock()
_auto_fetch_stop = _threading_af.Event()
_auto_fetch_last_run: float = 0.0  # epoch seconds; in-memory, resets on restart

# --- Concurrency bounds ----------------------------------------------------
# A burst of summarize requests (each is its own daemon thread) or overlapping
# auto+manual refreshes (each an 8-worker pool) could otherwise spawn unbounded
# threads. Cap concurrent summaries and serialize refreshes (single-flight).
_MAX_CONCURRENT_SUMMARIES = 3
_summary_sem = _threading_af.BoundedSemaphore(_MAX_CONCURRENT_SUMMARIES)
_refresh_lock = _threading_af.Lock()  # single-flight: one refresh_all() at a time


def _auto_fetch_loop() -> None:
    global _auto_fetch_last_run
    logger.info("[feeds] auto-fetch loop started")
    # Exact-schedule loop: compute the due time (last run + interval) and sleep
    # right up to it in ≤30s slices (so interval changes and shutdown are picked
    # up quickly), instead of polling on a fixed 60s grid that fired up to a
    # minute late and drifted by the fetch duration every cycle.
    while not _auto_fetch_stop.is_set():
        interval_min = 0
        try:
            conn = _open()
            row = conn.execute(
                "SELECT auto_fetch_minutes FROM feed_settings WHERE id = 1"
            ).fetchone()
            conn.close()
            interval_min = int(row[0] or 0) if row else 0
        except Exception:
            logger.debug("auto-fetch: settings read failed", exc_info=True)
        if interval_min <= 0:
            if _auto_fetch_stop.wait(30):
                break
            continue
        period = interval_min * 60.0
        now = time.time()
        due = (_auto_fetch_last_run + period) if _auto_fetch_last_run else now
        if now < due:
            # Re-derive `due` each slice: a manual refresh or an interval
            # change mid-sleep moves the schedule and must be honored.
            if _auto_fetch_stop.wait(min(30.0, due - now)):
                break
            continue
        # Skip this tick if a manual refresh is mid-flight rather than blocking
        # the daemon behind it — the single-flight lock guarantees no overlap,
        # and we'll re-fire on the next slice.
        if not _refresh_lock.acquire(blocking=False):
            logger.info("[feeds] auto-fetch skipped (refresh already running)")
            if _auto_fetch_stop.wait(30):
                break
            continue
        _refresh_lock.release()
        logger.info("[feeds] auto-fetch firing (interval=%dm)", interval_min)
        try:
            results = refresh_all()
            ok = sum(1 for r in results if str(r.get("status", "")).startswith("ok"))
            new_entries = sum(int(r.get("new_entries", 0) or 0) for r in results)
            print(
                f"[feeds/auto-fetch] interval={interval_min}m feeds={len(results)} "
                f"ok={ok} new_entries={new_entries}",
                flush=True,
            )
        except Exception:
            logger.exception("auto-fetch loop iteration failed")
        # Anchor the next run to the SCHEDULED time, not completion time —
        # refresh_all() stamps completion, which would add the fetch duration
        # to every period. If we're over a period late (host slept, service
        # restarted), re-anchor to now rather than burst-firing to catch up.
        _auto_fetch_last_run = due if (time.time() - due) < period else time.time()


def _ensure_auto_fetch_thread() -> None:
    global _auto_fetch_thread, _auto_fetch_last_run
    with _auto_fetch_lock:
        if _auto_fetch_thread is not None and _auto_fetch_thread.is_alive():
            return
        # seed last-run from the persisted MAX(last_fetched_at) so the
        # countdown is accurate immediately after a webui restart (the in-memory
        # _auto_fetch_last_run starts at 0) and the daemon doesn't re-fetch
        # redundantly on every restart.
        if not _auto_fetch_last_run:
            try:
                _seed_conn = _open()
                _seed_row = _seed_conn.execute(
                    "SELECT MAX(last_fetched_at) FROM feeds"
                ).fetchone()
                _seed_conn.close()
                if _seed_row and _seed_row[0]:
                    _auto_fetch_last_run = float(_seed_row[0])
            except Exception:
                logger.debug("auto-fetch: seed last-run failed", exc_info=True)
        _auto_fetch_stop.clear()
        _auto_fetch_thread = _threading_af.Thread(
            target=_auto_fetch_loop,
            name="feeds-auto-fetch",
            daemon=True,
        )
        _auto_fetch_thread.start()


def _open() -> sqlite3.Connection:
    _ensure_db()
    conn = sqlite3.connect(_FEEDS_DB)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")  # wait up to 5s for a lock vs erroring
    return conn


# ── Seed feeds_seed.txt on first run ──────────────────────────────────────
def _maybe_seed() -> int:
    """If the DB has zero feeds AND the seed file exists, populate it once.

    Seed file format (one entry per line, with region header lines):
        🇺🇸 US                                          ← region header
        NPR News https://feeds.npr.org/1001/rss.xml — News — 9/10

    Region from the header becomes the row's `category`. The trailing
    " — Topic — N/10" is stripped (kept only for human review of the
    seed file). Returns the count of feeds inserted.
    """
    try:
        conn = _open()
        try:
            existing = conn.execute("SELECT COUNT(*) AS c FROM feeds").fetchone()
            if existing and existing["c"] > 0:
                return 0
        finally:
            conn.close()
    except Exception:
        return 0

    if not _SEED_FILE.exists():
        return 0

    try:
        lines = _SEED_FILE.read_text(encoding="utf-8").splitlines()
    except Exception:
        return 0

    category = "general"
    inserted = 0
    now = time.time()
    conn = _open()
    try:
        for raw in lines:
            line = raw.strip()
            if not line:
                continue
            # Region header: line has no URL.
            m = _URL_RE.search(line)
            if not m:
                # Strip leading non-letter chars (emojis) and use the rest
                # as the category. E.g. "🇺🇸 US" → "US".
                clean = line
                while clean and not clean[0].isalpha():
                    clean = clean[1:]
                clean = clean.strip()
                if clean:
                    category = clean
                continue
            url = m.group(1).rstrip(",.;)")
            name = line[:m.start()].strip()
            # If the line had no name (URL is the entire content), use host.
            if not name:
                try:
                    from urllib.parse import urlparse
                    name = urlparse(url).netloc or url
                except Exception:
                    name = url
            try:
                conn.execute(
                    "INSERT INTO feeds (category, name, url, enabled, fetch_interval_minutes, created_at, updated_at) "
                    "VALUES (?, ?, ?, 1, 60, ?, ?)",
                    (category, name[:200], url[:1024], now, now),
                )
                inserted += 1
            except sqlite3.IntegrityError:
                # URL already present — seed is idempotent on partial runs.
                pass
        conn.commit()
    finally:
        conn.close()
    if inserted:
        logger.info("Seeded %d feeds from %s", inserted, _SEED_FILE)
    return inserted


# ── Helpers ────────────────────────────────────────────────────────────────
def _strip_html(raw: str) -> str:
    if not raw:
        return ""
    txt = _HTML_TAG_RE.sub(" ", raw)
    txt = html.unescape(txt)
    return _WHITESPACE_RE.sub(" ", txt).strip()


def _stable_guid(entry: Any, fallback_url: str) -> str:
    raw = entry.get("id") or entry.get("guid") or entry.get("link") or fallback_url
    if not raw:
        return hashlib.sha256(repr(entry).encode("utf-8", errors="replace")).hexdigest()[:64]
    return str(raw)[:512]


def _parse_published(entry: Any) -> float | None:
    for key in ("published_parsed", "updated_parsed"):
        struct = entry.get(key)
        if struct:
            try:
                dt = datetime(*struct[:6], tzinfo=timezone.utc)
                return dt.timestamp()
            except (TypeError, ValueError):
                continue
    return None


def _require_auth(handler) -> bool:
    from shim import is_auth_enabled, parse_cookie, verify_session
    if not is_auth_enabled():
        return True
    cv = parse_cookie(handler)
    return bool(cv and verify_session(cv))


def _err(handler, status: int, msg: str) -> bool:
    j(handler, {"error": msg}, status=status)
    return True


# ── Feed CRUD ─────────────────────────────────────────────────────────────
def list_feeds() -> list[dict]:
    _maybe_seed()  # idempotent — only runs on a truly empty DB
    conn = _open()
    try:
        rows = conn.execute(
            "SELECT id, category, name, url, enabled, fetch_interval_minutes, "
            "last_fetched_at, last_status, last_error, consecutive_failures, "
            "created_at, updated_at FROM feeds ORDER BY category, name"
        ).fetchall()
        feeds = [dict(r) for r in rows]
        # Attach entry counts per feed
        counts = {
            row["feed_id"]: row["c"]
            for row in conn.execute(
                "SELECT feed_id, COUNT(*) AS c FROM entries GROUP BY feed_id"
            ).fetchall()
        }
        for f in feeds:
            f["entry_count"] = counts.get(f["id"], 0)
            f["enabled"] = bool(f["enabled"])
        return feeds
    finally:
        conn.close()


def create_feed(name: str, url: str, category: str = "general",
                fetch_interval_minutes: int = 60) -> dict:
    name = (name or "").strip()
    url = (url or "").strip()
    category = (category or "general").strip()[:64] or "general"
    if not name or not url:
        raise ValueError("name and url are required")
    if not (url.startswith("http://") or url.startswith("https://")):
        raise ValueError("url must be http(s)://")
    if fetch_interval_minutes < 5:
        fetch_interval_minutes = 5  # sane floor
    now = time.time()
    conn = _open()
    try:
        cur = conn.execute(
            "INSERT INTO feeds (category, name, url, enabled, fetch_interval_minutes, created_at, updated_at) "
            "VALUES (?, ?, ?, 1, ?, ?, ?)",
            (category, name[:200], url[:1024], fetch_interval_minutes, now, now),
        )
        conn.commit()
        return {"id": cur.lastrowid, "name": name, "url": url, "category": category}
    except sqlite3.IntegrityError as exc:
        raise ValueError(f"feed url already exists ({exc})")
    finally:
        conn.close()


def update_feed(feed_id: int, fields: dict) -> bool:
    allowed = {"name", "url", "category", "enabled", "fetch_interval_minutes"}
    sets = []
    params: list[Any] = []
    for k, v in fields.items():
        if k not in allowed:
            continue
        if k == "enabled":
            v = 1 if v else 0
        elif k == "fetch_interval_minutes":
            try:
                v = max(5, int(v))
            except Exception:
                continue
        elif k == "url":
            v = str(v).strip()
            if not (v.startswith("http://") or v.startswith("https://")):
                raise ValueError("url must be http(s)://")
        elif k == "name":
            v = str(v).strip()[:200]
            if not v:
                continue
        elif k == "category":
            v = (str(v).strip()[:64] or "general")
        sets.append(f"{k} = ?")
        params.append(v)
    if not sets:
        return False
    sets.append("updated_at = ?")
    params.append(time.time())
    params.append(feed_id)
    conn = _open()
    try:
        cur = conn.execute(f"UPDATE feeds SET {', '.join(sets)} WHERE id = ?", params)
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def delete_feed(feed_id: int) -> bool:
    conn = _open()
    try:
        cur = conn.execute("DELETE FROM feeds WHERE id = ?", (feed_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# ── Fetching (token-free) ──────────────────────────────────────────────────
_MAX_REDIRECTS = 5


def _validate_public_ip(ip_str: str, host: str) -> None:
    """Reject any address that isn't globally routable. ``is_global`` is False
    for private, loopback, link-local, reserved, multicast, unspecified AND the
    shared CGNAT range 100.64.0.0/10 (e.g. the 100.100.100.200 Alibaba metadata
    IP) — which the old is_private-based check let through."""
    ip = ipaddress.ip_address(ip_str)
    if not ip.is_global:
        raise ValueError(f"refusing to fetch non-global address {ip} (host {host})")


def _resolve_pinned(host: str, port: int):
    """Resolve ``host``, validate that EVERY resolved address is public, and
    return one ``(family, ip)`` to connect to. Pinning the validated IP for the
    actual socket closes the DNS-rebinding window (validate-then-reconnect)."""
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise ValueError(f"dns resolution failed: {exc}")
    if not infos:
        raise ValueError(f"no addresses for {host}")
    pinned = None
    for info in infos:
        addr = info[4][0]
        _validate_public_ip(addr, host)
        if pinned is None:
            pinned = (info[0], addr)
    return pinned


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, pinned_ip, *a, **kw):
        super().__init__(host, *a, **kw)
        self._pinned_ip = pinned_ip

    def connect(self):
        self.sock = socket.create_connection(
            (self._pinned_ip, self.port), self.timeout, self.source_address)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, pinned_ip, *a, **kw):
        super().__init__(host, *a, **kw)
        self._pinned_ip = pinned_ip

    def connect(self):
        sock = socket.create_connection(
            (self._pinned_ip, self.port), self.timeout, self.source_address)
        # SNI + certificate validation use the real hostname, not the pinned IP.
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def _safe_fetch(url: str, headers: dict, timeout: float, max_bytes: int,
                max_redirects: int = _MAX_REDIRECTS, truncate: bool = False):
    """SSRF-safe HTTP GET. Validates every hop resolves to a *global* address,
    pins the validated IP for the connection (no rebind window), preserves the
    Host header + HTTPS SNI/cert validation, and follows a bounded number of
    redirects re-validating+re-pinning each. Returns ``(status, headers, body)``
    where ``headers`` keys are lower-cased."""
    from urllib.parse import urlparse, urljoin
    current = url
    for _ in range(max_redirects + 1):
        p = urlparse(current)
        if p.scheme not in ("http", "https"):
            raise ValueError("url must be http(s)://")
        host = p.hostname
        if not host:
            raise ValueError("url has no host")
        port = p.port or (443 if p.scheme == "https" else 80)
        _family, ip = _resolve_pinned(host, port)
        if p.scheme == "https":
            conn = _PinnedHTTPSConnection(
                host, ip, port=port, timeout=timeout,
                context=ssl.create_default_context())
        else:
            conn = _PinnedHTTPConnection(host, ip, port=port, timeout=timeout)
        try:
            path = p.path or "/"
            if p.query:
                path += "?" + p.query
            conn.request("GET", path, headers=headers)  # Host set from `host`
            resp = conn.getresponse()
            if resp.status in (301, 302, 303, 307, 308):
                loc = resp.getheader("Location")
                resp.read(65536)  # drain (bounded) before closing; conn.close() discards the rest
                if not loc:
                    raise ValueError("redirect without Location")
                current = urljoin(current, loc)
                continue
            hdrs = {k.lower(): v for k, v in resp.getheaders()}
            body = resp.read(max_bytes + 1)
            if len(body) > max_bytes:
                if truncate:
                    body = body[:max_bytes]
                else:
                    raise ValueError(f"response exceeds {max_bytes} byte cap")
            return resp.status, hdrs, body
        finally:
            conn.close()
    raise ValueError(f"too many redirects (>{max_redirects})")


def _assert_public_url(url: str) -> None:
    """Validate a URL is http(s) and resolves only to public addresses (used at
    feed add/edit time). The fetch itself uses _safe_fetch, which re-validates
    and IP-pins on every hop."""
    from urllib.parse import urlparse
    p = urlparse(url)
    if p.scheme not in ("http", "https"):
        raise ValueError("url must be http(s)://")
    if not p.hostname:
        raise ValueError("url has no host")
    _resolve_pinned(p.hostname, p.port or (443 if p.scheme == "https" else 80))


def _http_get(url: str) -> tuple[int, bytes]:
    """Fetch raw bytes with a timeout, SSRF-safe IP pinning, and a size cap."""
    status, _hdrs, body = _safe_fetch(url, {
        "User-Agent": _USER_AGENT,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml; q=0.9, */*; q=0.5",
    }, _FETCH_TIMEOUT, _MAX_FEED_BYTES)
    return status, body


def _safe_link(url: str) -> str:
    """Keep only http(s) links; drop javascript:/data:/etc so a stored entry
    link can't become an XSS sink when rendered as an href."""
    u = (url or "").strip()
    lo = u.lower()
    return u if lo.startswith("http://") or lo.startswith("https://") else ""


# ── Stdlib feed parser ─────────────────────────────────────────────────────
# The sidecar runs under `python3 -S` (no site-packages) per the token-v1
# contract, so `import feedparser` fails at runtime. Parse RSS 2.0 / Atom /
# RSS-1.0(RDF) with xml.etree instead — no third-party dependency, no vendoring.
# We expose only the tiny feedparser-compatible surface fetch_feed() uses:
# a result with .entries / .bozo / .get('bozo_exception'), each entry a dict
# with link/title/summary/description/id/guid/published_parsed/updated_parsed.

class _ParsedFeed(dict):
    """feedparser-shaped result: attribute .entries/.bozo + dict .get()."""
    @property
    def entries(self) -> list:
        return self.get("entries", [])

    @property
    def bozo(self) -> bool:
        return bool(self.get("bozo", False))


def _localname(tag: Any) -> str:
    """ElementTree tags are '{namespace}local'; return the lowercased localname."""
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1].lower()


def _child_text(el, *names: str) -> str:
    """First direct child whose localname is in `names`, its stripped text."""
    want = set(names)
    for child in el:
        if _localname(child.tag) in want:
            return (child.text or "").strip()
    return ""


def _date_struct(datestr: str):
    """Parse an RSS (RFC 822) or Atom (RFC 3339) date to a UTC time-tuple whose
    [:6] is (Y, M, D, h, m, s) — the shape _parse_published() consumes. None on
    failure so a bad date just drops the timestamp rather than the whole entry."""
    if not datestr:
        return None
    datestr = datestr.strip()
    try:  # RFC 822 (RSS pubDate)
        dt = parsedate_to_datetime(datestr)
        if dt is not None:
            if dt.tzinfo is not None:
                dt = dt.astimezone(timezone.utc)
            return dt.timetuple()
    except (TypeError, ValueError, IndexError, OverflowError):
        pass
    try:  # RFC 3339 / ISO 8601 (Atom updated/published)
        dt = datetime.fromisoformat(datestr.replace("Z", "+00:00"))
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc)
        return dt.timetuple()
    except (TypeError, ValueError):
        return None


def _rss_item(it) -> dict:
    guid = _child_text(it, "guid")
    desc = _child_text(it, "description")
    return {
        "title": _child_text(it, "title"),
        "link": _child_text(it, "link"),
        "description": desc,
        # content:encoded (localname 'encoded') is richer than description when present
        "summary": _child_text(it, "encoded") or desc,
        "id": guid,
        "guid": guid,
        # RSS pubDate, or Dublin Core <dc:date> (localname 'date')
        "published_parsed": _date_struct(_child_text(it, "pubdate", "date")),
        "updated_parsed": None,
    }


def _atom_entry(en) -> dict:
    link = ""
    for child in en:
        if _localname(child.tag) == "link":
            href = (child.get("href") or "").strip()
            if not href:
                continue
            rel = child.get("rel", "alternate")
            if rel == "alternate":
                link = href
                break
            if not link:
                link = href  # fall back to first link if no rel=alternate
    ident = _child_text(en, "id")
    body = _child_text(en, "summary", "content")
    return {
        "title": _child_text(en, "title"),
        "link": link,
        "description": body,
        "summary": body,
        "id": ident,
        "guid": ident,
        "published_parsed": _date_struct(_child_text(en, "published", "issued")),
        "updated_parsed": _date_struct(_child_text(en, "updated", "modified")),
    }


def _parse_feed_bytes(body: bytes) -> _ParsedFeed:
    """Stdlib replacement for feedparser.parse() covering RSS 2.0 / Atom / RSS 1.0."""
    result = _ParsedFeed(entries=[], bozo=False)
    try:
        root = _ET.fromstring(body)
    except _ET.ParseError as exc:
        result["bozo"] = True
        result["bozo_exception"] = f"XML parse error: {exc}"
        return result
    except Exception as exc:  # pragma: no cover - defensive
        result["bozo"] = True
        result["bozo_exception"] = f"{type(exc).__name__}: {exc}"
        return result

    root_tag = _localname(root.tag)
    entries: list[dict] = []
    if root_tag == "rss":
        channel = next((c for c in root if _localname(c.tag) == "channel"), None)
        scope = channel if channel is not None else root
        entries = [_rss_item(c) for c in scope if _localname(c.tag) == "item"]
    elif root_tag == "feed":  # Atom
        entries = [_atom_entry(c) for c in root if _localname(c.tag) == "entry"]
    elif root_tag == "rdf":  # RSS 1.0 (items are siblings of <channel>)
        entries = [_rss_item(c) for c in root if _localname(c.tag) == "item"]
    else:
        result["bozo"] = True
        result["bozo_exception"] = f"unrecognized feed root <{root_tag}>"

    result["entries"] = entries
    return result


def fetch_feed(feed_id: int) -> dict:
    """Fetch + parse + upsert one feed. Never raises. Returns a status dict.
    Used by both the single-feed refresh and the parallel refresh_all."""
    conn = _open()
    try:
        row = conn.execute(
            "SELECT id, url, name FROM feeds WHERE id = ?", (feed_id,)
        ).fetchone()
        if not row:
            return {"status": "not_found", "feed_id": feed_id}
        url = row["url"]
        name = row["name"]
    finally:
        conn.close()

    started = time.time()

    # Fetch with our own urllib + timeout, then parse the bytes with our
    # stdlib parser (_parse_feed_bytes).
    try:
        http_status, body = _http_get(url)
    except urllib.error.HTTPError as exc:
        return _record_fetch_failure(
            feed_id, f"http_{exc.code}",
            f"HTTP {exc.code} {exc.reason or ''}".strip(),
            feed_name=name,
        )
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        return _record_fetch_failure(
            feed_id, "network_error", f"{type(reason).__name__}: {reason}",
            feed_name=name,
        )
    except Exception as exc:
        return _record_fetch_failure(
            feed_id, "exception", f"{type(exc).__name__}: {exc}",
            feed_name=name,
        )

    if 400 <= http_status < 600:
        return _record_fetch_failure(feed_id, f"http_{http_status}",
                                     f"HTTP {http_status}", feed_name=name)

    try:
        parsed = _parse_feed_bytes(body)
    except Exception as exc:
        return _record_fetch_failure(feed_id, "parse_error",
                                     f"{type(exc).__name__}: {exc}",
                                     feed_name=name)

    entries = list(getattr(parsed, "entries", [])[:_MAX_ENTRIES_PER_FETCH])
    total = len(entries)
    if total == 0:
        bozo_exc = parsed.get("bozo_exception")
        return _record_fetch_failure(
            feed_id, "no_entries",
            f"bozo: {bozo_exc}" if bozo_exc else "0 entries returned",
            feed_name=name,
        )

    new_entries = 0
    conn = _open()
    try:
        existing = {
            r["guid"]
            for r in conn.execute(
                "SELECT guid FROM entries WHERE feed_id = ?", (feed_id,)
            ).fetchall()
        }
        for entry in entries:
            link = _safe_link((entry.get("link") or "")[:1024])
            guid = _stable_guid(entry, link)
            if guid in existing:
                continue
            title = _strip_html(entry.get("title") or "")[:1000]
            summary = _strip_html(entry.get("summary") or entry.get("description") or "")[:5000]
            published = _parse_published(entry)
            if not title and not link:
                continue
            conn.execute(
                "INSERT INTO entries (feed_id, guid, title, link, summary, published_at, fetched_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (feed_id, guid, title or "(no title)", link or "(no link)",
                 summary or None, published, started),
            )
            new_entries += 1
        bozo = bool(getattr(parsed, "bozo", False))
        bozo_exc = parsed.get("bozo_exception")
        conn.execute(
            "UPDATE feeds SET last_fetched_at = ?, last_status = ?, last_error = ?, "
            "consecutive_failures = 0, updated_at = ? WHERE id = ?",
            (started,
             "ok_with_warnings" if bozo else "ok",
             f"bozo: {bozo_exc}" if bozo and bozo_exc else None,
             time.time(),
             feed_id),
        )
        conn.commit()
    finally:
        conn.close()

    return {
        "status": "ok",
        "feed_id": feed_id,
        "feed_name": name,
        "new_entries": new_entries,
        "total_returned": total,
    }


def _record_fetch_failure(feed_id: int, status: str, error: str,
                          feed_name: str = "") -> dict:
    now = time.time()
    conn = _open()
    try:
        conn.execute(
            "UPDATE feeds SET last_fetched_at = ?, last_status = ?, last_error = ?, "
            "consecutive_failures = consecutive_failures + 1, updated_at = ? WHERE id = ?",
            (now, status, error[:500], now, feed_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"status": status, "feed_id": feed_id, "feed_name": feed_name, "error": error}


def refresh_all(only_ids: list[int] | None = None, progress_cb=None) -> list[dict]:
    """Single-flight guard around the real refresh. Auto (daemon) and manual
    (POST) refreshes must never overlap — two 8-worker pools writing the same
    SQLite rows at once causes lock contention and doubled fetch load. If a
    refresh is already running, block until it finishes, then run this one
    (serialized), rather than launching an overlapping set of workers."""
    with _refresh_lock:
        return _refresh_all_locked(only_ids, progress_cb)


# ── Refresh as a background job (POST starts, GET polls) ────────────────────
# A full refresh is ~10-30s, which exceeds the core sidecar-proxy's hard 10s
# timeout — a synchronous POST always 502s at the proxy even though the sidecar
# finishes fine. So POST kicks off a background run and returns 202 immediately;
# the UI polls GET /api/feeds/refresh-status until {running:false} for results.
_refresh_job_lock = _threading_af.Lock()
_refresh_job: dict[str, Any] = {
    "running": False, "done": 0, "total": 0, "results": [],
    "started_at": 0.0, "finished_at": 0.0, "error": "",
}


def _refresh_worker(only_ids: list[int] | None) -> None:
    def _progress(done: int, total: int) -> None:
        with _refresh_job_lock:
            _refresh_job["done"] = done
            _refresh_job["total"] = total
    results: list[dict] = []
    err = ""
    try:
        results = refresh_all(only_ids, progress_cb=_progress)
    except Exception as exc:  # pragma: no cover - defensive
        err = f"{type(exc).__name__}: {exc}"
    with _refresh_job_lock:
        _refresh_job["results"] = results
        _refresh_job["error"] = err
        _refresh_job["running"] = False
        _refresh_job["finished_at"] = time.time()


def start_refresh(only_ids: list[int] | None = None) -> dict:
    """Reserve + start ONE background refresh job (idempotent while one runs).
    Returns a status snapshot. Refresh itself is single-flight (refresh_all holds
    _refresh_lock), so at most one refresh executes regardless of callers."""
    with _refresh_job_lock:
        if _refresh_job["running"]:
            return dict(_refresh_job)
        _refresh_job.update(running=True, done=0, total=0, results=[],
                            started_at=time.time(), finished_at=0.0, error="")
        snap = dict(_refresh_job)
    t = __import__("threading").Thread(
        target=_refresh_worker, args=(only_ids,), name="feeds-refresh", daemon=True)
    t.start()
    return snap


def refresh_status() -> dict:
    """Poll payload for the refresh job. Results are only included once the run
    has finished (running:false), so a poll stays small mid-refresh."""
    with _refresh_job_lock:
        out: dict[str, Any] = {
            "running": bool(_refresh_job["running"]),
            "done": int(_refresh_job["done"]),
            "total": int(_refresh_job["total"]),
            "started_at": int(_refresh_job["started_at"] or 0),
        }
        if not _refresh_job["running"]:
            out["results"] = list(_refresh_job["results"])
            if _refresh_job["error"]:
                out["error"] = _refresh_job["error"]
        return out


# ── Summary-model connectivity test as a background job (POST starts, GET polls) ─
# The "Test" button runs a 1-word prompt through the configured model, but the
# model backends allow up to 240s (they're built for background summaries), so a
# synchronous test could exceed the proxy's 10s timeout on a cold model. Start +
# poll GET /api/feeds/summary-test-status instead.
_sumtest_job_lock = _threading_af.Lock()
_sumtest_job: dict[str, Any] = {"running": False, "result": None, "started_at": 0.0}


def _sumtest_worker() -> None:
    try:
        content, model = _summarize_llm("Reply with exactly one word: OK.")
        result = {"ok": True, "model": model, "sample": (content or "")[:80]}
    except Exception as exc:
        result = {"ok": False, "error": str(exc)[:300]}
    with _sumtest_job_lock:
        _sumtest_job["result"] = result
        _sumtest_job["running"] = False


def start_summary_test() -> dict:
    """Start ONE background model test (idempotent while one runs)."""
    with _sumtest_job_lock:
        if _sumtest_job["running"]:
            return {"running": True, "started_at": int(_sumtest_job["started_at"] or 0)}
        _sumtest_job.update(running=True, result=None, started_at=time.time())
        started = int(_sumtest_job["started_at"])
    __import__("threading").Thread(
        target=_sumtest_worker, name="feeds-summary-test", daemon=True).start()
    return {"running": True, "started_at": started}


def summary_test_status() -> dict:
    """Poll payload for the model test; carries the result once finished."""
    with _sumtest_job_lock:
        if _sumtest_job["running"]:
            return {"running": True}
        out = {"running": False}
        if _sumtest_job["result"] is not None:
            out.update(_sumtest_job["result"])
        return out


def _refresh_all_locked(only_ids: list[int] | None = None, progress_cb=None) -> list[dict]:
    """Refresh feeds in parallel via a thread pool. Each fetch has a 10s
    socket timeout, so 42 feeds finish in ~10-30s instead of 3-5 minutes.
    Callers must hold _refresh_lock (see refresh_all).

    progress_cb(done, total) is called as each feed completes (for the live
    refresh progress bar). Exceptions in the callback are swallowed so a slow/
    disconnected client can never break the refresh itself."""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    conn = _open()
    try:
        if only_ids:
            qmarks = ",".join("?" for _ in only_ids)
            rows = conn.execute(
                f"SELECT id FROM feeds WHERE enabled = 1 AND id IN ({qmarks})",
                only_ids,
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id FROM feeds WHERE enabled = 1 ORDER BY id"
            ).fetchall()
        ids = [r["id"] for r in rows]
    finally:
        conn.close()

    if not ids:
        return []

    results: list[dict] = []
    total = len(ids)
    done = 0
    with ThreadPoolExecutor(max_workers=_REFRESH_WORKERS) as pool:
        futures = {pool.submit(fetch_feed, fid): fid for fid in ids}
        for fut in as_completed(futures):
            try:
                results.append(fut.result(timeout=_FETCH_TIMEOUT + 5))
            except Exception as exc:
                fid = futures[fut]
                results.append({
                    "status": "exception",
                    "feed_id": fid,
                    "error": f"{type(exc).__name__}: {exc}",
                })
            done += 1
            if progress_cb is not None:
                try:
                    progress_cb(done, total)
                except Exception:
                    pass
    # Sort by feed_id for deterministic ordering
    results.sort(key=lambda r: r.get("feed_id", 0))
    # Any refresh (manual / client-triggered / daemon) resets the auto-fetch clock.
    # Otherwise the feeds "Refreshing…" countdown ring never clears after a client
    # refresh — it only tracked the daemon's timestamp, so it span indefinitely once
    # expired even though the fetch had already completed.
    global _auto_fetch_last_run
    _auto_fetch_last_run = time.time()
    return results


# ── Read state ───────────────────────────────────────────────────────────────
def mark_read(entry_id: int, read: bool = True) -> bool:
    """Set/clear an entry's server-side read_at. Read state then follows the user
    across devices (entry rows are stable — UNIQUE(feed_id, guid) survives re-fetch)."""
    conn = _open()
    try:
        cur = conn.execute(
            "UPDATE entries SET read_at = ? WHERE id = ?",
            (time.time() if read else None, int(entry_id)),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# ── Entries ────────────────────────────────────────────────────────────────
def list_entries(feed_id: int | None = None, category: str | None = None,
                 limit: int = 50, since: float | None = None,
                 apply_filter: bool = False, read_only: bool = False,
                 feed_ids: list | None = None, q: str | None = None,
                 before: float | None = None) -> list[dict]:
    """Return entries matching the requested scope.

    read_only=True returns only entries the user has clicked (read_at set),
    newest-clicked first — the "Read" history view. feed_ids restricts to an
    agency multi-select (list of feed ids). When apply_filter is True, post-
    filters with WORD-BOUNDARY regex against the saved keyword list.

    q is a free-text search: every space-separated term must appear (AND) in
    the entry title or summary (case-insensitive substring). Runs in SQL so it
    searches the whole archive, not just the current page.
    """
    limit = max(1, min(2000, int(limit)))
    sql = (
        "SELECT e.id, e.feed_id, f.name AS feed_name, f.category AS category, "
        "e.title, e.link, e.summary, e.published_at, e.fetched_at, e.read_at "
        "FROM entries e JOIN feeds f ON f.id = e.feed_id WHERE 1=1 "
    )
    params: list[Any] = []
    if feed_id is not None:
        sql += "AND e.feed_id = ? "
        params.append(feed_id)
    if feed_ids:
        try:
            _ids = [int(x) for x in feed_ids]
        except (TypeError, ValueError):
            _ids = []
        if _ids:
            sql += "AND e.feed_id IN (%s) " % ",".join("?" for _ in _ids)
            params.extend(_ids)
    if category:
        sql += "AND f.category = ? "
        params.append(category)
    if since is not None:
        sql += "AND COALESCE(e.published_at, e.fetched_at) >= ? "
        params.append(since)
    if before is not None:
        # Upper bound for paging OLDER (client passes the previous page's
        # next_before). Strict < so the boundary row isn't returned twice.
        sql += "AND COALESCE(e.published_at, e.fetched_at) < ? "
        params.append(before)
    terms = [t for t in (q or "").split() if t.strip()]
    for term in terms:
        sql += "AND (e.title LIKE ? ESCAPE '\\' OR e.summary LIKE ? ESCAPE '\\') "
        like = "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        params.extend([like, like])
    if read_only:
        sql += "AND e.read_at IS NOT NULL "
        sql += "ORDER BY e.read_at DESC "
    else:
        sql += "ORDER BY COALESCE(e.published_at, e.fetched_at) DESC "

    # When filtering, pull a wider pool from SQL because Python will
    # discard the non-matching rows. Cap to avoid unbounded scans.
    sql_limit = max(limit * 4, 500) if apply_filter else limit
    sql += "LIMIT ?"
    params.append(sql_limit)

    conn = _open()
    try:
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()

    if not apply_filter:
        return [dict(r) for r in rows]

    kws = get_settings().get("keywords") or []
    kws = [k.strip() for k in kws if k and k.strip()]
    if not kws:
        # Filter is on but no keywords defined — treat as a no-op so
        # the user sees something instead of an empty view.
        return [dict(r) for r in rows[:limit]]

    # Compile once. \b is unicode-aware in Python 3 re module.
    # re.escape protects against accidental regex metachars in keywords
    # (e.g. someone enters "U.S." as a keyword — the dot must be literal).
    patterns = [(kw, re.compile(rf"\b{re.escape(kw)}\b", re.IGNORECASE)) for kw in kws]

    out: list[dict] = []
    for r in rows:
        title = r["title"] or ""
        summary = r["summary"] or ""
        haystack = f"{title}\n{summary}"
        matched: list[str] = []
        for original_kw, pat in patterns:
            if pat.search(haystack):
                matched.append(original_kw)
        if matched:
            d = dict(r)
            d["matched_keywords"] = matched
            out.append(d)
            if len(out) >= limit:
                break
    return out


# ── Route handlers ────────────────────────────────────────────────────────
_FAVICON_DIR = STATE_DIR / "favicons"
_FAVICON_TTL = 30 * 24 * 3600   # refresh a cached icon at most monthly
_FAVICON_DOMAIN_RE = re.compile(r"^[a-z0-9.-]{1,255}$")


def _favicon_cached_path(domain: str):
    from pathlib import Path
    safe = domain.replace("/", "_")
    return _FAVICON_DIR / (safe + ".ico")


def _fetch_favicon(domain: str) -> bytes | None:
    """Fetch a site favicon server-side (DuckDuckGo, then Google as fallback).
    Keeps the browser same-origin (network_external stays false) and lets us
    cache aggressively so scrolling never re-hits an external host."""
    for url in (f"https://icons.duckduckgo.com/ip3/{domain}.ico",
                f"https://www.google.com/s2/favicons?sz=64&domain={domain}"):
        try:
            # SSRF-safe: _safe_fetch validates every hop resolves to a global
            # address and pins the IP for the connection, so a provider redirect
            # can't reach an internal host (defense-in-depth even for DDG/Google).
            _status, _hdrs, data = _safe_fetch(
                url, {"User-Agent": _BROWSER_UA},
                timeout=6, max_bytes=200_000, truncate=True)
            # DDG returns a 1x1 placeholder for unknown sites — treat tiny as miss.
            if data and len(data) > 70:
                return data
        except Exception:
            continue
    return None


def handle_favicon(handler, domain: str) -> bool:
    """Serve a cached site favicon (same-origin, immutable). Fetches + caches on
    first request per domain; every device/browser then hits the warm cache."""
    domain = (domain or "").strip().lower()
    if not domain or not _FAVICON_DOMAIN_RE.match(domain):
        return _err(handler, 400, "bad domain")
    path = _favicon_cached_path(domain)
    blob = None
    try:
        if path.is_file() and (time.time() - path.stat().st_mtime) < _FAVICON_TTL:
            blob = path.read_bytes()
    except Exception:
        blob = None
    if blob is None:
        blob = _fetch_favicon(domain)
        if blob:
            try:
                _FAVICON_DIR.mkdir(parents=True, exist_ok=True)
                path.write_bytes(blob)
            except Exception:
                pass
    if not blob:
        # 204 → the <img> onerror fires and the colored-initials fallback shows.
        handler.send_response(204)
        handler.send_header("Cache-Control", "public, max-age=86400")
        handler.end_headers()
        return True
    etag = '"' + hashlib.sha256(blob).hexdigest()[:16] + '"'
    if handler.headers.get("If-None-Match", "") == etag:
        handler.send_response(304)
        handler.send_header("ETag", etag)
        handler.end_headers()
        return True
    handler.send_response(200)
    handler.send_header("Content-Type", "image/x-icon")
    handler.send_header("Content-Length", str(len(blob)))
    handler.send_header("ETag", etag)
    handler.send_header("Cache-Control", "public, max-age=2592000, immutable")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.end_headers()
    try:
        handler.wfile.write(blob)
    except (BrokenPipeError, ConnectionResetError):
        pass
    return True


_RESP_BYTE_BUDGET = 450_000  # keep the serialized JSON body under the proxy's 512 KiB cap


def _cap_by_bytes(items: list[dict], budget: int = _RESP_BYTE_BUDGET):
    """Trim a newest-first list so its serialized JSON stays under the proxy's
    512 KiB response cap — otherwise the proxy rejects the WHOLE body and the
    view goes blank. Keeps the leading (newest) items and reports whether it
    trimmed, so the client can page older ones via ?before=. Always keeps at
    least one item so a single oversized row still returns something."""
    out: list[dict] = []
    used = 2  # the enclosing [] brackets
    for it in items:
        size = len(json.dumps(it, default=str).encode("utf-8")) + 1  # + comma
        if out and used + size > budget:
            return out, True
        out.append(it)
        used += size
    return out, False


def handle_get(handler, parsed) -> bool:
    """Dispatch GET /api/feeds/* routes."""
    path = parsed.path
    if path == "/api/feeds/favicon":
        from urllib.parse import parse_qs
        return handle_favicon(handler, parse_qs(parsed.query).get("domain", [""])[0])
    if path == "/api/feeds":
        return j(handler, {"feeds": list_feeds(), "settings": get_settings()})
    if path == "/api/feeds/settings":
        return j(handler, get_settings())
    if path == "/api/feeds/summary-status":
        return j(handler, _summary_status())
    if path == "/api/feeds/refresh-status":
        return j(handler, refresh_status())
    if path == "/api/feeds/summary-test-status":
        return j(handler, summary_test_status())
    if path == "/api/feeds/entries":
        from urllib.parse import parse_qs
        qs = parse_qs(parsed.query)
        kwargs: dict[str, Any] = {}
        if "feed_id" in qs:
            try:
                kwargs["feed_id"] = int(qs["feed_id"][0])
            except ValueError:
                return _err(handler, 400, "feed_id must be integer")
        if "category" in qs:
            kwargs["category"] = qs["category"][0]
        if "limit" in qs:
            try:
                kwargs["limit"] = int(qs["limit"][0])
            except ValueError:
                return _err(handler, 400, "limit must be integer")
        if "since" in qs:
            try:
                kwargs["since"] = float(qs["since"][0])
            except ValueError:
                return _err(handler, 400, "since must be epoch seconds")
        if qs.get("filter", [""])[0].lower() in {"1", "true", "yes"}:
            kwargs["apply_filter"] = True
        if qs.get("read_only", [""])[0].lower() in {"1", "true", "yes"}:
            kwargs["read_only"] = True
        if "feed_ids" in qs:
            try:
                kwargs["feed_ids"] = [int(x) for x in qs["feed_ids"][0].split(",") if x.strip()]
            except ValueError:
                return _err(handler, 400, "feed_ids must be comma-separated integers")
        if "q" in qs:
            kwargs["q"] = qs["q"][0][:200]
        if "before" in qs:
            try:
                kwargs["before"] = float(qs["before"][0])
            except ValueError:
                return _err(handler, 400, "before must be epoch seconds")
        entries = list_entries(**kwargs)
        capped, truncated = _cap_by_bytes(entries)
        resp: dict[str, Any] = {"entries": capped}
        if truncated:
            # Trimmed to fit the proxy cap — expose a cursor so the client can
            # fetch the older remainder with ?before=<next_before>.
            resp["truncated"] = True
            last = capped[-1] if capped else None
            if last is not None:
                resp["next_before"] = last.get("published_at") or last.get("fetched_at")
        return j(handler, resp)
    if path == "/api/feeds/summaries":
        from urllib.parse import parse_qs
        qs = parse_qs(parsed.query)
        if "id" in qs:
            try:
                sid = int(qs["id"][0])
            except ValueError:
                return _err(handler, 400, "id must be integer")
            s = get_summary(summary_id=sid)
            return j(handler, {"summary": s}) if s else _err(handler, 404, "summary not found")
        if "entry_id" in qs:
            try:
                eid = int(qs["entry_id"][0])
            except ValueError:
                return _err(handler, 400, "entry_id must be integer")
            return j(handler, {"summary": get_summary(entry_id=eid)})
        limit = 50
        if "limit" in qs:
            try:
                limit = int(qs["limit"][0])
            except ValueError:
                return _err(handler, 400, "limit must be integer")
        return j(handler, list_summaries(limit=limit))
    return False  # unmatched


def handle_post(handler, parsed, body: dict) -> bool:
    if not _require_auth(handler):
        return _err(handler, 401, "Authentication required")
    path = parsed.path
    if path == "/api/feeds":
        try:
            f = create_feed(
                body.get("name", ""),
                body.get("url", ""),
                body.get("category", "general"),
                int(body.get("fetch_interval_minutes", 60) or 60),
            )
        except ValueError as e:
            return _err(handler, 400, str(e))
        # Validate IMMEDIATELY: fetch the feed once so a bad URL / non-feed
        # page is reported right in the Add dialog instead of failing silently
        # on the next refresh. On failure the feed is rolled back.
        check = fetch_feed(f["id"])
        status = str(check.get("status", ""))
        if not status.startswith("ok"):
            delete_feed(f["id"])
            reason = check.get("error") or status or "unreachable"
            if status.startswith("http_"):
                reason = status.replace("http_", "HTTP ")
            elif status == "no_entries":
                reason = "URL responded but is not a valid RSS/Atom feed (no entries)"
            return _err(handler, 422, f"Feed check failed: {str(reason)[:200]}")
        f["check"] = {"status": status,
                      "new_entries": int(check.get("new_entries", 0) or 0)}
        return j(handler, f, status=201)
    if path == "/api/feeds/refresh":
        # Start a background job + return 202 immediately. A synchronous refresh
        # (~10-30s) would exceed the proxy's 10s timeout; the UI polls
        # GET /api/feeds/refresh-status for progress + results.
        ids = body.get("feed_ids")
        snap = start_refresh(ids if isinstance(ids, list) else None)
        return j(handler, {"running": True, "started_at": int(snap.get("started_at", 0))},
                 status=202)
    if path == "/api/feeds/read":
        # Server-side read state (cross-device). {id, read?} or {ids:[...], read?}.
        read = body.get("read", True)
        ids = body.get("ids")
        if not isinstance(ids, list):
            single = body.get("id")
            ids = [single] if single is not None else []
        n = 0
        for eid in ids:
            try:
                if mark_read(int(eid), bool(read)):
                    n += 1
            except (TypeError, ValueError):
                pass
        return j(handler, {"updated": n})
    if path == "/api/feeds/summary-test":
        # Connectivity/model check for the RSS-settings "Test" button. Uses the
        # CURRENT persisted summary config (Save first, then Test). Runs as a
        # background job (202) since the model call can exceed the 10s proxy
        # limit on a cold model; the UI polls /api/feeds/summary-test-status.
        snap = start_summary_test()
        return j(handler, snap, status=202)
    if path == "/api/feeds/summarize":
        return _handle_summarize(handler, body)
    if path == "/api/feeds/settings":
        try:
            kws = body.get("keywords")
            fe = body.get("filter_enabled")
            afm = body.get("auto_fetch_minutes")
            epp = body.get("entries_per_page")
            rr = body.get("read_retain")
            vf = body.get("visible_feeds")
            sc = body.get("summary_config")
            updated = update_settings(
                keywords=kws if isinstance(kws, list) else None,
                filter_enabled=fe if isinstance(fe, bool) else None,
                auto_fetch_minutes=afm if isinstance(afm, (int, float)) else None,
                entries_per_page=epp if isinstance(epp, (int, float)) else None,
                read_retain=rr if isinstance(rr, (int, float)) else None,
                visible_feeds=vf if isinstance(vf, list) else None,
                summary_config=sc if isinstance(sc, dict) else None,
            )
            return j(handler, updated)
        except Exception as exc:
            return _err(handler, 400, str(exc))
    return False


def handle_patch(handler, parsed, body: dict) -> bool:
    if not _require_auth(handler):
        return _err(handler, 401, "Authentication required")
    path = parsed.path
    if path.startswith("/api/feeds/"):
        try:
            feed_id = int(path.split("/")[-1])
        except (ValueError, IndexError):
            return _err(handler, 400, "invalid feed id")
        if update_feed(feed_id, body or {}):
            return j(handler, {"updated": True, "id": feed_id})
        return _err(handler, 404, "feed not found or no changes")
    return False


def handle_delete(handler, parsed) -> bool:
    if not _require_auth(handler):
        return _err(handler, 401, "Authentication required")
    path = parsed.path
    if path.startswith("/api/feeds/summaries/"):
        try:
            sid = int(path.split("/")[-1])
        except (ValueError, IndexError):
            return _err(handler, 400, "invalid summary id")
        if delete_summary(sid):
            return j(handler, {"deleted": True, "id": sid})
        return _err(handler, 404, "summary not found")
    if path.startswith("/api/feeds/"):
        try:
            feed_id = int(path.split("/")[-1])
        except (ValueError, IndexError):
            return _err(handler, 400, "invalid feed id")
        if delete_feed(feed_id):
            return j(handler, {"deleted": True, "id": feed_id})
        return _err(handler, 404, "feed not found")
    return False


# ── Summarization (FREE-ONLY: local ollama → OpenRouter :free) ────────────
def _handle_summarize(handler, body: dict) -> bool:
    """Body: {scope, target, model?}
       scope  ∈ {entry, feed, category, all}
       target = entry_id (int) | feed_id (int) | category (str) | (ignored for 'all')
       model  = optional override; defaults to the active profile's default

    Builds a plaintext digest of the relevant entries' titles + summaries,
    sends it to the agent loop via the same streaming infrastructure used
    by chat, returns the model's markdown response.

    Token consumption only happens here. All browsing/reading goes through
    /api/feeds and /api/feeds/entries which are pure SQLite reads.
    """
    scope = (body or {}).get("scope", "")
    target = (body or {}).get("target")
    model_override = (body or {}).get("model") or None
    if scope not in {"entry", "feed", "category", "all", "feeds"}:
        return _err(handler, 400, "scope must be one of: entry, feed, category, all, feeds")

    # Resolve entries for the scope
    entries: list[dict] = []
    if scope == "entry":
        try:
            entry_id = int(target)
        except (TypeError, ValueError):
            return _err(handler, 400, "target must be an entry id for scope=entry")
        conn = _open()
        try:
            row = conn.execute(
                "SELECT e.id, e.title, e.link, e.summary, e.published_at, f.name AS feed_name "
                "FROM entries e JOIN feeds f ON f.id = e.feed_id WHERE e.id = ?", (entry_id,)
            ).fetchone()
            if not row:
                return _err(handler, 404, "entry not found")
            entries.append(dict(row))
        finally:
            conn.close()
    elif scope == "feed":
        try:
            feed_id = int(target)
        except (TypeError, ValueError):
            return _err(handler, 400, "target must be a feed id for scope=feed")
        entries = list_entries(feed_id=feed_id, limit=30)
    elif scope == "category":
        if not target:
            return _err(handler, 400, "target must be a category name for scope=category")
        entries = list_entries(category=str(target), limit=50)
    elif scope == "all":
        entries = list_entries(limit=80)
    elif scope == "feeds":
        # Multi-select from the Summarize popup. target = [feed_id, ...].
        # Filter-aware: when the keyword filter is ON, only keyword-matching
        # entries of the selected feeds are summarized; OFF = all their entries.
        ids = target if isinstance(target, list) else []
        try:
            ids = [int(x) for x in ids]
        except (TypeError, ValueError):
            return _err(handler, 400, "target must be a list of feed ids for scope=feeds")
        if not ids:
            return _err(handler, 400, "select at least one feed to summarize")
        filter_on = bool(get_settings().get("filter_enabled"))
        seen = set()
        for fid in ids:
            for e in list_entries(feed_id=fid, limit=30, apply_filter=filter_on):
                if e["id"] not in seen:
                    seen.add(e["id"])
                    entries.append(e)

    if not entries:
        return _err(handler, 404, "no entries to summarize for that scope")

    # The prompt is built in the BACKGROUND worker (so the optional full-article
    # fetch doesn't block this response). Slim the entries to what it needs.
    work_entries = [
        {"id": e.get("id"), "title": e.get("title"), "link": e.get("link"),
         "feed_name": e.get("feed_name"), "summary": e.get("summary")}
        for e in entries
    ]

    # Human-readable label + the entry_id (single-article only) used to attach
    # the result inline to its card.
    inline_entry_id = None
    if scope == "entry":
        inline_entry_id = entries[0].get("id")
        label = entries[0].get("title") or "Article summary"
    elif scope == "feed":
        label = f"{entries[0].get('feed_name') or 'Feed'} digest"
    elif scope == "category":
        label = f"{str(target).title()} digest"
    elif scope == "all":
        label = "World Wide digest"
    else:  # feeds (multi-select)
        label = f"{len(entries)} entries digest"

    # Persist a 'running' row, then summarize in the background so the user can
    # navigate away — the result is waiting in 🧠 Summaries (and on the card)
    # when they return. FREE backends only (local ollama → OpenRouter :free).
    # The summarized articles, for the 'Source' hyperlink(s) at the end of the
    # digest — so you always know exactly which article(s) were summarized.
    sources = [
        {"feed": e.get("feed_name") or "?",
         "title": e.get("title") or "(untitled)",
         "link": e.get("link") or ""}
        for e in entries
    ]

    # Bound concurrent summarize jobs so a burst can't spawn unlimited daemon
    # threads (each one holds an LLM connection). Reject once the cap is hit.
    if not _summary_sem.acquire(blocking=False):
        return _err(handler, 429, "too many summaries in progress — try again shortly")

    try:
        now = time.time()
        conn = _open()
        try:
            # Rerun semantics for a single article: one article = one current
            # summary. Drop any prior summary for this entry so a re-run replaces
            # it (no duplicates piling up) and the inline card shows only the new one.
            if scope == "entry" and inline_entry_id is not None:
                conn.execute("DELETE FROM summaries WHERE entry_id = ? AND scope = 'entry'",
                             (inline_entry_id,))
            cur = conn.execute(
                "INSERT INTO summaries (scope, target, entry_id, title, status, "
                "entry_count, sources, created_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)",
                (scope, json.dumps(target) if target is not None else None,
                 inline_entry_id, label[:200], len(entries), json.dumps(sources), now),
            )
            summary_id = cur.lastrowid
            conn.commit()
        finally:
            conn.close()
    except Exception:
        _summary_sem.release()  # never leak a permit if setup fails before the thread starts
        raise

    def _run_summary():
        try:
            _summary_worker(summary_id, work_entries, scope)
        finally:
            _summary_sem.release()

    t = __import__("threading").Thread(target=_run_summary, daemon=True)
    t.start()

    return j(handler, {
        "status": "started",
        "id": summary_id,
        "scope": scope,
        "title": label,
        "entry_id": inline_entry_id,
        "entry_count": len(entries),
    })


def _summary_worker(summary_id: int, entries: list[dict], scope: str) -> None:
    """Background: build the prompt (fetching full article text for single-
    article summaries), run the free summarizer, write the result back."""
    try:
        prompt = _build_summary_prompt(entries, scope)
        content, model = _summarize_llm(prompt)
        conn = _open()
        try:
            conn.execute(
                "UPDATE summaries SET status='done', content=?, model=?, "
                "completed_at=? WHERE id=?",
                (content, model, time.time(), summary_id),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        logger.warning("summary %s failed: %s", summary_id, e)
        try:
            conn = _open()
            try:
                conn.execute(
                    "UPDATE summaries SET status='error', error=?, completed_at=? WHERE id=?",
                    (str(e)[:500], time.time(), summary_id),
                )
                conn.commit()
            finally:
                conn.close()
        except Exception:
            pass


# ── Summaries: list / read / delete ────────────────────────────────────────
def list_summaries(limit: int = 50) -> dict:
    """Light list (no content) for the 🧠 Summaries view + a running count and
    the set of entry_ids that have a finished single-article summary (so cards
    can show the inline 'Summary' expander)."""
    limit = max(1, min(500, int(limit)))
    conn = _open()
    try:
        rows = conn.execute(
            "SELECT id, scope, entry_id, title, status, model, error, "
            "entry_count, created_at, completed_at FROM summaries "
            "ORDER BY created_at DESC LIMIT ?", (limit,),
        ).fetchall()
        running = conn.execute(
            "SELECT COUNT(*) FROM summaries WHERE status='running'").fetchone()[0]
        total = conn.execute("SELECT COUNT(*) FROM summaries").fetchone()[0]
        clicked = conn.execute(
            "SELECT COUNT(*) FROM entries WHERE read_at IS NOT NULL").fetchone()[0]
        done_entry_ids = [
            r[0] for r in conn.execute(
                "SELECT DISTINCT entry_id FROM summaries "
                "WHERE entry_id IS NOT NULL AND status='done'").fetchall()
        ]
    finally:
        conn.close()
    return {
        "summaries": [dict(r) for r in rows],
        "running": running,
        "total": total,
        "clicked": clicked,
        "done_entry_ids": done_entry_ids,
    }


def get_summary(summary_id: int | None = None, entry_id: int | None = None) -> dict | None:
    """Full single summary (incl. content). By id, or the latest for an entry."""
    conn = _open()
    try:
        if summary_id is not None:
            row = conn.execute(
                "SELECT * FROM summaries WHERE id=?", (summary_id,)).fetchone()
        elif entry_id is not None:
            row = conn.execute(
                "SELECT * FROM summaries WHERE entry_id=? "
                "ORDER BY created_at DESC LIMIT 1", (entry_id,)).fetchone()
        else:
            return None
    finally:
        conn.close()
    return dict(row) if row else None


def delete_summary(summary_id: int) -> bool:
    conn = _open()
    try:
        cur = conn.execute("DELETE FROM summaries WHERE id=?", (summary_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()
