import { check, nextU64, textBytes } from '../src/bytes.ts';
import { canonical, fields, validateHeader, end, type Header, type End } from './archive.ts';
import { identifier, topology, same, type Topology } from './topology.ts';

export type Manifest = { format: 'sprig-barrier/1'; topology: Topology; id: string; epoch: string;
  cuts: Record<string, Header> };
export function manifest(value: unknown): Manifest {
  fields(value, ['format', 'topology', 'id', 'epoch', 'cuts']);
  check(value.format === 'sprig-barrier/1', 'barrier_manifest_version');
  const t = topology(value.topology); identifier(value.id); nextU64(value.epoch);
  fields(value.cuts, Object.keys(t.shards));
  for (const name of Object.keys(t.shards)) {
    const h = validateHeader(value.cuts[name]), c = h.control;
    check(h.base === null && h.epoch === value.epoch && same(c.partition, { topology: t, shard: name })
      && same(c.barrier, { id: value.id, epoch: value.epoch, phase: 'held', manifest: null }), 'barrier_cut_mismatch');
  }
  check(textBytes(canonical(value)).length <= 128 * 1024, 'barrier_manifest_limit');
  return value as Manifest;
}

export type ClusterPlan = { format: 'sprig-cluster-backup/1'; boundary: Manifest;
  finals: Record<string, { header: Header; footer: End }> };
export function clusterPlan(value: unknown): ClusterPlan {
  fields(value, ['format', 'boundary', 'finals']);
  check(value.format === 'sprig-cluster-backup/1', 'cluster_backup_version');
  const m = manifest(value.boundary); fields(value.finals, Object.keys(m.topology.shards));
  for (const name of Object.keys(m.topology.shards)) {
    const final = value.finals[name]; fields(final, ['header', 'footer']);
    const h = validateHeader(final.header); end(final.footer);
    check(same({ ...h, base: null }, m.cuts[name]), 'cluster_backup_cut');
  }
  check(textBytes(canonical(value)).length <= 256 * 1024, 'cluster_backup_limit');
  return value as ClusterPlan;
}
