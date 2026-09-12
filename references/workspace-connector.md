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
3. Run a bounded local-only status check first:

   ```text
   node <skill-root>/workspace-bridge/src/cli.js status --local-only --workspace <workspace-root>
   ```

   Continue to step 5 only when both `live` and `tunnelReady` are `true`. `live` means the local Node service exists; `tunnelReady` means cloudflared currently has an active Cloudflare connection. If `live` is true but `tunnelReady` is false, run `stop` once for this workspace and continue to step 4. If `live` is false, continue to step 4.

4. Start `serve` as a managed long-running command task:

   ```text
   node <skill-root>/workspace-bridge/src/cli.js serve --workspace <workspace-root>
   ```

   The command intentionally remains active for the lifetime of the Advisor session. Do not wait for it to exit. Wait at most 45 seconds for one JSON object with `"ready": true`; after that output appears, keep the task running and continue. If the task exits or no ready object appears within the bound, stop and report the Bridge startup failure.

5. Reuse the healthy Bridge from step 3, or keep the exact `serve` task from step 4 active, then run:

   ```text
   node <skill-root>/workspace-bridge/src/cli.js setup --require-live --workspace <workspace-root>
   ```

6. Parse the setup JSON response. It contains:

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
    "projectName": "Antigravity with ChatGPT · <workspace-name> · <workspace-id>",
    "project": {
      "reusable": false,
      "action": "create"
    },
     "code": "XXXX-XXXX",
     "expiresAt": 0
   }
   ```

The CLI canonicalizes the workspace root. The managed `serve` task owns the loopback-only Bridge and Quick Tunnel. cloudflared exposes a separately allocated loopback-only metrics endpoint; the CLI uses its `/ready` response to distinguish a live Node process from a live Cloudflare route without making a public-loopback request. `setup --require-live` fails instead of silently launching another detached process. Runtime and Connector state live in the OS user state directory, outside the workspace and outside Git.

### Decision

- `connector.action == "reuse"`: do not open the plugin manager and do not create another Connector. Continue with a new Advisor conversation and verify `workspace_info` there.
- `connector.action == "create"`: create the exact returned Connector.
- `connector.action == "recreate"`: the Quick Tunnel endpoint changed or the exact Connector needs fresh OAuth. Delete and recreate only the exact current-workspace Connector with the same name and current `mcpUrl`; complete OAuth again. Never create a second simultaneous Connector.
- `connector.action == "conflict"`: local state does not identify the expected workspace Connector. Stop and report; do not modify any Connector.

If a supposedly reusable Connector reports an account connection or authorization failure while `tunnelReady` is true, run `setup --require-live --reauthorize` once to get a fresh pairing code, follow the controlled `recreate` flow for that exact Connector, and retry verification once. Any second failure must stop the flow.

## 3. Create or recreate the ChatGPT Connector

Use only `call_mcp_tool` with `ServerName="chrome-devtools"`. Take a fresh snapshot before every UID-based action and never reuse a UID after navigation, submission, modal changes, or SPA rendering.

1. Open a dedicated page with `new_page` at `https://chatgpt.com/#settings/Security`. If Developer mode is visibly off, enable it; if it is already on, leave it unchanged. Do not alter unrelated settings.
2. Navigate that same dedicated page to:
   `https://chatgpt.com/plugins`
3. If login, 2FA, CAPTCHA, or a human-verification wall appears, stop and ask the user to complete that one action. Never access credentials, cookies, tokens, localStorage, or sessionStorage.
4. Inspect only the Connector cards needed to find the exact `connectorName`.
   - Ignore every Connector without the `Antigravity with ChatGPT ·` prefix.
   - Ignore prefixed Connectors with a different exact name.
   - Count exact-name matches. More than one exact match is ambiguous: stop and report without editing or deleting any of them. Zero or one match may continue through the controlled create/recreate rules below.
