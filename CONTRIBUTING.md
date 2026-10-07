# Contributing

Issues and pull requests are welcome. Include the steps to reproduce a problem, the expected behavior, and the observed behavior. Keep credentials, raw authentication responses, private task titles, and conversation content out of reports. See [SECURITY.md](SECURITY.md) for security reports.

## Project layout

| Location | Purpose |
| --- | --- |
| `gateway.py` | Account workers, request routing, and dashboard endpoints |
| `telemetry.py` | Local request ledger and allowance snapshots |
| `local_agents.py` | Read-only adapter for local Codex task metadata |
| `index.html`, `app.css`, `app.js`, `network.js` | Dashboard and task constellation |
| Root PowerShell scripts, `autostart.py`, `restore_provider.py` | Windows setup, startup, and restoration |
| `tests/` | Automated routing, telemetry, account-pool, and agent-reader checks |
| `docs/` | Dashboard details and demo recording guide |
| `media/` | Public cover, architecture diagram, and illustrative source image |
| `tools/` | Optional artwork rendering helpers |
| `.runtime/` | Ignored local dependencies and private state |

## Checks

Run `Setup.ps1` to create the local environment, then run these commands from the repository root. JavaScript syntax checks require Node.js.

```powershell
.runtime\venv\Scripts\python.exe -m unittest discover -s tests
node --check app.js
node --check network.js
git diff --check
```

The tests use temporary state and mocked backend responses. Live account verification consumes allowance and is a separate integration check.

Routing changes should preserve visible input and tool results, reject account-bound server state, and avoid replay after output or tool execution begins. Test manual selection, quota failover, cooldown behavior, and streaming lifecycle events when changing those paths. Telemetry changes should keep prompts, responses, identities, credentials, and durable task IDs out of the activity ledger. The agent adapter must keep Codex databases read-only and report unsupported formats as unavailable.

## Rebuilding artwork

These optional helpers require Pillow and NumPy; the gateway does not depend on them. Run them from the repository root in an environment with those libraries installed:

```powershell
python tools/render-cover.py
python tools/render-diagram.py
```

The cover reads `media/cover-constellation.png` by default and writes `media/project-cover.jpg` and `media/github-cover.png`. The diagram writes `media/how-it-works.png`. Keep public illustrations free of personal data and label demonstration values.
