#!/usr/bin/env node
// Keep tokens out of argv and shell history. Supply them via environment.
import { parseAddress, workTarget } from '../src/proof.ts';
const [command, argument, perByte, extra] = process.argv.slice(2);
const base = process.env.BLOB_STORE_URL;
const token = process.env.BLOB_STORE_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN;
let valid = base && token && extra === undefined && ['pause', 'resume', 'block', 'reclaim', 'pow'].includes(command);
if (command === 'pause' || command === 'resume') valid &&= argument === undefined;
if (command === 'block' || command === 'reclaim') valid &&= parseAddress(argument ?? '') !== null && perByte === undefined;
if (command === 'pow') {
  valid &&= argument === 'default' ? perByte === undefined : /^(0|[1-9]\d{0,2})$/.test(argument ?? '');
  if (argument !== 'default') {
    valid &&= perByte === undefined || /^(0|[1-9]\d{0,9})$/.test(perByte);
    try { workTarget(Number(argument), Number(perByte ?? 0), 1048576); } catch { valid = false; }
  }
}
if (!valid) {
  console.error('Set BLOB_STORE_URL and BLOB_STORE_ADMIN_TOKEN, then: npm run admin -- pause|resume|block HASH_LENGTH|reclaim HASH_LENGTH|pow BITS [WORK_PER_BYTE]|pow default');
  process.exit(1);
}
const origin = new URL(base);
if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
  throw new Error('Use HTTPS, except for local development.');
}
const path = ['block', 'reclaim', 'pow'].includes(command) ? `/admin/${command}/${argument}${perByte === undefined ? '' : '/' + perByte}` : `/admin/${command}`;
const response = await fetch(new URL(path, origin), {
  method: 'POST', headers: { Authorization: `Bearer ${token}` },
  redirect: 'error', signal: AbortSignal.timeout(30000),
});
console.log(`${response.status}\n${await response.text()}`);
if (!response.ok) process.exitCode = 1;
