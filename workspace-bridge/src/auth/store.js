import crypto from "node:crypto";

export const SUPPORTED_SCOPES = ["workspace.read", "workspace.search", "git.read", "offline_access"];
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const randomToken = (prefix) => `${prefix}${crypto.randomBytes(32).toString("base64url")}`;

export class AuthStore {
  constructor(workspaceId, options = {}) {
    this.workspaceId = workspaceId;
    this.accessTtlMs = options.accessTtlMs ?? 60 * 60_000;
    this.refreshTtlMs = options.refreshTtlMs ?? 30 * 24 * 60 * 60_000;
    this.clients = new Map();
    this.codes = new Map();
    this.tokens = new Map();
  }

  registerClient({ name, redirectUris }) {
    const client = {
      clientId: randomToken("ag_client_"),
      name: name || "ChatGPT",
      redirectUris,
      createdAt: Date.now()
    };
    this.clients.set(client.clientId, client);
    return client;
  }

  getClient(clientId) {
    return this.clients.get(clientId) ?? null;
  }

  createAuthorizationCode(input) {
    const raw = randomToken("ag_code_");
    this.codes.set(digest(raw), { ...input, workspaceId: this.workspaceId, expiresAt: Date.now() + 5 * 60_000 });
    return raw;
  }

  consumeAuthorizationCode(code) {
    const key = digest(code);
    const record = this.codes.get(key);
    this.codes.delete(key);
    if (!record || Date.now() > record.expiresAt) return null;
    return record;
  }

  issueTokens({ clientId, scopes }) {
    const now = Date.now();
    const accessToken = randomToken("ag_access_");
    this.tokens.set(digest(accessToken), {
      kind: "access",
      clientId,
      workspaceId: this.workspaceId,
      scopes,
      expiresAt: now + this.accessTtlMs
    });
    let refreshToken;
    if (scopes.includes("offline_access")) {
      refreshToken = randomToken("ag_refresh_");
      this.tokens.set(digest(refreshToken), {
        kind: "refresh",
        clientId,
        workspaceId: this.workspaceId,
        scopes,
        expiresAt: now + this.refreshTtlMs
      });
    }
    return { accessToken, refreshToken, expiresIn: Math.floor(this.accessTtlMs / 1000), scopes };
  }

  verifyAccessToken(token) {
    const record = this.tokens.get(digest(token));
    if (!record) return { ok: false, reason: "invalid" };
    if (record.kind !== "access") return { ok: false, reason: "wrong_type" };
    if (Date.now() > record.expiresAt) {
      this.tokens.delete(digest(token));
      return { ok: false, reason: "expired" };
    }
    return { ok: true, record };
  }

  rotateRefreshToken(token, clientId) {
    const key = digest(token);
    const record = this.tokens.get(key);
    this.tokens.delete(key);
    if (!record || record.kind !== "refresh" || record.clientId !== clientId || Date.now() > record.expiresAt) return null;
    return this.issueTokens({ clientId, scopes: record.scopes });
  }

  revoke(token) {
    this.tokens.delete(digest(token));
  }
}
