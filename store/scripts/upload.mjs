#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { shareSourceBytes } from '../examples/client.ts';

try {
  const [file, trialText = '1000000', extra] = process.argv.slice(2);
  if (!file || extra || !/^[1-9][0-9]{0,8}$/.test(trialText) || Number(trialText) > 100000000) throw new Error('Usage: node scripts/upload.mjs SOURCE.sprig [MAX_TRIALS]');
  const origin = new URL(process.env.BLOB_STORE_URL ?? 'http://localhost:8787');
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('Use HTTPS, except for local development');
  const handle = await open(file, 'r');
  let source;
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Source must be a regular file');
    const buffer = new Uint8Array(1048577);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 1048576) throw new Error('Source exceeds client size limit');
    source = buffer.subarray(0, length);
  } finally { await handle.close(); }
  console.log(await shareSourceBytes(origin.href, source, { maxTrials: Number(trialText) }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
