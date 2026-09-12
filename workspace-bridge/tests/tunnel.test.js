import assert from "node:assert/strict";
import test from "node:test";
import { parseQuickTunnelUrl } from "../src/tunnel/quick.js";
import { localTunnelIsReady, tunnelIsReadyForSetup, waitForTunnel } from "../src/tunnel/health.js";

test("extracts only a Cloudflare Quick Tunnel HTTPS URL", () => {
  assert.equal(
    parseQuickTunnelUrl("INF Your quick Tunnel has been created! Visit it at https://quiet-river.trycloudflare.com"),
    "https://quiet-river.trycloudflare.com"
  );
  assert.equal(parseQuickTunnelUrl("http://127.0.0.1:48766"), null);
});

test("waits for a Quick Tunnel that becomes reachable after registration", async () => {
  let attempts = 0;
  let clock = 0;
  const ready = await waitForTunnel(
    { publicUrl: "https://quiet-river.trycloudflare.com" },
    "workspace-1",
    {
      timeoutMs: 30_000,
      intervalMs: 1_000,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("edge is still registering");
        return {
          ok: true,
          async json() {
            return { workspaceId: "workspace-1", status: "ok" };
          }
        };
      }
    }
  );

  assert.equal(ready, true);
  assert.equal(attempts, 3);
});

test("stops retrying when the Quick Tunnel readiness deadline expires", async () => {
  let attempts = 0;
  let clock = 0;
  const ready = await waitForTunnel(
    { publicUrl: "https://quiet-river.trycloudflare.com" },
    "workspace-1",
    {
      timeoutMs: 2_500,
      intervalMs: 1_000,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      fetchImpl: async () => {
        attempts += 1;
        throw new Error("unreachable");
      }
    }
  );

  assert.equal(ready, false);
  assert.equal(attempts, 3);
});

test("uses cloudflared loopback readiness during Windows setup", async () => {
  let requestedUrl = null;
  const ready = await tunnelIsReadyForSetup(
    { publicUrl: "https://quiet-river.trycloudflare.com", tunnelMetricsPort: 23456 },
    "workspace-1",
    {
      platform: "win32",
      fetchImpl: async (url) => {
        requestedUrl = url;
        return { ok: true };
      }
    }
  );

  assert.equal(ready, true);
  assert.equal(requestedUrl, "http://127.0.0.1:23456/ready");
});

test("rejects a running cloudflared process whose local readiness endpoint is down", async () => {
  let clock = 0;
  const runtime = { publicUrl: "https://quiet-river.trycloudflare.com", tunnelMetricsPort: 23456 };
  assert.equal(await localTunnelIsReady(runtime, { fetchImpl: async () => ({ ok: false }) }), false);
  const ready = await tunnelIsReadyForSetup(runtime, "workspace-1", {
    platform: "win32",
    timeoutMs: 1_000,
    intervalMs: 250,
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    fetchImpl: async () => ({ ok: false })
  });
  assert.equal(ready, false);
});

test("falls back to the bounded public health check for an old runtime without metrics", async () => {
  const ready = await tunnelIsReadyForSetup(
    { publicUrl: "https://quiet-river.trycloudflare.com" },
    "workspace-1",
    {
      platform: "linux",
      timeoutMs: 1,
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return { workspaceId: "workspace-1", status: "ok" };
        }
      })
    }
  );

  assert.equal(ready, true);
});
