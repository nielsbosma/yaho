// A stand-in for `claude -p --output-format stream-json` used by tests. It ignores the model and runs the shell
// commands listed in steps.json in its working directory (the agent workspace), reporting each as a Bash tool call.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
const session = resume ?? `fake-${process.pid}`;
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const prompt = readFileSync(0, 'utf8');

emit({ type: 'system', subtype: 'init', session_id: session });
emit({
  type: 'assistant',
  message: { content: [{ type: 'text', text: resume ? `resumed ${resume}` : `prompt has ${prompt.length} chars` }] },
});

const file = resume && existsSync('steps-resume.json') ? 'steps-resume.json' : 'steps.json';
const steps = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
let n = 0;
for (const step of steps) {
  const id = `t${++n}`;
  if (step.sleep_ms) {
    await new Promise((r) => setTimeout(r, step.sleep_ms));
    continue;
  }
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: step.cmd } }] } });
  const r = spawnSync(step.cmd, { shell: true, encoding: 'utf8', input: step.stdin ?? '' });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: r.status !== 0 }] } });
}
emit({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'fake done',
  session_id: session,
  total_cost_usd: Number(process.env.FAKE_COST ?? 0.001),
});
