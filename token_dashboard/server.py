"""HTTP server: static frontend + JSON endpoints + SSE diff stream."""
from __future__ import annotations

import http.server
import json
import mimetypes
import queue
import threading
import time
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from .db import (
    overview_totals, expensive_prompts, project_summary,
    tool_token_breakdown, recent_sessions, session_turns,
    daily_token_breakdown, model_breakdown, skill_breakdown,
)
from .pricing import load_pricing, cost_for, get_plan, set_plan
from .tips import all_tips, dismiss_tip
from .scanner import scan_dir
from .skills import cached_catalog


WEB_ROOT = Path(__file__).resolve().parent.parent / "web"
PRICING_JSON = Path(__file__).resolve().parent.parent / "pricing.json"

EVENTS: "queue.Queue[dict]" = queue.Queue()


def _read_hooks_data(db_path: str) -> dict:
    """Return hooks from global settings files and any project .claude/ dirs."""
    import sqlite3
    sources = []
    claude_home = Path.home() / ".claude"

    for fname in ("settings.json", "settings.local.json"):
        p = claude_home / fname
        if not p.exists():
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        hooks = data.get("hooks", {})
        if hooks:
            sources.append({"label": f"~/.claude/{fname}", "hooks": hooks})

    try:
        con = sqlite3.connect(db_path)
        cwds = [r[0] for r in con.execute(
            "SELECT DISTINCT cwd FROM messages WHERE cwd IS NOT NULL LIMIT 50"
        ).fetchall()]
        con.close()
        seen: set[str] = set()
        for cwd in cwds:
            for fname in ("settings.json", "settings.local.json"):
                p = Path(cwd) / ".claude" / fname
                key = str(p)
                if key in seen or not p.exists():
                    continue
                seen.add(key)
                try:
                    data = json.loads(p.read_text(encoding="utf-8"))
                except Exception:
                    continue
                hooks = data.get("hooks", {})
                if hooks:
                    sources.append({"label": f"{Path(cwd).name}/.claude/{fname}", "hooks": hooks})
    except Exception:
        pass

    return {"sources": sources}


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    meta: dict = {}
    body = text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            for line in text[3:end].strip().splitlines():
                if ":" in line:
                    k, _, v = line.partition(":")
                    meta[k.strip()] = v.strip()
            body = text[end + 4:].strip()
    return meta, body


def _read_memory_data() -> dict:
    """Return global CLAUDE.md content and per-project memory entries."""
    claude_home = Path.home() / ".claude"
    result: dict = {"global": None, "projects": []}

    global_md = claude_home / "CLAUDE.md"
    if global_md.exists():
        try:
            result["global"] = global_md.read_text(encoding="utf-8")
        except Exception:
            pass

    projects_root = claude_home / "projects"
    if not projects_root.exists():
        return result

    for project_dir in sorted(projects_root.iterdir()):
        if not project_dir.is_dir():
            continue
        memory_dir = project_dir / "memory"
        if not memory_dir.exists():
            continue

        entries = []
        for md_file in sorted(memory_dir.glob("*.md")):
            if md_file.name == "MEMORY.md":
                continue
            try:
                text = md_file.read_text(encoding="utf-8")
                meta, body = _parse_frontmatter(text)
                entries.append({
                    "file": md_file.name,
                    "name": meta.get("name", md_file.stem),
                    "description": meta.get("description", ""),
                    "type": meta.get("type", ""),
                    "body": body,
                })
            except Exception:
                pass

        index_text = None
        index_md = memory_dir / "MEMORY.md"
        if index_md.exists():
            try:
                index_text = index_md.read_text(encoding="utf-8")
            except Exception:
                pass

        if entries or index_text:
            result["projects"].append({
                "slug": project_dir.name,
                "index": index_text,
                "entries": entries,
            })

    return result

MAX_POST_BYTES = 1_000_000  # 1 MB — we only accept tiny JSON bodies (plan, tip key)
MAX_LIMIT = 1000


