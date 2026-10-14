/**
 * Command Rules (Guard Rails): shell commands an agent runs are checked against patterns before they run. A pattern is
 * a wildcard pattern that must match a whole command (`git push --force*`), or a regular expression between slashes
 * (`/drop\s+table/i`). Matching ignores case.
 *
 * This guards against an agent's mistakes, not against an agent set on getting around it: a shell has too many ways to
 * spell a command. The parser below handles the common ones (quotes, paths, wrappers like sudo and timeout, sh -c,
 * substitutions, subshells, pipes into a shell).
 */
export type CommandAction = 'block' | 'ask' | 'allow';

export interface CommandRule {
  pattern: string;
  action: CommandAction;
  /** Shown to the agent and in the approval request. */
  note?: string;
}

export const DEFAULT_COMMAND_RULES: CommandRule[] = [
  { pattern: '/^rm\\s+(-\\S+\\s+)*(\\/|~|\\$HOME)\\/?\\*?(\\s|$)/', action: 'block', note: 'deletes the whole disk or home folder' },
  { pattern: 'mkfs*', action: 'block', note: 'formats a disk' },
  { pattern: '/^dd\\s.*\\bof=\\/dev\\//', action: 'block', note: 'writes over a device' },
  { pattern: '/:\\(\\)\\s*\\{.*:\\|:.*\\}/', action: 'block', note: 'a fork bomb' },
  {
    pattern: '/^((shutdown|reboot|halt|poweroff)\\b|systemctl\\s+(.*\\s)?(poweroff|reboot|halt|kexec)\\b|(telinit|init)\\s+[06](\\s|$))/',
    action: 'block',
    note: 'stops the machine',
  },
  { pattern: '/^chmod\\s+(-\\S+\\s+)*0?777\\s+\\/(\\s|$)/', action: 'block', note: 'opens up the whole disk' },
  { pattern: '/^rm\\s+(.*\\s)?(-[a-z]*r[a-z]*|--recursive)(\\s|$)/', action: 'ask', note: 'deletes folders' },
  {
    pattern: '/\\b(curl|wget)\\b[^|]*\\|\\s*(sudo\\s+)?((ba|z|da|k|a|mk)?sh|fish|source|eval|\\.)(\\s|$)/',
    action: 'ask',
    note: 'runs a script from the internet',
  },
  { pattern: '/\\b(drop|truncate)\\s+(table|database|schema)\\b/', action: 'ask', note: 'deletes database data' },
  {
    pattern: '/^git\\s+push\\b.*\\s(--force(-with-lease|-if-includes)?(=\\S*)?|-[a-z]*f[a-z]*|\\+\\S+)(\\s|$)/',
    action: 'ask',
    note: 'rewrites a remote branch',
  },
  { pattern: 'git reset --hard*', action: 'ask', note: 'discards uncommitted work' },
];

/** A rule's pattern as a regular expression, or an error message for a bad one. */
export function compileRule(pattern: string): RegExp | string {
  const p = pattern.trim();
  if (!p) return 'empty pattern';
  const re = /^\/(.+)\/([a-z]*)$/s.exec(p);
  try {
    if (re) {
      // g and y make test() remember where it stopped, which would skip matches on the next command.
      const flags = re[2]!.replace(/[gy]/g, '');
      return new RegExp(re[1]!, flags.includes('i') ? flags : `${flags}i`);
    }
    const glob = p
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
      .join('.*');
    return new RegExp(`^${glob}$`, 'is');
  } catch (e) {
    return (e as Error).message;
  }
}

export function validateRules(rules: unknown): CommandRule[] {
  if (rules === undefined || rules === null) return [];
  if (!Array.isArray(rules)) throw new Error('command rules must be a list');
  // A row left empty in the editor is dropped, not an error.
  return rules.flatMap((r, i) => {
    const rule = r as CommandRule;
    if (!rule || typeof rule.pattern !== 'string') throw new Error(`command rule ${i + 1} has no pattern`);
    if (!rule.pattern.trim()) return [];
    if (!['block', 'ask', 'allow'].includes(rule.action)) throw new Error(`command rule ${i + 1}: action must be block, ask or allow`);
    const re = compileRule(rule.pattern);
    if (typeof re === 'string') throw new Error(`command rule ${i + 1} (${rule.pattern}): ${re}`);
    return [{ pattern: rule.pattern, action: rule.action, ...(rule.note ? { note: String(rule.note) } : {}) }];
  });
}

