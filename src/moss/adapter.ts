import { interpret } from './interpreter.ts';
import type { RuntimeRequest } from '../runtime-contract.ts';
export async function run({ source, emit, input, load }: RuntimeRequest): Promise<{ summary: string }> {
  const result = await interpret(source, { print: emit, input, load });
  return { summary: `Moss finished · ${result.steps} steps · ${result.stack.length} values left on the stack.` };
}
