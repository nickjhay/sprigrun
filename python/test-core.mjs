// Optional cross-language integration test: Node 24 + root npm dependencies.
// Runs only against a disposable loopback store; uploads nothing externally.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { startNative } from '../core/scripts/local-http.mjs';
import { nativeClient } from '../core/scripts/http-client.mjs';

const run = promisify(execFile);
const server = await startNative({ port: 18789 });
try {
  const client = nativeClient(server.origin);
  const source = await client.publish('/sea', await readFile(new URL('./examples/fern.sprig', import.meta.url)));
  const publication = await client.publish('/grove/smallest_sprig', new TextEncoder().encode(source.result + '\n'));
  for (const reference of [source.result, publication.result]) {
    const { stdout, stderr } = await run(process.env.SPRIGRUN_PYTHON ?? 'python3',
      ['-m', 'sprigrun', 'run-ref', reference, '--origin', server.origin],
      { env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('./src', import.meta.url)) }, timeout: 20_000 });
    assert.equal(stdout, "'room for another fern'\n");
    assert.equal(stderr, 'verified ' + source.result.slice('/sea/'.length) + '\n');
  }
  console.log('Python runner verified and ran source by hash and publication through the native HTTP core.');
} finally {
  await server.close();
}
