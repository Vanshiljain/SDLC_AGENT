/**
 * A small, safe expression language for Flow conditions and templates.
 *
 * Supports: literals (numbers, 'strings', "strings", true/false/null, [arrays]),
 * identifiers with member/index access, unary ! and -, arithmetic + - * / %,
 * comparisons == != < <= > >=, `in`, logical && || (short-circuit), ternary
 * `a ? b : c`, parentheses and a whitelist of pure functions.
 *
 * It never uses eval/Function and refuses prototype-related property access.
 */

export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly position?: number,
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

type TokenType = 'num' | 'str' | 'ident' | 'op' | 'punc' | 'eof';
interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const MAX_EXPRESSION_LENGTH = 2000;
const FORBIDDEN_PROPS = new Set(['__proto__', 'prototype', 'constructor', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);
const TWO_CHAR_OPS = new Set(['==', '!=', '<=', '>=', '&&', '||']);
const ONE_CHAR_OPS = new Set(['<', '>', '+', '-', '*', '/', '%', '!', '?', ':']);
const PUNCTUATION = new Set(['(', ')', '[', ']', '.', ',']);

function tokenize(src: string): Token[] {
  if (src.length > MAX_EXPRESSION_LENGTH) {
    throw new ExpressionError(`Expression exceeds ${MAX_EXPRESSION_LENGTH} characters`);
  }
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < src.length && /[0-9_]/.test(src[i]!)) i++;
      if (src[i] === '.' && /[0-9]/.test(src[i + 1] ?? '')) {
        i++;
        while (i < src.length && /[0-9]/.test(src[i]!)) i++;
      }
      tokens.push({ type: 'num', value: src.slice(start, i).replace(/_/g, ''), pos: start });
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i++;
      let value = '';
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const next = src[i + 1]!;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
          continue;
        }
        value += src[i];
        i++;
      }
      if (src[i] !== quote) throw new ExpressionError('Unterminated string literal', start);
      i++;
      tokens.push({ type: 'str', value, pos: start });
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i]!)) i++;
      tokens.push({ type: 'ident', value: src.slice(start, i), pos: start });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      tokens.push({ type: 'op', value: two, pos: i });
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.has(ch)) {
      tokens.push({ type: 'op', value: ch, pos: i });
      i++;
      continue;
    }
    if (PUNCTUATION.has(ch)) {
      tokens.push({ type: 'punc', value: ch, pos: i });
      i++;
      continue;
    }
    throw new ExpressionError(`Unexpected character '${ch}'`, i);
  }
  tokens.push({ type: 'eof', value: '', pos: src.length });
  return tokens;
}

export type ExprNode =
  | { kind: 'literal'; value: unknown }
  | { kind: 'ident'; name: string }
  | { kind: 'member'; object: ExprNode; property: ExprNode; computed: boolean }
  | { kind: 'unary'; op: string; arg: ExprNode }
  | { kind: 'binary'; op: string; left: ExprNode; right: ExprNode }
  | { kind: 'ternary'; test: ExprNode; consequent: ExprNode; alternate: ExprNode }
  | { kind: 'call'; callee: string; args: ExprNode[] }
  | { kind: 'array'; items: ExprNode[] };

