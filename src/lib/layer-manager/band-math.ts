/**
 * Band math: a small expression language over band samples (`b1`, `b2`, …),
 * evaluated per tile on whole planes. Used to display indices such as NDVI
 * as a single-band layer.
 *
 * Grammar: numbers, band references `bN`, `+ - * / ^`, unary minus,
 * parentheses and the functions abs, sqrt, log, log10, exp, min, max.
 * No `eval`: expressions are parsed into a tree and interpreted.
 * @module layer-manager/band-math
 */

import type { StretchSettings } from './types';
import { TILE_SIZE, fetchRawTile, type RawTileSource } from './raw-tiles';

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'band'; band: number }
  | { kind: 'neg'; arg: Node }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/' | '^'; left: Node; right: Node }
  | { kind: 'call'; fn: FunctionName; args: Node[] };

const FUNCTIONS = {
  abs: 1,
  sqrt: 1,
  log: 1,
  log10: 1,
  exp: 1,
  min: 2,
  max: 2,
} as const;
type FunctionName = keyof typeof FUNCTIONS;

type Token =
  | { type: 'num'; value: number; pos: number }
  | { type: 'id'; value: string; pos: number }
  | { type: 'op'; value: string; pos: number };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*)|(\S))/y;
  let match: RegExpExecArray | null;
  while (re.lastIndex < text.length && (match = re.exec(text))) {
    const pos = match.index + match[0].length - (match[1] ?? match[2] ?? match[3] ?? '').length;
    if (match[1] != null) tokens.push({ type: 'num', value: parseFloat(match[1]), pos });
    else if (match[2] != null) tokens.push({ type: 'id', value: match[2].toLowerCase(), pos });
    else if (match[3] != null) {
      if (!'+-*/^(),'.includes(match[3])) {
        throw new Error(`Unexpected "${match[3]}" at ${pos + 1}`);
      }
      tokens.push({ type: 'op', value: match[3], pos });
    }
  }
  return tokens;
}

/**
 * Recursive-descent parser:
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/') unary)*
 *   unary   := ('-' | '+') unary | power
 *   power   := primary ('^' unary)?     (right-associative; -b1^2 = -(b1^2))
 *   primary := number | bN | fn '(' expr (',' expr)* ')' | '(' expr ')'
 */
class Parser {
  private i = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly bandCount: number
  ) {}

  parse(): Node {
    if (!this.tokens.length) throw new Error('Expression is empty');
    const node = this.expr();
    const rest = this.tokens[this.i];
    if (rest) throw new Error(`Unexpected "${rest.value}" at ${rest.pos + 1}`);
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private isOp(value: string): boolean {
    const t = this.peek();
    return t?.type === 'op' && t.value === value;
  }

  private expect(value: string): void {
    if (!this.isOp(value)) {
      const t = this.peek();
      throw new Error(t ? `Expected "${value}" at ${t.pos + 1}` : `Expected "${value}" at end`);
    }
    this.i++;
  }

  private expr(): Node {
    let node = this.term();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.tokens[this.i++].value as '+' | '-';
      node = { kind: 'bin', op, left: node, right: this.term() };
    }
    return node;
  }

  private term(): Node {
    let node = this.unary();
    while (this.isOp('*') || this.isOp('/')) {
      const op = this.tokens[this.i++].value as '*' | '/';
      node = { kind: 'bin', op, left: node, right: this.unary() };
    }
    return node;
  }

  private unary(): Node {
    if (this.isOp('-')) {
      this.i++;
      return { kind: 'neg', arg: this.unary() };
    }
    if (this.isOp('+')) {
      this.i++;
      return this.unary();
    }
    return this.power();
  }

  private power(): Node {
    const base = this.primary();
    if (this.isOp('^')) {
      this.i++;
      return { kind: 'bin', op: '^', left: base, right: this.unary() };
    }
    return base;
  }

  private primary(): Node {
    const t = this.peek();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.type === 'num') {
      this.i++;
      return { kind: 'num', value: t.value };
    }
    if (this.isOp('(')) {
      this.i++;
      const node = this.expr();
      this.expect(')');
      return node;
    }
    if (t.type === 'id') {
      this.i++;
      const band = /^b(\d+)$/.exec(t.value);
      if (band) {
        const n = parseInt(band[1], 10);
        if (n < 1 || n > this.bandCount) {
          throw new Error(`Band ${n} does not exist (1–${this.bandCount})`);
        }
        return { kind: 'band', band: n };
      }
      if (t.value in FUNCTIONS) {
        const fn = t.value as FunctionName;
        this.expect('(');
        const args = [this.expr()];
        while (this.isOp(',')) {
          this.i++;
          args.push(this.expr());
        }
        this.expect(')');
        if (args.length !== FUNCTIONS[fn]) {
          throw new Error(`${fn}() takes ${FUNCTIONS[fn]} argument(s)`);
        }
        return { kind: 'call', fn, args };
      }
      throw new Error(`Unknown name "${t.value}" (use b1, b2, … or a function)`);
    }
    throw new Error(`Unexpected "${t.value}" at ${t.pos + 1}`);
  }
}

