import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const randomToken = () => randomBytes(32).toString('base64url');
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export const challenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
export function equal(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function metaSignature(body: Buffer, secret: string) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}
export function bridgeSignature(body: string, time: string, nonce: string, path: string, secret: string) {
  return createHmac('sha256', secret).update(`${time}\n${nonce}\nPOST\n${path}\n${body}`).digest('hex');
}
export class Vault {
  private key: Buffer;
  constructor(key: string) {
    this.key = Buffer.from(key, 'base64');
    if (this.key.length !== 32) throw new Error('HUB_ENCRYPTION_KEY deve conter 32 bytes em base64.');
  }
  seal(value: unknown, context: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const content = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), content]).toString('base64');
  }
  open<T>(value: string, context: string): T {
    const bytes = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
  }
}