5. Branch strictly on `connector.action`. The branches are mutually exclusive.

   ### `recreate` branch

   - If exactly one matching card exists, reconfirm its full exact `connectorName` in a fresh snapshot immediately before deleting only that Connector. After the modal closes, take a fresh snapshot and confirm that no card with the exact name remains. If deletion is ambiguous, fails, or the exact card remains, stop without creating anything.
   - If no matching card exists, skip deletion and continue. This covers a previously incomplete cleanup without creating a duplicate.
   - Only after confirmed deletion, navigate the dedicated page to:
     `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
   - Create the same exact `connectorName` with the current `mcpUrl`; do not alter any other Connector.

   ### `create` branch

   - Use this branch only when `connector.action == "create"` and no exact matching Connector card exists.
   - If exactly one match unexpectedly exists, delete only that exact Connector and confirm its card disappears before continuing. More than one match must stop.
   - Navigate the dedicated page to:
     `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
   - Fill the new Connector form:
     - Name: exact `connectorName`
     - Description: `Read-only access to the current Antigravity workspace for ChatGPT Advisor analysis.`
     - Server URL: exact `mcpUrl`
     - Authentication: `OAuth`

6. Immediately before submitting the new-Connector form, run this bounded local-only check:

   ```text
   node <skill-root>/workspace-bridge/src/cli.js status --local-only --workspace <workspace-root>
   ```

   Continue only when `live` and `tunnelReady` are both `true` and the returned `runtime.mcpUrl` equals the setup result. Never use `curl`, Node `fetch`, PowerShell web commands, or repeated public discovery probes; the loopback cloudflared readiness endpoint and the ChatGPT Connector flow are the authorities.
7. Submit Connect/Authorize. On the bridge authorization page, enter the current one-time `code` and submit.
8. Treat Connected/authorized/pairing accepted as success. Do not wait for a fixed tool count on the settings page.

If the code expires before submission, rerun setup with `--require-live --reauthorize` to obtain a fresh code for the same Connector. Never print tokens or extract OAuth state from the page.

If ChatGPT displays an explicit Connector or OAuth error, stop that attempt immediately. Take one fresh snapshot and run one `status --local-only` check, then report the exact webpage error and `live` result. Do not keep clicking, refill the form, start network diagnostics, or loop through retries.

## 4. Create and verify the Advisor conversation

Whether the Connector was created or reused, first follow [chatgpt-project.md](./chatgpt-project.md) to create or recover the workspace Project and start a new dedicated conversation inside it. Do not create a normal ChatGPT chat and do not reuse a conversation belonging to another Antigravity conversation.

1. The Advisor role comes from Project Instructions. Do not send a separate initialization chat message.
2. Send this verification Prompt as the first message, with the returned values substituted:

   ```text
   Use the "<connectorName>" connector now. Call workspace_info. Confirm that workspaceId is "<workspaceId>" and workspaceName is "<workspaceName>". Then read one small non-sensitive top-level text file and report its workspace-relative path. Do not use any other connector.
   ```

3. Accept the binding only if the reply identifies both the expected workspace ID and name and demonstrates a successful file read. A name-only match is insufficient.
4. After successful verification, run:

   ```text
   node <skill-root>/workspace-bridge/src/cli.js mark-connector-installed --workspace <workspace-root> --mcp-url <mcpUrl>
   ```

5. Persist the new ChatGPT conversation URL in the existing per-conversation `chatgpt_session.json` along with `workspaceId` and `connectorName`.

If verification fails with an account connection or authorization error, perform exactly one repair attempt:

1. Run `status --local-only` once.
2. If `tunnelReady` is false, stop the stale Bridge, start a new managed `serve`, run `setup --require-live`, and follow its `recreate` action for the same Connector name.
3. If `tunnelReady` is true, run `setup --require-live --reauthorize` and follow its controlled `recreate` action with the fresh pairing code.
4. Return to the same Advisor conversation and retry the verification Prompt once.

Do not mark the Connector installed or overwrite a previously valid conversation binding until verification succeeds. A second failure ends the attempt and must be reported.

## 5. Reuse behavior

On every later enable in the same workspace, run `setup` again:

- A locally live Bridge whose cloudflared `/ready` endpoint is healthy plus a confirmed Connector at the same MCP URL returns `reuse`.
- A stale or dead Tunnel is stopped and restarted. Its new URL returns `recreate`, so Antigravity deletes only the old exact-name Connector and creates the same name with the new URL. It never leaves two simultaneous Connectors for the workspace.
- A new Antigravity conversation always creates a new ChatGPT conversation inside the saved workspace Project, even when the Project and Connector are reused.
- The first `workspace_info` verification in every new ChatGPT conversation guards against workspace or Connector cross-wiring.

The browser-visible Connector is never the authority by name alone. The canonical workspace ID and the live MCP URL are the binding authority.

For an explicit user-requested shutdown, stop only the bridge for that workspace:

```text
node <skill-root>/workspace-bridge/src/cli.js stop --workspace <workspace-root>
```
