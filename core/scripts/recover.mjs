import { createReadStream } from 'node:fs';
import { open, link, unlink, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nativeClient } from './http-client.mjs';
import { randomUUID } from 'node:crypto';
import { check, nextU64, u64, utf8 } from '../src/bytes.ts';
import { advance, canonical, complete, end, hash, initial, MAX_LINE, parseLine,
  cutFromHeader, validateHeader, validateRecord } from '../host/archive.ts';

/** Bounded physical lines; reject truncation, CRLF, noncanonical JSON and trailing data. */
export async function* lines(file) {
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(file, { highWaterMark: 65536 })) {
    pending = Buffer.concat([pending, chunk]);
    let pos;
    while ((pos = pending.indexOf(10)) >= 0) {
      check(pos <= MAX_LINE, 'archive_line_limit');
      yield utf8(pending.subarray(0, pos)); pending = pending.subarray(pos + 1);
    }
    check(pending.length <= MAX_LINE, 'archive_line_limit');
  }
  check(pending.length === 0, 'archive_truncated');
}
export async function verify(file, expectedChain) {
  if (expectedChain !== undefined) hash(expectedChain);
  let header, progress, footer;
  for await (const line of lines(file)) {
    const value = parseLine(line);
    if (!header) { header = validateHeader(value); progress = await initial(header); continue; }
    check(!footer, 'archive_trailing_data');
    if (value.type === 'end') { footer = end(value); complete(header, progress, footer); }
    else progress = await advance(progress, await validateRecord(value, header), line);
  }
  check(header && footer, 'archive_truncated');
  if (expectedChain !== undefined) check(footer.chain === expectedChain, 'archive_trusted_digest_mismatch');
  return { header, footer, progress };
}
/** The adapter may be local or authenticated operator RPC. No public route needed. */
export async function backup(core, file, epoch, base = null) {
  // Refuse a known collision before creating a cut or doing remote export work.
  try { await lstat(file); throw Error('archive_exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  epoch ??= await core.cut();
  const header = validateHeader(parseLine(await core.snapshotHeader(epoch, base?.header.epoch ?? null, base?.footer.chain ?? null)));
  if (base !== null) check(canonical(header.base) === canonical({ chain: base.footer.chain, cut: cutFromHeader(base.header) }), 'archive_base_mismatch');
  else check(header.base === null, 'archive_base_mismatch');
  if (core.origin !== undefined) check(header.control.origin === core.origin, 'archive_origin');
  const temporary = file + '.' + randomUUID() + '.partial';
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(canonical(header) + '\n');
    let progress = await initial(header);
    let after = progress.position;
    for (;;) {
      const batch = typeof core.snapshotBatch === 'function';
      const page = batch ? await core.snapshotBatch(epoch, after) : await core.snapshotPage(epoch, after);
      const entries = batch ? page.records : page.keys;
      check(Array.isArray(entries) && entries.length <= 32 && typeof page.done === 'boolean', 'archive_page_limit');
      for (const item of entries) {
        const line = batch ? item : await core.snapshotRecord(epoch, item);
        progress = await advance(progress, await validateRecord(parseLine(line), header), line);
        await handle.writeFile(line + '\n');
      }
      check(page.after === progress.position, 'archive_cursor');
      if (page.done) break;
      check(u64(page.after) > u64(after), 'archive_cursor'); after = page.after;
    }
    const footer = { type: 'end', count: progress.count, chain: progress.chain };
    complete(header, progress, footer);
    await handle.writeFile(canonical(footer) + '\n'); await handle.sync(); await handle.close(); handle = null;
    // Atomic, exclusive publication: never overwrite an earlier backup.
    await link(temporary, file); await unlink(temporary);
    const directory = await open(dirname(resolve(file)), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return { header, footer, progress };
  } finally {
    await handle?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
export async function incrementalBackup(core, file, baseFile, baseChain, epoch) {
  hash(baseChain);
  return backup(core, file, epoch, await verify(baseFile, baseChain));
}
async function importChecked(core, file, checked, target) {
  const status = await core.restoreBegin(canonical(checked.header), canonical(checked.footer), target);
  if (status.phase !== 'importing') return status;
  let index = '0', first = true;
  for await (const line of lines(file)) {
    if (first) { check(line === canonical(checked.header), 'archive_changed'); first = false; continue; }
    const value = parseLine(line);
    if (value.type === 'end') { check(line === canonical(checked.footer), 'archive_changed'); break; }
    index = nextU64(index);
    if (BigInt(index) > BigInt(status.count)) await core.restoreRecord(index, line);
  }
  return core.restoreFinish(); // Still quarantined; incomplete suffixes explicitly wait.
}
export async function restore(core, file, expectedChain, targetChain = expectedChain) {
  hash(expectedChain); hash(targetChain);
  return importChecked(core, file, await verify(file, expectedChain), targetChain);
}
export async function verifyChain(files, target) {
  hash(target);
  check(Array.isArray(files) && files.length > 0 && files.length <= 1024, 'archive_chain_limit');
  const checked = [];
  for (const file of files) {
    const part = await verify(file), previous = checked.at(-1);
    if (!previous) check(part.header.base === null, 'restore_requires_snapshot');
    else check(part.header.base !== null && part.header.base.chain === previous.footer.chain
      && canonical(part.header.base.cut) === canonical(cutFromHeader(previous.header)), 'archive_base_mismatch');
    checked.push(part);
  }
  check(checked.at(-1).footer.chain === target, 'archive_trusted_digest_mismatch');
  return checked;
}
export async function restoreChain(core, files, target) {
  // Verify the complete plan and its independently trusted end before mutating the target.
  const checked = await verifyChain(files, target), status = await core.restoreStatus();
  const start = status === null ? 0 : checked.findIndex(p => p.footer.chain === status.expected);
  check(start >= 0 && (status === null || status.target === target), 'different_restore_active');
  let result;
  for (let i = start; i < files.length; i++) result = await importChecked(core, files[i], checked[i], target);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , command, ...args] = process.argv;
  if (command === 'restore') {
    check(args.length >= 4 && args[1] === '--chain', 'usage: node core/scripts/recover.mjs restore ORIGIN --chain TRUSTED_FINAL_SHA256 FULL [DELTA ...]');
    check(/^[0-9a-f]{64}$/.test(process.env.SPRIG_ADMIN_TOKEN ?? ''), 'operator_token_required');
    const core = nativeClient(args[0], { token: process.env.SPRIG_ADMIN_TOKEN });
    console.log(JSON.stringify(await restoreChain(core, args.slice(3), args[2])));
    console.log('Still quarantined. Reconcile history, then separately release, remove restore mode and unpause.');
  } else {
    const [file, flag, chain] = args;
    check(command === 'verify' && file && (!flag || (flag === '--chain' && chain)) && args.length <= 3,
      'usage: node core/scripts/recover.mjs verify FILE [--chain TRUSTED_SHA256]');
    const result = await verify(file, chain);
    console.log(`Verified archive framing, source hashes and accounting: ${result.footer.count} records, epoch ${result.header.epoch}`);
    console.log(`Chain: ${result.footer.chain}`);
    console.log('Authority and cross-reference checks also run in the quarantined restore target.');
  }
}
