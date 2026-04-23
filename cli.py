"""Token Dashboard CLI entrypoint."""
from __future__ import annotations

import argparse
import os
import webbrowser
from datetime import datetime, timedelta, timezone
from pathlib import Path

from token_dashboard.db import init_db, default_db_path, overview_totals
from token_dashboard.scanner import scan_dir
from token_dashboard.tips import all_tips


def _db_path(args) -> str:
    return args.db or os.environ.get("TOKEN_DASHBOARD_DB") or str(default_db_path())


def _projects(args) -> str:
    return (
        args.projects_dir
        or os.environ.get("CLAUDE_PROJECTS_DIR")
        or str(Path.home() / ".claude" / "projects")
    )


def _vps_config(args) -> dict | None:
    """Return VPS connection config from args/env, or None if VPS host is unset."""
    host = getattr(args, "vps_host", None) or os.environ.get("VPS_HOST")
    if not host:
        return None
    _port = getattr(args, "vps_port", None) or os.environ.get("VPS_PORT")
    return {
        "host": host,
        "port": int(_port) if _port else None,
        "user": getattr(args, "vps_user", None) or os.environ.get("VPS_USER", "ubuntu"),
        "key": getattr(args, "vps_key", None) or os.environ.get("VPS_KEY") or None,
        "remote_path": (
            getattr(args, "vps_remote_path", None)
            or os.environ.get("VPS_REMOTE_PATH", "~/.claude/projects/")
        ),
        "local_dir": Path(
            getattr(args, "vps_local_dir", None)
            or os.environ.get("VPS_LOCAL_DIR")
            or str(Path.home() / ".claude" / "vps-projects")
        ),
    }


def _today_range():
    now = datetime.now(timezone.utc)
    start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc).isoformat()
    end = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    return start, end


def cmd_scan(args):
    db = _db_path(args)
    init_db(db)
    n = scan_dir(_projects(args), db)
    print(f"Token Dashboard: scanned {n['files']} files, {n['messages']} messages, {n['tools']} tool calls")


def cmd_sync_vps(args):
    cfg = _vps_config(args)
    if not cfg:
        print("Token Dashboard: --vps-host (or VPS_HOST env var) is required")
        return
    from token_dashboard.vps_sync import sync_projects
    db = _db_path(args)
    init_db(db)
    print(f"Token Dashboard: syncing {cfg['user']}@{cfg['host']}:{cfg['remote_path']} -> {cfg['local_dir']}")
    try:
        sync_projects(
            cfg["host"],
            cfg["local_dir"],
            port=cfg["port"],
            key=cfg["key"],
            user=cfg["user"],
            remote_path=cfg["remote_path"],
        )
    except Exception as e:
        print(f"Token Dashboard: sync failed: {e}")
        return
    n = scan_dir(cfg["local_dir"], db, source="vps")
    print(f"Token Dashboard: vps scan: {n['files']} files, {n['messages']} messages, {n['tools']} tool calls")


def cmd_today(args):
    db = _db_path(args)
    init_db(db)
    s, e = _today_range()
    t = overview_totals(db, since=s, until=e)
    print("Token Dashboard — today")
    print(f"  sessions: {t['sessions']}    turns: {t['turns']}")
    print(f"  input:    {t['input_tokens']:>12,}    output: {t['output_tokens']:>12,}")
    print(f"  cache rd: {t['cache_read_tokens']:>12,}    cache cr: {t['cache_create_5m_tokens']+t['cache_create_1h_tokens']:>12,}")


def cmd_stats(args):
    db = _db_path(args)
    init_db(db)
    t = overview_totals(db)
    print("Token Dashboard — all time")
    print(f"  sessions: {t['sessions']}    turns: {t['turns']}")
    print(f"  input:    {t['input_tokens']:>12,}    output: {t['output_tokens']:>12,}")


def cmd_tips(args):
    db = _db_path(args)
    init_db(db)
    tips = all_tips(db)
    if not tips:
        print("Token Dashboard: no suggestions")
        return
    for tip in tips:
        print(f"[{tip['category']}] {tip['title']}")
        print(f"  {tip['body']}\n")


def cmd_dashboard(args):
    db = _db_path(args)
    init_db(db)
    cfg = _vps_config(args)
    if not args.no_scan:
        scan_dir(_projects(args), db)
        if cfg and cfg["local_dir"].is_dir():
            scan_dir(cfg["local_dir"], db, source="vps")
    from token_dashboard.server import run

    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8080"))
    url = f"http://{host}:{port}/"
    if not args.no_open:
        webbrowser.open(url)
    print(f"Token Dashboard listening on {url}")
    run(host, port, db, _projects(args), vps_config=cfg)


def main():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--db", help="SQLite path (default ~/.claude/token-dashboard.db)")
    common.add_argument("--projects-dir", help="JSONL root (default ~/.claude/projects)")

    vps = argparse.ArgumentParser(add_help=False)
    vps.add_argument("--vps-host", help="SSH host or alias for VPS (e.g. 'vps' or '144.217.80.193')")
    vps.add_argument("--vps-port", type=int, default=None, help="SSH port (omit when using an SSH alias — the alias already has it)")
    vps.add_argument("--vps-user", default="ubuntu", help="Remote SSH user (default ubuntu)")
    vps.add_argument("--vps-key", help="Path to SSH private key (optional if alias handles it)")
    vps.add_argument("--vps-remote-path", default="~/.claude/projects/", help="Remote JSONL root")
    vps.add_argument("--vps-local-dir", help="Local staging directory (default ~/.claude/vps-projects)")

    p = argparse.ArgumentParser(prog="token-dashboard", description="Local Claude Code usage dashboard", parents=[common])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("scan",  parents=[common]).set_defaults(func=cmd_scan)
    sub.add_parser("today", parents=[common]).set_defaults(func=cmd_today)
    sub.add_parser("stats", parents=[common]).set_defaults(func=cmd_stats)
    sub.add_parser("tips",  parents=[common]).set_defaults(func=cmd_tips)
    sv = sub.add_parser("sync-vps", parents=[common, vps])
    sv.set_defaults(func=cmd_sync_vps)
    d = sub.add_parser("dashboard", parents=[common, vps])
    d.add_argument("--no-scan", action="store_true")
    d.add_argument("--no-open", action="store_true")
    d.set_defaults(func=cmd_dashboard)
    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
