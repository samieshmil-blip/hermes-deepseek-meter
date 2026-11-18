"""DeepSeek meter backend — live account balance plus local token/cost totals.

Mounted at ``/api/plugins/deepseek-meter/`` by the gateway:

* ``GET /stats?force=1`` — balance + usage snapshot (what the status-bar chip polls)
* ``GET /balance``       — balance only

Read-only by design:

* **Balance** — one HTTPS call to ``api.deepseek.com/user/balance``. The API key
  comes from Hermes's own secret route (``agent.secret_scope.get_secret``), never
  from a ``.env`` file, ``auth.json`` or the environment directly, so it honours
  the active profile. The key is never returned to the renderer.
* **Usage** — ``session_model_usage`` in the local ``state.db``, opened with
  ``mode=ro`` so the gateway keeps its write lock. Only aggregates leave the
  process; no message text is read.

No tools, hooks, middleware or core patching: two GET routes and nothing else.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sqlite3
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter

router = APIRouter()

BALANCE_URL = "https://api.deepseek.com/user/balance"
BALANCE_TTL = 20.0
HTTP_TIMEOUT = 8.0

_cache: Dict[str, Any] = {"at": 0.0, "data": None}


# --------------------------------------------------------------------------- paths


def _hermes_home() -> Path:
    """Active Hermes home (profile-aware via ``HERMES_HOME``)."""
    override = (os.environ.get("HERMES_HOME") or "").strip()
    if override:
        return Path(override)
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:  # noqa: BLE001 — fall back to the platform default
        local = (os.environ.get("LOCALAPPDATA") or "").strip()
        if local and (Path(local) / "hermes").is_dir():
            return Path(local) / "hermes"
        return Path.home() / ".hermes"


def _api_key() -> Optional[str]:
    """The DeepSeek key, through Hermes's profile-scoped secret route."""
    try:
        from agent.secret_scope import get_secret

        value = get_secret("DEEPSEEK_API_KEY")
        if value:
            return str(value).strip()
    except Exception:  # noqa: BLE001 — no scope installed (single-profile CLI/dashboard)
        pass
    value = (os.environ.get("DEEPSEEK_API_KEY") or "").strip()
    return value or None


# ------------------------------------------------------------------------- balance


def _fetch_balance() -> Dict[str, Any]:
    key = _api_key()
    if not key:
        return {"ok": False, "error": "DEEPSEEK_API_KEY is not configured", "infos": []}

    request = urllib.request.Request(
        BALANCE_URL,
        headers={"Authorization": "Bearer " + key, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
            payload = json.loads(response.read().decode("utf-8", "replace"))
    except Exception as exc:  # noqa: BLE001 — any transport/auth error is a readout, not a crash
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "infos": []}

    infos: List[Dict[str, Any]] = []
    for row in payload.get("balance_infos") or []:
        if not isinstance(row, dict):
            continue
        try:
            infos.append(
                {
                    "currency": str(row.get("currency") or ""),
                    "total": float(row.get("total_balance") or 0),
                    "granted": float(row.get("granted_balance") or 0),
                    "topped_up": float(row.get("topped_up_balance") or 0),
                }
            )
        except (TypeError, ValueError):
            continue

    return {
        "ok": True,
        "is_available": bool(payload.get("is_available")),
        "infos": infos,
        "fetched_at": time.time(),
    }


def _balance_cached(force: bool = False) -> Dict[str, Any]:
    now = time.time()
    cached = _cache.get("data")
    if not force and cached and now - float(_cache.get("at") or 0.0) < BALANCE_TTL:
        return cached  # type: ignore[return-value]

    fresh = _fetch_balance()
    if fresh.get("ok"):
        _cache["data"] = fresh
        _cache["at"] = now
        return fresh

    if cached:
        stale = dict(cached)  # type: ignore[arg-type]
        stale["stale"] = True
        stale["error"] = fresh.get("error")
        return stale
    return fresh


# --------------------------------------------------------------------------- usage


def _usage() -> Dict[str, Any]:
    db = _hermes_home() / "state.db"
    if not db.exists():
        return {"ok": False, "error": f"state.db not found at {db}"}

    now = time.time()
    midnight = dt.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()

    try:
        con = sqlite3.connect("file:%s?mode=ro" % db.as_posix(), uri=True, timeout=3.0)
    except sqlite3.Error as exc:
        return {"ok": False, "error": f"sqlite: {exc}"}

    try:
        def window(since: float) -> Dict[str, Any]:
            row = con.execute(
                "select coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0),"
                " coalesce(sum(cache_read_tokens), 0), coalesce(sum(estimated_cost_usd), 0),"
                " coalesce(sum(api_call_count), 0), count(distinct session_id)"
                " from session_model_usage where coalesce(last_seen, first_seen, 0) >= ?",
                (since,),
            ).fetchone()
            tokens_in, tokens_out, cached_read, cost, calls, sessions = row
            return {
                "input": int(tokens_in or 0),
                "output": int(tokens_out or 0),
                "cached": int(cached_read or 0),
                "total": int((tokens_in or 0) + (tokens_out or 0)),
                "cost_usd": round(float(cost or 0.0), 6),
                "calls": int(calls or 0),
                "sessions": int(sessions or 0),
            }

        models = [
            {
                "model": str(model or "?"),
                "input": int(tokens_in or 0),
                "output": int(tokens_out or 0),
                "cost_usd": round(float(cost or 0.0), 6),
                "calls": int(calls or 0),
            }
            for (model, tokens_in, tokens_out, cost, calls) in con.execute(
                "select model, coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0),"
                " coalesce(sum(estimated_cost_usd), 0), coalesce(sum(api_call_count), 0)"
                " from session_model_usage where coalesce(last_seen, first_seen, 0) >= ?"
                " group by model order by 4 desc",
                (midnight,),
            ).fetchall()
        ]

        windows = {
            "today": window(midnight),
            "24h": window(now - 86400),
            "7d": window(now - 7 * 86400),
            "all": window(0),
        }
    except sqlite3.Error as exc:
        return {"ok": False, "error": f"sqlite: {exc}"}
    finally:
        con.close()

    return {
        "ok": True,
        "currency": "USD",
        "cost_note": "estimated from Hermes' price table, USD",
        "today": windows["today"],
        "last_24h": windows["24h"],
        "last_7d": windows["7d"],
        "all_time": windows["all"],
        "models": models,
    }


# ----------------------------------------------------------------------- endpoints


@router.get("/stats")
async def stats(force: int = 0) -> Dict[str, Any]:
    return {
        "ok": True,
        "balance": _balance_cached(bool(force)),
        "usage": _usage(),
        "generated_at": time.time(),
    }


@router.get("/balance")
async def balance(force: int = 0) -> Dict[str, Any]:
    return _balance_cached(bool(force))