const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  in: 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): ExprNode {
    const node = this.parseTernary();
    const t = this.peek();
    if (t.type !== 'eof') throw new ExpressionError(`Unexpected token '${t.value}'`, t.pos);
    return node;
  }

  private peek(): Token {
    return this.tokens[this.i]!;
  }
  private next(): Token {
    return this.tokens[this.i++]!;
  }
  private expect(type: TokenType, value?: string): Token {
    const t = this.next();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new ExpressionError(`Expected '${value ?? type}' but found '${t.value || t.type}'`, t.pos);
    }
    return t;
  }

  private parseTernary(): ExprNode {
    const test = this.parseBinary(0);
    const t = this.peek();
    if (t.type === 'op' && t.value === '?') {
      this.next();
      const consequent = this.parseTernary();
      this.expect('op', ':');
      const alternate = this.parseTernary();
      return { kind: 'ternary', test, consequent, alternate };
    }
    return test;
  }

  private binaryOp(): string | null {
    const t = this.peek();
    if (t.type === 'op' && t.value in BINARY_PRECEDENCE) return t.value;
    if (t.type === 'ident' && t.value === 'in') return 'in';
    return null;
  }

  private parseBinary(minPrec: number): ExprNode {
    let left = this.parseUnary();
    for (;;) {
      const op = this.binaryOp();
      if (!op) break;
      const prec = BINARY_PRECEDENCE[op]!;
      if (prec <= minPrec) break;
      this.next();
      const right = this.parseBinary(prec);
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseUnary(): ExprNode {
    const t = this.peek();
    if (t.type === 'op' && (t.value === '!' || t.value === '-')) {
      this.next();
      return { kind: 'unary', op: t.value, arg: this.parseUnary() };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  private parsePostfix(node: ExprNode): ExprNode {
    for (;;) {
      const t = this.peek();
      if (t.type === 'punc' && t.value === '.') {
        this.next();
        const prop = this.expect('ident');
        node = { kind: 'member', object: node, property: { kind: 'literal', value: prop.value }, computed: false };
      } else if (t.type === 'punc' && t.value === '[') {
        this.next();
        const property = this.parseTernary();
        this.expect('punc', ']');
        node = { kind: 'member', object: node, property, computed: true };
      } else {
        return node;
      }
    }
  }

  private parsePrimary(): ExprNode {
    const t = this.next();
    switch (t.type) {
      case 'num':
        return { kind: 'literal', value: Number(t.value) };
      case 'str':
        return { kind: 'literal', value: t.value };
      case 'ident': {
        if (t.value === 'true') return { kind: 'literal', value: true };
        if (t.value === 'false') return { kind: 'literal', value: false };
        if (t.value === 'null' || t.value === 'undefined') return { kind: 'literal', value: null };
        const p = this.peek();
        if (p.type === 'punc' && p.value === '(') {
          this.next();
          const args: ExprNode[] = [];
          if (!(this.peek().type === 'punc' && this.peek().value === ')')) {
            do {
              args.push(this.parseTernary());
            } while (this.peek().type === 'punc' && this.peek().value === ',' && this.next());
          }
          this.expect('punc', ')');
          if (!(t.value in FUNCTIONS)) throw new ExpressionError(`Unknown function '${t.value}'`, t.pos);
          return { kind: 'call', callee: t.value, args };
        }
        return { kind: 'ident', name: t.value };
      }
      case 'punc':
        if (t.value === '(') {
          const inner = this.parseTernary();
          this.expect('punc', ')');
          return inner;
        }
        if (t.value === '[') {
          const items: ExprNode[] = [];
          if (!(this.peek().type === 'punc' && this.peek().value === ']')) {
            do {
              items.push(this.parseTernary());
            } while (this.peek().type === 'punc' && this.peek().value === ',' && this.next());
          }
          this.expect('punc', ']');
          return { kind: 'array', items };
        }
        break;
      default:
        break;
    }
    throw new ExpressionError(`Unexpected token '${t.value || t.type}'`, t.pos);
  }
}

const isObjectLike = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
  len: (v) => (Array.isArray(v) || typeof v === 'string' ? v.length : isObjectLike(v) ? Object.keys(v).length : 0),
  contains: (haystack, needle) =>
    Array.isArray(haystack)
      ? haystack.some((x) => looseEquals(x, needle))
      : typeof haystack === 'string'
        ? haystack.includes(String(needle))
        : false,
  lower: (v) => (typeof v === 'string' ? v.toLowerCase() : v),
  upper: (v) => (typeof v === 'string' ? v.toUpperCase() : v),
  startsWith: (v, p) => typeof v === 'string' && v.startsWith(String(p)),
  endsWith: (v, p) => typeof v === 'string' && v.endsWith(String(p)),
  exists: (v) => v !== undefined && v !== null,
  empty: (v) =>
    v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || (isObjectLike(v) && Object.keys(v).length === 0),
  coalesce: (...args) => args.find((a) => a !== undefined && a !== null) ?? null,
  string: (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)),
  number: (v) => Number(v),
  json: (v) => JSON.stringify(v ?? null),
  join: (arr, sep) => (Array.isArray(arr) ? arr.map((x) => (isObjectLike(x) ? JSON.stringify(x) : String(x))).join(sep === undefined ? ', ' : String(sep)) : ''),
  slugify: (v) =>
    String(v ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60),
  truncate: (v, n) => {
    const s = String(v ?? '');
    const max = Number(n ?? 200);
    return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
  },
  pluck: (arr, key) => (Array.isArray(arr) ? arr.map((x) => (isObjectLike(x) ? x[String(key)] : undefined)) : []),
};

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (typeof a === 'number' && typeof b === 'string') return a === Number(b);
  if (typeof a === 'string' && typeof b === 'number') return Number(a) === b;
  return false;
}

