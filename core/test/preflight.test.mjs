import test from 'node:test';
import assert from 'node:assert/strict';
import { configFiles, readConfig, validateConfigs } from '../scripts/preflight.mjs';
const configs = await Promise.all(configFiles.map(readConfig));
test('launch configurations isolate metadata, bodies, origins and edge counters', () => {
  validateConfigs(configs);
  for (const [code, change] of [
    ['shared_worker', c => { c[1].name = c[0].name; }],
    ['shared_r2_bucket', c => { c[1].r2_buckets = c[0].r2_buckets; }],
    ['shared_or_insecure_origin', c => { c[1].vars.CORE_ORIGIN = c[0].vars.CORE_ORIGIN; }],
    ['route_must_match_signed_origin', c => { c[0].routes[0].pattern = 'different.example'; }],
    ['local_namespace_required', c => { c[0].durable_objects.bindings[0].script_name = c[1].name; }],
    ['alternate_origin_disabled', c => { c[0].workers_dev = true; }],
    ['shared_rate_limit_namespace', c => { c[1].ratelimits[0].namespace_id = c[0].ratelimits[0].namespace_id; }],
    ['unsafe_plaintext_or_development_binding', c => { c[0].vars.ADMIN_TOKEN = 'a'.repeat(64); }],
    ['unsafe_plaintext_or_development_binding', c => { c[0].vars.CORE_LOCAL_OPERATOR = '1'; }],
    ['invalid_policy', c => { c[0].vars.CORE_POLICY.sourceBytes = 999999; }],
  ]) {
    const changed = structuredClone(configs); change(changed);
    assert.throws(() => validateConfigs(changed), new RegExp(code));
  }
  const accidentalSecret = structuredClone(configs);
  accidentalSecret[0].vars.ADMIN_TOKEN = 'never_echo_this_credential';
  assert.throws(() => validateConfigs(accidentalSecret), error => {
    assert.ok(!error.message.includes('never_echo_this_credential')); return true;
  });
});
