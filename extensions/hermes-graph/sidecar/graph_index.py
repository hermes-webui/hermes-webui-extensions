"""graph_index.py — stdlib-only indexer for the hermes-graph sidecar.

Builds ONE in-memory graph snapshot from:
  * workspace roots   (files, dirs, links, imports, mentions, similarity)
  * ~/.hermes/skills  (SKILL.md frontmatter + references/ + scripts/)
  * ~/.hermes/memories (MEMORY.md / USER.md entries, split on the "§" line)
  * ~/.hermes/webui/sessions (_index.json + tool_calls of each session json)
  * ~/.hermes/cron/jobs.json, ~/.hermes/config.yaml (mcp_servers key NAMES only)

Design rules (see ESTUDO.md):
  * read-only; symlinks are never followed; nothing outside the configured roots is read
  * sensitive files (creds/tokens/keys/.env) are never opened — only their *name* can
    surface as a ``secret`` node when something else references it
  * no snippets of file content leave the process — edges carry (kind, weight, line)
  * per-file extraction is cached in SQLite keyed by (mtime_ns, size) => incremental
  * every regex is length-bounded (no unbounded scans of attacker-influenced text)
"""
from __future__ import annotations

import bisect
import fnmatch
import hashlib
import json
import math
import os
import random
import re
import sqlite3
import threading
import time
from collections import Counter, defaultdict, deque
from pathlib import Path
from typing import Dict, List, Optional, Tuple

SCHEMA_VERSION = 1

# ── limits ────────────────────────────────────────────────────────────────────
MAX_PARSE_BYTES = 256 * 1024        # bytes read per file for extraction
MAX_FILES_PER_ROOT = 20000
MAX_SESSION_BYTES = 32 * 1024 * 1024
MAX_DEPTH = 14
BUILD_BUDGET_S = 120.0              # hard stop for one build
RARE_DF_MAX = 20                    # token is "rare" if it appears in <= N docs
SIM_MIN_SHARED = 4
SIM_MIN_JACCARD = 0.15

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".cache", ".mypy_cache",
             ".pytest_cache", ".idea", ".vscode", ".drafts", "dist", "build", ".tox", ".next"}
# sensitive: never opened, never listed. Matched case-insensitively on the basename.
SENSITIVE_FILE = ("*cred*", "*password*", "*passwd*", "*secret*", "*token*", "*apikey*",
                  "*api_key*", "*.pem", "*.key", "*.p12", "*.pfx", "*.kdbx", ".env", ".env.*",
                  "*.env", "id_rsa*", "id_ed25519*", "auth.json", "*.keytab", "*.ovpn",
                  "wg*.conf", "*private*")
SENSITIVE_DIR = ("*cred*", "vault", "mcp-tokens", ".ssh", ".gnupg", "whatsapp", "*secret*",
                 "sidecar-auth", "*private*")
TEXT_EXT = {".md", ".markdown", ".txt", ".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs",
            ".ts", ".json", ".yaml", ".yml", ".toml", ".conf", ".cfg", ".ini", ".log", ".csv",
            ".html", ".htm", ".css", ".sql", ".service", ".rsc", ".c", ".h", ".cpp", ".asp",
            ".php", ".rb", ".go", ".rs", ".xml", ".tsv", ".env.example", ".rules", ".cron"}

EDGE_KINDS = ["contains", "md_link", "wikilink", "embed", "import", "exec", "mention",
              "similar", "tag", "entity", "skill_use", "cron_skill", "cron_script",
              "mcp", "skill_ref", "secret_ref", "dup"]
EDGE_WEIGHT = {"contains": 0.15, "md_link": 1.0, "wikilink": 1.0, "embed": 1.0, "import": 0.9,
               "exec": 0.7, "mention": 0.5, "similar": 0.6, "tag": 0.4, "entity": 0.35,
               "skill_use": 0.8, "cron_skill": 0.9, "cron_script": 0.9, "mcp": 0.6,
               "skill_ref": 0.8, "secret_ref": 0.5, "dup": 0.3}
NODE_TYPES = ["dir", "file", "tag", "memory", "skill", "session", "cron", "mcp_server",
              "entity", "secret"]

# ── bounded regexes ───────────────────────────────────────────────────────────
RE_MD_LINK = re.compile(r"(?<!\!)\[[^\]\n]{0,200}\]\(\s{0,3}<?([^)\s>#]{1,300})(?:#[^)\s]{0,100})?(?:\s{1,3}\"[^\"\n]{0,200}\")?\s{0,3}>?\)")
RE_MD_IMG = re.compile(r"\!\[[^\]\n]{0,200}\]\(\s{0,3}<?([^)\s>#]{1,300})(?:#[^)\s]{0,100})?[^)\n]{0,200}\)")
RE_WIKI = re.compile(r"(?<!\!)\[\[([^\]|#\n]{1,200})(?:#[^\]|\n]{0,100})?(?:\|[^\]\n]{0,200})?\]\]")
RE_EMBED = re.compile(r"\!\[\[([^\]|#\n]{1,200})(?:#[^\]|\n]{0,100})?(?:\|[^\]\n]{0,200})?\]\]")
RE_TAG = re.compile(r"(?:(?<=\s)|^)#([A-Za-z][\w/\-]{1,40})(?![\w/\-]*[#(])", re.M)
RE_HEXCOLOR = re.compile(r"^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$")
RE_SH_SOURCE = re.compile(r"^\s{0,40}(?:source|\.)\s{1,10}[\"']?([^\s\"';&|]{1,300})", re.M)
RE_SH_EXEC = re.compile(r"(?:^|[;&|(\s])(?:bash|sh|python3?|node|perl)\s{1,10}(?:-[\w-]{1,20}\s{1,10}){0,3}[\"']?([^\s\"';&|]{1,300}\.(?:sh|py|js|pl))\b", re.M)
RE_SH_DOTSLASH = re.compile(r"(?:^|[;&|(\s])\./([\w./\-]{1,200}\.(?:sh|py|js))\b", re.M)
RE_PY_IMPORT = re.compile(r"^\s{0,40}import\s{1,5}([\w.]{1,100}(?:\s{0,3},\s{0,3}[\w.]{1,100}){0,8})", re.M)
RE_PY_FROM = re.compile(r"^\s{0,40}from\s{1,5}(\.{0,4}[\w.]{0,100})\s{1,5}import\b", re.M)
RE_JS_IMPORT = re.compile(r"(?:require\(\s{0,3}|from\s{1,5}|import\s{1,5})[\"'](\.{1,2}/[^\"'\n]{1,200})[\"']")
RE_C_INCLUDE = re.compile(r"^\s{0,10}#\s{0,5}include\s{1,5}\"([^\"\n]{1,200})\"", re.M)
RE_TOKEN_FILE = re.compile(r"[\w][\w.\-]{3,80}\.[A-Za-z0-9]{1,6}\b|[\w]{1,40}[_\-][\w\-]{2,60}")
RE_WORD = re.compile(r"[A-Za-z][A-Za-z0-9_]{4,30}")
RE_IPV4 = re.compile(r"(?<![\w.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\w])")
RE_CT = re.compile(r"\b[Cc][Tt][-_ ]?(\d{2,4})\b")
RE_DOMAIN = re.compile(r"(?<![\w.@/\-])(?:[a-z0-9](?:[a-z0-9\-]{0,40}[a-z0-9])?\.){1,4}(?:tech|com|net|org|io|dev|local|lan|br|app|cloud|info)\b", re.I)
RE_SECRET_NAME = re.compile(r"\b[\w.\-]{0,60}(?:creds?|credentials?|password|secret|token)s?[\w.\-]{0,40}\.(?:txt|json|env|cfg|conf|yaml|yml)\b", re.I)
RE_SECRET_CONTENT = re.compile(r"-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----|AKIA[0-9A-Z]{16}|(?i:api[_-]?key|secret|passw(?:or)?d|token)\s{0,3}[:=]\s{0,3}[\"']?[A-Za-z0-9/+_\-]{16,}")
GENERIC_SEGMENTS = {"workspace", "deployment", "administration", "management", "development", "operations",
                    "automation", "integration", "configuration", "monitoring", "troubleshooting", "dispatch",
                    "research", "software", "general", "projects", "creative", "database", "services"}
