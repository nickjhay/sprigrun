// Offline protocol rehearsal. Receipts below are explicit fixtures, not commits.
import { readFile } from 'node:fs/promises';
import { actionId } from '../src/action.ts';
import { textBytes, utf8 } from '../src/bytes.ts';
import { verifyAction } from '../src/authority.ts';
import { nextAppendAction, receiptBytes } from '../src/receipt.ts';

const v = JSON.parse(await readFile(new URL('../test/vectors/ed25519.json', import.meta.url), 'utf8'));
const c = v.cases[1];
const origin = 'https://sprig.run';
const first = textBytes(c.action);
const checked = await verifyAction(first, c.signature, {
  keyRecord: textBytes(v.key_record), plotBinding: textBytes(v.plot_binding),
}, origin);
console.log('Offline protocol demo — public test key, no server writes.\n');
console.log(c.action);
console.log('Verified action:', checked.id);
const receipt = receiptBytes({
  action: checked.id, result: origin + '/chat/grove/fern.7/27',
  acceptedAtMs: '0', key: checked.key, binding: checked.binding,
}, origin);
console.log('\nFixture receipt: another writer advanced the chat; our entry is 27.');
console.log(utf8(receipt));
const second = await nextAppendAction(first, receipt, checked.action.body, origin);
console.log('The next identical message uses its receipt as the anchor:\n');
console.log(utf8(second));
console.log('Same retry:', await actionId(first, origin) === checked.id);
console.log('New occurrence:', await actionId(second, origin) !== checked.id);
console.log('The future database must enforce action-ID uniqueness atomically.');
