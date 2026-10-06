import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** AES-256-GCM secret encryption (Section 9). */

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

export type EncryptedSecret = { ciphertext: string; iv: string; tag: string };

export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Loads the master key from `keyPath`, creating it (mode 0600) on first run. */
export function loadOrCreateKey(keyPath: string): Buffer {
  if (existsSync(keyPath)) {
    const key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64');
    if (key.length !== KEY_BYTES)
      throw new Error(`Master key at ${keyPath} is corrupt (expected ${KEY_BYTES} bytes)`);
    return key;
  }
  mkdirSync(dirname(keyPath), { recursive: true });
  const key = generateKey();
  writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // Windows ignores POSIX modes; the data folder is user-private by default.
  }
  return key;
}

export function encrypt(plaintext: string, key: Buffer): EncryptedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decrypt(secret: EncryptedSecret, key: Buffer): string {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(secret.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Re-encrypts a secret under a new key (used by key rotation). */
export function rotate(secret: EncryptedSecret, oldKey: Buffer, newKey: Buffer): EncryptedSecret {
  return encrypt(decrypt(secret, oldKey), newKey);
}
