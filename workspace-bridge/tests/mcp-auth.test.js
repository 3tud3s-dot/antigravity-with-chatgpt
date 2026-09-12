import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge } from "../src/bridge/server.js";
import { cleanup, fakeTunnel, git, initializeGit, temporaryDirectory, write } from "./helpers.js";

const jsonResult = (result) => JSON.parse(result.content[0].text);

test("MCP exposes exactly six read-only tools and reads current uncommitted state", async (t) => {
  const root = temporaryDirectory("ag-mcp");
  t.after(() => cleanup(root));
  initializeGit(root);
  write(root, "source.txt", "committed\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  write(root, "source.txt", "local-uncommitted-value\n");
  const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnel: fakeTunnel, persistRuntime: false });
  t.after(() => bridge.close());
  const tokens = bridge.authStore.issueTokens({
    clientId: "test-client",
    scopes: ["workspace.read", "workspace.search", "git.read"]
  });
  const client = new Client({ name: "bridge-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${bridge.runtime.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } }
    })
  );
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ["git_diff", "git_status", "list_directory", "read_file", "search_workspace", "workspace_info"]
  );
  assert.ok(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true));
  const info = jsonResult(await client.callTool({ name: "workspace_info", arguments: {} }));
  assert.equal(info.rootAlias, "workspace:/");
  assert.equal(JSON.stringify(info).includes(root), false);
  const file = jsonResult(await client.callTool({ name: "read_file", arguments: { path: "source.txt" } }));
  assert.equal(file.content, "local-uncommitted-value");
  const diff = jsonResult(await client.callTool({ name: "git_diff", arguments: {} }));
  assert.match(diff.diff, /local-uncommitted-value/);
});

test("an access token issued for one workspace is rejected by another bridge", async (t) => {
  const rootA = temporaryDirectory("ag-token-a");
  const rootB = temporaryDirectory("ag-token-b");
  t.after(() => cleanup(rootA, rootB));
  const bridgeA = await startBridge({ workspaceRoot: rootA, port: 0, tunnel: fakeTunnel, persistRuntime: false });
  const bridgeB = await startBridge({ workspaceRoot: rootB, port: 0, tunnel: fakeTunnel, persistRuntime: false });
  t.after(() => Promise.all([bridgeA.close(), bridgeB.close()]));
  const tokenA = bridgeA.authStore.issueTokens({ clientId: "client-a", scopes: ["workspace.read"] }).accessToken;
  const response = await fetch(`http://127.0.0.1:${bridgeB.runtime.port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  });
  assert.equal(response.status, 401);
});

test("OAuth requires PKCE, supports refresh, and uses a short-lived one-time pairing code", async (t) => {
  const root = temporaryDirectory("ag-oauth");
  t.after(() => cleanup(root));
  const bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    tunnel: fakeTunnel,
    persistRuntime: false,
    authOptions: { accessTtlMs: 5 }
  });
  t.after(() => bridge.close());
  const local = `http://127.0.0.1:${bridge.runtime.port}`;
  const redirectUri = "https://chatgpt.com/aip/callback";
  const registration = await fetch(`${local}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [redirectUri] })
  });
  assert.equal(registration.status, 201);
  const { client_id: clientId } = await registration.json();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${local}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "workspace.read workspace.search git.read offline_access",
    state: "test-state",
    code_challenge: challenge,
    code_challenge_method: "S256"
  });
  const page = await fetch(authorize);
  assert.equal(page.status, 200);
  assert.match(
    page.headers.get("content-security-policy"),
    /form-action 'self' https:\/\/chatgpt\.com(?:;|\s)/
  );
  const requestId = (await page.text()).match(/name="request_id" value="([^"]+)"/)?.[1];
  assert.ok(requestId);
  const pairing = bridge.pairing.create();
  const approval = await fetch(`${local}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, pairing_code: pairing.code })
  });
  assert.equal(approval.status, 302);
  const callback = new URL(approval.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), "test-state");
  const tokenResponse = await fetch(`${local}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code"),
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier
    })
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.match(tokens.access_token, /^ag_access_/);
  assert.match(tokens.refresh_token, /^ag_refresh_/);
  assert.equal(bridge.pairing.verify(pairing.code).reason, "no_active_session");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(bridge.authStore.verifyAccessToken(tokens.access_token), { ok: false, reason: "expired" });
  const refreshResponse = await fetch(`${local}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId
    })
  });
  assert.equal(refreshResponse.status, 200);
  const refreshed = await refreshResponse.json();
  assert.match(refreshed.access_token, /^ag_access_/);
  assert.notEqual(refreshed.access_token, tokens.access_token);
  assert.match(refreshed.refresh_token, /^ag_refresh_/);
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
});

test("public MCP endpoint rejects unauthenticated requests", async (t) => {
  const root = temporaryDirectory("ag-unauthorized");
  t.after(() => cleanup(root));
  const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnel: fakeTunnel, persistRuntime: false });
  t.after(() => bridge.close());
  const response = await fetch(`http://127.0.0.1:${bridge.runtime.port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /resource_metadata=/);
});
