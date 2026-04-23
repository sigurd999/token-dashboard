"""Pull a remote ~/.claude/projects/ directory to a local staging path via rsync or scp."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def sync_projects(
    host: str,
    local_dir: Path,
    *,
    port: int | None = None,
    key: str | None = None,
    user: str = "ubuntu",
    remote_path: str = "~/.claude/projects/",
    timeout: int = 120,
) -> None:
    """Copy remote JSONL transcripts to ``local_dir``.

    Tries rsync first (incremental, preferred). Falls back to ``scp -r`` when
    rsync is not on PATH (scp ships with OpenSSH, available on all platforms).

    ``host`` may be a bare hostname/IP or an SSH alias from ~/.ssh/config.
    When using an SSH alias, omit ``port`` and ``key`` so the flags are not
    passed to ssh -- the alias settings in ~/.ssh/config take precedence and
    explicitly passing port 22 would override the alias's configured port.
    """
    local_dir = Path(local_dir)
    local_dir.mkdir(parents=True, exist_ok=True)

    src = f"{user}@{host}:{remote_path}"
    dst = str(local_dir).rstrip("/\\") + "/"

    ssh_extra: list[str] = []
    if port is not None:
        ssh_extra += ["-p", str(port)]
    if key:
        ssh_extra += ["-i", key]

    if shutil.which("rsync"):
        ssh_cmd = "ssh " + " ".join(ssh_extra) if ssh_extra else "ssh"
        subprocess.run(
            ["rsync", "-az", "--delete", "-e", ssh_cmd, src, dst],
            check=True,
            timeout=timeout,
        )
    else:
        # scp copies everything each time (no incremental), but always works.
        scp_port_flags: list[str] = []
        if port is not None:
            scp_port_flags = ["-P", str(port)]
        if key:
            scp_port_flags += ["-i", key]
        # Strip trailing slash from src so scp copies contents, not a nested dir.
        subprocess.run(
            ["scp", "-r", *scp_port_flags, src.rstrip("/"), dst],
            check=True,
            timeout=timeout,
        )
