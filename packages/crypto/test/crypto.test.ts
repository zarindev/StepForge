import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, generateKey, loadOrCreateKey, rotate } from '../src/index.ts';

describe('crypto', () => {
  it('round-trips a secret', () => {
    const key = generateKey();
    const enc = encrypt('s3cr3t-pa55', key);
    expect(enc.ciphertext).not.toContain('s3cr3t');
    expect(decrypt(enc, key)).toBe('s3cr3t-pa55');
  });

  it('uses a fresh IV each time', () => {
    const key = generateKey();
    expect(encrypt('x', key).iv).not.toBe(encrypt('x', key).iv);
  });

  it('rejects tampered ciphertext', () => {
    const key = generateKey();
    const enc = encrypt('hello', key);
    const bad = { ...enc, ciphertext: Buffer.from('jello').toString('base64') };
    expect(() => decrypt(bad, key)).toThrow();
  });

  it('rejects the wrong key', () => {
    const enc = encrypt('hello', generateKey());
    expect(() => decrypt(enc, generateKey())).toThrow();
  });

  it('rotates keys', () => {
    const a = generateKey();
    const b = generateKey();
    expect(decrypt(rotate(encrypt('v', a), a, b), b)).toBe('v');
  });

  it('creates the key file once and reuses it', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sf-key-')), 'sub', '.key');
    const k1 = loadOrCreateKey(path);
    const k2 = loadOrCreateKey(path);
    expect(k1.equals(k2)).toBe(true);
    expect(Buffer.from(readFileSync(path, 'utf8'), 'base64').length).toBe(32);
  });
});
