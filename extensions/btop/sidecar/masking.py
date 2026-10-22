"""Best-effort secret masking for process command lines (btop sidecar).

Works per argv element, never on the flattened string, so a value that contains
spaces stays one element and a flag can mask *the next* element whole. Every
regex repeat is bounded and every element is length-capped before any pattern
runs, so a hostile local user cannot stall the sampler with one huge argument:
the cost is linear in the (already capped) cmdline length.

This is a pattern list, not a guarantee. Unknown programs with positional
secrets (``htpasswd -b f user PASS``) are not recognised.
"""
from __future__ import annotations

import os
import re
from typing import Iterable, List, Optional

CMDLINE_READ_LIMIT = 16384   # bytes read from /proc/<pid>/cmdline
MAX_ARG_CHARS = 1024         # longer argv elements are replaced, never scanned
MASK = "***"

# ── names that mark a secret ───────────────────────────────────────────────
# Flag / variable names are split on - _ . and compared part-wise, plus a few
# compound substrings. Over-masking (e.g. --tokenizer) is accepted.
_SECRET_PARTS = {
    "password", "passwd", "pass", "pwd", "passphrase", "token", "secret",
    "key", "apikey", "pat", "auth", "credential", "credentials", "cookie", "bearer",
    "pw", "otp", "totp",
}
_SECRET_SUBSTRINGS = ("password", "passwd", "passphrase", "token", "secret", "apikey",
                      "api_key", "api-key", "privatekey", "private_key", "private-key",
                      "accesskey", "access_key", "credential")
_NAME_SPLIT = re.compile(r"[-_.]")


def secret_name(name: str) -> bool:
    n = name.strip().lower().lstrip("-")
    if not n or len(n) > 96:
        return False
    if any(s in n for s in _SECRET_SUBSTRINGS):
        return True
    return any(p in _SECRET_PARTS for p in _NAME_SPLIT.split(n) if p)


# ── program-specific short options ─────────────────────────────────────────
_MYSQL = {"mysql", "mariadb", "mysqldump", "mysqladmin", "mysqlimport", "mysqlshow",
          "mysqlcheck", "mysqlsh", "mysqlpump", "mariadb-dump", "mariadb-admin",
          "mariadb-import", "mariadb-check", "mysqlbinlog"}
_USERPASS = {"curl", "wget", "lftp", "aria2c", "httpie", "http", "https"}
_REDIS = {"redis-cli", "valkey-cli", "keydb-cli"}
_SSHPASS = {"sshpass"}
_KNOWN = _MYSQL | _USERPASS | _REDIS | _SSHPASS

# ── in-element patterns (all repeats bounded) ──────────────────────────────
_HEADER = re.compile(
    r"^(\s{0,8}[A-Za-z0-9-]{0,48}(?:auth[A-Za-z-]{0,24}|token|api-?key|secret|cookie|password|session)"
    r"[A-Za-z0-9-]{0,48}\s{0,8}:\s{0,8})\S.{0,4096}$",
    re.IGNORECASE | re.DOTALL,
)
_SCHEME_AUTH = re.compile(r"\b(Bearer|Basic|Token|Digest)(\s{1,8})[A-Za-z0-9._~+/=:-]{4,4096}", re.IGNORECASE)
_URL_CREDS = re.compile(
    r"((?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,31}://[^\s:/@]{0,256}:)[^\s@/]{1,256}@"
)
_QUERY = re.compile(
    r"([?&;][A-Za-z0-9_.-]{0,32}(?:token|key|secret|password|passwd|pwd|sig|signature|auth|code)=)[^&#\s]{1,2048}",
    re.IGNORECASE,
)
_TOKENS = re.compile(
    r"(?:sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{8,512}"
    r"|gh[pousr]_[A-Za-z0-9]{10,512}|github_pat_[A-Za-z0-9_]{10,512}|glpat-[A-Za-z0-9_-]{10,512}"
    r"|xox[abposr]-[A-Za-z0-9-]{8,512}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,512}"
    r"|hf_[A-Za-z0-9]{20,512}|npm_[A-Za-z0-9]{20,512}"
    r"|eyJ[A-Za-z0-9_-]{8,1024}\.[A-Za-z0-9_-]{8,1024}\.[A-Za-z0-9_-]{8,1024})"
)
_ENV = re.compile(r"^([A-Za-z_][A-Za-z0-9_]{0,95})=(.*)$", re.DOTALL)
_FLAG_EQ = re.compile(r"^(--?[A-Za-z0-9][A-Za-z0-9_.-]{0,95})=(.*)$", re.DOTALL)


