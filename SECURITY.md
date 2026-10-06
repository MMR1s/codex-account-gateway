# Security

This local experiment handles OAuth refresh tokens. The setup script protects its state folder on Windows, and the gateway binds only to loopback. Do not expose its ports or share runtime files. Host and Origin checks reduce browser-origin attacks; they are not a defense against malicious local software.

Activity tracking stores account slots, model names, timestamps, outcomes, token counts and durations. The quota cache retains only plan, window percentages, durations and reset times. Neither stores account identities or conversation text. Credentials remain in separate local account folders.

Disconnect removes the selected credential file from this PC; it does not revoke previously issued tokens server-side. Activity metadata remains. Use account security settings to revoke access if credentials may have been exposed.

The agent explorer reads local Codex task titles, IDs, model/provider metadata, update timestamps and recorded parent/child edges. It opens the state database read-only and returns metadata to the local dashboard without copying it into the gateway ledger. It does not read conversation history. Account identity hiding applies to account labels; task titles remain visible in the agent explorer. The task endpoint uses the same loopback, Host, Origin and custom-header checks as other administration endpoints.

Please report vulnerabilities privately through the repository owner's GitHub profile. Never paste credentials, raw authentication responses, state files or personal logs into public issues.

Live request attribution retains only a validated UUID from Codex thread/session headers in the transient in-flight table. It never stores raw request headers or opaque session strings. The UUID disappears when the request finishes; durable activity totals contain no task UUID. Unknown IDs do not light unrelated tasks.
