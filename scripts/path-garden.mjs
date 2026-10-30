import assert from 'node:assert/strict';
import { PathHost } from '../src/experiments/paths.ts';

// Host-issued permissions. These objects are never supplied by an HTTP caller.
const visitor = { id: 'visitor', appendUnder: ['/grove'], advance: [], enqueue: ['review'], finish: [] };
const host = new PathHost();
const card = title => `protocol sprig-card-sketch-1\ntitle ${title}\n`;
const submit = body => ({ publication: { kind: 'append', topic: '/grove/fern', body, enqueue: ['review'] } });
const first = host.commit(visitor, 'first', submit(card('A little fern')), 100);
host.commit(visitor, 'second', submit(card('Another fern')), 110);
assert.deepEqual(host.commit(visitor, 'first', submit(card('A little fern')), 120), first);

const author = { ...visitor, advance: [first.entry] };
host.commit(author, 'grow', { publication: {
  kind: 'advance', entry: first.entry, expected: '0', body: card('A fern unfurls'),
} }, 130);
const task = host.pending('review')[0];
assert.equal(task.source, '/grove/fern.0@0');

console.log('A grove is a topic with room for more than one fern.\n');
console.table(['/grove/fern.count', '/grove/fern.0', '/grove/fern.0@0', '/grove/fern.1@0'].map(path => {
  const read = host.get(path);
  return { path, status: read.status, text: read.value?.body.trim().replaceAll('\n', ' · ') };
}));
console.log('\nThe retry kept its number. The update kept its old revision.');
console.log(`The pending review still names ${task.source}, not whichever fern is current.`);

const reviewer = { id: 'reviewer', appendUnder: ['/reviews'], advance: [], enqueue: [], finish: ['review'] };
const review = { publication: { kind: 'append', topic: '/reviews/fern',
  body: `source ${task.source}\ncomment A small beginning.\n` }, finish: task.id };
const reviewed = host.commit(reviewer, 'review_first', review, 140);
assert.deepEqual(host.commit(reviewer, 'review_first', review, 150), reviewed);
console.log(`A demonstration comment is stored at ${reviewed.pinned}; its task completed in the same turn.`);
console.log('No model was called. GET only reads committed text; it runs no policy.');
console.log('Offline in-memory experiment: no server, Sprig VM, durable transaction, or upload.');
