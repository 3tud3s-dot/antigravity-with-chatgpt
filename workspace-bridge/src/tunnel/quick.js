import { spawn } from "node:child_process";
import readline from "node:readline";

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function parseQuickTunnelUrl(line) {
  return line.match(URL_PATTERN)?.[0] ?? null;
}

export class QuickTunnel {
  constructor(options = {}) {
    this.binary = options.binary ?? "cloudflared";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.child = null;
    this.url = null;
  }

  async start(port) {
    if (this.child && this.url) return this.url;
    const child = spawn(
      this.binary,
      [
        "tunnel",
        "--url",
        `http://127.0.0.1:${port}`,
        "--no-autoupdate",
        ...(process.platform === "win32" ? ["--protocol", "http2"] : [])
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    this.child = child;
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, url) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          void this.stop();
          reject(error);
        } else {
          this.url = url;
          resolve(url);
        }
      };
      const inspect = (line) => {
        const url = parseQuickTunnelUrl(line);
        if (url) finish(null, url);
      };
      readline.createInterface({ input: child.stdout }).on("line", inspect);
      readline.createInterface({ input: child.stderr }).on("line", inspect);
      child.once("error", (error) => finish(error));
      child.once("exit", (code) => {
        if (!settled) finish(new Error(`cloudflared exited before producing a URL (code ${code})`));
      });
      const timer = setTimeout(() => finish(new Error("Timed out waiting for the Quick Tunnel URL")), this.timeoutMs);
    });
  }

  async stop() {
    if (!this.child) return;
    this.child.kill("SIGTERM");
    this.child = null;
    this.url = null;
  }
}
