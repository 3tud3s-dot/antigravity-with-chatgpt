import assert from "node:assert/strict";
import test from "node:test";
import { connectorDecision } from "../src/bridge/state.js";

const runtime = {
  workspaceId: "workspace-a",
  connectorName: "Antigravity with ChatGPT · project-a",
  mcpUrl: "https://current.example.invalid/mcp"
};

test("connector decision creates, reuses, or replaces without duplication", () => {
  assert.deepEqual(connectorDecision(null, runtime), { reusable: false, action: "create" });
  assert.deepEqual(connectorDecision({ ...runtime }, runtime), { reusable: true, action: "reuse" });
  assert.deepEqual(
    connectorDecision({ ...runtime, mcpUrl: "https://old.example.invalid/mcp" }, runtime),
    { reusable: false, action: "replace" }
  );
  assert.deepEqual(connectorDecision({ ...runtime }, runtime, true), { reusable: false, action: "replace" });
  assert.deepEqual(
    connectorDecision({ ...runtime, workspaceId: "workspace-b" }, runtime),
    { reusable: false, action: "replace" }
  );
});