function getProperty(object: unknown, key: unknown): unknown {
  if (object === null || object === undefined) return undefined;
  const k = typeof key === 'number' ? key : String(key);
  if (typeof k === 'string' && FORBIDDEN_PROPS.has(k)) {
    throw new ExpressionError(`Access to '${k}' is not allowed`);
  }
  if (Array.isArray(object)) {
    if (k === 'length') return object.length;
    const idx = typeof k === 'number' ? k : Number(k);
    return Number.isInteger(idx) ? object[idx < 0 ? object.length + idx : idx] : undefined;
  }
  if (typeof object === 'string') {
    if (k === 'length') return object.length;
    return undefined;
  }
  if (isObjectLike(object) && Object.prototype.hasOwnProperty.call(object, k)) {
    return object[k as string];
  }
  return undefined;
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

function compare(op: string, a: unknown, b: unknown): boolean {
  const an = typeof a === 'string' && typeof b === 'string' ? a : Number(a);
  const bn = typeof a === 'string' && typeof b === 'string' ? b : Number(b);
  switch (op) {
    case '<':
      return an < bn;
    case '<=':
      return an <= bn;
    case '>':
      return an > bn;
    default:
      return an >= bn;
  }
}

function evaluateNode(node: ExprNode, scope: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'ident':
      if (FORBIDDEN_PROPS.has(node.name)) throw new ExpressionError(`Access to '${node.name}' is not allowed`);
      return Object.prototype.hasOwnProperty.call(scope, node.name) ? scope[node.name] : undefined;
    case 'member':
      return getProperty(evaluateNode(node.object, scope), evaluateNode(node.property, scope));
    case 'array':
      return node.items.map((n) => evaluateNode(n, scope));
    case 'unary': {
      const v = evaluateNode(node.arg, scope);
      return node.op === '!' ? !truthy(v) : -Number(v);
    }
    case 'ternary':
      return truthy(evaluateNode(node.test, scope))
        ? evaluateNode(node.consequent, scope)
        : evaluateNode(node.alternate, scope);
    case 'call':
      return FUNCTIONS[node.callee]!(...node.args.map((a) => evaluateNode(a, scope)));
    case 'binary': {
      if (node.op === '&&') {
        const l = evaluateNode(node.left, scope);
        return truthy(l) ? evaluateNode(node.right, scope) : l;
      }
      if (node.op === '||') {
        const l = evaluateNode(node.left, scope);
        return truthy(l) ? l : evaluateNode(node.right, scope);
      }
      const l = evaluateNode(node.left, scope);
      const r = evaluateNode(node.right, scope);
      switch (node.op) {
        case '==':
          return looseEquals(l, r);
        case '!=':
          return !looseEquals(l, r);
        case '<':
        case '<=':
        case '>':
        case '>=':
          return compare(node.op, l, r);
        case 'in':
          return Array.isArray(r)
            ? r.some((x) => looseEquals(x, l))
            : typeof r === 'string'
              ? r.includes(String(l))
              : isObjectLike(r)
                ? Object.prototype.hasOwnProperty.call(r, String(l))
                : false;
        case '+':
          return typeof l === 'string' || typeof r === 'string'
            ? `${l ?? ''}${r ?? ''}`
            : Number(l) + Number(r);
        case '-':
          return Number(l) - Number(r);
        case '*':
          return Number(l) * Number(r);
        case '/':
          return Number(r) === 0 ? null : Number(l) / Number(r);
        case '%':
          return Number(r) === 0 ? null : Number(l) % Number(r);
        default:
          throw new ExpressionError(`Unknown operator '${node.op}'`);
      }
    }
  }
}

const parseCache = new Map<string, ExprNode>();
const PARSE_CACHE_LIMIT = 500;

export function parseExpression(src: string): ExprNode {
  const cached = parseCache.get(src);
  if (cached) return cached;
  const ast = new Parser(tokenize(src)).parse();
  if (parseCache.size >= PARSE_CACHE_LIMIT) parseCache.clear();
  parseCache.set(src, ast);
  return ast;
}

export function evaluateExpression(src: string, scope: Record<string, unknown>): unknown {
  return evaluateNode(parseExpression(src), scope);
}

export function evaluateCondition(src: string, scope: Record<string, unknown>): boolean {
  return truthy(evaluateExpression(src, scope));
}

/** Collects dotted identifier paths referenced by an expression, e.g. "steps.tests.output". */
export function collectPaths(src: string): string[] {
  const paths: string[] = [];
  const walk = (node: ExprNode): string | null => {
    switch (node.kind) {
      case 'ident':
        return node.name;
      case 'member': {
        const base = walk(node.object);
        if (base !== null && !node.computed && node.property.kind === 'literal') {
          return `${base}.${String(node.property.value)}`;
        }
        if (base !== null) paths.push(base);
        if (node.computed) {
          const p = walk(node.property);
          if (p) paths.push(p);
        }
        return null;
      }
      case 'unary':
        flush(walk(node.arg));
        return null;
      case 'binary':
        flush(walk(node.left));
        flush(walk(node.right));
        return null;
      case 'ternary':
        flush(walk(node.test));
        flush(walk(node.consequent));
        flush(walk(node.alternate));
        return null;
      case 'call':
        node.args.forEach((a) => flush(walk(a)));
        return null;
      case 'array':
        node.items.forEach((a) => flush(walk(a)));
        return null;
      default:
        return null;
    }
  };
  const flush = (p: string | null) => {
    if (p) paths.push(p);
  };
  flush(walk(parseExpression(src)));
  return paths;
}

export const EXPRESSION_FUNCTIONS = Object.keys(FUNCTIONS);
