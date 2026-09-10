import fs from "node:fs";
import path from "node:path";

function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp(`(^|/)${escaped}$`, "i");
}

export async function searchWorkspace(workspace, options) {
  if (!options.query || options.query.length < 2) {
    return { matches: [], matchCount: 0, truncated: false, engine: "node" };
  }
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)));
  const { absolute, relative } = workspace.resolve(options.path ?? ".");
  const needle = options.query.toLowerCase();
  const glob = options.glob ? globToRegex(options.glob) : null;
  const matches = [];
  let truncated = false;

  const walk = async (directory, directoryRelative) => {
    if (truncated) return;
    let entries;
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const childRelative = directoryRelative ? `${directoryRelative}/${entry.name}` : entry.name;
      if (workspace.policy.isHidden(childRelative) || workspace.policy.isHidden(`${childRelative}/`)) continue;
      const childAbsolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(childAbsolute, childRelative);
        continue;
      }
      if (!entry.isFile() || (glob && !glob.test(childRelative))) continue;
      const stat = await fs.promises.stat(childAbsolute).catch(() => null);
      if (!stat || stat.size > 2 * 1024 * 1024) continue;
      let content;
      try {
        content = await fs.promises.readFile(childAbsolute, "utf8");
      } catch {
        continue;
      }
      if (content.includes("\0")) continue;
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index++) {
        const hit = lines[index].toLowerCase().includes(needle);
        if (!hit) continue;
        matches.push({ path: childRelative, line: index + 1, text: lines[index].trimEnd().slice(0, 500) });
        if (matches.length >= limit) {
          truncated = true;
          return;
        }
      }
    }
  };

  const startingRelative = relative || "";
  const stat = await fs.promises.stat(absolute).catch(() => null);
  if (!stat) return { matches: [], matchCount: 0, truncated: false, engine: "node" };
  if (stat.isDirectory()) await walk(absolute, startingRelative);
  else if (stat.isFile() && !workspace.policy.isHidden(startingRelative)) {
    const content = await fs.promises.readFile(absolute, "utf8");
    if (!content.includes("\0")) {
      for (const [index, line] of content.split("\n").entries()) {
        const hit = line.toLowerCase().includes(needle);
        if (hit) matches.push({ path: startingRelative, line: index + 1, text: line.trimEnd().slice(0, 500) });
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
      }
    }
  }
  return { matches, matchCount: matches.length, truncated, engine: "node" };
}
