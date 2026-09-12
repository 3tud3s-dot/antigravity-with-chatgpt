import assert from "node:assert/strict";
import test from "node:test";
import { connectorDecision, normalizeProjectUrl, projectDecision, projectNameFor } from "../src/bridge/state.js";

const runtime = {
  workspaceId: "workspace-a",
  connectorName: "Antigravity with ChatGPT · project-a",
  mcpUrl: "https://current.example.invalid/mcp"
};

test("connector decision creates, reuses, or recreates without duplication", () => {
  assert.deepEqual(connectorDecision(null, runtime), { reusable: false, action: "create" });
  assert.deepEqual(connectorDecision({ ...runtime }, runtime), { reusable: true, action: "reuse" });
  assert.deepEqual(
    connectorDecision({ ...runtime, mcpUrl: "https://old.example.invalid/mcp" }, runtime),
    { reusable: false, action: "recreate" }
  );
  assert.deepEqual(connectorDecision({ ...runtime }, runtime, true), { reusable: false, action: "recreate" });
  assert.deepEqual(
    connectorDecision({ ...runtime, workspaceId: "workspace-b" }, runtime),
    { reusable: false, action: "conflict" }
  );
});

test("project decision reuses only the matching workspace project", () => {
  const project = {
    workspaceId: "workspace-a",
    projectName: "Antigravity with ChatGPT · project-a",
    projectUrl: "https://chatgpt.com/g/g-p-example/project"
  };
  assert.deepEqual(
    projectDecision(project, "workspace-a", "Antigravity with ChatGPT · project-a"),
    { reusable: true, action: "reuse", projectUrl: "https://chatgpt.com/g/g-p-example/project" }
  );
  assert.deepEqual(
    projectDecision(project, "workspace-b", "Antigravity with ChatGPT · project-a"),
    { reusable: false, action: "create" }
  );
  assert.deepEqual(projectDecision(null, "workspace-a", project.projectName), { reusable: false, action: "create" });
  assert.deepEqual(
    projectDecision({ ...project, projectUrl: "https://example.com/project" }, "workspace-a", project.projectName),
    { reusable: false, action: "create" }
  );
});

test("project names include the stable workspace id to avoid basename collisions", () => {
  const name = projectNameFor({ name: "project-a", id: "abc123def456" });
  assert.equal(name, "Antigravity with ChatGPT · project- · abc123def456");
  assert.ok(name.length <= 50);
});

test("project URLs are restricted to non-chat ChatGPT pages", () => {
  assert.equal(
    normalizeProjectUrl("https://chatgpt.com/g/g-p-example/project?temporary=1#section"),
    "https://chatgpt.com/g/g-p-example/project"
  );
  assert.throws(() => normalizeProjectUrl("https://example.com/project"), /ChatGPT project/);
  assert.throws(() => normalizeProjectUrl("https://chatgpt.com/c/example"), /ChatGPT project/);
});
