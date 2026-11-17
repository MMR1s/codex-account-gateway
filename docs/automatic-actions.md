# Automatic browser actions

Relay stores two revocable permissions in its private state folder:
browser-action-permissions.json contains boolean radar and assistant settings.
Both default to false on a fresh installation. A user can change them in
the native sidebar under Automatic browser actions. They persist across restarts.

Radar applies only to the authenticated caller opportunity-radar-jobs.
Assistant applies only to native assistant: thread callers. Other apps continue
to require individual approval. Allowed action types are click, fill, press,
upload and learned api_call writes. Learning a new API recipe still requires review.
The payload of a browser request cannot enable its own permission.

These settings remove per-action prompts for tasks the user has requested.
They do not start a task, override a pause, grant webpage instructions authority,
enter passwords, or retry an ambiguous send. Uploads may transfer local files
supplied for the task; recipients and file contents should match that task.

The sidebar settings are changed only through trusted native IPC, not through
webpage content. Permission state is visible in the authenticated browser status.
Turning a setting off affects subsequent actions; an already executing request
cannot be recalled. An existing queued approval is never retroactively executed.
