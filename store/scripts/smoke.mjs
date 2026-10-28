#!/usr/bin/env node
import assert from 'node:assert/strict';
import { shareSource, loadSource } from '../examples/client.ts';
const base = process.env.BLOB_STORE_URL ?? 'http://localhost:8787';
const source = '# blob-store smoke check\nfrom world.v4 import *\n';
const address = await shareSource(base, source);
assert.equal((await loadSource(base, address)).source, source);
console.log(`Verified challenge → proof → PUT → GET: ${address}`);
