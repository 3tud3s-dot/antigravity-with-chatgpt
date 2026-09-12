import crypto from "node:crypto";
import express from "express";
import { AuthStore } from "../auth/store.js";
import { bearerAuth } from "../auth/middleware.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { PairingManager } from "../pairing/manager.js";
import { createMcpServer } from "../mcp/server.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { Workspace } from "../workspace/workspace.js";
import { DEFAULT_HOST, DEFAULT_PORT, SERVICE_NAME, VERSION } from "../config.js";
import { QuickTunnel } from "../tunnel/quick.js";
import { clearRuntime, connectorNameFor, writeRuntime } from "./state.js";

function listen(app, host, preferredPort) {
  return new Promise((resolve, reject) => {
    const attempt = (port, fallback) => {
      const server = app.listen(port, host);
      server.once("listening", () => {
        const address = server.address();
        resolve({ server, port: typeof address === "object" && address ? address.port : port });
      });
      server.once("error", (error) => {
        if (error.code === "EADDRINUSE" && fallback) attempt(0, false);
        else reject(error);
      });
    };
    attempt(preferredPort, preferredPort !== 0);
  });
}

export async function startBridge(options) {
  const workspace = new Workspace(options.workspaceRoot);
  const host = options.host ?? DEFAULT_HOST;
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("Workspace Bridge may only bind to loopback");
  }
  const authStore = new AuthStore(workspace.id, options.authOptions);
  const pairing = new PairingManager(workspace.id, options.pairingOptions);
  const tunnel = options.tunnel ?? new QuickTunnel();
  const adminToken = `ag_admin_${crypto.randomBytes(24).toString("base64url")}`;
  const connectorName = connectorNameFor(workspace);
  let publicUrl = null;
  let actualPort = null;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  const getBaseUrl = (request) => publicUrl ?? `${request.protocol}://${request.get("host")}`;

  app.get("/health", (_request, response) => {
    response.json({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, status: "ok" });
  });
  app.use(createOAuthRouter({ store: authStore, pairing, workspaceName: workspace.name, getBaseUrl }));
  const mcpHandler = createMcpHttpHandler(() => createMcpServer({ workspace }));
  app.all(
    "/mcp",
    express.json({ limit: "2mb" }),
    bearerAuth({ store: authStore, workspaceId: workspace.id, getBaseUrl }),
    (request, response) => void mcpHandler(request, response)
  );

  const adminGuard = (request, response, next) => {
    const remote = request.socket.remoteAddress ?? "";
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
    const proxied = Boolean(request.headers["cf-connecting-ip"] || request.headers["x-forwarded-for"]);
    const header = request.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!loopback || proxied || token !== adminToken) {
      response.status(404).end();
      return;
    }
    next();
  };
  app.post("/admin/pairing", adminGuard, (_request, response) => response.json(pairing.create()));
  app.get("/admin/info", adminGuard, (_request, response) => {
    response.json({ workspaceId: workspace.id, workspaceName: workspace.name, connectorName, publicUrl, mcpUrl: `${publicUrl}/mcp` });
  });
  app.post("/admin/shutdown", adminGuard, (_request, response) => {
    response.json({ shuttingDown: true });
    setTimeout(() => void close().then(() => process.exit(0)), 100);
  });

  const listening = await listen(app, host, options.port ?? DEFAULT_PORT);
  actualPort = listening.port;
  try {
    publicUrl = await tunnel.start(actualPort);
  } catch (error) {
    await new Promise((resolve) => listening.server.close(resolve));
    throw error;
  }
  const runtime = {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    workspaceName: workspace.name,
    connectorName,
    pid: process.pid,
    port: actualPort,
    tunnelMetricsPort: tunnel.metricsPort ?? null,
    adminToken,
    publicUrl,
    mcpUrl: `${publicUrl}/mcp`,
    startedAt: new Date().toISOString()
  };
  if (options.persistRuntime !== false) writeRuntime(runtime);

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await tunnel.stop().catch(() => undefined);
    await new Promise((resolve) => listening.server.close(resolve));
    if (options.persistRuntime !== false) clearRuntime(workspace.id);
  }
  return { workspace, connectorName, authStore, pairing, runtime, close };
}
