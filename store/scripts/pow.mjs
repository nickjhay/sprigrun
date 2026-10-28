#!/usr/bin/env node
// Offline solver. Input is a bounded challenge JSON file; stdout is ONLY a nonce.
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { proofPrefix, validChallenge } from '../src/proof.ts';

try {
  const [file, trialsText = '1000000', extra] = process.argv.slice(2);
  if (!file || extra || !/^[1-9][0-9]{0,8}$/.test(trialsText) || Number(trialsText) > 100000000) throw new Error('Usage: node scripts/pow.mjs CHALLENGE.json [MAX_TRIALS: 1..100000000]');
  const handle = await open(file, 'r');
  let bytes;
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Challenge must be a regular file');
    const buffer = Buffer.alloc(4097);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 4096) throw new Error('Challenge exceeds 4096 bytes');
    bytes = buffer.subarray(0, length);
  } finally { await handle.close(); }
  const challenge = JSON.parse(bytes.toString('utf8'));
  if (!validChallenge(challenge)) throw new Error('Invalid challenge');
  const prefix = createHash('sha256').update(proofPrefix(challenge));
  const until = Math.min(challenge.expires_at_ms, Date.now() + 30000);
  let solution;
  for (let i = 0; i < Number(trialsText); i++) {
    if (Date.now() >= until) throw new Error('Challenge expired or 30-second solver time limit reached');
    const nonce = i.toString(16).padStart(16, '0');
    if (prefix.copy().update(nonce + '\n').digest('hex') <= challenge.target) { solution = nonce; break; }
  }
  if (!solution) throw new Error(`No solution in ${trialsText} trials`);
  process.stdout.write(solution + '\n');
} catch (error) { console.error(error.message); process.exitCode = 1; }