// ---------- reading a shell line ----------

/** A command or process substitution: a line of its own, run for its output. */
interface Sub {
  line: string;
  proc: boolean;
}
interface Word {
  t: 'w';
  /** The word with its quotes and escapes removed. */
  v: string;
  raw: string;
  subs: Sub[];
  quoted: boolean;
  heredoc?: string;
}
type Tok = Word | { t: 'op'; v: string };

const OPS = /&&|\|\||;;&|;;|;&|\|&|&>>|&>|<<<|<<-|<<|<>|<&|>>|>&|>\||[;&|()<>\n]/y;
const REDIRECT = new Set(['<', '>', '>>', '<>', '<&', '>&', '>|', '&>', '&>>', '<<', '<<-', '<<<']);

/** The index of the ) that closes the ( at open, skipping quoted text. */
function closeParen(s: string, open: number): number {
  let depth = 0;
  let q: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (q === "'") {
      if (c === "'") q = null;
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (q === '"') {
      if (c === '"') q = null;
      continue;
    }
    if (c === "'" || c === '"') q = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return s.length;
}

function closeBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return s.length;
}

function closeBacktick(s: string, open: number): number {
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '`') return i;
  }
  return s.length;
}

/** Substitutions anywhere in text that the shell expands ($(…), `…`, also inside ${…}), whatever the quotes. */
function scanSubs(text: string): Sub[] {
  const out: Sub[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '$' && text[i + 1] === '(') {
      const e = closeParen(text, i + 1);
      out.push({ line: text.slice(i + 2, e), proc: false });
      i = e;
    } else if (text[i] === '`') {
      const e = closeBacktick(text, i);
      out.push({ line: text.slice(i + 1, e).replace(/\\`/g, '`'), proc: false });
      i = e;
    }
  }
  return out;
}

const ANSI: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' };

/** The text of a $'…' string; i is at its opening quote. Returns it and the index after the closing quote. */
function ansiC(s: string, i: number): [string, number] {
  let v = '';
  for (i++; i < s.length && s[i] !== "'"; i++) {
    if (s[i] !== '\\') {
      v += s[i];
      continue;
    }
    const c = s[++i] ?? '';
    const hex = (n: number) => {
      const m = new RegExp(`^[0-9a-fA-F]{1,${n}}`).exec(s.slice(i + 1));
      if (!m) return c;
      i += m[0].length;
      return String.fromCodePoint(parseInt(m[0], 16));
    };
    if (ANSI[c]) v += ANSI[c];
    else if (c === 'x') v += hex(2);
    else if (c === 'u') v += hex(4);
    else if (c === 'U') v += hex(8);
    else if (/[0-7]/.test(c)) {
      const m = /^[0-7]{1,3}/.exec(s.slice(i))!;
      v += String.fromCharCode(parseInt(m[0], 8));
      i += m[0].length - 1;
    } else if (c === 'c') v += String.fromCharCode((s[++i] ?? '@').charCodeAt(0) & 31);
    else v += c;
  }
  return [v, i + 1];
}

function readWord(s: string, start: number): Word & { end: number } {
  let i = start;
  let v = '';
  let quoted = false;
  const subs: Sub[] = [];
  while (i < s.length) {
    const c = s[i]!;
    if (/[\s;&|()<>]/.test(c)) break;
    if (c === '\\') {
      if (s[i + 1] !== '\n') v += s[i + 1] ?? '';
      i += 2;
      quoted = true;
    } else if (c === "'") {
      const e = s.indexOf("'", i + 1);
      const end = e < 0 ? s.length : e;
      v += s.slice(i + 1, end);
      i = end + 1;
      quoted = true;
    } else if (c === '$' && s[i + 1] === "'") {
      const [text, next] = ansiC(s, i + 1);
      v += text;
      i = next;
      quoted = true;
    } else if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        const d = s[j]!;
        if (d === '\\' && '$`"\\\n'.includes(s[j + 1] ?? '')) {
          if (s[j + 1] !== '\n') v += s[j + 1];
          j += 2;
        } else if (d === '$' && s[j + 1] === '(') {
          const e = closeParen(s, j + 1);
          subs.push({ line: s.slice(j + 2, e), proc: false });
          v += s.slice(j, e + 1);
          j = e + 1;
        } else if (d === '$' && s[j + 1] === '{') {
          const e = closeBrace(s, j + 1);
          subs.push(...scanSubs(s.slice(j + 2, e)));
          v += s.slice(j, e + 1);
          j = e + 1;
        } else if (d === '`') {
          const e = closeBacktick(s, j);
          subs.push({ line: s.slice(j + 1, e).replace(/\\`/g, '`'), proc: false });
          v += s.slice(j, e + 1);
          j = e + 1;
        } else {
          v += d;
          j++;
        }
      }
      i = j + 1;
      quoted = true;
    } else if (c === '$' && s[i + 1] === '(') {
      const e = closeParen(s, i + 1);
      subs.push({ line: s.slice(i + 2, e), proc: false });
      v += s.slice(i, e + 1);
      i = e + 1;
    } else if (c === '$' && s[i + 1] === '{') {
      const e = closeBrace(s, i + 1);
      subs.push(...scanSubs(s.slice(i + 2, e)));
      v += s.slice(i, e + 1);
      i = e + 1;
    } else if (c === '`') {
      const e = closeBacktick(s, i);
      subs.push({ line: s.slice(i + 1, e).replace(/\\`/g, '`'), proc: false });
      v += s.slice(i, e + 1);
      i = e + 1;
    } else {
      v += c;
      i++;
    }
  }
  return { t: 'w', v, raw: s.slice(start, i), subs, quoted, end: Math.min(i, s.length) };
}

/** Words and operators. A here-document's body is kept on its delimiter word, not read as commands. */
function lex(s: string): Tok[] {
  const out: Tok[] = [];
  const pending: Array<{ word: Word; strip: boolean }> = [];
  let delimiter: { strip: boolean } | null = null;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c !== '\n' && /\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '\\' && s[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '#') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if ((c === '<' || c === '>') && s[i + 1] === '(') {
      const e = closeParen(s, i + 1);
      out.push({ t: 'w', v: s.slice(i, e + 1), raw: s.slice(i, e + 1), subs: [{ line: s.slice(i + 2, e), proc: true }], quoted: false });
      i = e + 1;
      continue;
    }
    OPS.lastIndex = i;
    const op = OPS.exec(s);
    if (op) {
      out.push({ t: 'op', v: op[0] });
      i += op[0].length;
      if (op[0] === '<<' || op[0] === '<<-') delimiter = { strip: op[0] === '<<-' };
      if (op[0] === '\n') {
        // Here-document bodies start on the next line and end at their delimiter.
        for (const p of pending.splice(0)) {
          const body: string[] = [];
          while (i < s.length) {
            const nl = s.indexOf('\n', i);
            const line = s.slice(i, nl < 0 ? s.length : nl);
            i = nl < 0 ? s.length : nl + 1;
            if ((p.strip ? line.replace(/^\t+/, '') : line) === p.word.v) break;
            body.push(line);
          }
          p.word.heredoc = body.join('\n');
        }
      }
      continue;
    }
    const w = readWord(s, i);
    i = w.end;
    // 2>&1, 2>/dev/null: the digits are the redirected file descriptor, not a word.
    if (!w.quoted && /^\d+$/.test(w.v) && /[<>]/.test(s[i] ?? '')) continue;
    const { end: _, ...word } = w;
    out.push(word);
    if (delimiter) {
      pending.push({ word, strip: delimiter.strip });
      delimiter = null;
    }
  }
  return out;
}

interface Simple {
  words: Word[];
  redirects: Array<{ op: string; target: Word }>;
}

/** Tokens as pipelines of simple commands. ( ) { } and the shell's keywords only separate commands. */
function pipelines(toks: Tok[]): Simple[][] {
  const out: Simple[][] = [];
  let pipe: Simple[] = [];
  let cmd: Simple = { words: [], redirects: [] };
  const endCmd = () => {
    if (cmd.words.length || cmd.redirects.length) pipe.push(cmd);
    cmd = { words: [], redirects: [] };
  };
  const endPipe = () => {
    endCmd();
    if (pipe.length) out.push(pipe);
    pipe = [];
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.t === 'op') {
      if (REDIRECT.has(t.v)) {
        const next = toks[i + 1];
        if (next?.t === 'w') {
          cmd.redirects.push({ op: t.v, target: next });
          i++;
        }
      } else if (t.v === '|' || t.v === '|&') endCmd();
      else endPipe();
      continue;
    }
    if (!cmd.words.length && !t.quoted && KEYWORDS.has(t.v)) continue;
    cmd.words.push(t);
  }
  endPipe();
  return out;
}

const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'esac', 'coproc']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'su']);
/** Commands that run what they read (from a pipe, a here-document or a substitution) as shell code. */
const SINKS = new Set([...SHELLS, 'eval', 'source', '.']);

/**
 * Commands that run another command: the options each takes with a value (short letters, long names), and how many
 * plain words come before the command (timeout's duration, chroot's folder).
 */
const WRAPPERS: Record<string, { short?: string; long?: string[]; skip?: number }> = {
  sudo: { short: 'CDghpRrtTUu', long: ['chdir', 'close-from', 'group', 'host', 'prompt', 'chroot', 'role', 'type', 'command-timeout', 'other-user', 'user'] },
  doas: { short: 'Cu' },
  env: { short: 'uCS', long: ['unset', 'chdir', 'split-string'] },
  timeout: { short: 'sk', long: ['signal', 'kill-after'], skip: 1 },
  nice: { short: 'n', long: ['adjustment'] },
  ionice: { short: 'cnp', long: ['class', 'classdata', 'pid'] },
  nohup: {},
  setsid: {},
  time: { short: 'fo', long: ['format', 'output'] },
  command: {},
  builtin: {},
  exec: { short: 'a' },
  stdbuf: { short: 'ioe', long: ['input', 'output', 'error'] },
  xargs: { short: 'adEILnPs', long: ['arg-file', 'delimiter', 'eof', 'max-lines', 'max-args', 'max-procs', 'max-chars', 'process-slot-var'] },
  busybox: {},
  chroot: { long: ['userspec', 'groups'], skip: 1 },
  unbuffer: {},
  watch: { short: 'nd', long: ['interval', 'differences'] },
};

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const base = (w: string) => w.replace(/^.*[/\\]/, '').replace(/\.exe$/i, '');

/** The command a wrapper runs: its words after the wrapper's own options. env -S's string is split into words. */
function unwrap(argv: string[]): string[] | null {
  const spec = WRAPPERS[argv[0]!];
  if (!spec) return null;
  let i = 1;
  const extra: string[] = [];
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      i++;
      break;
    }
    if (a.startsWith('--')) {
      const name = a.slice(2).split('=')[0]!;
      const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : spec.long?.includes(name) ? argv[++i] : undefined;
      if (argv[0] === 'env' && name === 'split-string' && value) extra.push(...value.split(/\s+/).filter(Boolean));
      continue;
    }
    if (!/^-./.test(a) || argv[0] === 'busybox') break;
    // A cluster of short options; one that takes a value takes the rest of the cluster or the next word.
    for (let k = 1; k < a.length; k++) {
      if (!spec.short?.includes(a[k]!)) continue;
      const value = k + 1 < a.length ? a.slice(k + 1) : argv[++i];
      if (argv[0] === 'env' && a[k] === 'S' && value) extra.push(...value.split(/\s+/).filter(Boolean));
      break;
    }
  }
  let rest = [...extra, ...argv.slice(i)];
  if (argv[0] === 'env') while (rest[0] && ASSIGNMENT.test(rest[0])) rest = rest.slice(1);
  return rest.slice(spec.skip ?? 0);
}

