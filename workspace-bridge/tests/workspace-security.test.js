import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Workspace, WorkspaceError } from "../src/workspace/workspace.js";
import { searchWorkspace } from "../src/workspace/search.js";
import { cleanup, temporaryDirectory, write } from "./helpers.js";

test("workspace rejects traversal, absolute paths, symlink escapes, and sensitive files", async (t) => {
  const root = temporaryDirectory("ag-workspace");
  const outside = temporaryDirectory("ag-outside");
  t.after(() => cleanup(root, outside));
  write(root, "src/main.js", "export const visible = 'needle';\n");
  write(root, ".env", "TOKEN=needle-secret\n");
  write(root, "private.pem", "needle-private-key\n");
  write(root, "node_modules/noise.js", "needle-noise\n");
  write(outside, "outside.txt", "outside secret\n");
  const workspace = new Workspace(root);

  for (const candidate of ["../outside.txt", path.join(outside, "outside.txt"), "C:\\Windows\\win.ini"]) {
    assert.throws(() => workspace.resolve(candidate), (error) => error instanceof WorkspaceError && error.code === "PATH_OUTSIDE_WORKSPACE");
  }
  await assert.rejects(workspace.readFile(".env"), (error) => error.code === "ACCESS_DENIED_SENSITIVE_FILE");
  await assert.rejects(workspace.readFile("private.pem"), (error) => error.code === "ACCESS_DENIED_SENSITIVE_FILE");

  const listing = await workspace.listDirectory(".", { depth: 3 });
  assert.deepEqual(listing.entries.map((entry) => entry.path), ["src/", "src/main.js"]);
  const search = await searchWorkspace(workspace, { query: "needle" });
  assert.deepEqual(search.matches.map((match) => match.path), ["src/main.js"]);

  const link = path.join(root, "escape-link");
  try {
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`Symlink creation is unavailable: ${error.message}`);
    return;
  }
  assert.throws(() => workspace.resolve("escape-link/outside.txt"), (error) => error.code === "PATH_OUTSIDE_WORKSPACE");
});

test("read_file paginates text and rejects binary data", async (t) => {
  const root = temporaryDirectory("ag-read");
  t.after(() => cleanup(root));
  write(root, "lines.txt", "one\ntwo\nthree\nfour\n");
  fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([1, 0, 2]));
  const workspace = new Workspace(root);
  const page = await workspace.readFile("lines.txt", { startLine: 2, endLine: 3 });
  assert.equal(page.content, "two\nthree");
  assert.equal(page.nextStartLine, 4);
  await assert.rejects(workspace.readFile("binary.bin"), (error) => error.code === "BINARY_FILE");
});