STOP_NAMES = {"README.md", "SKILL.md", "index.md", "index.html", "__init__.py", "package.json",
              "requirements.txt", "config.json", "LICENSE", "Makefile", "main.py", "test.py",
              "output.txt", "output.json", "result.json", "results.json", "data.json", "notes.md"}


def safe_label(text: str, n: int = 64) -> str:
    """Node labels come from raw memory text: mask anything that looks like a credential first."""
    return re.sub(r"\s+", " ", RE_SECRET_CONTENT.sub("***", text))[:n]


def is_sensitive_file(name: str) -> bool:
    n = name.lower()
    return any(fnmatch.fnmatchcase(n, p) for p in SENSITIVE_FILE)


def is_sensitive_dir(name: str) -> bool:
    n = name.lower()
    return any(fnmatch.fnmatchcase(n, p) for p in SENSITIVE_DIR)


# ── config ────────────────────────────────────────────────────────────────────
class Config:
    def __init__(self) -> None:
        home = Path(os.environ.get("HOME", "~")).expanduser()
        self.hermes_home = Path(os.environ.get("HERMES_HOME", str(home / ".hermes"))).expanduser()
        state = os.environ.get("HERMES_WEBUI_STATE_DIR") or str(self.hermes_home / "webui")
        self.state_dir = Path(state).expanduser()
        roots: Dict[str, Path] = {}
        raw = os.environ.get("HERMES_GRAPH_ROOTS", "").strip()
        if raw:
            for part in raw.split(","):
                if "=" in part:
                    a, p = part.split("=", 1)
                    roots[a.strip()] = Path(p.strip()).expanduser()
        else:
            roots["ws"] = self._default_workspace(home)
        roots.setdefault("sk", self.hermes_home / "skills")
        self.roots = roots
        self.cache_path = Path(os.environ.get(
            "HERMES_GRAPH_CACHE", str(self.state_dir / "hermes-graph" / "index.sqlite3"))).expanduser()
        self.ttl = int(os.environ.get("HERMES_GRAPH_TTL", "120"))

    def _default_workspace(self, home: Path) -> Path:
        try:  # non-secret key only; the rest of settings.json is ignored
            d = json.loads((self.state_dir / "settings.json").read_text(encoding="utf-8"))
            p = d.get("default_workspace")
            if isinstance(p, str) and p:
                return Path(p).expanduser()
        except (OSError, ValueError):
            pass
        return home / "workspace"


# ── cache ─────────────────────────────────────────────────────────────────────
class Cache:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)")
        row = self.db.execute("SELECT v FROM meta WHERE k='schema'").fetchone()
        if not row or row[0] != str(SCHEMA_VERSION):
            self.db.execute("DROP TABLE IF EXISTS ent")
            self.db.execute("INSERT OR REPLACE INTO meta VALUES('schema',?)", (str(SCHEMA_VERSION),))
        self.db.execute("CREATE TABLE IF NOT EXISTS ent(k TEXT PRIMARY KEY, mtime_ns INTEGER, size INTEGER, data TEXT)")
        self.db.commit()
        self.hits = self.misses = 0

    def get(self, key: str, mtime_ns: int, size: int) -> Optional[dict]:
        r = self.db.execute("SELECT mtime_ns,size,data FROM ent WHERE k=?", (key,)).fetchone()
        if r and r[0] == mtime_ns and r[1] == size:
            self.hits += 1
            return json.loads(r[2])
        self.misses += 1
        return None

    def put(self, key: str, mtime_ns: int, size: int, data: dict) -> None:
        self.db.execute("INSERT OR REPLACE INTO ent VALUES(?,?,?,?)", (key, mtime_ns, size, json.dumps(data, separators=(",", ":"))))

    def prune(self, live: set) -> int:
        cur = [r[0] for r in self.db.execute("SELECT k FROM ent")]
        dead = [k for k in cur if k not in live]
        self.db.executemany("DELETE FROM ent WHERE k=?", [(k,) for k in dead])
        return len(dead)

    def commit(self) -> None:
        self.db.commit()


