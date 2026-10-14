/**
 * Command Rules (Guard Rails): shell commands an agent runs are checked against patterns before they run. A pattern is
 * a wildcard pattern that must match a whole command (`git push --force*`), or a regular expression between slashes
 * (`/drop\s+table/i`). Matching ignores case.
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
  { pattern: '/^(shutdown|reboot|halt|poweroff)\\b/', action: 'block', note: 'stops the machine' },
  { pattern: '/^chmod\\s+(-\\S+\\s+)*0?777\\s+\\/(\\s|$)/', action: 'block', note: 'opens up the whole disk' },
  { pattern: '/^rm\\s+(.*\\s)?(-[a-z]*r[a-z]*|--recursive)(\\s|$)/', action: 'ask', note: 'deletes folders' },
  { pattern: '/\\b(curl|wget)\\b[^|]*\\|\\s*(sudo\\s+)?(ba|z|da|k)?sh\\b/', action: 'ask', note: 'runs a script from the internet' },
  { pattern: '/\\b(drop|truncate)\\s+(table|database|schema)\\b/', action: 'ask', note: 'deletes database data' },
  { pattern: '/^git\\s+push\\b.*\\s(--force(-with-lease)?|-f)(\\s|=|$)/', action: 'ask', note: 'rewrites a remote branch' },
  { pattern: 'git reset --hard*', action: 'ask', note: 'discards uncommitted work' },
];

/** A rule's pattern as a regular expression, or an error message for a bad one. */
export function compileRule(pattern: string): RegExp | string {
  const p = pattern.trim();
  if (!p) return 'empty pattern';
  const re = /^\/(.+)\/([a-z]*)$/s.exec(p);
  try {
    if (re) return new RegExp(re[1]!, re[2]!.includes('i') ? re[2] : `${re[2]}i`);
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

/**
 * The commands a shell line runs: split on ; & | && || and newlines outside quotes, with the insides of $(…), `…` and
 * sh -c '…' added as commands of their own. Leading sudo, env and VAR=value are dropped so rules see the command itself.
 */
export function splitCommand(line: string, depth = 0): string[] {
  const out: string[] = [];
  const nested: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  const push = () => {
    const c = strip(cur);
    if (c) out.push(c);
    cur = '';
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"') {
        cur += ch + (line[++i] ?? '');
        continue;
      }
      if (ch === quote) quote = null;
      else if (quote === '"' && ch === '$' && line[i + 1] === '(') {
        const end = closing(line, i + 1);
        nested.push(line.slice(i + 2, end));
        cur += line.slice(i, end + 1);
        i = end;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '\\') {
      cur += ch + (line[++i] ?? '');
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '$' && line[i + 1] === '(') {
      const end = closing(line, i + 1);
      nested.push(line.slice(i + 2, end));
      cur += line.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = line.indexOf('`', i + 1);
      const stop = end < 0 ? line.length : end;
      nested.push(line.slice(i + 1, stop));
      cur += line.slice(i, stop + 1);
      i = stop;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      push();
      continue;
    }
    cur += ch;
  }
  push();
  for (const c of out) {
    const inner = /^(?:ba|z|da|k)?sh\s+(?:-\S+\s+)*-c\s+(['"])([\s\S]*)\1/.exec(c) ?? /^eval\s+(['"])([\s\S]*)\1/.exec(c);
    if (inner) nested.push(inner[2]!);
  }
  if (depth < 4) for (const n of nested) out.push(...splitCommand(n, depth + 1));
  return out;
}

function closing(s: string, open: number): number {
  let n = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') n++;
    else if (s[i] === ')' && --n === 0) return i;
  }
  return s.length;
}

function strip(c: string): string {
  let s = c.trim().replace(/\s+/g, ' ');
  for (;;) {
    const next = s
      .replace(/^(sudo|doas|command|nohup|time|exec)(\s+-\S+)*\s+/, '')
      .replace(/^env(\s+-\S+)*(\s+[A-Za-z_][A-Za-z0-9_]*=\S*)*\s+/, '')
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+/, '');
    if (next === s) return s;
    s = next;
  }
}

export interface CommandDecision {
  action: CommandAction;
  /** The rule that decided it (none when nothing matched), and the part of the line it matched. */
  rule?: CommandRule;
  part?: string;
}

/**
 * Block wins over everything; Allow wins over Ask for the same part. Each part of the line is checked, and the whole
 * line too (a pipe into sh is only visible there).
 */
export function decide(line: string, rules: CommandRule[]): CommandDecision {
  const compiled = rules
    .map((r) => ({ r, re: compileRule(r.pattern) }))
    .filter((x): x is { r: CommandRule; re: RegExp } => typeof x.re !== 'string');
  const whole = line.trim().replace(/\s+/g, ' ');
  const parts = [...new Set([whole, ...splitCommand(line)])];
  // An Allow for the whole line (as "Always allow" adds) covers every part of it.
  const lineAllowed = compiled.some((c) => c.r.action === 'allow' && c.re.test(whole));
  let ask: CommandDecision | null = null;
  for (const part of parts) {
    const hits = compiled.filter((c) => c.re.test(part));
    const block = hits.find((h) => h.r.action === 'block');
    if (block) return { action: 'block', rule: block.r, part };
    const asked = hits.find((h) => h.r.action === 'ask');
    if (asked && !lineAllowed && !hits.some((h) => h.r.action === 'allow')) ask ??= { action: 'ask', rule: asked.r, part };
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
