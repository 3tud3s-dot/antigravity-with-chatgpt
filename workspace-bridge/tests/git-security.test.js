import assert from "node:assert/strict";
import test from "node:test";
import { Workspace } from "../src/workspace/workspace.js";
import { gitDiff, gitStatus } from "../src/workspace/git.js";
import { cleanup, git, initializeGit, temporaryDirectory, write } from "./helpers.js";

test("git tools expose live safe changes but omit sensitive paths and content", (t) => {
  const root = temporaryDirectory("ag-git");
  t.after(() => cleanup(root));
  initializeGit(root);
  write(root, "safe.txt", "before\n");
  write(root, ".env", "SECRET=before\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  write(root, "safe.txt", "after-uncommitted\n");
  write(root, ".env", "SECRET=do-not-leak\n");
  write(root, ".env.local", "TOKEN=untracked-secret\n");
  write(root, "new file.txt", "visible-untracked\n");
  const workspace = new Workspace(root);

  const status = gitStatus(workspace);
  assert.deepEqual(status.unstaged.map((entry) => entry.path), ["safe.txt"]);
  assert.deepEqual(status.untracked, ["new file.txt"]);
  const diff = gitDiff(workspace, { mode: "unstaged" });
  assert.match(diff.diff, /after-uncommitted/);
  assert.doesNotMatch(diff.diff, /do-not-leak|SECRET|\.env/);
});

test("git_diff denies a rename when either side is sensitive", (t) => {
  const root = temporaryDirectory("ag-git-rename");
  t.after(() => cleanup(root));
  initializeGit(root);
  write(root, "visible.txt", "sensitive body\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  git(root, "mv", "visible.txt", "secrets.json");
  const workspace = new Workspace(root);
  const diff = gitDiff(workspace, { mode: "staged" });
  assert.equal(diff.diff, "");
});
