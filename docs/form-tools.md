# Shared form inspection and file upload

Local apps use POST /admin/browser/control with the existing clientId/requestId envelope.
Use action form_snapshot and an explicit tabId to read ordinary editable values,
the name of each control, recipient email attributes, and file-input refs.
If exactly one visible dialog exists, the snapshot is scoped to it. Otherwise
it describes the document. Passwords, hidden input values and login codes stay
omitted. Normal snapshot continues to omit all editable values.

Use action upload with tabId, a fresh file-input ref and path (an absolute local
file under 20 MB). The file is attached using Chromium's file-input API; no
arbitrary script execution or general filesystem API is exposed. Upload normally
queues approval with the file path preview, even for a native assistant turn
with actions enabled. The MCP browser_action tool calls this argument file_path.
Only upload a file explicitly supplied by the user.

These actions are general browser capabilities. Job matching, candidate facts,
outreach messages and durable send history remain in Opportunity Radar.

Run the actual Chromium fixture with:

    node_modules\electron\dist\electron.exe test/fixtures/form-upload.cjs

It uses an isolated temporary browser profile and a loopback form, checks omitted
passwords, scopes a compose dialog, and verifies the selected file after upload
approval. It never contacts a real recipient. Relaunch an already running browser
after updating its desktop code. Reload the MCP connection for the new tool argument.