def _mask_inline(s: str) -> str:
    if _HEADER.match(s):
        return _HEADER.sub(lambda m: m.group(1) + MASK, s)
    s = _SCHEME_AUTH.sub(lambda m: m.group(1) + m.group(2) + MASK, s)
    s = _URL_CREDS.sub(lambda m: m.group(1) + MASK + "@", s)
    s = _QUERY.sub(lambda m: m.group(1) + MASK, s)
    s = _TOKENS.sub(MASK, s)
    return s


def _mask_userpass(v: str) -> str:
    user, sep, _ = v.partition(":")
    return (user + ":" + MASK) if sep else v


def _prog(arg: str) -> Optional[str]:
    base = os.path.basename(arg)
    return base if base in _KNOWN else None


def mask_argv(argv: Iterable[str]) -> List[str]:
    out: List[str] = []
    prog: Optional[str] = None
    pending: Optional[str] = None          # "full" | "userpass"
    for i, arg in enumerate(argv):
        if len(arg) > MAX_ARG_CHARS:
            out.append(f"[{len(arg)} chars]")
            pending = None
            continue
        if pending:
            out.append(_mask_userpass(arg) if pending == "userpass" else MASK)
            pending = None
            continue
        if i == 0 or not arg.startswith("-"):
            p = _prog(arg)
            if p:
                prog = p
        if arg.startswith("-") and len(arg) > 1 and arg != "--":
            m = _FLAG_EQ.match(arg)
            if m:
                name, val = m.group(1), m.group(2)
                if prog in _USERPASS and name in ("--user", "--proxy-user"):
                    out.append(name + "=" + _mask_userpass(val))
                elif secret_name(name):
                    out.append(name + "=" + MASK)
                else:
                    out.append(name + "=" + _mask_inline(val))
                continue
            # program-specific attached / separate short options
            if prog in _MYSQL and arg.startswith("-p") and not arg.startswith("--"):
                out.append("-p" + MASK if len(arg) > 2 else arg)
                continue
            if prog in _SSHPASS and arg.startswith("-p") and not arg.startswith("--"):
                if len(arg) > 2:
                    out.append("-p" + MASK)
                else:
                    out.append(arg)
                    pending = "full"
                continue
            if prog in _USERPASS and (arg in ("-u", "-U", "--user", "--proxy-user")):
                out.append(arg)
                pending = "userpass"
                continue
            if prog in _USERPASS and arg.startswith("-u") and len(arg) > 2 and not arg.startswith("--"):
                out.append("-u" + _mask_userpass(arg[2:]))
                continue
            if prog in _REDIS and arg in ("-a", "--pass", "--user-pass"):
                out.append(arg)
                pending = "full"
                continue
            if secret_name(arg):
                out.append(arg)
                pending = "full"
                continue
            out.append(_mask_inline(arg))
            continue
        m = _ENV.match(arg)
        if m and secret_name(m.group(1)):
            out.append(m.group(1) + "=" + MASK)
            continue
        out.append(_mask_inline(arg))
    return out


def split_cmdline(raw: bytes, limit: int = CMDLINE_READ_LIMIT) -> List[str]:
    """Split raw /proc/<pid>/cmdline bytes into argv (NUL-separated)."""
    truncated = len(raw) >= limit
    raw = raw[:limit]
    parts = raw.split(b"\x00")
    if parts and parts[-1] == b"":
        parts.pop()
    argv = [p.decode("utf-8", "replace") for p in parts]
    if truncated and argv:
        argv.append("…")
    return argv


def mask_cmdline(raw: bytes) -> str:
    """Masked, space-joined command line from raw cmdline bytes."""
    return " ".join(mask_argv(split_cmdline(raw)))


def mask_text(text: str) -> str:
    """Mask a free-form string (split on whitespace). For tests / legacy callers."""
    return " ".join(mask_argv(text.split()))
