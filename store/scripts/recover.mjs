#!/usr/bin/env node
// Offline verification and authenticated, bounded snapshot transfer. Node 24+.
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { advance, bareOrigin, check, complete, equalJSON, fields, HASH,
  MAX_HEADER_BYTES, MAX_RECORD_BYTES, PAGE_SIZE, progress, validateHeader, validateRecord } from '../src/recovery-format.ts';

function limit(name, fallback, ceiling) {
  const value = Number(process.env[name] ?? fallback);
  check(Number.isSafeInteger(value) && value > 0 && value <= ceiling, `invalid_${name}`);
  return value;
}
export function budget() {
  const deadline = Date.now() + limit('RECOVERY_TIMEOUT_MS', 1800000, 86400000);
  return {
    bytes: limit('RECOVERY_MAX_BYTES', 1024 ** 3, 1024 ** 4),
    records: limit('RECOVERY_MAX_RECORDS', 100000, 100000000),
    remaining() { const ms = deadline - Date.now(); check(ms > 0, 'recovery_deadline'); return ms; },
  };
}

async function* lines(file, bounds) {
  const stream = createReadStream(file, { highWaterMark: 65536, signal: AbortSignal.timeout(bounds.remaining()) });
  let pending = Buffer.alloc(0), total = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  try {
    for await (const chunk of stream) {
      bounds.remaining(); total += chunk.length;
      check(total <= bounds.bytes, 'archive_byte_limit');
      pending = Buffer.concat([pending, chunk]);
      let end;
      while ((end = pending.indexOf(10)) !== -1) {
        check(end > 0 && end <= MAX_RECORD_BYTES, 'archive_line_limit');
        yield decoder.decode(pending.subarray(0, end));
        pending = pending.subarray(end + 1);
      }
      check(pending.length <= MAX_RECORD_BYTES, 'archive_line_limit');
    }
    check(pending.length === 0, 'archive_missing_final_newline');
  } finally { stream.destroy(); }
}

export async function verify(file, bounds = budget(), visit, allowMissingTrailer = false) {
  let header, state, trailer;
  for await (const line of lines(file, bounds)) {
    check(!trailer, 'archive_after_trailer');
    const value = JSON.parse(line);
    if (!header) {
      check(Buffer.byteLength(line) <= MAX_HEADER_BYTES, 'archive_header_limit');
      header = validateHeader(value);
      check(header.receipts <= bounds.records, 'archive_record_limit');
      // The header's exact encoding seeds the chain; exports use this encoding.
      check(JSON.stringify(header) === line, 'archive_header_encoding');
      state = progress(header);
    } else if (value?.type === 'trailer') {
      fields(value, ['type', 'count', 'chain']);
      check(value.count === state.count && typeof value.chain === 'string');
      complete(header, state, value.chain); trailer = value;
    } else {
      check(state.count < header.receipts && state.count < bounds.records, 'archive_record_limit');
      const { record } = validateRecord(value);
      state = advance(state, record.receipt, line);
      if (visit) await visit(record, line, header);
    }
  }
  check(header && (trailer || allowMissingTrailer), 'archive_incomplete');
  complete(header, state, state.chain);
  return { header, chain: state.chain, count: state.count, complete: !!trailer };
}

