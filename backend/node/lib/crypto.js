/**
 * AES-256-GCM encrypt/decrypt for secrets stored at rest (currently: the
 * WhatsApp provider API token in WhatsAppIntegration). Keyed by
 * INTEGRATION_ENCRYPTION_KEY in .env — a 32-byte key, base64-encoded
 * (generate with `openssl rand -base64 32`). This key is an application
 * secret, not a provider credential, so it stays in .env even though
 * provider credentials themselves now live in MongoDB.
 */
const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getKey() {
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY || "";
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "INTEGRATION_ENCRYPTION_KEY missing or invalid — set a 32-byte base64 key in .env (openssl rand -base64 32)"
    );
  }
  return key;
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(".");
}

function decrypt(ciphertext) {
  const key = getKey();
  const [ivB64, authTagB64, dataB64] = String(ciphertext).split(".");
  if (!ivB64 || !authTagB64 || !dataB64) throw new Error("Malformed ciphertext");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return decrypted.toString("utf8");
}

module.exports = { encrypt, decrypt };
