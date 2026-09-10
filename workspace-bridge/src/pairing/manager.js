import crypto from "node:crypto";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function createCode(length = 8) {
  const chars = [];
  while (chars.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      const ceiling = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
      if (byte >= ceiling) continue;
      chars.push(ALPHABET[byte % ALPHABET.length]);
      if (chars.length === length) break;
    }
  }
  return chars.join("");
}

const normalize = (value) => value.toUpperCase().replace(/[^A-Z2-9]/g, "");
const hash = (value) => crypto.createHash("sha256").update(value).digest();

export class PairingManager {
  constructor(workspaceId, options = {}) {
    this.workspaceId = workspaceId;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.ipLimit = options.ipLimit ?? 10;
    this.ipWindowMs = options.ipWindowMs ?? 60_000;
    this.session = null;
    this.ipHits = new Map();
  }

  create() {
    const raw = createCode();
    this.session = {
      id: crypto.randomBytes(16).toString("hex"),
      codeHash: hash(raw),
      expiresAt: Date.now() + this.ttlMs,
      attemptsLeft: this.maxAttempts
    };
    return {
      code: `${raw.slice(0, 4)}-${raw.slice(4)}`,
      expiresAt: this.session.expiresAt
    };
  }

  checkRate(ip) {
    if (!ip) return true;
    const now = Date.now();
    const current = this.ipHits.get(ip);
    if (!current || now > current.resetAt) {
      this.ipHits.set(ip, { count: 1, resetAt: now + this.ipWindowMs });
      return true;
    }
    current.count++;
    return current.count <= this.ipLimit;
  }

  verify(input, ip) {
    if (!this.checkRate(ip)) return { ok: false, reason: "rate_limited" };
    if (!this.session) return { ok: false, reason: "no_active_session" };
    if (Date.now() > this.session.expiresAt) {
      this.session = null;
      return { ok: false, reason: "expired" };
    }
    if (this.session.attemptsLeft <= 0) {
      this.session = null;
      return { ok: false, reason: "too_many_attempts" };
    }
    const candidate = hash(normalize(input));
    if (crypto.timingSafeEqual(candidate, this.session.codeHash)) {
      const id = this.session.id;
      this.session = null;
      return { ok: true, sessionId: id };
    }
    this.session.attemptsLeft--;
    const attemptsLeft = this.session.attemptsLeft;
    if (!attemptsLeft) this.session = null;
    return { ok: false, reason: attemptsLeft ? "invalid" : "too_many_attempts", attemptsLeft };
  }
}
