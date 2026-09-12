import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config.js";

export function runtimeFile(workspaceId) {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), `${workspaceId}.json`);
}

export function connectorFile(workspaceId) {
  return path.join(ensureDir(path.join(getStateDir(), "connectors")), `${workspaceId}.json`);
}

export function projectFile(workspaceId) {
  return path.join(ensureDir(path.join(getStateDir(), "projects")), `${workspaceId}.json`);
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

export function readProject(workspaceId) {
  return readJsonIfExists(projectFile(workspaceId));
}

export function markConnectorInstalled({ workspaceId, connectorName, mcpUrl }) {
  const state = { workspaceId, connectorName, mcpUrl, installedAt: new Date().toISOString() };
  writeSecureJson(connectorFile(workspaceId), state);
  return state;
}

function workspaceNameSuffix(workspace, maxLength) {
  return workspace.name.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function connectorNameFor(workspace) {
  const suffix = workspaceNameSuffix(workspace, 60);
  return `Antigravity with ChatGPT · ${suffix || workspace.id}`;
}

export function projectNameFor(workspace) {
  const prefix = "Antigravity with ChatGPT · ";
  const idPart = ` · ${workspace.id}`;
  const maxSuffixLen = Math.max(0, 50 - prefix.length - idPart.length);
  const suffix = workspaceNameSuffix(workspace, maxSuffixLen) || "workspace";
  return `${prefix}${suffix}${idPart}`.slice(0, 50);
}

export function normalizeProjectUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Project URL must be a valid ChatGPT URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "chatgpt.com" ||
    url.username ||
    url.password ||
    url.pathname === "/" ||
    url.pathname.startsWith("/c/")
  ) {
    throw new Error("Project URL must identify a ChatGPT project");
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function markProjectCreated({ workspaceId, projectName, projectUrl }) {
  const state = {
    workspaceId,
    projectName,
    projectUrl: normalizeProjectUrl(projectUrl),
    createdAt: new Date().toISOString()
  };
  writeSecureJson(projectFile(workspaceId), state);
  return state;
}

export function projectDecision(project, workspaceId, projectName) {
  if (project?.workspaceId !== workspaceId || project?.projectName !== projectName) {
    return { reusable: false, action: "create" };
  }
  try {
    return { reusable: true, action: "reuse", projectUrl: normalizeProjectUrl(project.projectUrl) };
  } catch {
    return { reusable: false, action: "create" };
  }
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
