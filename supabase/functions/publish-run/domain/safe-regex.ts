// Linear-time pattern matcher for file_contains graders (PLAN.md §6). Thompson NFA simulation: O(text x states).
// Supported: literals, ".", classes [...] / [^...] with ranges, \d \w \s \D \W \S, \n \r \t, escaped punctuation,
// groups ( ), alternation |, quantifiers * + ?, anchors ^ $. Flags: i (ASCII case folding), m (line anchors).
// Refused: backreferences, lookaround, lazy quantifiers, counted repetition, named/non-capturing groups, \b, other flags.

export const MAX_PATTERN_CHARS = 1024;
export const MAX_TEXT_CHARS = 512 * 1024;
const MAX_STATES = 4096;

type Pred = (code: number) => boolean;
type Node =
  | { t: "char"; pred: Pred }
  | { t: "bol" }
  | { t: "eol" }
  | { t: "cat"; items: Node[] }
  | { t: "alt"; items: Node[] }
  | { t: "star"; node: Node }
  | { t: "plus"; node: Node }
  | { t: "opt"; node: Node };

export class PatternError extends Error {}

const isDigit: Pred = (c) => c >= 48 && c <= 57;
const isWord: Pred = (c) => isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isSpace: Pred = (c) => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x2028 || c === 0x2029 || c === 0xfeff;
const isLineTerminator = (c: number) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;

function fold(c: number): number {
  return c >= 65 && c <= 90 ? c + 32 : c;
}

function upper(c: number): number {
  return c >= 97 && c <= 122 ? c - 32 : c;
}

class Parser {
  i = 0;
  constructor(
    private src: string,
    private ci: boolean,
  ) {}

  parse(): Node {
    const node = this.alt();
    if (this.i < this.src.length) throw new PatternError(`unexpected "${this.src[this.i]}" at ${this.i}`);
    return node;
  }

  private alt(): Node {
    const items = [this.cat()];
    while (this.src[this.i] === "|") {
      this.i += 1;
      items.push(this.cat());
    }
    return items.length === 1 ? items[0]! : { t: "alt", items };
  }

  private cat(): Node {
    const items: Node[] = [];
    while (this.i < this.src.length && this.src[this.i] !== "|" && this.src[this.i] !== ")") items.push(this.repeat());
    return { t: "cat", items };
  }

  private repeat(): Node {
    const atom = this.atom();
    const q = this.src[this.i];
    if (q === "{") throw new PatternError("counted repetition {m,n} is not supported");
    if (q !== "*" && q !== "+" && q !== "?") return atom;
    if (atom.t === "bol" || atom.t === "eol") throw new PatternError("anchors cannot be quantified");
    this.i += 1;
    const next = this.src[this.i];
    if (next === "?") throw new PatternError("lazy quantifiers are not supported");
    if (next === "*" || next === "+" || next === "{") throw new PatternError("stacked quantifiers are not supported");
    return q === "*" ? { t: "star", node: atom } : q === "+" ? { t: "plus", node: atom } : { t: "opt", node: atom };
  }

  private literal(code: number): Node {
    if (this.ci) {
      const f = fold(code);
      return { t: "char", pred: (c) => fold(c) === f };
    }
    return { t: "char", pred: (c) => c === code };
  }

  private atom(): Node {
    const ch = this.src[this.i];
    if (ch === undefined) throw new PatternError("unexpected end of pattern");
    if (ch === "(") {
      this.i += 1;
      if (this.src[this.i] === "?") throw new PatternError("lookaround, named and non-capturing groups are not supported");
      const inner = this.alt();
      if (this.src[this.i] !== ")") throw new PatternError("missing )");
      this.i += 1;
      return inner;
    }
    if (ch === ")") throw new PatternError("unbalanced )");
    if (ch === "*" || ch === "+" || ch === "?") throw new PatternError(`nothing to repeat at ${this.i}`);
    if (ch === "{" || ch === "}") throw new PatternError("braces must be escaped");
    this.i += 1;
    if (ch === ".") return { t: "char", pred: (c) => !isLineTerminator(c) };
    if (ch === "^") return { t: "bol" };
    if (ch === "$") return { t: "eol" };
    if (ch === "[") return this.cls();
    if (ch === "\\") return { t: "char", pred: this.escape(false) };
    return this.literal(ch.charCodeAt(0));
  }

  /** Returns a predicate for an escape after the backslash. */
  private escape(inClass: boolean): Pred {
    const e = this.src[this.i];
    if (e === undefined) throw new PatternError("trailing backslash");
    this.i += 1;
    switch (e) {
      case "d":
        return isDigit;
      case "D":
        return (c) => !isDigit(c);
      case "w":
        return isWord;
      case "W":
        return (c) => !isWord(c);
      case "s":
        return isSpace;
      case "S":
        return (c) => !isSpace(c);
      case "n":
        return (c) => c === 10;
      case "r":
        return (c) => c === 13;
      case "t":
        return (c) => c === 9;
      default:
        if (/[0-9]/.test(e)) throw new PatternError("backreferences are not supported");
        if (/[A-Za-z]/.test(e)) throw new PatternError(`escape \\${e} is not supported${inClass ? " in a class" : ""}`);
        return (this.literal(e.charCodeAt(0)) as { pred: Pred }).pred;
    }
  }