def _send_json(handler, obj, status: int = 200) -> None:
    body = json.dumps(obj, default=str).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def _send_error(handler, status: int, msg: str) -> None:
    _send_json(handler, {"error": msg}, status=status)


def _clamp_limit(raw, default: int) -> int:
    try:
        v = int(raw)
    except (TypeError, ValueError):
        return default
    return max(1, min(v, MAX_LIMIT))


def _serve_static(handler, rel: str) -> None:
    rel = rel.lstrip("/")
    p = (WEB_ROOT / rel).resolve()
    if not str(p).startswith(str(WEB_ROOT.resolve())) or not p.is_file():
        handler.send_response(404)
        handler.end_headers()
        return
    body = p.read_bytes()
    ctype, _ = mimetypes.guess_type(str(p))
    handler.send_response(200)
    handler.send_header("Content-Type", ctype or "application/octet-stream")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def build_handler(db_path: str, projects_dir: str, vps_config: dict | None = None):
    pricing = load_pricing(PRICING_JSON)

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

        def do_HEAD(self):
            return self.do_GET()

        def do_GET(self):
            url = urlparse(self.path)
            qs = parse_qs(url.query or "")
            path = url.path
            since = qs.get("since", [None])[0]
            until = qs.get("until", [None])[0]
            if path in ("/", "/index.html"):
                return _serve_static(self, "index.html")
            if path.startswith("/web/"):
                return _serve_static(self, path[5:])
            if path == "/api/overview":
                totals = overview_totals(db_path, since, until)
                cost_usd = 0.0
                for m in model_breakdown(db_path, since, until):
                    c = cost_for(m["model"], m, pricing)
                    if c["usd"] is not None:
                        cost_usd += c["usd"]
                totals["cost_usd"] = round(cost_usd, 4)
                return _send_json(self, totals)
            if path == "/api/prompts":
                limit = _clamp_limit(qs.get("limit", ["50"])[0], 50)
                sort = qs.get("sort", ["tokens"])[0]
                rows = expensive_prompts(db_path, limit=limit, sort=sort)
                for r in rows:
                    c = cost_for(r["model"], {
                        "input_tokens": 0, "output_tokens": 0,
                        "cache_read_tokens": r["cache_read_tokens"],
                        "cache_create_5m_tokens": 0, "cache_create_1h_tokens": 0,
                    }, pricing)
                    r["estimated_cost_usd"] = c["usd"]
                return _send_json(self, rows)
            if path == "/api/projects":
                return _send_json(self, project_summary(db_path, since, until))
            if path == "/api/tools":
                return _send_json(self, tool_token_breakdown(db_path, since, until))
            if path == "/api/sessions":
                project = qs.get("project", [None])[0]
                return _send_json(self, recent_sessions(
                    db_path, limit=_clamp_limit(qs.get("limit", ["20"])[0], 20),
                    since=since, until=until, project_slug=project,
                ))
            if path == "/api/daily":
                return _send_json(self, daily_token_breakdown(db_path, since, until))
            if path == "/api/skills":
                rows = skill_breakdown(db_path, since, until)
                catalog = cached_catalog()
                for r in rows:
                    info = catalog.get(r["skill"])
                    r["tokens_per_call"] = info["tokens"] if info else None
                return _send_json(self, rows)
            if path == "/api/by-model":
                rows = model_breakdown(db_path, since, until)
                for r in rows:
                    c = cost_for(r["model"], r, pricing)
                    r["cost_usd"] = c["usd"]
                    r["cost_estimated"] = c["estimated"]
                return _send_json(self, rows)
            if path.startswith("/api/sessions/"):
                sid = path.rsplit("/", 1)[1]
                return _send_json(self, session_turns(db_path, sid))
            if path == "/api/hooks":
                return _send_json(self, _read_hooks_data(db_path))
            if path == "/api/memory":
                return _send_json(self, _read_memory_data())
            if path == "/api/tips":
                return _send_json(self, all_tips(db_path))
            if path == "/api/plan":
                return _send_json(self, {"plan": get_plan(db_path), "pricing": pricing})
            if path == "/api/scan":
                n = scan_dir(projects_dir, db_path)
                if vps_config and vps_config["local_dir"].is_dir():
                    nv = scan_dir(vps_config["local_dir"], db_path, source="vps")
                    n = {k: n[k] + nv[k] for k in n}
                return _send_json(self, n)
            if path == "/api/vps-sync":
                if not vps_config:
                    return _send_error(self, 400, "VPS not configured (start with --vps-host)")
                try:
                    from .vps_sync import sync_projects
                    sync_projects(
                        vps_config["host"],
                        vps_config["local_dir"],
                        port=vps_config["port"],
                        key=vps_config["key"],
                        user=vps_config["user"],
                        remote_path=vps_config["remote_path"],
                    )
                    n = scan_dir(vps_config["local_dir"], db_path, source="vps")
                    EVENTS.put({"type": "vps-sync", "n": n, "ts": time.time()})
                    return _send_json(self, {"ok": True, **n})
                except Exception as e:
                    return _send_error(self, 500, str(e))
            if path == "/api/stream":
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "keep-alive")
                self.end_headers()
                while True:
                    try:
                        evt = EVENTS.get(timeout=15)
                        chunk = f"data: {json.dumps(evt, default=str)}\n\n".encode()
                    except queue.Empty:
                        chunk = b": ping\n\n"
                    try:
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                        return
            self.send_response(404)
            self.end_headers()

        def do_POST(self):
            url = urlparse(self.path)
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return _send_error(self, 400, "invalid Content-Length")
            if length < 0 or length > MAX_POST_BYTES:
                return _send_error(self, 413, f"body too large (max {MAX_POST_BYTES} bytes)")
            try:
                body = json.loads(self.rfile.read(length) or b"{}") if length else {}
            except json.JSONDecodeError:
                return _send_error(self, 400, "invalid JSON")
            if not isinstance(body, dict):
                return _send_error(self, 400, "body must be a JSON object")
            if url.path == "/api/plan":
                set_plan(db_path, body.get("plan", "api"))
                return _send_json(self, {"ok": True})
            if url.path == "/api/tips/dismiss":
                dismiss_tip(db_path, body.get("key", ""))
                return _send_json(self, {"ok": True})
            self.send_response(404)
            self.end_headers()

    return H


