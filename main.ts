// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- Section 5: a file as lines, and matching old lines at three tiers ----------

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every position i >= from where O matches lines[i..], at one tier; eofOnly keeps only matches ending at the last line. */
function occurrencesAt(O: string[], lines: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    if (eofOnly && i + O.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; 0 only when strict) at which O occurs at least once. */
function findTier(O: string[], lines: string[], strict: boolean, from: number, eofOnly: boolean): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrencesAt(O, lines, t, from, eofOnly);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One body line of a hunk or chunk: context, old, new, or a `\` (no-newline) marker. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

/** Split body lines into the old lines O and the new lines N. A context line of N remembers its index in O. */
function splitBody(items: BodyItem[]): { O: string[]; N: { text: string; oIdx: number | null }[] } {
  const O: string[] = [];
  const N: { text: string; oIdx: number | null }[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      N.push({ text: it.text, oIdx: O.length });
      O.push(it.text);
    } else if (it.kind === 'old') {
      O.push(it.text);
    } else if (it.kind === 'new') {
      N.push({ text: it.text, oIdx: null });
    }
  }
  return { O, N };
}

/** The lines N writes when it replaces O at position `at`: context lines are the file's own matched lines, and at
    tier 2 every other line is re-indented from O's first line's leading whitespace to the file's. */
function buildN(N: { text: string; oIdx: number | null }[], O: string[], fileLines: string[], at: number, tier: number): string[] {
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  const F = at < fileLines.length ? leadWs(fileLines[at]!) : '';
  return N.map((n) => {
    if (n.oIdx !== null) return fileLines[at + n.oIdx]!;
    if (tier !== 2) return n.text;
    const t = n.text;
    if (t === '' || /^[ \t]*$/.test(t)) return t;
    if (t.startsWith(P)) return F + t.slice(P.length);
    return t;
  });
}

// ---------- Section 6: unified diffs ----------

interface Hunk {
  a: number;
  body: BodyItem[];
}

interface Section {
  oldPath: string | null; // null: /dev/null, no file
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
  pair: boolean; // a `---`/`+++` pair named the paths, so rename lines do not
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A `--- ` or `+++ ` path: text after the four characters, up to the first tab, trimmed; /dev/null is null. */
function headerPath(l: string): string | null {
  const t = l.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

function gitPaths(l: string, idx: number): [string, string] {
  const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
  if (!m) throw new Exit2(`error: parse ${idx + 1}`);
  return [m[1]!, m[2]!];
}

/** Read one hunk starting at lines[idx]; returns it and the index of the first line after its body. */
function readHunk(lines: string[], idx: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[idx]!);
  if (!m) throw new Exit2(`error: parse ${idx + 1}`);
  const body: BodyItem[] = [];
  let j = idx + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '' });
      j++;
    } else if (l[0] === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1) });
      j++;
    } else if (l[0] === '-') {
      body.push({ kind: 'old', text: l.slice(1) });
      j++;
    } else if (l[0] === '+') {
      body.push({ kind: 'new', text: l.slice(1) });
      j++;
    } else if (l[0] === '\\') {
      body.push({ kind: 'bs', text: l.slice(1) });
      j++;
    } else break;
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') body.pop();
    else break;
  }
  return { hunk: { a: Number(m[1]), body }, next: j };
}

/** Whether a `\` line follows the hunk's last context or `+` line: then a result running to the end of the file
    ends without a line break. */
function backslashAfterLast(h: Hunk): boolean {
  for (let j = h.body.length - 1; j >= 0; j--) {
    const it = h.body[j]!;
    if (it.kind === 'ctx' || it.kind === 'new') {
      return j + 1 < h.body.length && h.body[j + 1]!.kind === 'bs';
    }
  }
  return false;
}

/** Parse the patch into sections. Lines outside bodies and section headers are ignored (prose, code fences). */
function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let state: 'outside' | 'header' | 'afterBody' = 'outside';
  let i = 0;
  const start = (oldP: string | null, newP: string | null, pair: boolean): void => {
    cur = { oldPath: oldP, newPath: newP, create: false, remove: false, hunks: [], pair };
    sections.push(cur);
    state = 'header';
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (state === 'outside') {
      if (l.startsWith('diff --git ')) {
        const p = gitPaths(l, i);
        start(p[0], p[1], false);
        i++;
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        start(headerPath(l), headerPath(lines[i + 1]!), true);
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const p = gitPaths(l, i);
      start(p[0], p[1], false);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const r = readHunk(lines, i);
      cur!.hunks.push(r.hunk);
      i = r.next;
      state = 'afterBody';
      continue;
    }
    if (state === 'header') {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur!.oldPath = headerPath(l);
          cur!.newPath = headerPath(lines[i + 1]!);
          cur!.pair = true;
          i += 2;
        } else {
          throw new Exit2(`error: parse ${i + 2}`);
        }
        continue;
      }
      if (l.startsWith('+++ ')) {
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        if (!cur!.pair) cur!.oldPath = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!cur!.pair) cur!.newPath = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur!.create = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur!.remove = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      start(headerPath(l), headerPath(lines[i + 1]!), true);
      i += 2;
      continue;
    }
    i++;
  }
  return sections;
}

/** Apply a section's hunks, in order, to a file's lines. */
function applyHunks(state: FileState, hunks: Hunk[], path: string, strict: boolean): void {
  let d = 0;
  for (const h of hunks) {
    const { O, N } = splitBody(h.body);
    if (O.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), state.lines.length);
      const atEnd = pos === state.lines.length;
      const ins = N.map((x) => x.text);
      state.lines.splice(pos, 0, ...ins);
      if (atEnd) state.finalBreak = !backslashAfterLast(h);
      d += N.length;
    } else {
      const found = findTier(O, state.lines, strict, 0, false);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.at[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.at) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const rep = buildN(N, O, state.lines, best, found.tier);
      const toEnd = best + O.length === state.lines.length;
      state.lines.splice(best, O.length, ...rep);
      if (toEnd) state.finalBreak = !backslashAfterLast(h);
      d += N.length - O.length;
    }
  }
}

/** One section is one edit. */
function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = oldP === null || sec.create;
    if (isCreate) {
      if (newP === null) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const added: string[] = [];
      for (const h of sec.hunks) {
        for (const it of h.body) if (it.kind === 'new') added.push(it.text);
      }
      let finalBreak = true;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        for (let j = h.body.length - 1; j >= 0; j--) {
          if (h.body[j]!.kind === 'new') {
            finalBreak = !(j + 1 < h.body.length && h.body[j + 1]!.kind === 'bs');
            break outer;
          }
        }
      }
      tree.now.set(newP, serializeFile({ lines: added, br: '\n', finalBreak }));
      return;
    }
    const isDelete = newP === null || sec.remove;
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (newP !== p && !safe(newP!)) throw new Fail('unsafe', newP!);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (newP !== p && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const state = parseFile(cur);
    applyHunks(state, sec.hunks, p, strict);
    const out = serializeFile(state);
    if (newP !== p) {
      tree.now.set(newP!, out);
      tree.now.set(p, null);
      tree.moves.push({ old: p, new: newP! });
    } else {
      tree.now.set(p, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => unifiedEdit(s, strict));
}

// ---------- Section 7: SEARCH/REPLACE blocks ----------

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, serializeFile({ lines: [...newLines], br: '\n', finalBreak: true }));
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = parseFile(cur);
    const found = findTier(oldLines, f.lines, strict, 0, false);
    if (!found) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const at = found.at[0]!;
    const rep = buildN(
      newLines.map((t) => ({ text: t, oIdx: null })),
      oldLines,
      f.lines,
      at,
      found.tier,
    );
    f.lines.splice(at, oldLines.length, ...rep);
    tree.now.set(path, serializeFile(f));
  };
}

/** Parse the patch into one edit per SEARCH/REPLACE block, in order. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevRep = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let s = -1;
    for (; i < lines.length; i++) {
      if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
        s = i;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevRep; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(makeSearchReplaceEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevRep = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------- Section 8: V4A patches ----------

interface VChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}

function makeAddFile(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, serializeFile({ lines: [...fileLines], br: '\n', finalBreak: true }));
  };
}

function makeDeleteFile(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function makeUpdateFile(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let k = cursor; k < f.lines.length; k++) {
            if (lineEq(ch.anchor, f.lines[k]!, t)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const { O, N } = splitBody(ch.items);
      if (O.length === 0) {
        const pos = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        const ins = N.map((x) => x.text);
        f.lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
      } else {
        const found = findTier(O, f.lines, strict, cursor, ch.eof);
        if (!found) throw new Fail('no-match', path);
        const at = found.at[0]!;
        const rep = buildN(N, O, f.lines, at, found.tier);
        f.lines.splice(at, O.length, ...rep);
        cursor = at + rep.length;
      }
    }
    const out = serializeFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

/** The index of the next section start at or after `from`, or `last` when there is none. */
function v4aSectionEnd(lines: string[], from: number, last: number): number {
  for (let j = from; j < last; j++) {
    const l = lines[j]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) return j;
  }
  return last;
}

/** Parse one Update File section's lines (trailing blank lines already removed) into its move target and chunks. */
function parseUpdateSection(body: string[], absStart: number): { moveTo: string | null; chunks: VChunk[] } {
  let moveTo: string | null = null;
  let idx = 0;
  if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
    moveTo = body[0]!.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  const finish = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  while (idx < body.length) {
    const l = body[idx]!;
    const abs = absStart + idx;
    if (l.startsWith('@@')) {
      finish();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
      idx++;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${abs + 1}`);
      cur.eof = true;
      finish();
      idx++;
      continue;
    }
    if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${abs + 1}`);
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${abs + 1}`);
        cur = { anchor: null, items: [], eof: false };
      }
      if (l === '') cur.items.push({ kind: 'ctx', text: '' });
      else if (l[0] === ' ') cur.items.push({ kind: 'ctx', text: l.slice(1) });
      else if (l[0] === '-') cur.items.push({ kind: 'old', text: l.slice(1) });
      else cur.items.push({ kind: 'new', text: l.slice(1) });
      idx++;
      continue;
    }
    throw new Exit2(`error: parse ${abs + 1}`);
  }
  finish();
  return { moveTo, chunks };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      const end = v4aSectionEnd(lines, i + 1, last);
      const body = lines.slice(i + 1, end);
      while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
      const fileLines: string[] = [];
      for (let k = 0; k < body.length; k++) {
        const bl = body[k]!;
        if (bl.startsWith('+')) fileLines.push(bl.slice(1));
        else if (bl === '') fileLines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(makeAddFile(p, fileLines));
      i = end;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      const end = v4aSectionEnd(lines, i + 1, last);
      const body = lines.slice(i + 1, end);
      while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
      for (let k = 0; k < body.length; k++) {
        if (!blank(body[k]!)) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(makeDeleteFile(p));
      i = end;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const p = l.slice('*** Update File: '.length).trim();
      const end = v4aSectionEnd(lines, i + 1, last);
      const body = lines.slice(i + 1, end);
      while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
      const upd = parseUpdateSection(body, i + 1);
      if (upd.chunks.length === 0 && upd.moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(makeUpdateFile(p, upd.moveTo, upd.chunks, strict));
      i = end;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const moved = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      moved.add(m.old);
      moved.add(m.new);
    }
  }
  for (const p of changed) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
