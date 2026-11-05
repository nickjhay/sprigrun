// Adapter-based operator helpers. No deployment, public admin routes or scheduler.
import { open, link, unlink, lstat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { check } from '../src/bytes.ts';
import { canonical, digest, hash } from '../host/archive.ts';
import { clusterPlan } from '../host/cluster.ts';
import { same } from '../host/topology.ts';
import { backup, verifyChain, prepareRestoreChain } from './recover.mjs';

async function publish(file, value) {
  const temporary = file + '.' + randomUUID() + '.partial'; let h;
  try {
    h = await open(temporary, 'wx', 0o600); await h.writeFile(canonical(value) + '\n');
    await h.sync(); await h.close(); h = null;
    await link(temporary, file); await unlink(temporary);
    const d = await open(dirname(resolve(file)), 'r'); try { await d.sync(); } finally { await d.close(); }
  } finally { await h?.close(); await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
/** Copy an already committed boundary. Optional per-member bases must be independently pinned. */
export async function captureCluster(host, directory, id, bases = null) {
  const boundary = await host.controller.published(id), finals = {}, files = {};
  const planFile = join(directory, 'cluster.json');
  try { await lstat(planFile); throw Error('archive_exists'); } catch (e) { if(e.code !== 'ENOENT') throw e; }
  for (const name of Object.keys(boundary.topology.shards).sort()) {
    const base = bases === null ? null : bases[name];
    check(bases === null || base, 'cluster_backup_missing_member');
    const checked = base ? await verifyChain(base.files, base.digest) : null;
    const file = join(directory, name + '.jsonl');
    const a = await backup(host.shard(name), file, boundary.epoch, checked?.at(-1) ?? null);
    finals[name] = {header:a.header, footer:a.footer}; files[name] = [...(base?.files ?? []), file];
  }
  const plan = clusterPlan({ format:'sprig-cluster-backup/1', boundary, finals });
  await publish(planFile, plan);
  return { plan, digest: await digest(canonical(plan)), files, planFile };
}
/** Verify every complete suffix before creating any state at the restore target. */
export async function verifyCluster(plan, files, trustedDigest) {
  plan = structuredClone(plan);
  hash(trustedDigest); clusterPlan(plan);
  check(await digest(canonical(plan)) === trustedDigest, 'cluster_trusted_digest_mismatch');
  check(same(Object.fromEntries(Object.keys(files).map(n=>[n,true])), plan.boundary.topology.shards), 'cluster_backup_missing_member');
  const chains = {};
  for (const name of Object.keys(plan.finals)) {
    const chain = await prepareRestoreChain(files[name], plan.finals[name].footer.chain), last = chain.final;
    check(same({header:last.header, footer:last.footer}, plan.finals[name]), 'cluster_backup_cut');
    chains[name] = chain;
  }
  return { plan: structuredClone(plan), async restore(host) {
    // Caller must actually fence the old writers and pin the final boundary independently.
    // This helper deliberately does not supply the operator's fencing confirmation.
    check((await host.controller.restoreStatus())?.digest === trustedDigest, 'cluster_restore_not_ready');
    for (const name of Object.keys(plan.finals).sort()) {
      const core = host.shard(name);
      const adapter = new Proxy(core, { get(target, method) {
        if (method === 'restoreBegin') return (header, footer, end) => target.restoreBegin(header, footer, end, trustedDigest);
        return target[method];
      }});
      await chains[name].restore(adapter);
    }
    return host.controller.restoreStatus(); // Verification/release are explicit bounded steps.
  } };
}
export async function importCluster(host, bundle, trustedDigest) {
  return (await verifyCluster(bundle.plan, bundle.files, trustedDigest)).restore(host);
}
