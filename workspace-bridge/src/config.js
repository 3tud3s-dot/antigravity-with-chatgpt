import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SERVICE_NAME = "antigravity-workspace-bridge";
export const VERSION = "0.1.0";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 48766;

export function getStateDir() {
  const override = process.env.ANTIGRAVITY_CHATGPT_STATE_DIR;
  if (override?.trim()) return path.resolve(override);
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "antigravity-with-chatgpt");
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
      "antigravity-with-chatgpt"
    );
  }
  return path.join(process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "antigravity-with-chatgpt");
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function writeSecureJson(file, data) {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort on platforms without POSIX mode semantics.
  }
}

export function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
