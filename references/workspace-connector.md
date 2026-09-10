# Workspace Connector Protocol

This protocol provisions one read-only ChatGPT Connector per Antigravity workspace. Browser control remains exclusively on the existing `chrome-devtools` MCP path.

## 1. Invariants

- One canonical local workspace maps to one Connector name and one workspace ID.
- Different Antigravity conversations in the same workspace create different ChatGPT conversations but reuse the same Connector.
- The Connector exposes exactly six read-only tools: `workspace_info`, `list_directory`, `read_file`, `search_workspace`, `git_status`, and `git_diff`.
- Never create, expose, or imply write, delete, shell, commit, push, install, or arbitrary execution tools.
- Never enter a pairing code in a ChatGPT conversation. It belongs only in the OAuth authorization form.
- Never inspect, edit, delete, rename, reconnect, or overwrite a Connector whose name does not begin with `Antigravity with ChatGPT ·`.
- Within that prefix, operate only on the exact `connectorName` returned by the Workspace Bridge for the current workspace.

## 2. Start or recover the Workspace Bridge

Let `<skill-root>` be the directory containing `SKILL.md`, and let `<workspace-root>` be the current Antigravity workspace—not the Skill checkout unless the Skill checkout is itself the user's active workspace.

1. Require Node.js 20 or later and `cloudflared`. If either is unavailable, stop and report the missing prerequisite; do not silently expose an unauthenticated server.
2. If `<skill-root>/workspace-bridge/node_modules` is missing, run `npm ci --omit=dev` in `<skill-root>/workspace-bridge`. This installs only the bridge's implementation dependencies; it does not add an install tool to ChatGPT.
3. Run:

   ```text
   node <skill-root>/workspace-bridge/src/cli.js setup --workspace <workspace-root>
   ```

4. Parse the JSON response. It contains:

   ```json
   {
     "workspaceId": "<stable-id>",
     "workspaceName": "<name>",
     "connectorName": "Antigravity with ChatGPT · <workspace-name>",
     "mcpUrl": "https://<quick-tunnel-host>/mcp",
     "connector": {
       "reusable": false,
       "action": "create"
     },
     "code": "XXXX-XXXX",
     "expiresAt": 0
   }
   ```

The CLI canonicalizes the workspace root, reuses a healthy bridge for the same workspace, or starts a detached loopback-only bridge and Quick Tunnel. Runtime and Connector state live in the OS user state directory, outside the workspace and outside Git.

### Decision

- `connector.action == "reuse"`: do not open the plugin manager and do not create another Connector. Continue with a new Advisor conversation and verify `workspace_info` there.
- `connector.action == "create"`: create the exact returned Connector.
- `connector.action == "replace"`: the Quick Tunnel endpoint changed. Delete only the exact returned Connector if it exists, then recreate that same name. Never use Reconnect on the old endpoint.

If a supposedly reusable Connector fails the workspace verification, run setup once with `--force-connector`, then follow the returned `replace` flow. Do not loop indefinitely.

## 3. Create or replace the ChatGPT Connector

Use only `call_mcp_tool` with `ServerName="chrome-devtools"`. Take a fresh snapshot before every UID-based action and never reuse a UID after navigation, submission, modal changes, or SPA rendering.

1. Open a dedicated page with `new_page` at `https://chatgpt.com/#settings/Security`. If Developer mode is visibly off, enable it; if it is already on, leave it unchanged. Do not alter unrelated settings.
2. Navigate that same dedicated page to:
   `https://chatgpt.com/plugins`
3. If login, 2FA, CAPTCHA, or a human-verification wall appears, stop and ask the user to complete that one action. Never access credentials, cookies, tokens, localStorage, or sessionStorage.
4. Inspect only the Connector cards needed to find the exact `connectorName`.
   - Ignore every Connector without the `Antigravity with ChatGPT ·` prefix.
   - Ignore prefixed Connectors with a different exact name.
5. For `replace`, delete only the exact matching Connector. For `create`, if an exact match unexpectedly already exists, delete that exact match before creation so a duplicate is never created.
6. Navigate the same dedicated page to:
   `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
7. Fill the form:
   - Name: exact `connectorName`
   - Description: `Read-only access to the current Antigravity workspace for ChatGPT Advisor analysis.`
   - Server URL: exact `mcpUrl`
   - Authentication: `OAuth`
8. Submit Connect/Authorize. On the bridge authorization page, enter the current one-time `code` and submit.
9. Treat Connected/authorized/pairing accepted as success. Do not wait for a fixed tool count on the settings page.

If the code expires before submission, rerun setup with `--force-connector` to obtain a fresh code. Never print tokens or extract OAuth state from the page.

## 4. Create and verify the Advisor conversation

Whether the Connector was created or reused, create a new dedicated ChatGPT page for this Antigravity conversation. Do not reuse a ChatGPT conversation belonging to another Antigravity conversation.

1. Send the existing Advisor initialization Prompt exactly once:

   > 你是 Antigravity 的外部顾问。接下来会收到用户发送给 Antigravity 的任务。请给出简洁的分析、建议和可执行步骤，并指出重要风险或遗漏。Antigravity 会读取你的回复并负责最终判断和执行。

2. After that reply completes, send this separate verification Prompt with the returned values substituted:

   ```text
   Use the "<connectorName>" connector now. Call workspace_info. Confirm that workspaceId is "<workspaceId>" and workspaceName is "<workspaceName>". Then read one small non-sensitive top-level text file and report its workspace-relative path. Do not use any other connector.
   ```

3. Accept the binding only if the reply identifies both the expected workspace ID and name and demonstrates a successful file read. A name-only match is insufficient.
4. After successful verification, run:

   ```text
   node <skill-root>/workspace-bridge/src/cli.js mark-connector-installed --workspace <workspace-root> --mcp-url <mcpUrl>
   ```

5. Persist the new ChatGPT conversation URL in the existing per-conversation `chatgpt_session.json` along with `workspaceId` and `connectorName`.

If verification fails, do not mark the Connector installed and do not overwrite a previously valid conversation binding. Report the exact failure after one repair attempt.

## 5. Reuse behavior

On every later enable in the same workspace, run `setup` again:

- A live bridge plus a locally confirmed Connector at the same MCP URL returns `reuse`.
- A dead bridge starts a new Quick Tunnel; its URL differs, so setup returns `replace` rather than creating a second Connector.
- A new Antigravity conversation always creates a new ChatGPT conversation, even when the workspace Connector is reused.
- The first `workspace_info` verification in every new ChatGPT conversation guards against workspace or Connector cross-wiring.

The browser-visible Connector is never the authority by name alone. The canonical workspace ID and the live MCP URL are the binding authority.

For an explicit user-requested shutdown, stop only the bridge for that workspace:

```text
node <skill-root>/workspace-bridge/src/cli.js stop --workspace <workspace-root>
```
