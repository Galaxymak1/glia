// ULIDs for claim and proposal ids (SPEC.md, "Claim layer": never reused): 48 bits of
// milliseconds and 80 random bits, in Crockford base32, so ids sort by creation time.

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now = Date.now()): string {
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = ALPHABET[t % 32] + time;
  const bytes = randomBytes(10);
  let random = "";
  // 80 bits = 16 characters of 5 bits each.
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  for (let i = 0; i < 16; i++, bits >>= 5n) random = ALPHABET[Number(bits & 31n)] + random;
  return time + random;
}
