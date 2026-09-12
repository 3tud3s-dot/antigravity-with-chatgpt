import crypto from "node:crypto";
import express from "express";
import { SUPPORTED_SCOPES } from "./store.js";

const escapeHtml = (value) =>
  String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

function isAllowedRedirectUri(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch {
    return false;
  }
}

function filterScopes(value) {
  const requested = String(value || "").split(/\s+/).filter(Boolean);
  return requested.length ? requested.filter((scope) => SUPPORTED_SCOPES.includes(scope)) : [...SUPPORTED_SCOPES];
}

function challengeFor(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function pairingPage({ requestId, workspaceName, scopes, error }) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
  <title>Authorize Antigravity Workspace</title></head><body>
  <main><h1>Authorize read-only workspace access</h1><p>Workspace: <strong>${escapeHtml(workspaceName)}</strong></p>
  <p>Scopes: ${scopes.map(escapeHtml).join(", ")}</p>${error ? `<p role="alert">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="authorize"><input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
  <label for="pairing_code">Pairing code</label><input id="pairing_code" name="pairing_code" autocomplete="one-time-code" required>
  <button type="submit">Authorize</button></form></main></body></html>`;
}

export function createOAuthRouter({ store, pairing, workspaceName, getBaseUrl }) {
  const router = express.Router();
  const pending = new Map();
  router.use((_request, response, next) => {
    response.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    });
    next();
  });
  const baseMetadata = (request) => {
    const base = getBaseUrl(request);
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: SUPPORTED_SCOPES
    };
  };
  const authMetadata = (request, response) => response.json(baseMetadata(request));
  router.get("/.well-known/oauth-authorization-server", authMetadata);
  router.get("/.well-known/oauth-authorization-server/mcp", authMetadata);
  router.get("/.well-known/openid-configuration", authMetadata);
  router.get("/.well-known/oauth-protected-resource", (request, response) => {
    const base = getBaseUrl(request);
    response.json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: SUPPORTED_SCOPES });
  });
  router.get("/.well-known/oauth-protected-resource/mcp", (request, response) => {
    const base = getBaseUrl(request);
    response.json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: SUPPORTED_SCOPES });
  });

  router.post("/oauth/register", express.json(), (request, response) => {
    const redirectUris = Array.isArray(request.body?.redirect_uris) ? request.body.redirect_uris : [];
    if (!redirectUris.length || !redirectUris.every((uri) => typeof uri === "string" && isAllowedRedirectUri(uri))) {
      response.status(400).json({ error: "invalid_redirect_uri" });
      return;
    }
    const client = store.registerClient({ name: request.body?.client_name, redirectUris });
    response.status(201).json({
      client_id: client.clientId,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"]
    });
  });

  router.get("/oauth/authorize", (request, response) => {
    const query = request.query;
    const client = typeof query.client_id === "string" ? store.getClient(query.client_id) : null;
    if (!client || typeof query.redirect_uri !== "string" || !client.redirectUris.includes(query.redirect_uri)) {
      response.status(400).send("Invalid client or redirect URI");
      return;
    }
    if (query.response_type !== "code" || query.code_challenge_method !== "S256" || typeof query.code_challenge !== "string") {
      response.status(400).send("Authorization code flow with PKCE S256 is required");
      return;
    }
    const requestId = crypto.randomBytes(24).toString("base64url");
    const record = {
      clientId: client.clientId,
      redirectUri: query.redirect_uri,
      state: typeof query.state === "string" ? query.state : "",
      codeChallenge: query.code_challenge,
      scopes: filterScopes(query.scope),
      expiresAt: Date.now() + 5 * 60_000
    };
    pending.set(requestId, record);
    response.type("html").send(pairingPage({ requestId, workspaceName, scopes: record.scopes }));
  });

  router.post("/oauth/authorize", express.urlencoded({ extended: false }), (request, response) => {
    const record = pending.get(request.body?.request_id);
    if (!record || Date.now() > record.expiresAt) {
      response.status(400).send("Authorization request expired");
      return;
    }
    const result = pairing.verify(request.body?.pairing_code ?? "", request.ip);
    if (!result.ok) {
      response.status(400).type("html").send(pairingPage({
        requestId: request.body.request_id,
        workspaceName,
        scopes: record.scopes,
        error: `Pairing failed: ${result.reason}`
      }));
      return;
    }
    pending.delete(request.body.request_id);
    const code = store.createAuthorizationCode(record);
    const redirect = new URL(record.redirectUri);
    redirect.searchParams.set("code", code);
    if (record.state) redirect.searchParams.set("state", record.state);
    response.redirect(redirect.toString());
  });

  router.post("/oauth/token", express.urlencoded({ extended: false }), express.json(), (request, response) => {
    const body = request.body ?? {};
    if (body.grant_type === "authorization_code") {
      const record = store.consumeAuthorizationCode(body.code ?? "");
      if (
        !record ||
        record.clientId !== body.client_id ||
        record.redirectUri !== body.redirect_uri ||
        typeof body.code_verifier !== "string" ||
        challengeFor(body.code_verifier) !== record.codeChallenge
      ) {
        response.status(400).json({ error: "invalid_grant" });
        return;
      }
      const tokens = store.issueTokens({ clientId: record.clientId, scopes: record.scopes });
      response.json({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: tokens.scopes.join(" ")
      });
      return;
    }
    if (body.grant_type === "refresh_token") {
      const tokens = store.rotateRefreshToken(body.refresh_token ?? "", body.client_id ?? "");
      if (!tokens) {
        response.status(400).json({ error: "invalid_grant" });
        return;
      }
      response.json({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: tokens.scopes.join(" ")
      });
      return;
    }
    response.status(400).json({ error: "unsupported_grant_type" });
  });

  router.post("/oauth/revoke", express.urlencoded({ extended: false }), (request, response) => {
    if (request.body?.token) store.revoke(request.body.token);
    response.status(200).end();
  });
  return router;
}
