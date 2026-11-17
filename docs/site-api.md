# Reusable website APIs

The gateway can read websites in two additional ways: call API Anything's installed public read operations over HTTP, or learn a reusable JSON request from the gateway browser's own traffic. This is a general gateway capability available to the assistant, local apps, and other MCP agents. It is independent of Opportunity Radar.

## What API Anything actually does

[API Anything](https://github.com/goodnight000/api-anything) learns operations from browser requests and replays them. It does not reveal every website's hidden data or guarantee support for every service. Learning generally needs a real example, and dynamic session headers, changing endpoints, GraphQL encodings, challenges and unsupported transports can still prevent reuse. Its own README states these limits.

The gateway pins the MIT-licensed `api-anything@0.4.0` npm package, with its license distributed in the dependency. Its `learnOperation` compiler checks and describes captured operations. Its `api-anything/host` interface provides local discovery, planning and calls for the installed catalog. The integration sets `API_ANYTHING_LOCAL_ONLY=1`, uses a private API Anything home beneath gateway state, and caps catalog calls at plain HTTP (`maxTier:1`, `allowWrites:false`). It does not run the upstream setup wizard, import your everyday browser's cookies, share captures, publish recipes, or contact the community registry. Catalog calls still contact the requested websites.

The checked package contains 114 bundled site manifests; this is an inventory count, not a claim that every operation currently works. Site failures are returned as such. Use `catalog_sites` with `query`, `offset`, and `limit`, then `catalog_describe` to learn the actual operation names and parameters.

## Learning from a signed-in browser

1. Open a website in the gateway browser and sign in yourself.
2. Open **API lab**, then **Record tab**. Capture is explicit and limited to this tab's original origin, Fetch/XHR requests and successful JSON responses. Sign-in/token endpoints, static resources and other origins are skipped. Recording does not itself send any request.
3. Use the relevant website feature once, such as searching or opening a list. A real write performed manually is still a real write; teaching does not undo it. Do not send an unwanted message just to collect an example.
4. Stop recording, refresh the list, select the relevant JSON request and give it a name.
5. Select the observed query keys or dotted JSON body fields that should become parameters. A query key `q` becomes argument `query_q`; JSON field `message` becomes `body_message`.
6. Explicitly classify the operation as a read or a write. Creating a recipe through an agent or API always queues a review of its URL, method and parameter choices. Clicking **Save reusable operation** yourself is the direct human workflow.
7. Inspect `api_plan`, then use `api_call` to reuse the request. Reads do not need repeated UI navigation; writes follow the browser's approval policy. No arbitrary URL-fetch or JavaScript-execution API was added.

Learned requests run as same-origin `fetch` calls in a tab already open on that website. The browser supplies its existing session cookies. Recorded auth/CSRF header values are held only in private process memory, never returned in capture metadata or saved in the manifest. Known credential query/body fields are replaced with placeholders and restored internally for the call. Operation manifests persist in `site-api-operations.json` under private gateway state. Cookie-only operations can reuse the browser's persisted sign-in. Operations requiring captured headers/fields need recapture after a browser restart or token rotation; `requiresRecapture` reports that condition. Their secrets are not exported to API Anything's session files or to other apps.

Captured request bodies/responses are bounded and held in memory. Request metadata and response previews redact credential-like field names. Response data remains untrusted website content and may contain private account data that the user authorized the agent to read. Callers must decide whether and where to store their results.

## Shared HTTP actions

All actions use the existing `/v1/browser/control` envelope, bearer credential and request-result polling. Other clients must not hold credentials in browser frontend code.

```json
{
  "clientId": "my-local-app",
  "requestId": "search-posts-42",
  "action": {
    "action": "api_call",
    "tabId": "the-tab-id",
    "operationId": "the-saved-operation-id",
    "args": { "query_q": "a new search" }
  }
}
```

| Action | Input | Result |
| --- | --- | --- |
| `api_capture_start` | `tabId` | Start recording same-origin JSON traffic |
| `api_capture_stop` | `tabId` | Stop and list recorded request metadata |
| `api_requests` | `tabId` | Captured IDs, redacted URLs, candidate parameter names, response previews |
| `api_learn` | `tabId`, `captureId`, `name`, `readOnly`, `queryParams`, `bodyParams` | Review/save a reusable operation |
| `api_operations` | none | Saved operation IDs, origins, arguments, read/write labels and recapture status |
| `api_plan` | `operationId`, `args` | Preview request without sending |
| `api_call` | `tabId`, `operationId`, `args` | Bounded JSON response from the existing signed-in browser |
| `catalog_sites` | optional `query`, `offset`, `limit` | Local installed read-operation catalog |
| `catalog_describe` | `site` | Operation/argument details |
| `catalog_plan` | `site`, `operation`, `args` | Preview a public HTTP call |
| `catalog_call` | `site`, `operation`, `args` | Public read result through API Anything's host SDK |

The native Codex sidebar has these actions in its existing browser tool. The `gateway_browser` MCP server exposes `browser_api_operations` and `browser_api`; the latter uses `action`, stable `request_id`, and the corresponding snake_case inputs (`tab_id`, `operation_id`, `capture_id`, `read_only`, `query_params`, `body_params`, `args`, `site`, `operation`). Existing MCP `browser_request_status` handles approval/results. Restart an existing MCP client or start a new chat to discover the added tools.

## Writes and limits

Write operations are not automatically retried. Use stable caller/request IDs for the same intended action; the gateway's retained request record prevents repeated execution while the browser process retains it. An HTTP success is labeled **sent-unverified**, not delivered or applied. Check a subsequent read or the website before claiming success. A network failure after sending is **unknown**; do not repeat it blindly. Records are not a durable exactly-once system across browser restarts.

This initial adapter supports same-origin JSON Fetch/XHR operations, ordinary query parameters and dotted JSON body fields. It does not yet infer dependent request chains, rotate signed transaction IDs, learn WebSocket protocols, or parameterize JSON embedded inside query strings. Such requests can fail and require site-specific work. Redirects are not followed during signed-in replay. Responses are bounded to 256 KiB and returned arrays to 100 items; use the site's pagination/query parameters for larger reads. Capture is bounded to 60 records and approximately 8 MiB per tab.

Creating an incorrectly labeled read can have side effects, so review that classification. Obvious write endpoint paths are rejected as reads, but endpoint names cannot prove semantics. Website account access, restrictions, and authorization still apply. No real external messages are sent as installation tests.

## Alternatives assessed

| Project | Verified role | Fit here |
| --- | --- | --- |
| [API Anything](https://github.com/goodnight000/api-anything) | Local reusable request specs, compiler, read/write controls, host library | Integrated, pinned to 0.4.0; local-only |
| [Unbrowse](https://github.com/unbrowse-ai/unbrowse) | Current README describes a CLI/SDK connected to a hosted service and hosted MCP | Adds a hosted account/service dependency; not required for this local gateway |
| [Reverse API Engineer](https://github.com/kalil0321/reverse-api-engineer) | Captures traffic and generates typed client code with an agent | Useful for generating a dedicated connector later; not needed as a second full browser/agent stack |

These are capability comparisons from the current source/README inspection, not independent performance benchmarks. Source checkout inspected: API Anything `d40abd44f171c5cc444f1ac6b947afefa8605b78`; npm runtime version is pinned separately in `desktop/package-lock.json`.