/** The command string of sh -c '…' (-c alone or in -lc, -ec, anywhere among the options), or null. */
function shellCommand(argv: string[]): string | null {
  const su = argv[0] === 'su';
  let c = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--command' || a.startsWith('--command=')) return a.includes('=') ? a.slice(10) : (argv[i + 1] ?? null);
    if (a === '--') return c ? (argv[i + 1] ?? null) : null;
    // Options that take the next word: bash's -o and rc files, su's shell and groups.
    if (/^[-+]o$/.test(a) || ['--rcfile', '--init-file'].includes(a) || (su && ['-s', '--shell', '-g', '--group', '-G', '--supp-group'].includes(a))) {
      i++;
      continue;
    }
    if (/^-[^-]/.test(a)) {
      if (a.includes('c')) {
        if (su && a.endsWith('c')) return argv[i + 1] ?? null;
        c = true;
      }
      continue;
    }
    if (/^[-+]/.test(a)) continue;
    if (c) return a;
    // su takes the user before or after its options; a shell's first plain word is a script to run.
    if (!su) return null;
  }
  return null;
}

/** git's own options before the subcommand (-C dir, -c key=value, --git-dir=…) do not change what it does. */
function gitCommand(argv: string[]): string[] | null {
  let i = 1;
  while (i < argv.length && argv[i]!.startsWith('-')) {
    const a = argv[i]!;
    i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix'].includes(a) ? 2 : 1;
  }
  return i > 1 ? ['git', ...argv.slice(i)] : null;
}

