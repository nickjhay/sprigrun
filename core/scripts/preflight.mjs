import '../../scripts/check-node.mjs';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'jsonc-parser';
import { policy } from '../host/policy.ts';
import { httpPolicy } from '../http/transport.ts';
import { canonicalOrigin } from '../src/references.ts';
import { seedInventory } from './seeds.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const configFiles = ['staging', 'production'].map(stage => join(root, 'core/deploy/' + stage + '.jsonc'));
export async function readConfig(path) {
  const errors = [], config = parse(await readFile(path, 'utf8'), errors);
  assert.equal(errors.length, 0, 'invalid_config_json');
  return config;
}
/** Local guardrails only: account permissions, live secrets and bucket settings need the cloud rehearsal. */
export function validateConfigs(configs) {
  const names = new Set(), origins = new Set(), buckets = new Set(), limits = new Set();
  for (const c of configs) {
    assert.match(c.name, /^[a-z][a-z0-9-]+$/);
    assert.ok(!names.has(c.name), 'shared_worker'); names.add(c.name);
    const origin = canonicalOrigin(c.vars.CORE_ORIGIN), host = new URL(origin).hostname;
    assert.ok(origin.startsWith('https://') && !origins.has(origin), 'shared_or_insecure_origin'); origins.add(origin);
    assert.deepEqual(c.routes, [{ pattern: host, custom_domain: true }], 'route_must_match_signed_origin');
    assert.equal(c.workers_dev, false, 'alternate_origin_disabled');
    assert.equal(c.preview_urls, false, 'alternate_origin_disabled');
    assert.deepEqual(c.secrets, { required: ['ADMIN_TOKEN', 'BACKUP_TOKEN'] }, 'required_secrets');
    assert.equal(c.env, undefined, 'use_separate_explicit_configs');
    assert.equal(c.migrations, undefined, 'do_not_mix_lifecycle_formats');
    assert.deepEqual(c.exports, { NativeCoordinator: { type: 'durable-object', storage: 'sqlite' } });
    assert.deepEqual(c.durable_objects, { bindings: [{ name: 'CORE', class_name: 'NativeCoordinator' }] }, 'local_namespace_required');
    assert.equal(c.r2_buckets.length, 1);
    const bucket = c.r2_buckets[0];
    assert.equal(bucket.binding, 'SOURCES');
    assert.match(bucket.bucket_name, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
    assert.ok(!buckets.has(bucket.bucket_name), 'shared_r2_bucket'); buckets.add(bucket.bucket_name);
    assert.ok(bucket.preview_bucket_name === undefined, 'no_preview_bucket');
    for (const key of ['ADMIN_TOKEN', 'BACKUP_TOKEN', 'CORE_LOCAL_OPERATOR', 'CORE_RESTORE_MODE'])
      assert.ok(!Object.hasOwn(c.vars, key), 'unsafe_plaintext_or_development_binding: ' + key);
    assert.match(c.vars.ABUSE_EMAIL, /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/);
    assert.ok(Number.isSafeInteger(c.vars.CORE_CAPACITY_BYTES) && c.vars.CORE_CAPACITY_BYTES > 0);
    policy(c.vars.CORE_POLICY); httpPolicy(c.vars.CORE_HTTP_POLICY);
    assert.ok(Number.isSafeInteger(c.limits.cpu_ms) && c.limits.cpu_ms > 0 && c.limits.cpu_ms <= 100);
    assert.equal(c.observability.enabled, false, 'review_logging_before_enabling');
    assert.deepEqual(c.ratelimits.map(r => r.name).sort(), ['READ_RATE_LIMITER', 'WRITE_RATE_LIMITER']);
    for (const r of c.ratelimits) {
      assert.match(r.namespace_id, /^[0-9]+$/);
      assert.ok(!limits.has(r.namespace_id), 'shared_rate_limit_namespace'); limits.add(r.namespace_id);
      assert.ok(Number.isSafeInteger(r.simple.limit) && r.simple.limit > 0);
      assert.ok([10, 60].includes(r.simple.period));
    }
  }
}
export async function main() {
  if (process.argv.length > 2) throw Error('usage: npm run preflight:core');
  const configs = await Promise.all(configFiles.map(readConfig));
  validateConfigs(configs);
  for (let i = 0; i < configs.length; i++)
    assert.equal(resolve(dirname(configFiles[i]), configs[i].main), join(root, 'core/http/worker.ts'), 'wrong_worker_entry');
  assert.equal(await seedInventory(), await readFile(new URL('../seed/inventory.txt', import.meta.url), 'utf8'), 'seed_inventory_changed');
  const directory = await mkdtemp(join(tmpdir(), 'sprig-preflight-'));
  try {
    for (const path of configFiles) {
      await promisify(execFile)(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'),
        'deploy', '--dry-run', '--config', path, '--outdir', directory],
      { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, timeout: 60000 });
      console.log('Bundled ' + path.slice(root.length) + ' without deployment.');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
  console.log('Local preflight passed: isolated resources, bindings, policy, routes and seed inventory.');
  console.log('Still required: account/bucket privacy, live secrets, report inbox, cloud rehearsal and independent backup checks.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
