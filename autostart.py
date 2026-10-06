"""Start the user's local gateway quietly, unless it is already running."""
import json
from pathlib import Path
import subprocess
import sys
import urllib.request

here = Path(__file__).resolve().parent
try:
    with urllib.request.urlopen('http://127.0.0.1:4000/health', timeout=3) as response:
        health = json.load(response)
    if health.get('service') == 'dual-account-local':
        raise SystemExit(0)
    raise SystemExit('Port 4000 belongs to another service; gateway was not started.')
except (OSError, ValueError):
    pass

subprocess.Popen(
    [sys.executable, str(here / 'gateway.py')],
    cwd=str(here),
    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    close_fds=True,
)
