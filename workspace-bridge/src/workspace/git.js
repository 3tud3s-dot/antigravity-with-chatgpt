import { spawnSync } from "node:child_process";

function runGit(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function gitInfo(workspace) {
  const check = runGit(workspace.root, ["rev-parse", "--is-inside-work-tree"]);
  if (!check.ok || check.stdout.trim() !== "true") {
    return { isRepo: false, branch: null, commit: null, dirty: false };
  }
  const branch = runGit(workspace.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = runGit(workspace.root, ["rev-parse", "--short", "HEAD"]);
  const status = runGit(workspace.root, ["status", "--porcelain", "--", "."]);
  return {
    isRepo: true,
    branch: branch.ok ? branch.stdout.trim() : null,
    commit: commit.ok ? commit.stdout.trim() : null,
    dirty: status.ok && Boolean(status.stdout.trim())
  };
}

export function gitStatus(workspace) {
  const empty = {
    isRepo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: []
  };
  const result = runGit(workspace.root, ["status", "--porcelain=v1", "--branch", "-z", "--", "."]);
  if (!result.ok) return empty;
  const output = { ...empty, isRepo: true };
  const records = result.stdout.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index++) {
    const line = records[index];
    if (line.startsWith("## ")) {
      const header = line.slice(3);
      const match = header.match(/^(.+?)(?:\.\.\.(\S+))?(?: \[ahead (\d+)(?:, behind (\d+))?\]| \[behind (\d+)\])?$/);
      if (match) {
        output.branch = match[1] === "HEAD (no branch)" ? null : match[1];
        output.upstream = match[2] ?? null;
        output.ahead = Number(match[3] ?? 0);
        output.behind = Number(match[4] ?? match[5] ?? 0);
      }
    } else if (line.startsWith("?? ")) {
      const filePath = line.slice(3);
      if (!workspace.policy.isSensitive(filePath)) output.untracked.push(filePath);
    } else if (line.length >= 4) {
      const xy = line.slice(0, 2);
      let filePath = line.slice(3);
      if (xy.includes("R") || xy.includes("C")) {
        const originalPath = records[++index] ?? "";
        if (workspace.policy.isSensitive(filePath) || workspace.policy.isSensitive(originalPath)) continue;
        filePath = `${originalPath} -> ${filePath}`;
      } else if (workspace.policy.isSensitive(filePath)) continue;
      if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy)) output.conflicted.push(filePath);
      else {
        if (xy[0] !== " ") output.staged.push({ path: filePath, change: xy[0] });
        if (xy[1] !== " ") output.unstaged.push({ path: filePath, change: xy[1] });
      }
    }
  }
  return output;
}

function diffModeArgs(mode) {
  if (mode === "staged") return ["--cached"];
  if (mode === "head") return ["HEAD"];
  return [];
}

function inScope(filePath, scope) {
  return !scope || scope === "." || filePath === scope || filePath.startsWith(`${scope}/`);
}

export function gitDiff(workspace, options = {}, scope) {
  const mode = options.mode ?? "unstaged";
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const maxBytes = Math.min(256 * 1024, Math.max(1024, Math.floor(options.maxBytes ?? 64 * 1024)));
  const modeArgs = diffModeArgs(mode);
  const inventory = runGit(workspace.root, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames=1%",
    ...modeArgs,
    "--",
    "."
  ]);
  if (!inventory.ok) {
    return { isRepo: false, mode, totalBytes: 0, offset: 0, returnedBytes: 0, hasMore: false, nextOffset: null, diff: "" };
  }

  const tokens = inventory.stdout.split("\0");
  const safePaths = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++];
    if (!status) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      if (
        oldPath &&
        newPath &&
        !workspace.policy.isSensitive(oldPath) &&
        !workspace.policy.isSensitive(newPath) &&
        (inScope(oldPath, scope) || inScope(newPath, scope))
      ) {
        safePaths.push(oldPath, newPath);
      }
    } else {
      const filePath = tokens[index++];
      if (filePath && !workspace.policy.isSensitive(filePath) && inScope(filePath, scope)) safePaths.push(filePath);
    }
  }
  if (!safePaths.length) {
    return { isRepo: true, mode, totalBytes: 0, offset: 0, returnedBytes: 0, hasMore: false, nextOffset: null, diff: "" };
  }

  let combined = "";
  for (let index = 0; index < safePaths.length; index += 50) {
    const pathspecs = safePaths.slice(index, index + 50).map((filePath) => `:(literal)${filePath}`);
    const result = runGit(workspace.root, ["diff", "--no-color", "--find-renames=1%", ...modeArgs, "--", ...pathspecs]);
    if (!result.ok || Buffer.byteLength(combined, "utf8") + Buffer.byteLength(result.stdout, "utf8") > 64 * 1024 * 1024) {
      return { isRepo: false, mode, totalBytes: 0, offset: 0, returnedBytes: 0, hasMore: false, nextOffset: null, diff: "" };
    }
    combined += result.stdout;
  }
  const full = Buffer.from(combined, "utf8");
  let slice = full.subarray(offset, offset + maxBytes);
  let text = slice.toString("utf8");
  if (offset + slice.length < full.length) {
    const newline = text.lastIndexOf("\n");
    if (newline > 0) {
      text = text.slice(0, newline + 1);
      slice = Buffer.from(text, "utf8");
    }
  }
  const hasMore = offset + slice.length < full.length;
  return {
    isRepo: true,
    mode,
    totalBytes: full.length,
    offset,
    returnedBytes: slice.length,
    hasMore,
    nextOffset: hasMore ? offset + slice.length : null,
    diff: text
  };
}