function parse(text: string, bandCount: number): Node {
  return new Parser(tokenize(text), bandCount).parse();
}

function collectBands(node: Node, out: Set<number>): Set<number> {
  switch (node.kind) {
    case 'band':
      out.add(node.band);
      break;
    case 'neg':
      collectBands(node.arg, out);
      break;
    case 'bin':
      collectBands(node.left, out);
      collectBands(node.right, out);
      break;
    case 'call':
      node.args.forEach(a => collectBands(a, out));
      break;
    default:
      break;
  }
  return out;
}

type Value = number | Float32Array;

function unaryOp(a: Value, f: (x: number) => number): Value {
  if (typeof a === 'number') return f(a);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = f(a[i]);
  return out;
}

function binaryOp(a: Value, b: Value, f: (x: number, y: number) => number, n: number): Value {
  if (typeof a === 'number' && typeof b === 'number') return f(a, b);
  const out = new Float32Array(n);
  if (typeof a === 'number') {
    const bb = b as Float32Array;
    for (let i = 0; i < n; i++) out[i] = f(a, bb[i]);
  } else if (typeof b === 'number') {
    for (let i = 0; i < n; i++) out[i] = f(a[i], b);
  } else {
    for (let i = 0; i < n; i++) out[i] = f(a[i], b[i]);
  }
  return out;
}

const BINARY: Record<'+' | '-' | '*' | '/' | '^', (x: number, y: number) => number> = {
  '+': (x, y) => x + y,
  '-': (x, y) => x - y,
  '*': (x, y) => x * y,
  '/': (x, y) => x / y,
  '^': (x, y) => Math.pow(x, y),
};

const CALLS: Record<FunctionName, (...xs: number[]) => number> = {
  abs: Math.abs,
  sqrt: Math.sqrt,
  log: Math.log,
  log10: Math.log10,
  exp: Math.exp,
  min: Math.min,
  max: Math.max,
};

function evaluateNode(node: Node, planes: Map<number, Float32Array>, n: number): Value {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'band': {
      const plane = planes.get(node.band);
      if (!plane) throw new Error(`Band ${node.band} not loaded`);
      return plane;
    }
    case 'neg':
      return unaryOp(evaluateNode(node.arg, planes, n), x => -x);
    case 'bin':
      return binaryOp(
        evaluateNode(node.left, planes, n),
        evaluateNode(node.right, planes, n),
        BINARY[node.op],
        n
      );
    case 'call': {
      const fn = CALLS[node.fn];
      const args = node.args.map(a => evaluateNode(a, planes, n));
      return args.length === 1
        ? unaryOp(args[0], x => fn(x))
        : binaryOp(args[0], args[1], (x, y) => fn(x, y), n);
    }
  }
}

/** A parsed expression, ready to evaluate on tile planes */
export interface CompiledBandMath {
  expression: string;
  /** Bands the expression reads, ascending */
  bands: number[];
  /**
   * Evaluate on planes of `n` samples, keyed by band number. Non-finite
   * results (division by zero, log of negatives, nodata) become NaN, which
   * renders transparent.
   */
  evaluate: (planes: Map<number, Float32Array>, n: number) => Float32Array;
}

/** Parse and check an expression against the band count; throws on errors */
export function compileBandMath(expression: string, bandCount: number): CompiledBandMath {
  const tree = parse(expression, bandCount);
  const bands = [...collectBands(tree, new Set())].sort((a, b) => a - b);
  if (!bands.length) throw new Error('Expression uses no band');
  return {
    expression,
    bands,
    evaluate(planes, n) {
      const value = evaluateNode(tree, planes, n);
      const out = typeof value === 'number' ? new Float32Array(n).fill(value) : value;
      // A bare band ("b1") evaluates to its plane; never modify cached planes
      const result = [...planes.values()].includes(out) ? out.slice() : out;
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(result[i])) result[i] = NaN;
      }
      return result;
    },
  };
}

