import { check } from '../src/bytes.ts';

export function fields(value: unknown, names: readonly string[]): asserts value is { [key: string]: any } {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'archive_fields');
  const keys = Object.keys(value);
  check(keys.length === names.length && names.every(k => Object.hasOwn(value, k)), 'archive_fields');
}
export function canonical(value: unknown): string {
  function sorted(v: any): any {
    if (v !== null && typeof v === 'object') {
      check(!Array.isArray(v), 'archive_array');
      return Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])]));
    }
    return v;
  }
  return JSON.stringify(sorted(value));
}
