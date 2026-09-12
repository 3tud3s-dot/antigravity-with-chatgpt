import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Workspace } from "./workspace/workspace.js";
import { startBridge } from "./bridge/server.js";
import {
  connectorDecision,
  connectorNameFor,
  markConnectorInstalled,
  markProjectCreated,
  projectDecision,
  projectNameFor,
  readConnector,
  readProject,
  readRuntime
} from "./bridge/state.js";
import { localTunnelIsReady, tunnelIsHealthy, tunnelIsReadyForSetup } from "./tunnel/health.js";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function output(data) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

async function runtimeIsHealthy(runtime, workspaceId) {
  if (!runtime || runtime.workspaceId !== workspaceId || !runtime.port) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/health`, { signal: AbortSignal.timeout(2000) });
    const body = await response.json();
    return response.ok && body.workspaceId === workspaceId && body.status === "ok";
  } catch {
    return false;
  }
}

async function waitForRuntime(workspaceId, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runtime = readRuntime(workspaceId);
    if (await runtimeIsHealthy(runtime, workspaceId)) return runtime;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Workspace Bridge did not become ready in time");
}

async function adminPost(runtime, route) {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${runtime.adminToken}` },
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`Bridge admin request failed (${response.status})`);
  return response.json();
}

async function setup(workspaceRoot, options = {}) {
  const workspace = new Workspace(workspaceRoot);
  let runtime = readRuntime(workspace.id);
  const localHealthy = await runtimeIsHealthy(runtime, workspace.id);
  if (localHealthy && !(await tunnelIsReadyForSetup(runtime, workspace.id))) {
    await adminPost(runtime, "/admin/shutdown").catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
    runtime = null;
  }
  if (!(await runtimeIsHealthy(runtime, workspace.id))) {
    if (options.requireLive) {
      throw new Error("Workspace Bridge is not running; start and keep the serve command active before setup");
    }
    const self = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [self, "serve", "--workspace", workspace.root], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    runtime = await waitForRuntime(workspace.id);
  }
  if (!(await tunnelIsReadyForSetup(runtime, workspace.id))) {
    await adminPost(runtime, "/admin/shutdown").catch(() => undefined);
    throw new Error("Quick Tunnel does not have an active Cloudflare connection");
  }
  const connector = readConnector(workspace.id);
  const project = readProject(workspace.id);
  const forced = options.reauthorize || process.argv.includes("--force-connector");
  const decision = connectorDecision(connector, runtime, forced);
  const projectName = projectNameFor(workspace);
  const result = {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    connectorName: runtime.connectorName,
    mcpUrl: runtime.mcpUrl,
    connector: decision,
    tunnelReady: true,
    projectName,
    project: projectDecision(project, workspace.id, projectName)
  };
  if (["create", "recreate"].includes(decision.action)) {
    Object.assign(result, await adminPost(runtime, "/admin/pairing"));
  }
  if (!(await runtimeIsHealthy(runtime, workspace.id))) {
    throw new Error("Workspace Bridge stopped before setup completed");
  }
  output(result);
}

async function main() {
  const command = process.argv[2];
  const workspaceRoot = argument("--workspace");
  if (!workspaceRoot) throw new Error("--workspace is required");
  if (command === "serve") {
    const workspace = new Workspace(workspaceRoot);
    if (await runtimeIsHealthy(readRuntime(workspace.id), workspace.id)) {
      throw new Error("Workspace Bridge is already running; reuse it through setup --require-live");
    }
    const bridge = await startBridge({ workspaceRoot });
    if (!(await tunnelIsReadyForSetup(bridge.runtime, bridge.runtime.workspaceId))) {
      await bridge.close();
      throw new Error("Quick Tunnel did not establish an active Cloudflare connection");
    }
    output({
      ready: true,
      service: bridge.runtime.service,
      workspaceId: bridge.runtime.workspaceId,
      workspaceName: bridge.runtime.workspaceName,
      connectorName: bridge.runtime.connectorName,
      mcpUrl: bridge.runtime.mcpUrl,
      tunnelReady: true
    });
    const stop = async () => {
      await bridge.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }
  if (command === "setup") {
    await setup(workspaceRoot, {
      requireLive: process.argv.includes("--require-live"),
      reauthorize: process.argv.includes("--reauthorize")
    });
    return;
  }
  if (command === "mark-connector-installed") {
    const workspace = new Workspace(workspaceRoot);
    const runtime = readRuntime(workspace.id);
    const mcpUrl = argument("--mcp-url");
    if (!runtime || !mcpUrl || runtime.mcpUrl !== mcpUrl) throw new Error("MCP URL does not match the live workspace bridge");
    output(markConnectorInstalled({
      workspaceId: workspace.id,
      connectorName: connectorNameFor(workspace),
      mcpUrl
    }));
    return;
  }
  if (command === "mark-project-created") {
    const workspace = new Workspace(workspaceRoot);
    const projectUrl = argument("--project-url");
    if (!projectUrl) throw new Error("--project-url is required");
    output(markProjectCreated({
      workspaceId: workspace.id,
      projectName: projectNameFor(workspace),
      projectUrl
    }));
    return;
  }
  if (command === "status") {
    const workspace = new Workspace(workspaceRoot);
    const runtime = readRuntime(workspace.id);
    const connector = readConnector(workspace.id);
    const project = readProject(workspace.id);
    const live = await runtimeIsHealthy(runtime, workspace.id);
    const localOnly = process.argv.includes("--local-only");
    const tunnelReady = live ? await localTunnelIsReady(runtime) : false;
    output({
      workspaceId: workspace.id,
      live,
      tunnelReady,
      publicReachable: localOnly ? null : await tunnelIsHealthy(runtime, workspace.id),
      runtime: runtime
        ? {
            service: runtime.service,
            version: runtime.version,
            workspaceId: runtime.workspaceId,
            workspaceRoot: runtime.workspaceRoot,
            workspaceName: runtime.workspaceName,
            connectorName: runtime.connectorName,
            pid: runtime.pid,
            port: runtime.port,
            tunnelMetricsPort: runtime.tunnelMetricsPort ?? null,
            publicUrl: runtime.publicUrl,
            mcpUrl: runtime.mcpUrl,
            startedAt: runtime.startedAt
          }
        : null,
      connector,
      project
    });
    return;
  }
  if (command === "stop") {
    const workspace = new Workspace(workspaceRoot);
    const runtime = readRuntime(workspace.id);
    if (!(await runtimeIsHealthy(runtime, workspace.id))) {
      output({ stopped: false, reason: "not_running" });
      return;
    }
    await adminPost(runtime, "/admin/shutdown");
    output({ stopped: true });
    return;
  }
  throw new Error(
    "Usage: node src/cli.js <setup|serve|status|stop|mark-connector-installed|mark-project-created> --workspace <path> [--require-live] [--reauthorize]"
  );
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
});