# ── extraction (pure functions, unit-testable) ────────────────────────────────
def blank_code_fences(text: str) -> str:
    """Replace the body of ``` fenced blocks with spaces (keeps offsets / line numbers)."""
    out, fence = [], False
    for line in text.split("\n"):
        if line.lstrip().startswith("```") or line.lstrip().startswith("~~~"):
            fence = not fence
            out.append(" " * len(line))
        elif fence:
            out.append(" " * len(line))
        else:
            out.append(line)
    return "\n".join(out)


def parse_frontmatter(text: str) -> Tuple[dict, int]:
    """Minimal YAML-subset frontmatter: scalars, inline [a, b] lists, '- x' lists.
    Returns (dict, end_offset). Not a YAML parser on purpose (no deps, no code exec)."""
    if not text.startswith("---"):
        return {}, 0
    end = text.find("\n---", 3, 20000)
    if end < 0:
        return {}, 0
    block = text[3:end].strip("\n")
    fm: dict = {}
    cur = None
    for line in block.split("\n")[:200]:
        if re.match(r"^\s{0,8}-\s", line) and cur:
            fm.setdefault(cur, [])
            if isinstance(fm[cur], list):
                fm[cur].append(line.split("-", 1)[1].strip().strip("\"'"))
            continue
        m = re.match(r"^([A-Za-z_][\w\-]{0,40}):\s{0,3}(.{0,500})$", line)
        if not m:
            continue
        cur, val = m.group(1), m.group(2).strip()
        if val.startswith("[") and val.endswith("]"):
            fm[cur] = [v.strip().strip("\"'") for v in val[1:-1].split(",") if v.strip()]
        elif val == "":
            fm[cur] = []
        else:
            fm[cur] = val.strip("\"'")
    return fm, end + 4


def _line_of(starts: List[int], off: int) -> int:
    return bisect.bisect_right(starts, off)


def extract_text(rel: str, text: str) -> dict:
    """Raw (unresolved) references of one document. Everything is JSON-serialisable."""
    ext = os.path.splitext(rel)[1].lower()
    starts = [0]
    for m in re.finditer("\n", text):
        starts.append(m.end())
    out: dict = {"links": [], "tags": [], "fm": {}, "ents": [], "toks": [], "rare": [], "secret_names": [], "has_secret": False}

    def add(kind, rx, scan, group=1, cap=400):
        n = 0
        for m in rx.finditer(scan):
            tgt = m.group(group).strip()
            if not tgt or tgt.startswith(("http:", "https:", "mailto:", "data:", "tel:", "javascript:", "#")):
                continue
            out["links"].append([kind, tgt, _line_of(starts, m.start())])
            n += 1
            if n >= cap:
                break

    if ext in (".md", ".markdown", ".txt", ".html", ".htm"):
        scan = blank_code_fences(text) if ext in (".md", ".markdown") else text
        if ext in (".md", ".markdown"):
            fm, _ = parse_frontmatter(text)
            out["fm"] = {k: v for k, v in fm.items() if k in ("name", "description", "tags", "aliases", "title", "related_skills", "category", "version")}
            out["fm_keys"] = sorted(fm.keys())[:30]
            tags = fm.get("tags") or fm.get("tag") or []
            if isinstance(tags, str):
                tags = [t.strip() for t in tags.split(",")]
            for t in tags[:20]:
                t = t.lstrip("#").strip()
                if t:
                    out["tags"].append(t.lower())
            for m in RE_TAG.finditer(scan):
                t = m.group(1)
                if not RE_HEXCOLOR.match(t):
                    out["tags"].append(t.lower())
                if len(out["tags"]) > 40:
                    break
            out["h"] = len(re.findall(r"^#{1,6}\s", scan, re.M))
        if scan.count("[") > 4000:            # pathological bracket density (minified/generated/hostile): skip link regexes
            out["patho"] = True
        elif "[[" in scan:                    # cheap prefilters keep the common case linear
            add("embed", RE_EMBED, scan)
            add("wikilink", RE_WIKI, scan)
        if "](" in scan and not out.get("patho"):
            add("embed", RE_MD_IMG, scan)
            add("md_link", RE_MD_LINK, scan)
    elif ext in (".sh", ".bash", ".zsh", ".service", ".cron", ".rules"):
        add("exec", RE_SH_SOURCE, text)
        add("exec", RE_SH_EXEC, text)
        add("exec", RE_SH_DOTSLASH, text)
    elif ext == ".py":
        for m in RE_PY_FROM.finditer(text):
            out["links"].append(["import", "py:" + m.group(1), _line_of(starts, m.start())])
        for m in RE_PY_IMPORT.finditer(text):
            for part in m.group(1).split(","):
                part = part.strip()
                if part:
                    out["links"].append(["import", "py:" + part, _line_of(starts, m.start())])
        add("exec", RE_SH_EXEC, text)
    elif ext in (".js", ".mjs", ".cjs", ".ts"):
        add("import", RE_JS_IMPORT, text)
    elif ext in (".c", ".h", ".cpp"):
        add("import", RE_C_INCLUDE, text)
    else:
        add("exec", RE_SH_EXEC, text, cap=50)

    # entities (IPs, CTs, domains) — line of first occurrence
    seen = set()
    for kind, rx, norm in (("ip", RE_IPV4, lambda m: m.group(0)),
                           ("ct", RE_CT, lambda m: "CT" + m.group(1)),
                           ("domain", RE_DOMAIN, lambda m: m.group(0).lower())):
        for m in rx.finditer(text):
            v = norm(m)
            if kind == "ip" and (v.startswith(("0.", "255.")) or v in ("127.0.0.1",)):
                continue
            key = (kind, v)
            if key in seen:
                continue
            seen.add(key)
            out["ents"].append([kind, v, _line_of(starts, m.start())])
            if len(out["ents"]) >= 300:
                break
    # file-like tokens (for basename mentions) and rare-word bag (for similarity)
    toks = []
    seen_t = set()
    for m in RE_TOKEN_FILE.finditer(text):
        t = m.group(0)
        if t not in seen_t:
            seen_t.add(t)
            toks.append([t, _line_of(starts, m.start())])
            if len(toks) >= 500:
                break
    out["toks"] = toks
    out["rare"] = sorted({w.lower() for w in RE_WORD.findall(text)})[:3000]
    out["secret_names"] = sorted({m.group(0) for m in RE_SECRET_NAME.finditer(text)})[:30]
    out["has_secret"] = bool(RE_SECRET_CONTENT.search(text))
    return out


