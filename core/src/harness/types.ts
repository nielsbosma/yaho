/** What a harness adapter is given to run one job. */
export interface HarnessRun {
  command: string;
  args?: string[];
  cwd: string;
  env: Record<string, string>;
  model: string;
  systemPrompt: string;
  prompt: string;
  /** Native session id to resume, when the harness supports it. */
  resumeSessionId?: string | null;
}

/** Normalised events every adapter emits. */
export type HarnessEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; name: string; input: unknown; id?: string }
  | { kind: 'tool_result'; id?: string; output: string; is_error?: boolean }
  | { kind: 'cost'; total_usd: number }
  | { kind: 'result'; ok: boolean; summary?: string; cost_usd?: number; error?: string }
  | { kind: 'stderr'; text: string };

export interface HarnessProcess {
  pid: number | undefined;
  /** Resolves with the exit code once the process and its output are done. */
  done: Promise<number | null>;
  kill(): void;
}

export interface HarnessAdapter {
  name: string;
  start(run: HarnessRun, onEvent: (e: HarnessEvent) => void): HarnessProcess;
}
