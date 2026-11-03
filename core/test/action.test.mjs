import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_MARKER, actionBytes, actionId, parseAction } from '../src/action.ts';
import { LIMITS, contentAddress, textBytes, utf8 } from '../src/bytes.ts';
import { nextAppendAction, parseReceipt, receiptBytes, receiptForAction } from '../src/receipt.ts';
const origin = 'https://sprig.run';
const destination = origin + '/chat/grove/chess.7/12';
const author = '/plot/nick.0';
const body = textBytes('Hello from the fern.');
const make = (extra = {}) => actionBytes({ destination, author, body, ...extra }, origin);
const key = '/sea/' + 'ab'.repeat(32) + '_112';
const binding = 'cd'.repeat(32) + '_230';
async function receipt(action, extra = {}) {
  return receiptBytes({ action: await actionId(action, origin),
    result: origin + '/chat/grove/chess.7/27', acceptedAtMs: '1793743200000',
    key, binding, ...extra }, origin);
}

test('metadata precedes the essential request and the exact body', () => {
  const bytes = make();
  assert.equal(utf8(bytes), ACTION_MARKER + '\nauthor: /plot/nick.0\n\nPOST ' + destination + '\n\nHello from the fern.');
  const parsed = parseAction(bytes, origin);
  assert.equal(parsed.target.anchor, '12');
  assert.deepEqual(parsed.body, body);
  assert.equal(parsed.author, author);
  assert.deepEqual(actionBytes(parsed, origin), bytes);
});

test('anonymous framing has no author field, even when the payload resembles an action', () => {
  const bytes = make({ author: null, body: make() });
  assert(utf8(bytes).startsWith(ACTION_MARKER + '\n\nPOST '));
  assert.equal(parseAction(bytes, origin).author, null);
  assert.deepEqual(parseAction(bytes, origin).body, make());
});

test('body bytes preserve CRLF, NUL, Unicode, BOM, blank lines and EOF exactly', async () => {
  for (const text of ['', '\n', '\r\n', '\uFEFFfern\u0000🌿\r\n\n', 'e\u0301', 'é']) {
    const bytes = make({ body: textBytes(text) });
    assert.deepEqual(parseAction(bytes, origin).body, textBytes(text));
    assert.deepEqual(actionBytes(parseAction(bytes, origin), origin), bytes);
  }
  assert.notEqual(await actionId(make(), origin), await actionId(make({ body: textBytes('Hello from the fern.\n') }), origin));
  assert.throws(() => make({ body: new Uint8Array([0xc0, 0xaf]) }), /invalid_utf8/);
  assert.throws(() => textBytes('\ud800'), /invalid_text/);
});

test('old framing, occurrence fields, extensions and normalization opportunities reject', () => {
  const good = utf8(make());
  for (const text of [
    good.replace('/action/1', '/action/2'),
    good.replace('author: ', 'author:  '),
    good.replace('\n\nPOST ', '\noccurrence: 123\n\nPOST '),
    good.replace('\n\nPOST ', '\nauthor: /plot/other.0\n\nPOST '),
    good.replace('\n\nPOST ', '\nexpires: 123\n\nPOST '),
    good.replace('\n\nPOST ', '\r\n\r\nPOST '),
    good.replace('POST ', 'PUT '), good.replace('POST ', 'POST  '),
    good.replace('/12\n\n', '/12\nContent-Type: text/plain\n\n'),
    good.replace('/12\n\n', '/12\r\n\r\n'),
    good.replace('/12\n\n', '/12?x=1\n\n'),
    good.replace('/12\n\n', '/12#latest\n\n'),
    '\uFEFF' + good,
    ACTION_MARKER + '\nPOST ' + destination + '\nauthor: ' + author + '\n\nhello',
    ACTION_MARKER + '\n\nPOST ' + destination,
  ]) assert.throws(() => parseAction(textBytes(text), origin), undefined, text);
  for (const bad of ['https://sprig.run.evil/chat/grove/chess.7',
    destination + '\n\ninjected', destination + '/', destination.replace('/12', '/%31%32')])
    assert.throws(() => make({ destination: bad }), undefined, bad);
  assert.throws(() => make({ author: '/plot/nick.0\n\nPOST ' + destination }), /invalid/);
  assert.throws(() => parseAction(make(), 'http://localhost:8787'), /wrong_origin/);
});

test('byte and header limits are checked before unbounded parsing', () => {
  assert.equal(parseAction(make({ body: new Uint8Array(LIMITS.sourceBytes) }), origin).body.length, LIMITS.sourceBytes);
  assert.throws(() => make({ body: new Uint8Array(LIMITS.sourceBytes + 1) }), /limit/);
  assert.throws(() => parseAction(new Uint8Array(LIMITS.actionBytes + 1), origin), /limit/);
  assert.throws(() => parseAction(textBytes(ACTION_MARKER + '\n' + 'a'.repeat(1100) + '\n\nPOST ' + destination + '\n\n'), origin), /metadata/);
  assert.throws(() => parseAction(textBytes(ACTION_MARKER + '\n\nPOST ' + 'a'.repeat(1100) + '\n\n'), origin), /frame/);
});