# ── Louvain (one pass + aggregation, deterministic) ───────────────────────────
def louvain(n: int, edges: List[Tuple[int, int, float]], seed: int = 7, max_levels: int = 4) -> List[int]:
    rnd = random.Random(seed)
    comm_of_node = list(range(n))
    cur_n = n
    cur_edges = edges
    for _ in range(max_levels):
        adj: List[Dict[int, float]] = [defaultdict(float) for _ in range(cur_n)]
        m2 = 0.0
        for a, b, w in cur_edges:
            if a == b:
                adj[a][a] += w
                m2 += w * 2
            else:
                adj[a][b] += w
                adj[b][a] += w
                m2 += w * 2
        if m2 == 0:
            break
        k = [sum(d.values()) + d.get(i, 0.0) for i, d in enumerate(adj)]
        comm = list(range(cur_n))
        tot = k[:]
        improved_any = False
        order = list(range(cur_n))
        for _it in range(10):
            rnd.shuffle(order)
            moved = 0
            for i in order:
                ci = comm[i]
                links: Dict[int, float] = defaultdict(float)
                for j, w in adj[i].items():
                    if j != i:
                        links[comm[j]] += w
                tot[ci] -= k[i]
                best, best_gain = ci, links.get(ci, 0.0) - tot[ci] * k[i] / m2
                for c, w in links.items():
                    gain = w - tot[c] * k[i] / m2
                    if gain > best_gain + 1e-12:
                        best, best_gain = c, gain
                tot[best] += k[i]
                if best != ci:
                    comm[i] = best
                    moved += 1
            if not moved:
                break
            improved_any = True
        if not improved_any:
            break
        remap = {c: idx for idx, c in enumerate(sorted(set(comm)))}
        comm = [remap[c] for c in comm]
        comm_of_node = [comm[c] for c in comm_of_node]
        agg: Dict[Tuple[int, int], float] = defaultdict(float)
        for a, b, w in cur_edges:
            ca, cb = comm[a], comm[b]
            agg[(min(ca, cb), max(ca, cb))] += w
        cur_edges = [(a, b, w) for (a, b), w in agg.items()]
        if len(remap) == cur_n:
            break
        cur_n = len(remap)
    return comm_of_node