def _scan_loop(db_path: str, projects_dir: str, vps_config=None, interval: float = 30.0, vps_sync_interval: float = 300.0):
    from pathlib import Path
    last_vps_sync = 0.0
    while True:
        try:
            n = scan_dir(projects_dir, db_path)
            if vps_config:
                now = time.time()
                if now - last_vps_sync >= vps_sync_interval:
                    try:
                        from .vps_sync import sync_projects
                        sync_projects(
                            vps_config["host"],
                            vps_config["local_dir"],
                            port=vps_config["port"],
                            key=vps_config["key"],
                            user=vps_config["user"],
                            remote_path=vps_config["remote_path"],
                        )
                        last_vps_sync = time.time()
                    except Exception as e:
                        EVENTS.put({"type": "error", "message": f"vps-sync: {e}"})
                local_dir = Path(vps_config["local_dir"])
                if local_dir.is_dir():
                    nv = scan_dir(local_dir, db_path, source="vps")
                    n = {k: n[k] + nv[k] for k in n}
            if n["messages"] > 0:
                EVENTS.put({"type": "scan", "n": n, "ts": time.time()})
        except Exception as e:
            EVENTS.put({"type": "error", "message": str(e)})
        time.sleep(interval)


def run(host: str, port: int, db_path: str, projects_dir: str, vps_config: dict | None = None):
    threading.Thread(target=_scan_loop, args=(db_path, projects_dir, vps_config), daemon=True).start()
    H = build_handler(db_path, projects_dir, vps_config)
    httpd = http.server.ThreadingHTTPServer((host, port), H)
    httpd.serve_forever()
