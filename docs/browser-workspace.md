# Gateway browser workspace

The browser is a general gateway capability. It is independent of Opportunity Radar or any other consuming app. Open **Browser → Open browser workspace** in the gateway dashboard, or run `Start browser.ps1`. Use `Setup browser.ps1` once to install the Electron runtime. Node 22.12+ and an installed Codex CLI are required.

The desktop window has persistent Chromium tabs, an address bar, and a Codex assistant. Sign into websites manually. Website sessions and tab URLs live in the gateway's private state directory under `browser-profile` and `browser-tabs.json`. The browser assistant uses Codex app-server with your existing account/provider configuration. A gateway provider uses its selected account; an OpenAI-direct provider stays direct. The model selector offers models reported by your CLI. This does not transfer another chat's history or grant unlimited usage.

AI tasks have browser tools. Shell, web search, multi-agent features, and globally configured MCP servers are disabled for the browser assistant. Password and login-code fields are excluded from snapshots and cannot be filled by browser tools. Page contents are untrusted data. Browsing, snapshots, and screenshots are available without mutation approval; clicks, typing, and key presses require approval in the sidebar. You can allow those actions for one AI task using the clearly labeled checkbox; that permission resets after the task. The sidebar also offers separate, persistent and revocable Automatic browser actions settings for the assistant and Opportunity Radar. Both default to off. Local apps cannot enable these settings or approve their own actions. See [Automatic browser actions](automatic-actions.md). Direct human interaction with the browser works normally.

## Input and output contract

Use the gateway's loopback HTTP API from an application's backend. Authenticate with `Authorization: Bearer <gateway credential>`. Read the credential from the existing private `gateway-key.txt`, or use your installation's credential helper; never put it in frontend JavaScript, URLs, source control, or logs. Existing gateway origin and host checks apply. The dashboard has equivalent `/admin/browser/*` routes guarded by its local admin checks.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/browser/status` | Running state, tab IDs, URLs, pending approvals |
| `POST /v1/browser/launch` | Open the local browser window |
| `POST /v1/browser/control` | Submit a structured action |
| `GET /v1/browser/requests/{requestId}?clientId={clientId}` | Poll an action result |
| `GET /v1/browser/approvals/{approvalId}` | Poll a pending human approval |
| `GET /v1/browser/events?after={sequence}` | Request lifecycle metadata |

An input envelope identifies the caller and the action:

```json
{
  "clientId": "opportunity-radar",
  "requestId": "read-post-81",
  "action": { "action": "snapshot", "tabId": "the-tab-id" }
}
```

A completed response has `state: "complete"` and a structured `result`. Snapshots provide `url`, `title`, `text`, and `elements` with short-lived `ref` identifiers. Form values are omitted. Screenshots provide a PNG data URL. Other actions report their outcome or request acknowledgment; read the page to verify the final website state.

Clicks, fills, and key presses may return HTTP 202:

```json
{
  "clientId": "opportunity-radar",
  "requestId": "draft-81",
  "state": "awaiting-approval",
  "approvalId": "the-approval-id",
  "result": null
}
```

Show that state in the consuming app and poll the request endpoint. The user sees the caller, page URL, action, and proposed text/key in the browser sidebar. Approval is pinned to the original tab and page URL. Approvals expire after five minutes or when the AI task is stopped. Apps receive the eventual result or error; they cannot approve through the API.

Supported actions: `tabs`, `open`, `select`, `close`, `navigate`, `back`, `forward`, `reload`, `snapshot`, `screenshot`, `click`, `fill`, `press`, `scroll`. `open` and `navigate` accept HTTP/HTTPS URLs. `click`/`fill` require a current element `ref`. `fill` accepts `text`. `press` accepts Enter, Tab, Escape, Backspace, arrows, Home, End, Control+A, Meta+A, or Space. `scroll` accepts up/down and a bounded pixel amount. There is no arbitrary JavaScript or cookie/token extraction endpoint.

