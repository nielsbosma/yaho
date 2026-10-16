/** The numbers in a model name, to compare versions: claude-sonnet-4-5 → [4, 5], gpt-5.4-mini → [5, 4]. */
function version(name: string): number[] {
  return (name.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '').match(/\d+/g) ?? []).map(Number);
}

function newest(names: string[]): string | undefined {
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) - (b[i] ?? -1);
    return 0;
  };
  // Of equal versions, the shortest name: the alias rather than a dated snapshot.
  return [...names].sort((a, b) => cmp(version(b), version(a)) || a.length - b.length)[0];
}

/**
 * The model a provider starts with, by the same rule for every provider: the newest Claude Sonnet, else the newest
 * plain GPT (no mini, nano, pro, chat or audio variant), else the first model listed.
 */
export function defaultModel(models: string[]): string {
  const base = (m: string) => m.split('/').at(-1)!;
  const sonnet = models.filter((m) => /claude-sonnet-\d|claude-\d[\d.-]*-sonnet/.test(base(m)));
  const gpt = models.filter((m) => /^gpt-\d+(\.\d+)?(-\d{4}-\d{2}-\d{2})?$/.test(base(m)));
  return newest(sonnet) ?? newest(gpt) ?? models[0] ?? '';
}
