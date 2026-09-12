import { spawn } from "node:child_process";
import net from "node:net";
import readline from "node:readline";

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function parseQuickTunnelUrl(line) {
  return line.match(URL_PATTERN)?.[0] ?? null;
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("Unable to reserve a loopback metrics port"));
        else resolve(port);
      });
    });
  });
}

export class QuickTunnel {
  constructor(options = {}) {
    this.binary = options.binary ?? "cloudflared";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.child = null;
    this.url = null;
    this.metricsPort = null;
  }

  async start(port) {
    if (this.child && this.url) return this.url;
    const metricsPort = await reserveLoopbackPort();
    const child = spawn(
      this.binary,
      [
        "tunnel",
        "--url",
        `http://127.0.0.1:${port}`,
        "--no-autoupdate",
        "--metrics",
        `127.0.0.1:${metricsPort}`,
        ...(process.platform === "win32" ? ["--protocol", "http2"] : [])
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    this.child = child;
    this.metricsPort = metricsPort;
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
    this.metricsPort = null;
  }
}
