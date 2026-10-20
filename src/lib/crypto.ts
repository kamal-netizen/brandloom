import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * AES-256-GCM for the Instagram page tokens at rest — the same format as
 * Shipyard's env-var encryption (apps/api/src/crypto/crypto.service.ts).
 *
 * Stored format:  v1:<iv-b64url>:<authTag-b64url>:<ciphertext-b64url>
 *
 * GCM is authenticated, so a tampered row fails at decrypt rather than
 * yielding a plausible token. The version prefix leaves room for rotation.
 */
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const VERSION = "v1";

function keyFrom(raw: string | undefined): Buffer {
  if (!raw) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set. Generate one with:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  const key = Buffer.from(raw, "hex");
  // A short key silently weakens every stored token, so this is fatal.
  if (key.length !== 32) {
    throw new Error(`TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes); got ${key.length} bytes.`);
  }
  return key;
}

export function encrypt(plaintext: string, rawKey = process.env.TOKEN_ENCRYPTION_KEY): string {
  const key = keyFrom(rawKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decrypt(stored: string, rawKey = process.env.TOKEN_ENCRYPTION_KEY): string {
  const key = keyFrom(rawKey);
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("stored secret is malformed or uses an unknown format");
  const [, iv, tag, ct] = parts;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key or an altered row. Never log the ciphertext.
    throw new Error("unable to decrypt stored secret");
  }
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Constant-time string compare (scheduler secret, OAuth state). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}
