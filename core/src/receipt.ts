import { actionBytes, actionId, parseAction } from './action.ts';
import { check, contentAddress, copyBytes, LIMITS, parseAddress, u64 } from './bytes.ts';
import { canonicalOrigin, formatReference, parseReference } from './references.ts';
import { readRecord, writeRecord } from './records.ts';

export type Receipt = {
  action: string; result: string; acceptedAtMs: string;
  key: string | null; binding: string | null;
};
export function parseReceipt(input: Uint8Array, origin: string): Receipt {
  const [action, result, acceptedAtMs, key, binding] = readRecord(input, 'receipt/1',
    ['action', 'result', 'accepted-at-ms', 'key', 'binding']);
  parseAddress(action!);
  check(result!.startsWith(canonicalOrigin(origin) + '/'), 'wrong_origin');
  const ref = parseReference(result!.slice(origin.length));
  check(ref.kind !== 'chat' && ref.kind !== 'step', 'invalid_receipt_result');
  u64(acceptedAtMs!);
  if (key !== '-') check(parseReference(key!).kind === 'sea', 'invalid_key_reference');
  if (binding !== '-') { parseAddress(binding!, LIMITS.recordBytes); check(key !== '-', 'invalid_receipt_binding'); }
  return { action: action!, result: result!, acceptedAtMs: acceptedAtMs!,
    key: key === '-' ? null : key!, binding: binding === '-' ? null : binding! };
}
export function receiptBytes(receipt: Receipt, origin: string): Uint8Array<ArrayBuffer> {
  const bytes = writeRecord('receipt/1', [
    ['action', receipt.action], ['result', receipt.result],
    ['accepted-at-ms', receipt.acceptedAtMs], ['key', receipt.key ?? '-'],
    ['binding', receipt.binding ?? '-'],
  ]);
  parseReceipt(bytes, origin);
  return bytes;
}
/** Validate correspondence, not the host's honesty or a durable commit. */
export async function receiptForAction(input: Uint8Array, receiptInput: Uint8Array, origin: string) {
  const bytes = copyBytes(input);
  const receipt = parseReceipt(copyBytes(receiptInput, LIMITS.recordBytes), origin);
  const action = parseAction(bytes, origin);
  check(receipt.action === await actionId(bytes, origin), 'wrong_receipt_action');
  if (action.author === null) {
    check(receipt.key === null && receipt.binding === null, 'wrong_receipt_authority');
  } else {
    check(receipt.key !== null, 'wrong_receipt_authority');
    if (parseReference(action.author).kind === 'sea')
      check(receipt.key === action.author && receipt.binding === null, 'wrong_receipt_authority');
    else check(receipt.binding !== null, 'wrong_receipt_authority');
  }
  const result = parseReference(receipt.result.slice(origin.length));
  const target = action.target;
  let correct = false;
  switch (target.kind) {
    case 'sea':
      correct = result.kind === 'sea' && result.address === await contentAddress(action.body); break;
    case 'grove':
      correct = result.kind === 'grove' && result.topic.join('/') === target.topic.join('/'); break;
    case 'plot':
      correct = action.author !== null && result.kind === 'plot' && result.handle === target.handle; break;
    case 'publication':
      correct = action.author !== null && result.kind === 'publication'
        && formatReference(result.plot) === formatReference(target.plot)
        && result.topic.join('/') === target.topic.join('/'); break;
    case 'chat':
      correct = result.kind === 'message'
        && formatReference(result.subject) === formatReference(target.subject); break;
  }
  check(correct, 'wrong_receipt_result');
  if (target.kind !== 'sea' && target.anchor !== null) {
    check(result.kind === 'grove' || result.kind === 'plot' || result.kind === 'publication'
      || result.kind === 'message', 'wrong_receipt_result');
    check(u64(result.number) > u64(target.anchor), 'wrong_receipt_result');
  }
  return { action, receipt };
}
/** Only advance an acknowledged send. Persist the old bytes to retry a timeout. */
export async function nextAppendAction(previous: Uint8Array, receipt: Uint8Array,
  body: Uint8Array, origin: string): Promise<Uint8Array<ArrayBuffer>> {
  const payload = copyBytes(body, LIMITS.sourceBytes);
  const accepted = await receiptForAction(previous, receipt, origin);
  check(accepted.action.target.kind !== 'sea', 'append_action_required');
  return actionBytes({ destination: accepted.receipt.result,
    author: accepted.action.author, body: payload }, origin);
}
