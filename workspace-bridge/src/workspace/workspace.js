import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { PathPolicy } from "./policy.js";

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
const normalizeCase = (value) => (CASE_INSENSITIVE ? value.toLowerCase() : value);
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;
const DEFAULT_MAX_LINES = 400;
const HARD_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 256 * 1024;

export class WorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

export class Workspace {
  constructor(rootInput) {
    const resolved = path.resolve(rootInput);
    let real;
    try {
      real = fs.realpathSync.native(resolved);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `Workspace root does not exist: ${rootInput}`);
    }
    if (!fs.statSync(real).isDirectory()) {
      throw new WorkspaceError("NOT_A_DIRECTORY", `Workspace root is not a directory: ${rootInput}`);
    }
    this.root = real;
    this.id = crypto.createHash("sha256").update(normalizeCase(real)).digest("hex").slice(0, 12);
    this.name = path.basename(real);
    this.policy = new PathPolicy(real);
  }

  contains(candidate) {
    const root = normalizeCase(this.root);
    const value = normalizeCase(candidate);
    return value === root || value.startsWith(root + path.sep);
  }

  canonicalize(absolutePath) {
    let current = absolutePath;
    const suffix = [];
    for (;;) {
      try {
        const real = fs.realpathSync.native(current);
        return suffix.length ? path.join(real, ...suffix) : real;
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return absolutePath;
        suffix.unshift(path.basename(current));
        current = parent;
      }
    }
  }

  resolve(requested, { allowSensitive = false } = {}) {
    if (typeof requested !== "string" || requested.includes("\0")) {
      throw new WorkspaceError("INVALID_PATH", "Invalid path");
    }
    let input = requested.trim();
    if (!input || input === "/") input = ".";
    input = input.replace(/^workspace:\/*/i, "");
    if (!input) input = ".";
    if (path.isAbsolute(input) || WINDOWS_ABSOLUTE.test(input) || input.startsWith("\\\\")) {
      throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", `Absolute paths are not allowed: ${requested}`);
    }
    input = input.replace(/\\/g, "/");
    const absolute = path.resolve(this.root, input);
    const canonical = this.canonicalize(absolute);
    if (!this.contains(canonical)) {
      throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", `Path resolves outside the workspace: ${requested}`);
    }
    const relative = path.relative(this.root, canonical).split(path.sep).join("/");
    if (relative.startsWith("..")) {
      throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", `Path resolves outside the workspace: ${requested}`);
    }
    if (!allowSensitive && relative && this.policy.isSensitive(relative)) {
      throw new WorkspaceError(
        "ACCESS_DENIED_SENSITIVE_FILE",
        `ACCESS_DENIED_SENSITIVE_FILE: '${relative}' cannot be read.`
      );
    }
    return { absolute: canonical, relative };
  }

  async isBinary(absolute) {
    const handle = await fs.promises.open(absolute, "r");
    try {
      const sample = Buffer.alloc(8192);
      const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
      return sample.subarray(0, bytesRead).includes(0);
    } finally {
      await handle.close();
    }
  }

  async readFile(requested, options = {}) {
    const { absolute, relative } = this.resolve(requested);
    let stat;
    try {
      stat = await fs.promises.stat(absolute);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `File not found: ${relative}`);
    }
    if (!stat.isFile()) throw new WorkspaceError("NOT_A_FILE", `Not a regular file: ${relative}`);
    if (await this.isBinary(absolute)) throw new WorkspaceError("BINARY_FILE", `Binary file is not readable: ${relative}`);

    const startLine = Math.max(1, Math.floor(options.startLine ?? 1));
    const maxLines = Math.min(HARD_MAX_LINES, Math.max(1, Math.floor(options.maxLines ?? DEFAULT_MAX_LINES)));
    const endLimit = options.endLine
      ? Math.min(Math.floor(options.endLine), startLine + HARD_MAX_LINES - 1)
      : startLine + maxLines - 1;
    const maxBytes = Math.min(1024 * 1024, Math.max(1024, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES)));
    const lines = [];
    let totalLines = 0;
    let returnedBytes = 0;
    let actualEnd = startLine - 1;
    let byteLimitReached = false;
    const stream = fs.createReadStream(absolute, { encoding: "utf8" });
    const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of reader) {
      totalLines++;
      if (totalLines < startLine || totalLines > endLimit || byteLimitReached) continue;
      const cost = Buffer.byteLength(line, "utf8") + 1;
      if (returnedBytes + cost > maxBytes && lines.length) {
        byteLimitReached = true;
        continue;
      }
      lines.push(line);
      returnedBytes += cost;
      actualEnd = totalLines;
    }
    const remainingLines = Math.max(0, totalLines - actualEnd);
    return {
      path: relative,
      sizeBytes: stat.size,
      totalLines,
      startLine: Math.min(startLine, Math.max(totalLines, 1)),
      endLine: actualEnd,
      truncated: remainingLines > 0,
      remainingLines,
      nextStartLine: remainingLines > 0 ? actualEnd + 1 : null,
      content: lines.join("\n")
    };
  }

  async listDirectory(requested = ".", options = {}) {
    const { absolute, relative } = this.resolve(requested);
    let stat;
    try {
      stat = await fs.promises.stat(absolute);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `Directory not found: ${relative || "."}`);
    }
    if (!stat.isDirectory()) throw new WorkspaceError("NOT_A_DIRECTORY", `Not a directory: ${relative}`);
    const depth = Math.min(4, Math.max(1, Math.floor(options.depth ?? 1)));
    const limit = Math.min(1000, Math.max(1, Math.floor(options.limit ?? 200)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const all = [];
    const walk = async (directory, directoryRelative, level) => {
      let entries;
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => Number(a.isFile()) - Number(b.isFile()) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        const childRelative = directoryRelative ? `${directoryRelative}/${entry.name}` : entry.name;
        if (this.policy.isHidden(childRelative) || this.policy.isHidden(`${childRelative}/`)) continue;
        const childAbsolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          all.push({ path: `${childRelative}/`, type: "dir" });
          if (level < depth) await walk(childAbsolute, childRelative, level + 1);
        } else if (entry.isFile()) {
          const sizeBytes = (await fs.promises.stat(childAbsolute).catch(() => null))?.size;
          all.push({ path: childRelative, type: "file", ...(sizeBytes === undefined ? {} : { sizeBytes }) });
        }
        if (all.length >= offset + limit + 2000) return;
      }
    };
    await walk(absolute, relative, 1);
    const entries = all.slice(offset, offset + limit);
    return {
      path: relative || ".",
      entries,
      total: all.length,
      offset,
      limit,
      hasMore: offset + entries.length < all.length
    };
  }

  detectProject() {
    const has = (name) => fs.existsSync(path.join(this.root, name));
    const languages = [];
    let projectType = "unknown";
    let packageManager = null;
    if (has("package.json")) {
      projectType = "node";
      languages.push("JavaScript");
      if (has("tsconfig.json")) languages.push("TypeScript");
      if (has("pnpm-lock.yaml")) packageManager = "pnpm";
      else if (has("yarn.lock")) packageManager = "yarn";
      else if (has("package-lock.json")) packageManager = "npm";
    } else if (has("pyproject.toml") || has("requirements.txt")) {
      projectType = "python";
      languages.push("Python");
    } else if (has("Cargo.toml")) {
      projectType = "rust";
      languages.push("Rust");
    } else if (has("go.mod")) {
      projectType = "go";
      languages.push("Go");
    }
    return { projectType, languages, packageManager };
  }
}