test('client and parsed byte buffers are independent, including Node Buffers', () => {
  const input = Buffer.from(make());
  const parsed = parseAction(input, origin);
  input.fill(0);
  assert.deepEqual(parsed.body, body);
  const payload = Buffer.from('hello');
  const action = make({ body: payload });
  payload.fill(0);
  assert.equal(utf8(parseAction(action, origin).body), 'hello');
});

test('identical actions have identical IDs; the author and anchor are signed intent', async () => {
  assert.equal(await actionId(make(), origin), await actionId(make(), origin));
  assert.notEqual(await actionId(make(), origin), await actionId(make({ destination: origin + '/chat/grove/chess.7/27' }), origin));
  assert.notEqual(await actionId(make(), origin), await actionId(make({ author: '/plot/nick.1' }), origin));
});

test('a receipt advances to the allocated number, never anchor plus one', async () => {
  const first = make();
  const ack = await receipt(first);
  const next = await nextAppendAction(first, ack, body, origin);
  assert.equal(parseAction(next, origin).destination, origin + '/chat/grove/chess.7/27');
  assert.equal(parseAction(next, origin).author, author);
  assert.deepEqual(parseAction(next, origin).body, body);
  assert.notEqual(await actionId(first, origin), await actionId(next, origin));
  assert.deepEqual(first, make()); // The retained request is still retryable unchanged.
  assert.equal(parseReceipt(ack, origin).acceptedAtMs, '1793743200000');
});

test('a misleading receipt cannot move a pending action into another log or backwards', async () => {
  const first = make();
  for (const result of [origin + '/chat/grove/chess.8/27',
    origin + '/chat/grove/chess.7/12', origin + '/chat/grove/chess.7/11',
    origin + '/chat/grove/chess.7/step/12/27', origin + '/grove/chess.27'])
    await assert.rejects(nextAppendAction(first, await receipt(first, { result }), body, origin), /wrong_receipt_result/);
  await assert.rejects(nextAppendAction(first, await receipt(first, { action: 'ee'.repeat(32) + '_10' }), body, origin), /wrong_receipt_action/);
  await assert.rejects(nextAppendAction(first, await receipt(first, { binding: null }), body, origin), /authority/);
  const ack = utf8(await receipt(first));
  assert.throws(() => parseReceipt(textBytes(ack.replace('receipt/1', 'receipt/2')), origin), /version/);
  assert.throws(() => parseReceipt(textBytes(ack.replace('accepted-at-ms: ', 'accepted-at-ms: 0')), origin), /u64/);
  assert.throws(() => parseReceipt(textBytes(ack.replace('https://sprig.run', 'https://elsewhere.test')), origin), /wrong_origin/);
});

test('raw source receipt pins bytes and direct authority checks remain separate', async () => {
  const a = make({ destination: origin + '/sea', author: null });
  const good = await receipt(a, { result: origin + '/sea/' + await contentAddress(body), key: null, binding: null });
  await receiptForAction(a, good, origin);
  await assert.rejects(nextAppendAction(a, good, body, origin), /append_action_required/);
  await assert.rejects(receiptForAction(a, await receipt(a, { result: origin + key, key: null, binding: null }), origin), /wrong_receipt_result/);
  const signed = make({ author: key });
  await receiptForAction(signed, await receipt(signed, { binding: null }), origin);
  await assert.rejects(receiptForAction(signed, await receipt(signed), origin), /wrong_receipt_authority/);
});

test('name allocation receipts match their exact topic and plot', async () => {
  for (const [target, result] of [
    ['/grove/nz/fern', '/grove/nz/fern.9'], ['/plot/nick', '/plot/nick.9'],
    ['/plot/nick.0/games/chess', '/plot/nick.0/games/chess.9'],
  ]) {
    const a = make({ destination: origin + target });
    await receiptForAction(a, await receipt(a, { result: origin + result }), origin);
    await assert.rejects(receiptForAction(a, await receipt(a, { result: origin + result.replace(/nick|fern|chess/, 'other') }), origin), /wrong_receipt_result/);
  }
});

test('receipt continuation lets identical values occupy distinct named places without a nonce', async () => {
  for (const [target, result] of [
    ['/grove/fern', '/grove/fern.7'], ['/plot/nick', '/plot/nick.7'],
    ['/plot/nick.0/fern', '/plot/nick.0/fern.7'],
  ]) {
    const first = make({ destination: origin + target });
    const ack = await receipt(first, { result: origin + result });
    const next = await nextAppendAction(first, ack, body, origin);
    assert.equal(parseAction(next, origin).destination, origin + result);
    assert.equal(parseAction(next, origin).target.anchor, '7');
    assert.notEqual(await actionId(first, origin), await actionId(next, origin));
    await assert.rejects(receiptForAction(next, await receipt(next, { result: origin + result }), origin), /wrong_receipt_result/);
    await receiptForAction(next, await receipt(next, { result: origin + result.replace(/7$/, '12') }), origin);
  }
});
