import { createReadStream } from 'node:fs';
import { open, link, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { check, nextU64, utf8 } from '../src/bytes.ts';
import { advance, canonical, complete, end, hash, initial, MAX_LINE, parseLine,
  TABLES, validateHeader, validateRecord } from '../host/archive.ts';

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
export async function backup(core, file, epoch) {
  epoch ??= await core.cut();
  const header = validateHeader(parseLine(await core.snapshotHeader(epoch)));
  const temporary = file + '.' + randomUUID() + '.partial';
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(canonical(header) + '\n');
    let progress = await initial(header);
    for (const table of TABLES) {
      let after = '';
      for (;;) {
        const page = await core.snapshotPage(epoch, table, after);
        for (const key of page.keys) {
          const line = await core.snapshotRecord(epoch, table, key);
          const record = await validateRecord(parseLine(line), header);
          check(record.type === table, 'archive_table');
          progress = await advance(progress, record, line);
          await handle.writeFile(line + '\n');
        }
        if (page.done) break;
        check(typeof page.after === 'string' && page.after > after, 'archive_cursor');
        after = page.after;
      }
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
export async function restore(core, file, expectedChain) {
  // A trusted digest is mandatory; a footer is an integrity check, not a signature.
  hash(expectedChain);
  const checked = await verify(file, expectedChain);
  const status = await core.restoreBegin(canonical(checked.header), canonical(checked.footer));
  if (status.phase === 'restored' || status.phase === 'released') return status;
  let index = '0', first = true;
  for await (const line of lines(file)) {
    if (first) { check(line === canonical(checked.header), 'archive_changed'); first = false; continue; }
    const value = parseLine(line);
    if (value.type === 'end') { check(line === canonical(checked.footer), 'archive_changed'); break; }
    index = nextU64(index);
    if (BigInt(index) > BigInt(status.count)) await core.restoreRecord(index, line);
  }
  return core.restoreFinish(); // Remains quarantined, with writes paused and zero credit.
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , command, file, flag, chain] = process.argv;
  check(command === 'verify' && file && (!flag || (flag === '--chain' && chain)) && process.argv.length <= 6,
    'usage: node core/scripts/recover.mjs verify FILE [--chain TRUSTED_SHA256]');
  const result = await verify(file, chain);
  console.log(`Verified archive framing, source hashes and accounting: ${result.footer.count} records, epoch ${result.header.epoch}`);
  console.log(`Chain: ${result.footer.chain}`);
  console.log('Authority and cross-reference checks also run in the quarantined restore target.');
}
