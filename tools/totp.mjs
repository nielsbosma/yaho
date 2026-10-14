// The current authenticator code for a base32 key, as an authenticator app shows it (for the smoke and e2e tests).
//   node tools/totp.mjs <key> [steps ahead]
import { createHmac } from 'node:crypto';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';

export function totp(key, ahead = 0) {
  const bits = [...key.replace(/\s/g, '').toUpperCase()]
    .map((c) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0'))
    .join('');
  const secret = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + ahead));
  const h = createHmac('sha1', secret).update(msg).digest();
  return String((h.readUInt32BE(h[19] & 15) & 0x7fffffff) % 1e6).padStart(6, '0');
}

if (argv[1] === fileURLToPath(import.meta.url)) console.log(totp(argv[2], Number(argv[3] ?? 0)));
