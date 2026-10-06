# Security

This local experiment handles OAuth refresh tokens. The setup script protects its state folder on Windows, and the gateway binds only to loopback. Do not expose its ports or share runtime files. Host and Origin checks reduce browser-origin attacks; they are not a defense against malicious local software.

Activity tracking stores account slots, model names, timestamps, outcomes, token counts and durations. The quota cache retains only plan, window percentages, durations and reset times. Neither stores account identities or conversation text. Credentials remain in separate local account folders.

Disconnect removes the selected credential file from this PC; it does not revoke previously issued tokens server-side. Activity metadata remains. Use account security settings to revoke access if credentials may have been exposed.

Please report vulnerabilities privately through the repository owner's GitHub profile. Never paste credentials, raw authentication responses, state files or personal logs into public issues.
