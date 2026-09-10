import assert from "node:assert/strict";
import test from "node:test";
import { parseQuickTunnelUrl } from "../src/tunnel/quick.js";
import { tunnelIsReadyForSetup, waitForTunnel } from "../src/tunnel/health.js";

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

test("skips the unreliable public-loopback probe during Windows setup", async () => {
  let attempted = false;
  const ready = await tunnelIsReadyForSetup(
    { publicUrl: "https://quiet-river.trycloudflare.com" },
    "workspace-1",
    {
      platform: "win32",
      fetchImpl: async () => {
        attempted = true;
        throw new Error("public loopback is blocked");
      }
    }
  );

  assert.equal(ready, true);
  assert.equal(attempted, false);
});

test("keeps the bounded public health check on other platforms", async () => {
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