Each consumer should open its own tab and keep its returned `tabId`. Browser logins are shared, but separate tabs reduce interference between workflows. Caller IDs label requests and deduplicate retries; they are not separate user accounts or security boundaries. All clients authorized with this local gateway credential share the same browser access. DOM changes or another snapshot can invalidate element references; take another snapshot after a stale-reference error. The browser window shows actions and active tabs as work proceeds. Request IDs prevent duplicate execution of the same client/action within the current browser process while the request record is retained (up to 200 retained request records; pending records are never evicted). Reusing the same ID for a different action is rejected. Request records, approvals, and event history are in memory and disappear on restart. Do not automatically repeat a message send, purchase, or other mutation if its outcome is unknown after a timeout or restart. Inspect the website first.

Events have a sequence cursor and contain caller ID, request ID, action name, tab ID, and lifecycle state. They do not contain page text or draft content. At most 500 events are retained; compare `oldestSequence` with your cursor to detect a gap. Results may contain private page content, so consuming apps should handle their storage deliberately. The gateway's existing traffic ledger continues to store model request metadata only. Codex manages AI conversation history separately.

## Python apps

Use `clients/browser_client.py` from a trusted local backend:

```python
from clients.browser_client import GatewayBrowser

browser = GatewayBrowser(key_file=private_key_path, client_id="my-research-app")
browser.launch()
# Wait until browser.state()["running"] is true.
opened = browser.action("open", url="https://example.com/", request_id="open-example-1")
tab_id = opened["result"]["tabId"]
page = browser.action("snapshot", tabId=tab_id, request_id="read-example-1")
print(page["result"]["title"])
```

The response to opening a tab acknowledges tab creation, not completed page loading. Inspect `loading` in browser state before taking the first snapshot. Use stable request IDs when intentionally retrying the same request; use a new ID for a fresh read. The client does not automatically retry mutations.

## Other agents: MCP

`gateway_browser.py` is a stdio MCP server with `browser_state`, `open_browser_workspace`, `browser_read`, `browser_action`, `browser_request_status`, and `browser_events`. It authenticates to the loopback gateway from the private state directory. Any MCP-compatible local agent can use it. For the installed legacy-layout gateway, register:

```powershell
codex mcp add gateway_browser -- "<gateway-python.exe>" "<gateway-folder>\gateway_browser.py"
```

Start a new agent/chat after registration. Each MCP process gets its own caller ID, and its tool results preserve request IDs. Pending approval and screenshot image outputs are supported. Read-only tools advertise read-only annotations; the action tool advertises possible side effects and still enforces the browser's human approval queue.

Opportunity Radar consumes this shared capability through **Inspect in gateway browser**. It opens a selected post in the gateway's browser; the browser assistant can then read it in the signed-in context and help with the user's requested next step. No client-finding logic is embedded in the browser service.

## Verification

Run Python unit tests in `tests/` and `npm test` in `desktop/`. `desktop/test/smoke.cjs` is an opt-in Electron integration check using an isolated profile and a local fixture. It tests snapshots, omitted password fields, approved local form actions, and a real Codex browser-tool round trip. The last step consumes model allowance. It never sends a message to a real recipient.

The browser is a local personal workspace, not a hosted browser service. Website restrictions, CAPTCHA, unsupported embedded sign-in flows, and account eligibility can still prevent a workflow. General-purpose operation is supported; task-specific website integrations may need further work.


## Reusable website APIs

The shared browser now includes **API lab**, powered by pinned `api-anything@0.4.0`: record same-origin JSON traffic once, save a parameterized operation, and reuse it from Codex, apps, or other agents without repeating UI steps. Public catalog reads use plain HTTP; signed-in operations stay in the existing browser session. New recipes require review, and writes follow the browser approval policy. See [site API setup, research comparison, inputs/outputs, and limits](site-api.md).
