import crypto from "crypto";

/**
 * Servicio de encriptación AES-256-GCM para credenciales sensibles.
 *
 * Formato almacenado: iv:authTag:ciphertext (todo en hex)
 */

const ALGORITHM = "aes-256-gcm" as const;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error("ENCRYPTION_KEY no configurada en .env");
  }
  // Derivar una clave de 32 bytes a partir del string proporcionado
  return crypto.createHash("sha256").update(key).digest();
}

/**
 * Encripta un valor sensible (token, credential).
 * @param plaintext - Valor a encriptar
 * @returns Formato: iv:authTag:ciphertext (hex)
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Desencripta un valor almacenado.
 * @param encryptedValue - Formato: iv:authTag:ciphertext (hex)
 * @returns Valor original
 */
export function decrypt(encryptedValue: string): string {
  const key = getEncryptionKey();
  const parts = encryptedValue.split(":");

  if (parts.length !== 3) {
    throw new Error("Formato de valor encriptado inválido");
  }

  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const encrypted = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}
