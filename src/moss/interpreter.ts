// Moss is interpreted data. No guest text is evaluated as JavaScript.
export type Value = number | string;
type Token = { kind: 'word' | 'value'; value: Value; line: number };
type Instruction = Token | { kind: 'define'; name: string; body: Token[]; line: number };
export interface MossIO {
  print(text: string): void;
  input(prompt: string): Promise<string>;
  load(address: string): Promise<Uint8Array>;
}
export const MOSS_LIMITS = Object.freeze({
  sourceBytes: 262144, totalSourceBytes: 1048576, tokens: 32768,
  steps: 100000, frames: 64, words: 256, stack: 256,
  stringChars: 16384, stackChars: 65536, modules: 32, inputs: 16,
  outputChars: 65536, outputMessages: 1024,
});
const BUILTINS = new Set(['+','-','*','/','%','=','<','>','dup','drop','swap','over',
  'str','number','len','upper','lower','trim','reverse','print','input','graft']);
const numeric = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function lex(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0, line = 1;
  while (at < text.length) {
    const char = text[at]!;
    if (/\s/u.test(char)) { if (char === '\n') line++; at++; continue; }
    if (char === '#') { while (at < text.length && text[at] !== '\n') at++; continue; }
    const start = at, startLine = line;
    if (char === '"') {
      at++; let closed = false;
      while (at < text.length) {
        const c = text[at++]!;
        if (c === '\n' || c === '\r') throw new Error(`Line ${startLine}: use \\n inside a string.`);
        if (c === '\\') { at++; continue; }
        if (c === '"') { closed = true; break; }
      }
      if (!closed) throw new Error(`Line ${startLine}: unclosed string.`);
      let value: string;
      try { value = JSON.parse(text.slice(start, at)); }
      catch { throw new Error(`Line ${startLine}: invalid string escape.`); }
      if (value.length > MOSS_LIMITS.stringChars) throw new Error('String limit reached.');
      tokens.push({ kind: 'value', value, line: startLine });
    } else {
      if (char === ':' || char === ';') at++;
      else while (at < text.length && !/[\s:;#"]/u.test(text[at]!)) at++;
      const word = text.slice(start, at);
      if (!word) throw new Error(`Line ${line}: unexpected character.`);
      const value = numeric.test(word) ? Number(word) : word;
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Line ${line}: number must be finite.`);
      tokens.push({ kind: typeof value === 'number' ? 'value' : 'word', value, line });
    }
    if (tokens.length > MOSS_LIMITS.tokens) throw new Error('Token limit reached.');
  }
  return tokens;
}
function compile(bytes: Uint8Array): { code: Instruction[]; tokens: number } {
  if (bytes.length > MOSS_LIMITS.sourceBytes) throw new Error('Source exceeds 256 KiB.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Source must be UTF-8.'); }
  if (text.split('\n', 1)[0]?.replace(/\r$/, '') !== '#!moss/1')
    throw new Error('Moss needs #!moss/1 on the first line. This is a test language, not Sprig.');
  const tokens = lex(text), code: Instruction[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === 'word' && token.value === ':') {
      const name = tokens[++i];
      if (!name || name.kind !== 'word' || typeof name.value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name.value) || BUILTINS.has(name.value))
        throw new Error(`Line ${token.line}: expected a new word name after :`);
      const body: Token[] = []; let closed = false;
      while (++i < tokens.length) {
        const next = tokens[i]!;
        if (next.kind === 'word' && next.value === ';') { closed = true; break; }
        if (next.kind === 'word' && next.value === ':') throw new Error(`Line ${next.line}: definitions cannot nest.`);
        body.push(next);
      }
      if (!closed) throw new Error(`Line ${token.line}: finish the definition with ;`);
      code.push({ kind: 'define', name: name.value, body, line: token.line });
    } else {
      if (token.kind === 'word' && token.value === ';') throw new Error(`Line ${token.line}: unexpected ;`);
      code.push(token);
    }
  }
  return { code, tokens: tokens.length };
}

export async function interpret(source: Uint8Array, io: MossIO): Promise<{ stack: Value[]; steps: number }> {
  const stack: Value[] = [];
  const words = new Map<string, { code: Token[]; label: string }>();
  const grafted = new Set<string>(), active = new Set<string>();
  type Frame = { code: Instruction[]; ip: number; label: string; address?: string };
  const frames: Frame[] = [];
  let sourceBytes = 0, tokenCount = 0, steps = 0, inputs = 0, outputChars = 0, outputMessages = 0;
  function program(bytes: Uint8Array, label: string, address?: string): Frame {
    sourceBytes += bytes.length;
    if (sourceBytes > MOSS_LIMITS.totalSourceBytes) throw new Error('Total source limit reached.');
    const parsed = compile(bytes); tokenCount += parsed.tokens;
    if (tokenCount > MOSS_LIMITS.tokens) throw new Error('Total token limit reached.');
    return { code: parsed.code, ip: 0, label, address };
  }
  function pop(): Value { if (!stack.length) throw new Error('The stack is empty.'); return stack.pop()!; }
  function string(value: Value): string { if (typeof value !== 'string') throw new Error('Expected a string.'); return value; }
  function number(value: Value): number { if (typeof value !== 'number') throw new Error('Expected a number; use number to convert text.'); return value; }
  function push(value: Value): void {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Arithmetic result must be finite.');
    if (typeof value === 'string' && value.length > MOSS_LIMITS.stringChars) throw new Error('String limit reached.');
    if (stack.length >= MOSS_LIMITS.stack) throw new Error('Stack limit reached.');
    const chars = stack.reduce<number>((n,v)=>n+(typeof v==='string'?v.length:0),0);
    if (chars + (typeof value === 'string' ? value.length : 0) > MOSS_LIMITS.stackChars) throw new Error('Stack text limit reached.');
    stack.push(value);
  }
  frames.push(program(source, 'main'));
  while (frames.length) {
    const frame = frames.at(-1)!;
    if (frame.ip === frame.code.length) {
      frames.pop();
      if (frame.address) { active.delete(frame.address); grafted.add(frame.address); }
      continue;
    }
    const op = frame.code[frame.ip++]!;
    try {
      if (++steps > MOSS_LIMITS.steps) throw new Error('Instruction limit reached.');
      if (op.kind === 'value') { push(op.value); continue; }
      if (op.kind === 'define') {
        if (words.has(op.name)) throw new Error(`Word ${op.name} is already defined.`);
        if (words.size >= MOSS_LIMITS.words) throw new Error('Word limit reached.');
        words.set(op.name, { code: op.body, label: frame.label }); continue;
      }
      const word = op.value as string;
      if (words.has(word)) {
        const definition = words.get(word)!;
        if (frames.length >= MOSS_LIMITS.frames) throw new Error('Call depth limit reached.');
        frames.push({ ...definition, ip: 0 }); continue;
      }
      switch (word) {
        case '+': {
          const b=pop(),a=pop();
          if (typeof a==='number' && typeof b==='number') push(a+b);
          else if (typeof a==='string' && typeof b==='string') {
            if (a.length+b.length>MOSS_LIMITS.stringChars) throw new Error('String limit reached.');
            push(a+b);
          } else throw new Error('+ needs two numbers or two strings; use str for text.');
          break;
        }
        case '-': case '*': case '/': case '%': {
          const b=number(pop()),a=number(pop());
          if ((word==='/'||word==='%')&&b===0) throw new Error('Division by zero.');
          push(word==='-'?a-b:word==='*'?a*b:word==='/'?a/b:a%b); break;
        }
        case '=': { const b=pop(),a=pop(); push(a===b?1:0); break; }
        case '<': case '>': { const b=number(pop()),a=number(pop());push((word==='<'?a<b:a>b)?1:0);break; }
        case 'dup': {const a=pop();push(a);push(a);break;}
        case 'drop': pop();break;
        case 'swap': {const b=pop(),a=pop();push(b);push(a);break;}
        case 'over': {const b=pop(),a=pop();push(a);push(b);push(a);break;}
        case 'str': push(String(pop()));break;
        case 'number': {const a=string(pop()).trim();if(!numeric.test(a))throw new Error('That text is not a decimal number.');push(Number(a));break;}
        case 'len': push(Array.from(string(pop())).length);break;
        case 'upper': push(string(pop()).toUpperCase());break;
        case 'lower': push(string(pop()).toLowerCase());break;
        case 'trim': push(string(pop()).trim());break;
        case 'reverse': push(Array.from(string(pop())).reverse().join(''));break;
        case 'print': {
          const text=String(pop())+'\n'; outputChars+=text.length;
          if(++outputMessages>MOSS_LIMITS.outputMessages||outputChars>MOSS_LIMITS.outputChars)throw new Error('Output limit reached.');
          io.print(text);break;
        }
        case 'input': {
          if(++inputs>MOSS_LIMITS.inputs)throw new Error('Input request limit reached.');
          push(await io.input(string(pop())));break;
        }
        case 'graft': {
          const address=string(pop());
          if(!/^[0-9a-f]{64}_(0|[1-9][0-9]{0,6})$/.test(address)||Number(address.split('_')[1])>MOSS_LIMITS.sourceBytes)throw new Error('graft needs a SHA-256_hex_byteLength address within 256 KiB.');
          if(active.has(address))throw new Error('Recursive graft detected.');
          if(grafted.has(address))break;
          if(active.size+grafted.size>=MOSS_LIMITS.modules)throw new Error('Graft limit reached.');
          if(frames.length>=MOSS_LIMITS.frames)throw new Error('Call depth limit reached.');
          const bytes=await io.load(address);
          const next=program(bytes,address.slice(0,12),address);
          active.add(address);frames.push(next);break;
        }
        default: throw new Error(`Unknown word: ${word.slice(0,80)}`);
      }
    } catch (error) {
      throw new Error(`${frame.label}:${op.line}: ${error instanceof Error?error.message:'Execution failed.'}`);
    }
  }
  return { stack, steps };
}
