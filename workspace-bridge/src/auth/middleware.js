export function bearerAuth({ store, workspaceId, getBaseUrl }) {
  return (request, response, next) => {
    const challenge = (description) =>
      `Bearer realm="antigravity-workspace", error="invalid_token", error_description="${description}", ` +
      `resource_metadata="${getBaseUrl(request)}/.well-known/oauth-protected-resource/mcp"`;
    const header = request.headers.authorization;
    if (!header?.toLowerCase().startsWith("bearer ")) {
      response.status(401).set("WWW-Authenticate", challenge("Missing bearer token")).json({ error: "unauthorized" });
      return;
    }
    const token = header.slice(7).trim();
    const verdict = store.verifyAccessToken(token);
    if (!verdict.ok) {
      response.status(401).set("WWW-Authenticate", challenge(`Token ${verdict.reason}`)).json({ error: "unauthorized" });
      return;
    }
    if (verdict.record.workspaceId !== workspaceId) {
      response.status(403).json({ error: "forbidden" });
      return;
    }
    request.auth = {
      token,
      clientId: verdict.record.clientId,
      scopes: verdict.record.scopes,
      expiresAt: Math.floor(verdict.record.expiresAt / 1000)
    };
    next();
  };
}
