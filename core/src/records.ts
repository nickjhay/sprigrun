import { check, copyBytes, LIMITS, textBytes, utf8 } from './bytes.ts';

/** Fixed fields in fixed order. Public records are never parsed as YAML. */
export function readRecord(input: Uint8Array, type: string, fields: string[]): string[] {
  const lines = utf8(copyBytes(input, LIMITS.recordBytes)).split('\n');
  check(lines[0] === '#!sprig.run/spec/' + type, 'unsupported_record_version');
  check(lines.length === fields.length + 2 && lines.at(-1) === '', 'invalid_record_frame');
  return fields.map((name, i) => {
    const prefix = name + ': ';
    check(lines[i + 1]!.startsWith(prefix), 'invalid_record_field');
    const value = lines[i + 1]!.slice(prefix.length);
    check(value.length > 0 && !value.includes('\r'), 'invalid_record_field');
    return value;
  });
}
export function writeRecord(type: string, fields: [string, string][]): Uint8Array<ArrayBuffer> {
  check(fields.every(([, value]) => typeof value === 'string' && !/[\r\n]/.test(value)), 'invalid_record_field');
  const bytes = textBytes('#!sprig.run/spec/' + type + '\n'
    + fields.map(([name, value]) => name + ': ' + value + '\n').join(''));
  readRecord(bytes, type, fields.map(([name]) => name));
  return bytes;
}