const compiledCache = new Map<string, CompiledBandMath>();

/** `compileBandMath` memoised per expression and band count */
export function compileBandMathCached(expression: string, bandCount: number): CompiledBandMath {
  const key = `${bandCount}|${expression}`;
  let compiled = compiledCache.get(key);
  if (!compiled) {
    compiled = compileBandMath(expression, bandCount);
    if (compiledCache.size > 64) compiledCache.clear();
    compiledCache.set(key, compiled);
  }
  return compiled;
}

/** Expression templates offered in the UI (A and B are band numbers) */
export const BAND_MATH_TEMPLATES = {
  nd: {
    label: 'Normalized difference (A−B)/(A+B)',
    build: (a: number, b: number) => `(b${a} - b${b}) / (b${a} + b${b})`,
  },
  ratio: { label: 'Ratio A/B', build: (a: number, b: number) => `b${a} / b${b}` },
  diff: { label: 'Difference A−B', build: (a: number, b: number) => `b${a} - b${b}` },
} as const;
export type BandMathTemplate = keyof typeof BAND_MATH_TEMPLATES;

/** 2–98 % stretch of the finite values (sampled to ≤ 1M), plus their full range */
export interface BandMathStretch extends StretchSettings {
  range: [number, number];
}

/** 2nd and 98th percentiles of the finite values (sampled to ≤ 1M) */
export function percentileStretch(values: Float32Array[]): BandMathStretch | null {
  const total = values.reduce((n, v) => n + v.length, 0);
  const stride = Math.max(1, Math.ceil(total / 1_000_000));
  const kept: number[] = [];
  let k = 0;
  for (const plane of values) {
    for (let i = 0; i < plane.length; i++, k++) {
      if (k % stride === 0 && Number.isFinite(plane[i])) kept.push(plane[i]);
    }
  }
  if (!kept.length) return null;
  kept.sort((a, b) => a - b);
  const at = (q: number) => kept[Math.round((kept.length - 1) * q)];
  let min = at(0.02);
  let max = at(0.98);
  if (max <= min) {
    min = kept[0];
    max = kept[kept.length - 1];
    if (max <= min) max = min + 1;
  }
  return { min, max, gamma: 1, range: [kept[0], kept[kept.length - 1]] };
}

const MAX_MERCATOR_LAT = 85.0511;

/** Web Mercator tile column and row of a lon/lat at zoom `z` */
function tileXY(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const clampedLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const rad = (clampedLat * Math.PI) / 180;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return [Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))];
}

/**
 * Tiles covering `bounds` at the deepest zoom that needs at most `maxTiles`
 * of them: a low-resolution overview of the whole layer.
 */
export function overviewTiles(
  bounds: [number, number, number, number],
  maxTiles = 9
): Array<{ z: number; x: number; y: number }> {
  const [west, south, east, north] = bounds;
  const cover = (z: number) => {
    const [x0, y0] = tileXY(west, north, z);
    const [x1, y1] = tileXY(east, south, z);
    const tiles: Array<{ z: number; x: number; y: number }> = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ z, x, y });
    return tiles;
  };
  let best = cover(0);
  for (let z = 1; z <= 22; z++) {
    const tiles = cover(z);
    if (tiles.length > maxTiles) break;
    best = tiles;
  }
  return best;
}

/**
 * Evaluate an expression on a low-resolution overview of the layer and
 * return its 2–98 % stretch (null when no valid value).
 */
export async function sampleBandMathStretch(
  source: Omit<RawTileSource, 'bands'>,
  bounds: [number, number, number, number],
  compiled: CompiledBandMath
): Promise<BandMathStretch | null> {
  const signal = new AbortController().signal;
  const tiles = overviewTiles(bounds);
  const results = await Promise.all(
    tiles.map(coord => fetchRawTile({ ...source, bands: compiled.bands }, coord, signal))
  );
  const values: Float32Array[] = [];
  for (const planes of results) {
    if (planes.some(p => !p)) continue;
    const byBand = new Map(compiled.bands.map((b, i) => [b, planes[i] as Float32Array]));
    values.push(compiled.evaluate(byBand, TILE_SIZE * TILE_SIZE));
  }
  return percentileStretch(values);
}