# ── builder ───────────────────────────────────────────────────────────────────
class Builder:
    def __init__(self, cfg: Config, cache: Cache) -> None:
        self.cfg = cfg
        self.cache = cache
        self.t0 = time.time()
        self.stats: Dict[str, object] = defaultdict(int)
        self.nodes: Dict[str, dict] = {}
        self.edges: Dict[Tuple[str, str, str], dict] = {}
        self.sens_names: Dict[str, str] = {}   # basename -> root alias (existing sensitive files)
        self.skill_seg: Dict[str, List[str]] = {}
        self.session_keys: set = set()
        self.cron_pending: List[Tuple[str, dict]] = []

    # -- helpers
    def over_budget(self) -> bool:
        return time.time() - self.t0 > BUILD_BUDGET_S

    def node(self, nid: str, ntype: str, label: str, **attrs) -> dict:
        n = self.nodes.get(nid)
        if n is None:
            n = {"id": nid, "t": ntype, "label": label}
            n.update(attrs)
            self.nodes[nid] = n
        return n

    def edge(self, s: str, t: str, kind: str, w: Optional[float] = None, line: int = 0) -> None:
        if s == t or s not in self.nodes or t not in self.nodes:
            return
        k = (s, t, kind) if kind not in ("similar", "dup") else (min(s, t), max(s, t), kind)
        e = self.edges.get(k)
        if e is None:
            self.edges[k] = {"s": k[0], "t": k[1], "k": kind, "w": EDGE_WEIGHT[kind] if w is None else w, "line": line, "n": 1}
        else:
            e["n"] += 1
            if w is None:
                e["w"] = min(1.0, e["w"] + 0.05)

    # -- discovery
    def walk(self, alias: str, root: Path) -> List[dict]:
        files: List[dict] = []
        if not root.is_dir():
            self.stats[f"root_missing_{alias}"] += 1
            return files
        stack = [(root, "", 0)]
        while stack:
            d, rel, depth = stack.pop()
            if depth > MAX_DEPTH:
                self.stats["skipped_depth"] += 1
                continue
            try:
                entries = sorted(os.scandir(d), key=lambda e: e.name)
            except OSError:
                self.stats["scan_errors"] += 1
                continue
            for e in entries:
                name = e.name
                try:
                    if e.is_symlink():
                        self.stats["skipped_symlink"] += 1
                        continue
                    isdir, isfile = e.is_dir(follow_symlinks=False), e.is_file(follow_symlinks=False)
                except OSError:
                    continue
                r = f"{rel}/{name}" if rel else name
                if isdir:
                    if name in SKIP_DIRS or name.startswith("."):
                        self.stats["skipped_dir"] += 1
                    elif is_sensitive_dir(name):
                        self.stats["skipped_sensitive_dir"] += 1
                    else:
                        stack.append((Path(e.path), r, depth + 1))
                elif isfile:
                    if name.startswith(".") and name not in (".env.example",):
                        self.stats["skipped_dotfile"] += 1
                        if is_sensitive_file(name):
                            self.sens_names[name] = alias
                        continue
                    if is_sensitive_file(name):
                        self.stats["skipped_sensitive_file"] += 1
                        self.sens_names[name] = alias
                        continue
                    if len(files) >= MAX_FILES_PER_ROOT:
                        self.stats["skipped_cap"] += 1
                        continue
                    try:
                        st = e.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    files.append({"alias": alias, "rel": r, "abs": e.path, "size": st.st_size, "mtime_ns": st.st_mtime_ns})
        return files

    def is_text(self, f: dict, ext: str) -> bool:
        if ext in TEXT_EXT:
            return True
        if ext != "" and ext not in (".bin", ".zip", ".gz", ".png", ".jpg", ".jpeg", ".pdf", ".xlsx", ".docx", ".pptx", ".db", ".sqlite", ".tar", ".tgz", ".7z", ".gif", ".webp", ".mp3", ".mp4", ".wav", ".pyc", ".so", ".exe"):
            try:
                with open(f["abs"], "rb") as fh:
                    head = fh.read(2048)
                return b"\0" not in head
            except OSError:
                return False
        return False

    def extract_file(self, f: dict) -> Optional[dict]:
        ext = os.path.splitext(f["rel"])[1].lower()
        key = f"{f['alias']}:{f['rel']}"
        if f["size"] == 0 or not self.is_text(f, ext):
            self.stats["binary_or_empty"] += 1
            return None
        cached = self.cache.get(key, f["mtime_ns"], f["size"])
        if cached is not None:
            return cached
        try:
            with open(f["abs"], "rb") as fh:
                raw = fh.read(MAX_PARSE_BYTES)
        except OSError:
            self.stats["read_errors"] += 1
            return None
        text = raw.decode("utf-8", errors="replace")
        data = extract_text(f["rel"], text)
        data["sha1"] = hashlib.sha1(raw).hexdigest()
        data["trunc"] = f["size"] > MAX_PARSE_BYTES
        self.cache.put(key, f["mtime_ns"], f["size"], data)
        return data

    # -- main build
    def build(self) -> dict:
        cfg = self.cfg
        docs: Dict[str, dict] = {}        # node id -> extraction data
        file_nodes: Dict[str, dict] = {}  # "alias:rel" -> file rec
        live_keys: set = set()
        # 1. files
        for alias, root in cfg.roots.items():
            if self.over_budget():
                self.stats["budget_exceeded"] = 1
                break
            for f in self.walk(alias, root):
                key = f"{f['alias']}:{f['rel']}"
                live_keys.add(key)
                file_nodes[key] = f
        self.stats["files_seen"] = len(file_nodes)
        # extraction (+ dedup by content hash)
        canon_by_hash: Dict[str, str] = {}
        dup_of: Dict[str, str] = {}
        for i, key in enumerate(sorted(file_nodes)):
            f = file_nodes[key]
            if i % 64 == 0 and self.over_budget():
                self.stats["budget_exceeded"] = 1
                break
            data = self.extract_file(f)
            f["data"] = data
            if data and f["size"] >= 64:
                h = data["sha1"]
                if h in canon_by_hash:
                    dup_of[key] = canon_by_hash[h]
                else:
                    canon_by_hash[h] = key
        self.cache.commit()
        self.stats["extracted"] = sum(1 for f in file_nodes.values() if f.get("data"))
        self.stats["duplicates_collapsed"] = len(dup_of)

        # 2. nodes: dirs + files (skills' SKILL.md become skill nodes)
        skill_by_key: Dict[str, str] = {}
        for key, f in file_nodes.items():
            if key in dup_of:
                continue
            alias, rel = f["alias"], f["rel"]
            data = f.get("data") or {}
            if alias == "sk" and rel.endswith("/SKILL.md"):
                fm = data.get("fm", {})
                name = (fm.get("name") or rel.split("/")[-2]).strip()
                nid = f"skill:{name}"
                self.node(nid, "skill", name, root=alias, path=rel, size=f["size"], mtime=f["mtime_ns"] // 10**9,
                          desc=str(fm.get("description", ""))[:160], cat=rel.split("/")[0])
                skill_by_key[key] = nid
                docs[nid] = data
                continue
            nid = f"f:{alias}:{rel}"
            self.node(nid, "file", rel.rsplit("/", 1)[-1], root=alias, path=rel, size=f["size"],
                      mtime=f["mtime_ns"] // 10**9)
            if data:
                docs[nid] = data
            parts = rel.split("/")
            parent = f"d:{alias}:" + "/".join(parts[:-1])
            for depth in range(len(parts) - 1):
                did = f"d:{alias}:" + "/".join(parts[:depth + 1])
                pid = f"d:{alias}:" + "/".join(parts[:depth]) if depth else f"d:{alias}:"
                if did not in self.nodes:
                    self.node(did, "dir", parts[depth], root=alias, path="/".join(parts[:depth + 1]))
                    if pid not in self.nodes:
                        self.node(pid, "dir", alias, root=alias, path="")
                    self.edge(pid, did, "contains")
            if len(parts) == 1:
                rid = f"d:{alias}:"
                if rid not in self.nodes:
                    self.node(rid, "dir", alias, root=alias, path="")
                parent = rid
            self.edge(parent, nid, "contains")
        # skill dir contains its files (skill node <-> files of the same skill folder)
        for key, f in file_nodes.items():
            if f["alias"] != "sk" or key in dup_of or key in skill_by_key:
                continue
            parts = f["rel"].split("/")
            for up in range(len(parts) - 1, 0, -1):
                sk_key = "sk:" + "/".join(parts[:up]) + "/SKILL.md"
                if sk_key in skill_by_key:
                    self.edge(skill_by_key[sk_key], f"f:sk:{f['rel']}", "skill_ref", 0.8)
                    break

        # 3. brain nodes
        self.prime_segments()
        self.add_memory(docs)
        self.add_cron(docs)
        self.add_mcp()
        self.add_sessions(docs)

        # 4. resolution of per-document references
        by_path: Dict[str, str] = {}
        by_base: Dict[str, List[str]] = defaultdict(list)
        by_stem: Dict[str, List[str]] = defaultdict(list)
        for nid, n in self.nodes.items():
            if n["t"] in ("file", "skill") and n.get("path"):
                key = f"{n['root']}:{n['path']}"
                by_path[key] = nid
                base = n["path"].rsplit("/", 1)[-1]
                by_base[base].append(nid)
                by_stem[os.path.splitext(base)[0].lower()].append(nid)
        skill_names = {n["label"].lower(): nid for nid, n in self.nodes.items() if n["t"] == "skill"}

        def resolve(src: dict, target: str, kind: str) -> Optional[str]:
            root = src["root"]
            sdir = src["path"].rsplit("/", 1)[0] if "/" in src["path"] else ""
            target = target.split("?")[0]
            if target.startswith("py:"):
                mod = target[3:]
                if not mod:
                    return None
                lead = len(mod) - len(mod.lstrip("."))
                parts = mod.lstrip(".").split(".")
                bases = [sdir] if lead else [sdir, ""]
                if lead > 1:
                    bases = ["/".join(sdir.split("/")[:-(lead - 1)]) if sdir else ""]
                for b in bases:
                    p = "/".join(x for x in [b] + parts if x)
                    for cand in (p + ".py", p + "/__init__.py"):
                        if f"{root}:{cand}" in by_path:
                            return by_path[f"{root}:{cand}"]
                return None
            cands = []
            if target.startswith("/"):
                cands.append(target.lstrip("/"))
            else:
                cands.append(os.path.normpath(f"{sdir}/{target}" if sdir else target))
                cands.append(os.path.normpath(target))
            for c in cands:
                if c.startswith(".."):
                    continue
                for cc in ([c] if os.path.splitext(c)[1] else [c, c + ".md"]):
                    if f"{root}:{cc}" in by_path:
                        return by_path[f"{root}:{cc}"]
            if kind in ("wikilink", "embed"):  # Obsidian: resolve by name, nearest wins
                nm = os.path.basename(target)
                pool = by_base.get(nm) or by_base.get(nm + ".md") or by_stem.get(os.path.splitext(nm)[0].lower()) or []
                pool = [p for p in pool if self.nodes[p]["root"] == root]
                if pool:
                    return max(pool, key=lambda p: (os.path.commonprefix([self.nodes[p]["path"], src["path"]]).count("/"), -len(self.nodes[p]["path"])))
            return None

        # basename index for mentions: unique-ish names only
        mention_idx: Dict[str, List[str]] = {}
        for base, ids in by_base.items():
            if base in STOP_NAMES or len(base) < 6:
                continue
            if 1 <= len(ids) <= 3:
                mention_idx[base] = ids
        stats_links = Counter()
        for nid, data in docs.items():
            src = self.nodes[nid]
            if src["t"] not in ("file", "skill"):
                continue
            for kind, target, line in data.get("links", []):
                stats_links[kind + "_raw"] += 1
                dst = resolve(src, target, kind)
                if dst:
                    stats_links[kind + "_resolved"] += 1
                    self.edge(nid, dst, kind, None, line)
            for tok, line in data.get("toks", []):
                if tok in mention_idx:
                    for dst in mention_idx[tok]:
                        if dst != nid:
                            self.edge(nid, dst, "mention", None, line)
                if tok.lower() in skill_names and src["t"] != "skill":
                    self.edge(nid, skill_names[tok.lower()], "mention", 0.6, line)
            for t in data.get("tags", [])[:25]:
                tid = f"tag:{t}"
                self.node(tid, "tag", "#" + t)
                self.edge(nid, tid, "tag")
            for sn in data.get("secret_names", []):
                self.secret_ref(nid, sn, 0)
            for tok, line in data.get("toks", []):
                if tok in self.sens_names:
                    self.secret_ref(nid, tok, line)
            if data.get("has_secret"):
                self.stats["docs_with_secret_like_content"] += 1
        self.stats["links"] = dict(stats_links)

        # memory / session / cron / skill -> skills, files, entities
        for nid, n in list(self.nodes.items()):
            if n["t"] in ("memory", "session", "cron"):
                data = docs.get(nid) or {}
                for tok, line in data.get("toks", []):
                    if tok in mention_idx:
                        for dst in mention_idx[tok]:
                            self.edge(nid, dst, "mention", 0.7, line)
                    if tok in self.sens_names or RE_SECRET_NAME.fullmatch(tok):
                        self.secret_ref(nid, tok, line)
                    if tok.lower() in skill_names:
                        self.edge(nid, skill_names[tok.lower()], "mention", 0.7, line)
                if n["t"] == "memory":  # natural-language mention: "MikroTik hEX" -> mikrotik-* skills
                    for w in data.get("rare", []):
                        sids = self.skill_seg.get(w)
                        if sids:
                            for sid in sids:
                                self.edge(nid, sid, "mention", round(0.5 / len(sids) + 0.15, 3), 0)
                for w in data.get("rare", []):
                    if f"mcp:{w}" in self.nodes:
                        self.edge(nid, f"mcp:{w}", "mcp", None, 0)
        self.brain_edges(docs, by_base)
        self.link_entities(docs)
        self.similarity(docs)
        for key, canon in dup_of.items():  # keep dup info as attr on canonical node
            cid = skill_by_key.get(canon) or f"f:{canon.split(':', 1)[0]}:{canon.split(':', 1)[1]}"
            if cid in self.nodes:
                self.nodes[cid]["dups"] = self.nodes[cid].get("dups", 0) + 1

        self.cap_fanout("mention", 25)
        # 5. degree + communities
        ids = sorted(self.nodes)
        idx = {nid: i for i, nid in enumerate(ids)}
        elist = [(idx[e["s"]], idx[e["t"]], e["w"]) for e in self.edges.values()]
        deg = Counter()
        sdeg = Counter()       # semantic degree: every edge except the structural `contains`
        for e in self.edges.values():
            deg[idx[e["s"]]] += 1
            deg[idx[e["t"]]] += 1
            if e["k"] != "contains":
                sdeg[idx[e["s"]]] += 1
                sdeg[idx[e["t"]]] += 1
        t_l = time.time()
        comm = louvain(len(ids), elist)
        self.stats["louvain_s"] = round(time.time() - t_l, 3)
        sizes = Counter(comm)
        # relabel communities by size desc for stable colors
        order = {c: r for r, (c, _n) in enumerate(sizes.most_common())}
        # drop isolated nodes that carry no information (empty dirs etc. stay if they have contains)
        out_nodes = []
        for nid in ids:
            n = self.nodes[nid]
            n["deg"] = deg[idx[nid]]
            n["sd"] = sdeg[idx[nid]]
            n["c"] = order[comm[idx[nid]]]
            out_nodes.append(n)
        snap = self.pack(out_nodes, ids, idx)
        self.stats["elapsed_s"] = round(time.time() - self.t0, 3)
        self.stats["cache_hits"], self.stats["cache_misses"] = self.cache.hits, self.cache.misses
        self.stats["cache_pruned"] = self.cache.prune(live_keys | {k for k in self.session_keys})
        self.cache.commit()
        snap["stats"] = self.final_stats(out_nodes)
        return snap

    def cap_fanout(self, kind: str, cap: int) -> None:
        """Data dumps (json/jsonl/log) name hundreds of files; keep the first `cap` per source
        and damp their weight so they do not become fake hubs."""
        by_src: Dict[str, List[dict]] = defaultdict(list)
        for e in self.edges.values():
            if e["k"] == kind:
                by_src[e["s"]].append(e)
        dropped = 0
        for src, es in by_src.items():
            if len(es) > cap:
                es.sort(key=lambda e: (e["line"], e["t"]))
                for e in es[cap:]:
                    del self.edges[(e["s"], e["t"], e["k"])]
                    dropped += 1
                for e in es[:cap]:
                    e["w"] = round(e["w"] * 0.6, 3)
        self.stats[f"{kind}_capped"] = dropped

    def final_stats(self, out_nodes: List[dict]) -> dict:
        st = dict(self.stats)
        st["nodes"] = len(out_nodes)
        st["edges"] = len(self.edges)
        st["nodes_by_type"] = dict(Counter(n["t"] for n in out_nodes))
        st["edges_by_kind"] = dict(Counter(e["k"] for e in self.edges.values()))
        st["isolated_nodes"] = sum(1 for n in out_nodes if n["deg"] == 0)
        st["orphan_files_no_semantic_edge"] = sum(1 for n in out_nodes if n["t"] == "file" and n["sd"] == 0)
        st["communities"] = len({n["c"] for n in out_nodes})
        return st

    def pack(self, out_nodes: List[dict], ids: List[str], idx: Dict[str, int]) -> dict:
        kidx = {k: i for i, k in enumerate(EDGE_KINDS)}
        tidx = {t: i for i, t in enumerate(NODE_TYPES)}
        nodes = []
        for n in out_nodes:
            extra = {k: v for k, v in n.items() if k not in ("id", "t", "label", "root", "path", "size", "mtime", "deg", "c")}
            nodes.append([n["id"], tidx[n["t"]], n["label"], n.get("root", ""), n.get("path", ""),
                          n.get("size", 0), n.get("mtime", 0), n["deg"], n["c"], extra])
        edges = [[idx[e["s"]], idx[e["t"]], kidx[e["k"]], round(e["w"], 3), e["line"]]
                 for e in sorted(self.edges.values(), key=lambda e: (e["s"], e["t"], e["k"]))]
        return {"v": SCHEMA_VERSION, "built_at": int(time.time()),
                "node_fields": ["id", "type", "label", "root", "path", "size", "mtime", "deg", "comm", "attrs"],
                "edge_fields": ["s", "t", "kind", "w", "line"],
                "types": NODE_TYPES, "kinds": EDGE_KINDS, "nodes": nodes, "edges": edges}

    # -- brain sources
    def secret_ref(self, src: str, name: str, line: int) -> None:
        nid = f"sec:{name}"
        self.node(nid, "secret", name, missing=name not in self.sens_names)
        self.edge(src, nid, "secret_ref", None, line)

    def add_memory(self, docs: Dict[str, dict]) -> None:
        mdir = self.cfg.hermes_home / "memories"
        for fname in ("MEMORY.md", "USER.md"):
            p = mdir / fname
            try:
                text = p.read_text(encoding="utf-8", errors="replace")[:MAX_PARSE_BYTES]
            except OSError:
                continue
            fid = f"mf:{fname}"
            self.node(fid, "memory", fname, root="mem", path=fname, size=len(text), kind="file")
            starts_entries = [e.strip() for e in re.split(r"\n§\n|\n§$|^§\n", text) if e.strip()]
            for i, entry in enumerate(starts_entries):
                h = hashlib.sha1(entry.encode("utf-8")).hexdigest()[:10]
                nid = f"mem:{fname[:-3].lower()}:{h}"
                label = safe_label(entry)
                self.node(nid, "memory", label, root="mem", path=fname, size=len(entry), idx=i, kind="entry")
                data = extract_text("mem.md", entry)
                data["links"] = []
                docs[nid] = data
                self.edge(fid, nid, "contains")
        self.stats["memory_entries"] = sum(1 for n in self.nodes.values() if n["t"] == "memory" and n.get("kind") == "entry")

    def add_cron(self, docs: Dict[str, dict]) -> None:
        p = self.cfg.hermes_home / "cron" / "jobs.json"
        try:
            jobs = json.loads(p.read_text(encoding="utf-8")).get("jobs", [])
        except (OSError, ValueError, AttributeError):
            return
        for j in jobs:
            if not isinstance(j, dict):
                continue
            jid = f"cron:{j.get('id') or j.get('name')}"
            self.node(jid, "cron", str(j.get("name") or j.get("id"))[:60], schedule=str(j.get("schedule_display") or "")[:40],
                      enabled=bool(j.get("enabled", True)), last_status=str(j.get("last_status") or ""))
            data = extract_text("cron.md", str(j.get("prompt") or "")[:20000])
            data["links"] = []
            docs[jid] = data
            self.cron_pending.append((jid, j))

    def add_mcp(self) -> None:
        p = self.cfg.hermes_home / "config.yaml"
        names: List[str] = []
        try:
            inside = False
            with open(p, "r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if re.match(r"^mcp_servers:\s*$", line):
                        inside = True
                        continue
                    if inside:
                        if re.match(r"^\S", line):
                            break
                        m = re.match(r"^  ([A-Za-z0-9_\-]{1,40}):\s*$", line)   # key NAME only; values never read
                        if m:
                            names.append(m.group(1))
        except OSError:
            return
        for nm in names:
            self.node(f"mcp:{nm}", "mcp_server", nm)

    def add_sessions(self, docs: Dict[str, dict]) -> None:
        sdir = self.cfg.state_dir / "sessions"
        try:
            index = json.loads((sdir / "_index.json").read_text(encoding="utf-8"))
            if isinstance(index, dict):
                index = index.get("sessions", [])
        except (OSError, ValueError):
            index = []
        for s in index:
            if not isinstance(s, dict) or not s.get("session_id"):
                continue
            sid = str(s["session_id"])
            nid = f"ses:{sid}"
            self.node(nid, "session", str(s.get("title") or sid)[:70], root="ses", path=sid,
                      mtime=int(s.get("updated_at") or 0), n_msgs=int(s.get("message_count") or 0),
                      ws=str(s.get("workspace") or ""), model=str(s.get("model") or ""))
            p = sdir / f"{sid}.json"
            try:
                st = p.stat()
            except OSError:
                continue
            key = f"ses:{sid}"
            self.session_keys.add(key)
            if st.st_size > MAX_SESSION_BYTES:
                self.stats["sessions_too_big"] += 1
                continue
            data = self.cache.get(key, st.st_mtime_ns, st.st_size)
            if data is None:
                data = self.extract_session(p)
                self.cache.put(key, st.st_mtime_ns, st.st_size, data)
            docs[nid] = data
        self.cache.commit()

    def extract_session(self, p: Path) -> dict:
        out = {"links": [], "tags": [], "ents": [], "toks": [], "rare": [], "tools": {}, "skills": [], "secret_names": []}
        try:
            s = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return out
        tools: Counter = Counter()
        skills: Counter = Counter()
        blob: List[str] = []
        for tc in s.get("tool_calls", []) or []:
            if not isinstance(tc, dict):
                continue
            nm = str(tc.get("name") or "")
            tools[nm] += 1
            args = str(tc.get("args") or "")[:1000]
            if nm == "skill_view":
                m = re.search(r"'name':\s*'([\w.\-]{1,80})'", args)
                if m:
                    skills[m.group(1)] += 1
            blob.append(args)
        for m in s.get("messages", []) or []:
            if isinstance(m, dict) and m.get("role") == "user":
                c = m.get("content")
                if isinstance(c, list):
                    c = " ".join(str(x.get("text", "")) for x in c if isinstance(x, dict))
                blob.append(str(c or "")[:4000])
        text = "\n".join(blob)[:400000]
        d = extract_text("ses.txt", text)
        d["links"] = []
        d["tools"] = dict(tools.most_common(60))
        d["skills"] = dict(skills)
        d["toks"] = d["toks"][:300]
        d["rare"] = d["rare"][:600]
        return d

    # -- cross edges
    def prime_segments(self) -> None:
        seg: Dict[str, set] = defaultdict(set)
        for nid, n in self.nodes.items():
            if n["t"] == "skill":
                for part in re.split(r"[-_ ]", n["label"].lower()):
                    if len(part) >= 7 and part not in GENERIC_SEGMENTS:
                        seg[part].add(nid)
        self.skill_seg = {p: sorted(ids) for p, ids in seg.items() if len(ids) <= 4}

    def brain_edges(self, docs: Dict[str, dict], by_base: Dict[str, List[str]]) -> None:
        for jid, j in self.cron_pending:
            sk = list(j.get("skills") or []) + ([j["skill"]] if j.get("skill") else [])
            for name in sk:
                self.edge(jid, f"skill:{name}", "cron_skill")
            script = os.path.basename(str(j.get("script") or ""))
            for dst in by_base.get(script, [])[:3] if script else []:
                self.edge(jid, dst, "cron_script")
        for nid, n in list(self.nodes.items()):
            if n["t"] != "session":
                continue
            data = docs.get(nid) or {}
            for name, cnt in (data.get("skills") or {}).items():
                self.edge(nid, f"skill:{name}", "skill_use", round(min(1.0, 0.5 + 0.1 * cnt), 3), 0)
            for tool, cnt in (data.get("tools") or {}).items():
                m = re.match(r"mcp_([A-Za-z0-9\-]{1,40}?)_", tool)
                if m and f"mcp:{m.group(1)}" in self.nodes:
                    self.edge(nid, f"mcp:{m.group(1)}", "mcp", round(min(1.0, 0.4 + 0.05 * cnt), 3), 0)

    def link_entities(self, docs: Dict[str, dict]) -> None:
        """Entities (IP / CTnnn / domain) that appear in >=1 memory entry become hub nodes."""
        mem_ents: Dict[Tuple[str, str], List[Tuple[str, int]]] = defaultdict(list)
        for nid, n in self.nodes.items():
            if n["t"] == "memory" and n.get("kind") == "entry":
                for kind, val, line in (docs.get(nid) or {}).get("ents", []):
                    mem_ents[(kind, val)].append((nid, line))
        used = 0
        for (kind, val), holders in mem_ents.items():
            eid = f"ent:{kind}:{val}"
            self.node(eid, "entity", val, ekind=kind)
            for nid, line in holders:
                self.edge(nid, eid, "entity", None, line)
            used += 1
        for nid, data in docs.items():
            n = self.nodes.get(nid)
            if not n or n["t"] == "memory":
                continue
            for kind, val, line in data.get("ents", []):
                eid = f"ent:{kind}:{val}"
                if eid in self.nodes:
                    self.edge(nid, eid, "entity", None, line)
        # drop entity nodes that ended with a single edge (no relating power)
        deg = Counter()
        for e in self.edges.values():
            deg[e["s"]] += 1
            deg[e["t"]] += 1
        for eid in [i for i, n in self.nodes.items() if n["t"] == "entity" and deg[i] < 2]:
            del self.nodes[eid]
            self.stats["entities_dropped_orphan"] += 1
        self.edges = {k: v for k, v in self.edges.items() if v["s"] in self.nodes and v["t"] in self.nodes}

    def similarity(self, docs: Dict[str, dict]) -> None:
        post: Dict[str, List[str]] = defaultdict(list)
        cand = [nid for nid, n in self.nodes.items() if n["t"] in ("file", "skill") and docs.get(nid, {}).get("rare")]
        for nid in cand:
            for w in docs[nid]["rare"]:
                post[w].append(nid)
        shared: Counter = Counter()
        for w, ids in post.items():
            if 2 <= len(ids) <= RARE_DF_MAX:
                for i in range(len(ids)):
                    for j in range(i + 1, len(ids)):
                        shared[(ids[i], ids[j])] += 1
        rare_sets = {nid: {w for w in docs[nid]["rare"] if 2 <= len(post[w]) <= RARE_DF_MAX} for nid in cand}
        made = 0
        for (a, b), c in shared.items():
            if c < SIM_MIN_SHARED:
                continue
            ra, rb = rare_sets[a], rare_sets[b]
            jac = c / max(1, len(ra | rb))
            if jac >= SIM_MIN_JACCARD:
                self.edge(a, b, "similar", round(min(1.0, 0.3 + jac), 3), 0)
                made += 1
        self.stats["similar_edges"] = made



def build_snapshot(cfg: Config, cache: Cache) -> dict:
    return Builder(cfg, cache).build()
