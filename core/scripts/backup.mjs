import '../../scripts/check-node.mjs';
import { open, link, unlink, lstat, realpath } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { check, u64 } from '../src/bytes.ts';
import { fields, hash, canonical } from '../host/archive.ts';
import { canonicalOrigin } from '../src/references.ts';
import { nativeClient } from './http-client.mjs';
import { backup, verify } from './recover.mjs';

const FORMAT = 'sprig-backup-witness/1';
async function absent(file) {
  try { await lstat(file); throw Error('output_exists'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
async function exclusive(file, bytes) {
  const tmp = file + '.' + randomUUID() + '.partial';
  let handle;
  try {
    handle = await open(tmp, 'wx', 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    await link(tmp, file); await unlink(tmp);
    const directory = await open(dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close();
    await unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
}
async function readWitness(file) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    check(bytesRead <= 4096, 'witness_size');
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    fields(value, ['format', 'origin', 'epoch', 'chain', 'records', 'archive']);
    check(value.format === FORMAT && typeof value.archive === 'string', 'witness_format');
    canonicalOrigin(value.origin); u64(value.epoch); u64(value.records); hash(value.chain);
    return value;
  } finally { await handle.close(); }
}
export async function capture(core, file, witnessFile, { epoch, onCut = () => {} } = {}) {
  file = resolve(file); witnessFile = resolve(witnessFile);
  // Distinct directories help prevent accidental bundling. They cannot prove independent custody.
  check(await realpath(dirname(file)) !== await realpath(dirname(witnessFile)), 'separate_witness_directory_required');
  await absent(file); await absent(witnessFile);
  if (epoch !== undefined) u64(epoch);
  epoch ??= await core.cut(); u64(epoch); onCut(epoch);
  const saved = await backup(core, file, epoch);
  const witness = { format: FORMAT, origin: saved.header.control.origin, epoch: saved.header.epoch,
    chain: saved.footer.chain, records: saved.footer.count, archive: basename(file) };
  try { await exclusive(witnessFile, canonical(witness) + '\n'); }
  catch { throw Error('archive_saved_but_witness_failed'); } // Keep the completed archive.
  return witness;
}
export async function checkBackup(file, witnessFile) {
  const witness = await readWitness(witnessFile);
  const checked = await verify(file, witness.chain);
  check(checked.header.control.origin === witness.origin && checked.header.epoch === witness.epoch
    && checked.footer.count === witness.records, 'witness_mismatch');
  return witness;
}
export async function main(args, { env = process.env, fetcher = fetch, out = console.log, progress = console.error } = {}) {
  const command = args.shift();
  if (command === 'check') {
    check(args.length === 3 && args[1] === '--witness', 'usage');
    const result = await checkBackup(args[0], args[2]); out(JSON.stringify(result)); return result;
  }
  check(command === 'capture' && (args.length === 4 || args.length === 6)
    && args[2] === '--witness' && (args.length === 4 || args[4] === '--epoch'), 'usage');
  const [origin, file, , witness, , epoch] = args;
  check(/^[0-9a-f]{64}$/.test(env.SPRIG_BACKUP_TOKEN ?? ''), 'backup_token_required');
  const core = nativeClient(origin, { token: env.SPRIG_BACKUP_TOKEN, fetcher });
  const result = await capture(core, file, witness, { epoch, onCut: n => progress('Closed epoch ' + n + '; copying this cut.') });
  out(JSON.stringify(result)); return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch (e) {
    // Neither server bodies nor credentials are printed by this CLI.
    const code = String(e.message);
    console.error(/^(?:[0-9]{3}: )?[a-z][a-z0-9_]{0,99}$/.test(code) ? code : 'backup_failed');
    console.error('Usage: npm run backup:core -- capture ORIGIN ARCHIVE --witness FILE [--epoch N]');
    console.error('   or: npm run backup:core -- check ARCHIVE --witness FILE');
    process.exitCode = 1;
  }
}
