import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config.js";

export function runtimeFile(workspaceId) {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), `${workspaceId}.json`);
}

export function connectorFile(workspaceId) {
  return path.join(ensureDir(path.join(getStateDir(), "connectors")), `${workspaceId}.json`);
}

export function readRuntime(workspaceId) {
  return readJsonIfExists(runtimeFile(workspaceId));
}

export function writeRuntime(state) {
  writeSecureJson(runtimeFile(state.workspaceId), state);
}

export function clearRuntime(workspaceId) {
  try {
    fs.rmSync(runtimeFile(workspaceId), { force: true });
  } catch {
    // A stale record is harmless because setup also performs a live health check.
  }
}

export function readConnector(workspaceId) {
  return readJsonIfExists(connectorFile(workspaceId));
}

export function markConnectorInstalled({ workspaceId, connectorName, mcpUrl }) {
  const state = { workspaceId, connectorName, mcpUrl, installedAt: new Date().toISOString() };
  writeSecureJson(connectorFile(workspaceId), state);
  return state;
}

export function connectorNameFor(workspace) {
  const suffix = workspace.name.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return `Antigravity with ChatGPT · ${suffix || workspace.id}`;
}

export function connectorDecision(connector, runtime, forced = false) {
  const reusable =
    !forced &&
    connector?.workspaceId === runtime.workspaceId &&
    connector?.mcpUrl === runtime.mcpUrl &&
    connector?.connectorName === runtime.connectorName;
  return {
    reusable,
    action: reusable ? "reuse" : connector ? "replace" : "create"
  };
}
