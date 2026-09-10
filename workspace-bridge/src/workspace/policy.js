import fs from "node:fs";
import path from "node:path";
import ignore from "ignore";

export const SENSITIVE_PATTERNS = [
  ".env",
  ".env.*",
  "!.env.example",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "id_rsa",
  "id_rsa.*",
  "id_ed25519",
  "id_ed25519.*",
  "id_ecdsa",
  "id_ecdsa.*",
  ".ssh/",
  ".aws/",
  ".gnupg/",
  ".npmrc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".cloudflared/",
  "credentials.json",
  "service-account*.json",
  "secrets.json",
  "cookies.sqlite",
  "Cookies",
  "chatgpt_session.json",
  "mcp_config.json"
];

export const NOISE_PATTERNS = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  "coverage/",
  ".cache/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".pytest_cache/",
  ".idea/",
  ".tooling/",
  ".DS_Store"
];

export class PathPolicy {
  constructor(workspaceRoot) {
    this.sensitive = ignore().add(SENSITIVE_PATTERNS);
    this.noise = ignore().add(NOISE_PATTERNS);
    this.custom = ignore();
    const customFile = path.join(workspaceRoot, ".antigravity-chatgpt-ignore");
    try {
      if (fs.existsSync(customFile)) this.custom.add(fs.readFileSync(customFile, "utf8"));
    } catch {
      // Default deny rules remain active if the optional file cannot be read.
    }
  }

  isSensitive(relativePath) {
    if (!relativePath || relativePath === ".") return false;
    return this.sensitive.ignores(relativePath) || this.custom.ignores(relativePath);
  }

  isNoise(relativePath) {
    if (!relativePath || relativePath === ".") return false;
    return this.noise.ignores(relativePath);
  }

  isHidden(relativePath) {
    return this.isSensitive(relativePath) || this.isNoise(relativePath);
  }
}