/** One command as rules see it: each spelling of it (as written, unwrapped), and the one Allow rules are checked on. */
export interface CommandPart {
  texts: string[];
  /** A single command: what Allow rules are checked against. */
  allow?: string;
  /** A pipe, or what a shell is fed: the commands it combines, each of which an Allow must cover. */
  of?: string[];
}

interface Parsed {
  parts: CommandPart[];
  /** The line's own commands (not nested ones), by pipeline, as Allow rules see them. */
  pipes: string[][];
}

const join = (argv: string[]) => argv.join(' ').replace(/\s+/g, ' ').trim();

function parse(line: string, depth: number): Parsed {
  const parts: CommandPart[] = [];
  const pipes: string[][] = [];
  if (depth > 6) return { parts: [{ texts: [join([line])], of: [] }], pipes: [] };
  const nested = (l: string) => {
    const p = parse(l, depth + 1);
    parts.push(...p.parts);
    return p.pipes.flat();
  };

  for (const pipe of pipelines(lex(line))) {
    const finals: string[] = [];
    for (const cmd of pipe) {
      const subs = [...cmd.words, ...cmd.redirects.map((r) => r.target)].flatMap((w) => w.subs);
      const subFinals = subs.flatMap((s) => nested(s.line));
      let argv = cmd.words.map((w) => w.v);
      while (argv[0] !== undefined && ASSIGNMENT.test(argv[0])) argv = argv.slice(1);
      const texts = [join(cmd.words.map((w) => w.raw))];
      for (let n = 0; n < 20 && argv.length; n++) {
        argv = [base(argv[0]!), ...argv.slice(1)];
        texts.push(join(argv));
        const name = argv[0]!;
        const inner = unwrap(argv);
        if (inner) {
          argv = inner;
          while (argv[0] !== undefined && ASSIGNMENT.test(argv[0])) argv = argv.slice(1);
          continue;
        }
        if (name === 'eval') nested(argv.slice(1).join(' '));
        else if (SHELLS.has(name)) {
          const c = shellCommand(argv);
          if (c !== null) nested(c);
        } else if (name === 'find') {
          // find … -exec cmd {} ; runs cmd.
          for (let i = 1; i < argv.length; i++)
            if (/^-(exec|execdir|ok|okdir)$/.test(argv[i]!)) {
              const end = argv.findIndex((a, k) => k > i && (a === ';' || a === '+'));
              nested(argv.slice(i + 1, end < 0 ? undefined : end).map(quote).join(' '));
            }
        } else if (name === 'git') {
          const g = gitCommand(argv);
          if (g) {
            argv = g;
            texts.push(join(argv));
          }
        }
        break;
      }
      const final = join(argv);
      // What a shell is given to run in a here-document or here-string; the expansions in any other here-document.
      if (SINKS.has(argv[0] ?? ''))
        for (const r of cmd.redirects) {
          const input = r.op === '<<<' ? r.target.v : r.target.heredoc;
          if (input !== undefined) nested(input);
        }
      else
        for (const r of cmd.redirects)
          if (r.target.heredoc !== undefined && !/['"\\]/.test(r.target.raw)) for (const s of scanSubs(r.target.heredoc)) nested(s.line);
      parts.push({ texts: [...new Set(texts.filter(Boolean))], allow: final });
      // A substitution's output run as code: bash <(curl …), sh -c "$(curl …)", eval "$(…)".
      if (SINKS.has(argv[0] ?? '')) for (const f of subFinals) parts.push({ texts: [`${f} | ${final}`], of: [f, final] });
      finals.push(final);
    }
    // A pipe: what runs after each command, e.g. curl … | sh.
    for (let a = 0; a < finals.length; a++)
      for (let b = a + 1; b < finals.length; b++) parts.push({ texts: [`${finals[a]} | ${finals[b]}`], of: [finals[a]!, finals[b]!] });
    if (finals.length > 2) parts.push({ texts: [finals.join(' | ')], of: finals });
    pipes.push(finals);
  }
  return { parts, pipes };
}

const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

/** Every command a shell line runs, as rules see it: the parts of decide(), nested ones included. */
export function commandParts(line: string): CommandPart[] {
  return parse(line, 0).parts;
}

/** The commands a shell line runs, unwrapped and unquoted: each one Allow rules are checked against. */
export function splitCommand(line: string): string[] {
  return commandParts(line).flatMap((p) => (p.allow ? [p.allow] : []));
}

export interface CommandDecision {
  action: CommandAction;
  /** The rule that decided it (none when nothing matched), and the part of the line it matched. */
  rule?: CommandRule;
  part?: string;
}

/**
 * Block wins over everything. Each command of the line is checked on its own, as are pipes between them and the whole
 * line. An Allow covers an Ask only for the command it matches (a pipe or the line only when it covers each command in
 * it); an Allow for the exact line, as "Always allow" adds, covers every Ask in it.
 */
export function decide(line: string, rules: CommandRule[]): CommandDecision {
  const compiled = rules
    .map((r) => ({ r, re: compileRule(r.pattern) }))
    .filter((x): x is { r: CommandRule; re: RegExp } => typeof x.re !== 'string');
  const allows = compiled.filter((c) => c.r.action === 'allow');
  const exact = exactRule(line).pattern;
  const lineAllowed = allows.some((c) => c.r.pattern === exact);
  const parts = commandParts(line);
  const whole: CommandPart = { texts: [line.trim().replace(/\s+/g, ' ')], of: parts.flatMap((p) => (p.allow !== undefined ? [p.allow] : [])) };
  const covered = (p: CommandPart) =>
    p.allow !== undefined ? allows.some((a) => a.re.test(p.allow!)) : !!p.of?.length && p.of.every((t) => allows.some((a) => a.re.test(t)));
  let ask: CommandDecision | null = null;
  for (const part of [whole, ...parts]) {
    for (const c of compiled) {
      if (c.r.action === 'allow') continue;
      const hit = part.texts.find((t) => c.re.test(t));
      if (hit === undefined) continue;
      if (c.r.action === 'block') return { action: 'block', rule: c.r, part: hit };
      if (!lineAllowed && !covered(part)) ask ??= { action: 'ask', rule: c.r, part: hit };
    }
  }
  return ask ?? { action: 'allow' };
}

/** An Allow rule for exactly this command, for "Always allow". */
export const exactRule = (command: string): CommandRule => ({
  pattern: `/^${command
    .trim()
    .replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    .replace(/\s+/g, '\\s+')}$/`,
  action: 'allow',
  note: 'always allowed from the inbox',
});
