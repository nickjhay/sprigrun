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

const FORMAT = 'sprig-backup-witness/3';
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
    fields(value, ['format', 'origin', 'journal', 'from', 'through', 'base', 'chain', 'records', 'archive']);
    check(value.format === FORMAT && typeof value.archive === 'string', 'witness_format');
    canonicalOrigin(value.origin); u64(value.records); hash(value.chain);
    u64(value.from); u64(value.through); if (value.base !== null) hash(value.base);
    check(/^[0-9a-f]{32}$/.test(value.journal), 'witness_journal');
    return value;
  } finally { await handle.close(); }
}
export async function capture(core, file, witnessFile, { checkpoint, baseFile, baseWitness, onCheckpoint = () => {} } = {}) {
  file = resolve(file); witnessFile = resolve(witnessFile);
  // Distinct directories help prevent accidental bundling. They cannot prove independent custody.
  check(await realpath(dirname(file)) !== await realpath(dirname(witnessFile)), 'separate_witness_directory_required');
  await absent(file); await absent(witnessFile);
  check((baseFile === undefined) === (baseWitness === undefined), 'base_witness_required');
  const base = baseFile === undefined ? null : (await checkedBackup(baseFile, baseWitness)).checked;
  checkpoint ??= await core.checkpoint(); onCheckpoint(JSON.parse(checkpoint).control.position);
  const saved = await backup(core, file, checkpoint, base);
  const witness = { format: FORMAT, origin: saved.header.control.origin, journal: saved.header.control.journal,
    from: base?.header.control.position ?? '0', through: saved.header.control.position, base: base?.footer.chain ?? null,
    chain: saved.footer.chain, records: saved.footer.count, archive: basename(file) };
  try { await exclusive(witnessFile, canonical(witness) + '\n'); }
  catch { throw Error('archive_saved_but_witness_failed'); } // Keep the completed archive.
  return witness;
}
async function checkedBackup(file, witnessFile) {
  const witness = await readWitness(witnessFile);
  const checked = await verify(file, witness.chain);
  check(checked.header.control.origin === witness.origin
    && checked.footer.count === witness.records && checked.header.control.journal === witness.journal
    && checked.header.control.position === witness.through && (checked.header.base?.chain ?? null) === witness.base
    && (checked.header.base === null ? '0' : checked.header.base.checkpoint.control.position) === witness.from, 'witness_mismatch');
  return { witness, checked };
}
export async function checkBackup(file, witnessFile) { return (await checkedBackup(file, witnessFile)).witness; }
export async function main(args, { env = process.env, fetcher = fetch, out = console.log, progress = console.error } = {}) {
  const command = args.shift();
  if (command === 'check') {
    check(args.length === 3 && args[1] === '--witness', 'usage');
    const result = await checkBackup(args[0], args[2]); out(JSON.stringify(result)); return result;
  }
  check(command === 'capture' && args.length >= 4 && args.length % 2 === 0, 'usage');
  const [origin, file] = args, options = {};
  for (let i = 2; i < args.length; i += 2) {
    const flag = args[i];
    check(['--witness', '--base', '--base-witness'].includes(flag) && !Object.hasOwn(options, flag), 'usage');
    options[flag] = args[i + 1];
  }
  check(options['--witness'], 'usage');
  check(/^[0-9a-f]{64}$/.test(env.SPRIG_BACKUP_TOKEN ?? ''), 'backup_token_required');
  const core = nativeClient(origin, { token: env.SPRIG_BACKUP_TOKEN, fetcher });
  const result = await capture(core, file, options['--witness'], { baseFile: options['--base'], baseWitness: options['--base-witness'],
    onCheckpoint: n => progress('Copying committed prefix through ' + n + '; publishing continues.') });
  out(JSON.stringify(result)); return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch (e) {
    // Neither server bodies nor credentials are printed by this CLI.
    const code = String(e.message);
    console.error(/^(?:[0-9]{3}: )?[a-z][a-z0-9_]{0,99}$/.test(code) ? code : 'backup_failed');
    console.error('Usage: npm run backup:core -- capture ORIGIN ARCHIVE --witness FILE');
    console.error('       [--base PREVIOUS_ARCHIVE --base-witness PREVIOUS_WITNESS]');
    console.error('   or: npm run backup:core -- check ARCHIVE --witness FILE');
    process.exitCode = 1;
  }
}