function connection(bounds) {
  const origin = bareOrigin(process.env.BLOB_STORE_URL);
  const token = process.env.BLOB_STORE_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN;
  check(typeof token === 'string' && /^[0-9a-f]{64}$/i.test(token), 'missing_admin_token');
  return {
    origin,
    async post(action, data, cap = MAX_HEADER_BYTES) {
      const response = await fetch(`${origin}/admin/recovery/${action}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(Math.min(30000, bounds.remaining())),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: typeof data === 'string' ? data : JSON.stringify(data),
      });
      const bytes = new Uint8Array(cap); let size = 0;
      for await (const chunk of response.body) {
        check(size + chunk.length <= cap, 'recovery_response_limit'); bytes.set(chunk, size); size += chunk.length;
      }
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
      // Never log response bodies, source bytes or credentials on failure.
      if (!response.ok) throw new Error(`recovery_http_${response.status}: ${/^[a-z_]+$/.test(value.error) ? value.error : 'request_failed'}`);
      return value;
    },
  };
}

export async function exportSnapshot(file, bounds = budget()) {
  const api = connection(bounds);
  const output = await open(file, 'wx', 0o600); // Refuse to replace any previous copy.
  let size = 0;
  const write = async value => {
    const line = JSON.stringify(value);
    check(Buffer.byteLength(line) <= MAX_RECORD_BYTES, 'archive_line_limit');
    size += Buffer.byteLength(line) + 1; check(size <= bounds.bytes, 'archive_byte_limit');
    bounds.remaining(); await output.writeFile(line + '\n'); return line;
  };
  try {
    const header = validateHeader(await api.post('snapshot/begin', {}));
    check(header.source_origin === api.origin && header.receipts <= bounds.records, 'snapshot_limits_or_origin');
    await write(header);
    let state = progress(header);
    for (;;) {
      const page = await api.post('snapshot/page', { id: header.id, after: state.after });
      fields(page, ['addresses']);
      check(Array.isArray(page.addresses) && page.addresses.length <= PAGE_SIZE, 'invalid_snapshot_page');
      if (!page.addresses.length) break;
      for (const address of page.addresses) {
        check(typeof address === 'string' && address > state.after && state.count < header.receipts, 'snapshot_order');
        const { record } = validateRecord(await api.post('snapshot/object', { id: header.id, address }, MAX_RECORD_BYTES));
        check(record.receipt.address === address);
        state = advance(state, record.receipt, await write(record));
      }
    }
    complete(header, state, state.chain);
    // Make every record durable before releasing the source pin. A complete
    // trailer is written only after the coordinator's durable finish ACK.
    await output.sync();
    const done = await api.post('snapshot/finish', { id: header.id, count: state.count, chain: state.chain });
    check(done.complete === true, 'invalid_snapshot_completion');
    await write({ type: 'trailer', count: state.count, chain: state.chain });
    await output.sync();
    return { id: header.id, count: state.count, chain: state.chain, complete: true };
  } finally { await output.close(); } // Failure leaves an incomplete file; the snapshot pin expires or can be released.
}

export async function restoreSnapshot(file, bounds = budget()) {
  // No HTTP, let alone writes, until the entire archive validates offline.
  const archive = await verify(file, bounds);
  const api = connection(bounds);
  check(api.origin !== archive.header.source_origin, 'restore_requires_separate_origin');
  const begun = await api.post('restore/begin', { header: archive.header, chain: archive.chain });
  if (begun.complete === true) return { complete: true, count: archive.count, uploads_paused: true };
  check(begun.complete === false && typeof begun.after === 'string', 'invalid_restore_cursor');
  let found = begun.after === '';
  const repeated = await verify(file, bounds, async (record, line, header) => {
    check(equalJSON(header, archive.header), 'archive_changed');
    if (!found) { if (record.receipt.address === begun.after) found = true; return; }
    const accepted = await api.post('restore/record', line);
    check(accepted.after === record.receipt.address, 'invalid_restore_cursor');
  });
  check(found && equalJSON(repeated, archive), 'archive_changed_or_cursor_missing');
  const done = await api.post('restore/finish', { id: archive.header.id, chain: archive.chain });
  check(done.complete === true && done.uploads_paused === true, 'invalid_restore_result');
  return { ...done, count: archive.count };
}

export async function finishSnapshot(file, bounds = budget()) {
  // Accept only a complete, validated record prefix. Never invent missing data.
  const archive = await verify(file, bounds, undefined, true);
  if (!archive.complete) {
    const api = connection(bounds);
    check(api.origin === archive.header.source_origin, 'snapshot_origin_mismatch');
    const output = await open(file, 'a');
    try {
      await output.sync();
      const done = await api.post('snapshot/finish', {
        id: archive.header.id, count: archive.count, chain: archive.chain,
      });
      check(done.complete === true, 'invalid_snapshot_completion');
      await output.writeFile(JSON.stringify({ type: 'trailer', count: archive.count, chain: archive.chain }) + '\n');
      await output.sync();
    } finally { await output.close(); }
  }
  const checked = await verify(file, bounds);
  check(equalJSON(checked, { ...archive, complete: true }), 'archive_changed');
  return { id: archive.header.id, count: archive.count, chain: archive.chain, complete: true };
}

async function main() {
  const [command, argument, option, extra] = process.argv.slice(2);
  check(argument && !extra && (command === 'restore' ? option === '--empty-target' : option === undefined), 'usage');
  const bounds = budget();
  if (command === 'export') {
    console.log(JSON.stringify(await exportSnapshot(argument, bounds)));
    console.log('Source stayed writable. The archive is complete and its snapshot pin is released.');
  } else if (command === 'verify') {
    const { header, chain, count } = await verify(argument, bounds);
    console.log(JSON.stringify({ id: header.id, captured_at_ms: header.captured_at_ms, count, chain, verified: true }));
  } else if (command === 'finish') {
    console.log(JSON.stringify(await finishSnapshot(argument, bounds)));
  } else if (command === 'restore') {
    console.log(JSON.stringify(await restoreSnapshot(argument, bounds)));
    console.log('Target remains isolated and paused. Reconcile newer history before any deliberate cutover.');
  } else if (command === 'release') {
    check(HASH.test(argument), 'invalid_snapshot_id');
    console.log(JSON.stringify(await connection(bounds).post('snapshot/end', { id: argument })));
  } else throw new Error('usage');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof SyntaxError ? 'invalid_archive_json' : error.message);
    console.error('recover.mjs export FILE | finish FILE | verify FILE | restore FILE --empty-target | release SNAPSHOT_ID');
    console.error('No automatic cutover. An interrupted export may still hold a snapshot pin until release or expiry.');
    process.exitCode = 1;
  });
}
