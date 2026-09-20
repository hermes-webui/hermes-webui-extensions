"""Command Code usage collector for the commandcode-usage sidecar.

``GET https://api.commandcode.ai/alpha/billing/credits`` (with the Command Code
API key) returns the plan's window limits (five-hour / weekly: ``used``, ``cap``,
``resetAt``) plus the credit balances (monthly / purchased / free). The sibling
``billing/subscriptions`` and ``usage/summary`` endpoints add the plan identity
and the current billing period's request/cost totals. Those are Command Code's
own alpha accounting endpoints — the same data their CLI and third-party quota
tools read — so they are the authoritative numbers for the account.

The payload the sidecar returns carries only display fields: no account id,
email, or token is fetched. It is small and constant-size, well inside core's
sidecar-proxy cap.

Read-only: the sidecar writes no application or state data (Python may create
bounded bytecode caches in its own runtime directory). The API key is read from
the process environment or ``~/.hermes/.env`` and is never returned, logged, or
embedded in an error string.
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

ALPHA_BASE = "https://api.commandcode.ai/alpha"
CREDITS_URL = ALPHA_BASE + "/billing/credits"
SUBSCRIPTIONS_URL = ALPHA_BASE + "/billing/subscriptions"
SUMMARY_URL = ALPHA_BASE + "/usage/summary"

_HTTP_TIMEOUT_SECONDS = 6.0
_USAGE_CACHE_SECONDS = 60.0
# Guard against a runaway upstream body (or a redirect payload) creeping past
# core's 512 KiB sidecar-proxy cap. Each response is a few KB; 64 KiB is generous.
_MAX_UPSTREAM_BYTES = 64 * 1024

_USER_AGENT = "hermes-webui-ext-commandcode-usage/0.1.0"

# Plan ids seen on the billing endpoints -> display labels. Unknown ids fall
# back to a prettified form, so a new plan shows up without a code change.
_PLAN_LABELS: Dict[str, str] = {
    "individual-go": "Go",
    "individual-pro": "Pro",
    "individual-max10": "Max 10",
    "individual-max20": "Max 20",
    "individual-goat": "GOAT",
    "team-pro": "Team Pro",
    "provider": "Provider",
}

# COMMANDCODE_API_KEY is the env name the Command Code CLI and the Hermes
# Command Code provider use.
_KEY_NAMES = ("COMMANDCODE_API_KEY",)

# Windows in the credits payload, in display order: API field, payload key, label.
_WINDOWS: Tuple[Tuple[str, str, str], ...] = (
    ("fiveHour", "five_hour", "5-hour usage"),
    ("weekly", "weekly", "Weekly usage"),
)


# ── redirect / body hardening ───────────────────────────────────────────────

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse ANY redirect for the credentialed request.

    urllib follows redirects while PRESERVING the Authorization header, so a
    redirect (captive portal, DNS interference, a compromised/changed endpoint)
    would hand the API key to an unknown host. We fail instead.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(
            req.full_url, code, f"refusing redirect to {newurl}", headers, fp
        )


_OPENER = urllib.request.build_opener(_NoRedirect)

_usage_cache_lock = threading.Lock()
_usage_cache: Dict[str, Any] = {"at": 0.0, "payload": None}


# ── paths / keys ────────────────────────────────────────────────────────────

def hermes_home() -> Path:
    """Resolve the Hermes home whose ``.env`` we read.

    ``HERMES_HOME`` wins. Otherwise, when the unit (or the operator) sets
    ``HERMES_WEBUI_STATE_DIR`` — the canonical launch environment, which the
    systemd unit must contain — its ``webui`` layout implies the Hermes home as
    its parent. Falls back to ``~/.hermes``.
    """
    home = os.getenv("HERMES_HOME")
    if home:
        return Path(home).expanduser()
    state_dir = os.getenv("HERMES_WEBUI_STATE_DIR")
    if state_dir:
        state_path = Path(state_dir).expanduser()
        if state_path.name == "webui":
            return state_path.parent
    return Path.home() / ".hermes"


def dotenv_path() -> Path:
    return hermes_home() / ".env"


def _parse_dotenv(text: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        if "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if name:
            out[name] = value
    return out


def _read_dotenv() -> Dict[str, str]:
    try:
        return _parse_dotenv(dotenv_path().read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        return {}


def resolve_key(names: Tuple[str, ...], dotenv: Optional[Dict[str, str]] = None) -> Tuple[Optional[str], str]:
    """Return (key, source) where source is 'env', 'dotenv' or 'none'.

    The key value is only ever used to build an outbound Authorization header.
    """
    for name in names:
        value = os.getenv(name)
        if value and value.strip():
            return value.strip(), "env"
    if dotenv is None:
        dotenv = _read_dotenv()
    for name in names:
        value = dotenv.get(name)
        if value and value.strip():
            return value.strip(), "dotenv"
    return None, "none"


# ── parsing helpers ─────────────────────────────────────────────────────────

def _num(value) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _int(value) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value)


def _iso_ms(value) -> Optional[str]:
    """Convert a millisecond epoch (the alpha API's ``resetAt``) to ISO-8601 UTC."""
    ms = _num(value)
    if ms is None or ms <= 0:
        return None
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _plan_label(plan_id: Optional[str]) -> Optional[str]:
    if not isinstance(plan_id, str) or not plan_id.strip():
        return None
    plan_id = plan_id.strip()
    if plan_id in _PLAN_LABELS:
        return _PLAN_LABELS[plan_id]
    words = [word for word in plan_id.replace("_", "-").split("-") if word]
    return " ".join(word.capitalize() for word in words) or plan_id


def _error_code(exc: BaseException) -> str:
    """Map a fetch failure to a stable, UI-friendly code."""
    if isinstance(exc, urllib.error.HTTPError):
        if exc.code == 401:
            return "invalid_key"
        if exc.code == 403:
            return "blocked"
        if exc.code == 404:
            return "not_found"
        if 300 <= exc.code < 400:
            return "redirected"
        return f"http_{exc.code}"
    if isinstance(exc, (ValueError, json.JSONDecodeError)):
        return "bad_payload"
    return "unreachable"


# ── endpoint fetches ────────────────────────────────────────────────────────

def _get_json(url: str, key: str) -> Dict[str, Any]:
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "User-Agent": _USER_AGENT,
        },
    )
    with _OPENER.open(req, timeout=_HTTP_TIMEOUT_SECONDS) as resp:
        raw = resp.read(_MAX_UPSTREAM_BYTES + 1)
    if len(raw) > _MAX_UPSTREAM_BYTES:
        raise ValueError("usage response exceeded size cap")
    payload = json.loads(raw.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("unexpected usage payload")
    return payload


def _window(entry: Any, key: str, label: str) -> Optional[Dict[str, Any]]:
    if not isinstance(entry, dict):
        return None
    used = _num(entry.get("used"))
    cap = _num(entry.get("cap"))
    percent = None
    if used is not None and cap not in (None, 0.0):
        # Direct ratio of the two returned numbers; the panel shows it next to
        # both so the basis stays visible. Nothing else is recomputed locally.
        percent = round(used / cap * 100.0, 1)
    return {
        "label": label,
        "used": used,
        "cap": cap,
        "percent": percent,
        "exceeded": bool(entry.get("exceeded")),
        "resets_at": _iso_ms(entry.get("resetAt")),
    }


def _fetch_account(key: str) -> Dict[str, Any]:
    """Fetch credits (required) plus plan and period totals (best-effort)."""
    credits_payload = _get_json(CREDITS_URL, key)

    plan: Dict[str, Any] = {
        "id": None,
        "label": None,
        "status": None,
        "renews_at": None,
        "cancel_at_period_end": False,
        "error": None,
    }
    try:
        subs = _get_json(SUBSCRIPTIONS_URL, key)
        data = _dict(subs.get("data"))
        if data:
            plan_id = data.get("planId") if isinstance(data.get("planId"), str) else None
            plan["id"] = plan_id
            plan["label"] = _plan_label(plan_id)
            plan["status"] = data.get("status") if isinstance(data.get("status"), str) else None
            plan["renews_at"] = (
                data.get("currentPeriodEnd") if isinstance(data.get("currentPeriodEnd"), str) else None
            )
            plan["cancel_at_period_end"] = bool(data.get("cancelAtPeriodEnd"))
        else:
            plan["error"] = "bad_payload"
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as exc:
        plan["error"] = _error_code(exc)

    period: Dict[str, Any] = {
        "requests": None,
        "cost": None,
        "success_rate": None,
        "period_basis": None,
        "error": None,
    }
    try:
        summary = _get_json(SUMMARY_URL, key)
        period["requests"] = _int(summary.get("totalCount"))
        period["cost"] = _num(summary.get("totalCost"))
        period["success_rate"] = _num(summary.get("successRate"))
        period["period_basis"] = (
            summary.get("periodBasis") if isinstance(summary.get("periodBasis"), str) else None
        )
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as exc:
        period["error"] = _error_code(exc)

    credits_raw = _dict(credits_payload.get("credits"))
    limits_raw = _dict(credits_payload.get("windowLimits"))

    windows: Dict[str, Any] = {}
    for api_key, payload_key, label in _WINDOWS:
        window = _window(limits_raw.get(api_key), payload_key, label)
        if window is not None:
            windows[payload_key] = window

    credits = {
        "monthly_remaining": _num(credits_raw.get("monthlyCredits")),
        "purchased": _num(credits_raw.get("purchasedCredits")),
        "free": _num(credits_raw.get("freeCredits")),
        "below_threshold": bool(credits_raw.get("belowThreshold")),
    }

    return {
        "windows": windows,
        "credits": credits,
        "plan": plan,
        "period": period,
    }


def account_usage(key: Optional[str], *, force: bool = False) -> Dict[str, Any]:
    """Cached (60 s) live Command Code usage. Never raises: returns an error field."""
    if not key:
        return {"available": False, "error": "no_key", "windows": {}}

    now = time.time()
    if not force:
        with _usage_cache_lock:
            cached_at = float(_usage_cache.get("at") or 0.0)
            cached = _usage_cache.get("payload")
            if cached is not None and (now - cached_at) < _USAGE_CACHE_SECONDS:
                out = dict(cached)
                out["cached"] = True
                return out

    try:
        data = _fetch_account(key)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as exc:
        return {"available": False, "error": _error_code(exc), "windows": {}}

    result = {"available": True, "error": None, "fetched_at": now, **data}
    with _usage_cache_lock:
        _usage_cache["at"] = now
        _usage_cache["payload"] = dict(result)
    out = dict(result)
    out["cached"] = False
    return out


# ── payload ─────────────────────────────────────────────────────────────────

def build_payload(*, force: bool = False) -> Dict[str, Any]:
    """The /api/usage payload: display fields only, small and constant-size."""
    dotenv = _read_dotenv()
    key, _source = resolve_key(_KEY_NAMES, dotenv)
    return {
        "ok": True,
        "generated_at": time.time(),
        "commandcode": account_usage(key, force=force),
    }