  /** Reads one class member code (literal or escaped literal). */
  private classCode(): number {
    if (this.src[this.i] !== "\\") {
      const code = this.src.charCodeAt(this.i);
      this.i += 1;
      return code;
    }
    this.i += 1;
    const e = this.src[this.i];
    if (e === undefined) throw new PatternError("trailing backslash");
    this.i += 1;
    if (e === "n") return 10;
    if (e === "r") return 13;
    if (e === "t") return 9;
    if (/[A-Za-z0-9]/.test(e)) throw new PatternError(`escape \${e} is not supported in a class`);
    return e.charCodeAt(0);
  }

  private cls(): Node {
    let negate = false;
    if (this.src[this.i] === "^") {
      negate = true;
      this.i += 1;
    }
    const preds: Pred[] = [];
    let first = true;
    while (this.i < this.src.length && (this.src[this.i] !== "]" || first)) {
      first = false;
      const peek = this.src[this.i + 1];
      if (this.src[this.i] === "\\" && peek !== undefined && "dDwWsS".includes(peek)) {
        this.i += 1;
        preds.push(this.escape(true));
        continue;
      }
      const lo = this.classCode();
      let hi = lo;
      if (this.src[this.i] === "-" && this.src[this.i + 1] !== undefined && this.src[this.i + 1] !== "]") {
        this.i += 1;
        hi = this.classCode();
        if (hi < lo) throw new PatternError("class range out of order");
      }
      const inRange = (c: number) => c >= lo && c <= hi;
      preds.push(this.ci ? (c) => inRange(c) || inRange(fold(c)) || inRange(upper(c)) : inRange);
    }
    if (this.src[this.i] !== "]") throw new PatternError("missing ]");
    this.i += 1;
    return { t: "char", pred: (c) => preds.some((p) => p(c)) !== negate };
  }
}

// NFA
type State =
  | { k: "char"; pred: Pred; out: number }
  | { k: "split"; a: number; b: number }
  | { k: "bol"; out: number }
  | { k: "eol"; out: number }
  | { k: "match" };

class Compiler {
  states: State[] = [];
  private add(s: State): number {
    if (this.states.length >= MAX_STATES) throw new PatternError("pattern is too complex");
    this.states.push(s);
    return this.states.length - 1;
  }
  /** Compiles node so that it continues to `next`; returns entry state index. */
  emit(node: Node, next: number): number {
    switch (node.t) {
      case "char":
        return this.add({ k: "char", pred: node.pred, out: next });
      case "bol":
        return this.add({ k: "bol", out: next });
      case "eol":
        return this.add({ k: "eol", out: next });
      case "cat": {
        let entry = next;
        for (let i = node.items.length - 1; i >= 0; i -= 1) entry = this.emit(node.items[i]!, entry);
        return entry;
      }
      case "alt": {
        let entry = this.emit(node.items[node.items.length - 1]!, next);
        for (let i = node.items.length - 2; i >= 0; i -= 1) entry = this.add({ k: "split", a: this.emit(node.items[i]!, next), b: entry });
        return entry;
      }
      case "opt":
        return this.add({ k: "split", a: this.emit(node.node, next), b: next });
      case "star": {
        const split = this.add({ k: "split", a: -1, b: next });
        const body = this.emit(node.node, split);
        (this.states[split] as { a: number }).a = body;
        return split;
      }
      case "plus": {
        const split = this.add({ k: "split", a: -1, b: next });
        const body = this.emit(node.node, split);
        (this.states[split] as { a: number }).a = body;
        return body;
      }
    }
  }
}

export interface CompiledPattern {
  test(text: string): boolean;
}

export function compilePattern(pattern: string, flags = ""): CompiledPattern {
  if (pattern.length > MAX_PATTERN_CHARS) throw new PatternError(`pattern exceeds ${MAX_PATTERN_CHARS} characters`);
  if (!/^[im]*$/.test(flags) || new Set(flags).size !== flags.length) throw new PatternError("flags must be a subset of i, m");
  const ci = flags.includes("i");
  const multiline = flags.includes("m");
  const ast = new Parser(pattern, ci).parse();
  const c = new Compiler();
  const matchIndex = c.states.push({ k: "match" }) - 1;
  const start = c.emit(ast, matchIndex);
  const states = c.states;

  return {
    test(text: string): boolean {
      if (text.length > MAX_TEXT_CHARS) throw new PatternError(`text exceeds ${MAX_TEXT_CHARS} characters`);
      let current = new Set<number>();
      const atBol = (pos: number) => pos === 0 || (multiline && isLineTerminator(text.charCodeAt(pos - 1)));
      const atEol = (pos: number) => pos === text.length || (multiline && isLineTerminator(text.charCodeAt(pos)));
      const addState = (set: Set<number>, idx: number, pos: number): boolean => {
        const stack = [idx];
        while (stack.length) {
          const s = stack.pop()!;
          if (s < 0 || set.has(s)) continue;
          set.add(s);
          const st = states[s]!;
          if (st.k === "match") return true;
          if (st.k === "split") stack.push(st.b, st.a);
          else if (st.k === "bol" && atBol(pos)) stack.push(st.out);
          else if (st.k === "eol" && atEol(pos)) stack.push(st.out);
        }
        return false;
      };
      for (let pos = 0; pos <= text.length; pos += 1) {
        if (addState(current, start, pos)) return true;
        if (pos === text.length) break;
        const code = text.charCodeAt(pos);
        const next = new Set<number>();
        for (const s of current) {
          const st = states[s]!;
          if (st.k === "char" && st.pred(code) && addState(next, st.out, pos + 1)) return true;
        }
        current = next;
      }
      return false;
    },
  };
}
