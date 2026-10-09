import { EventEmitter } from 'node:events';
import type { Settings } from './config.ts';
import { paths } from './config.ts';
import type { DB } from './db/index.ts';

/** Everything the core's modules share. One per running core. */
export interface Ctx {
  db: DB;
  settings: Settings;
  paths: ReturnType<typeof paths>;
  apiToken: string;
  bus: Bus;
  /** Set by the server once it listens. */
  apiUrl: string;
  scheduler?: { upcoming(agent: string): Array<{ type: string; at: string; cron?: string }>; tick(at?: Date): void };
  /** Set by the job runner; lets the scheduler and API start and stop jobs without import cycles. */
  runner?: {
    enqueue(agent: string, trigger: string, opts?: { detail?: string; hop?: number; sessionId?: string | null; force?: boolean }): unknown;
    pump(): void;
    stop(jobId: string, status: string, reason?: string, extra?: { summary?: string; resumeAt?: string }): void;
    continueJob(jobId: string): void;
    sleep(jobId: string, ms: number): string;
  };
}

/** Events pushed to the UI over SSE. */
export type BusEvent =
  | { type: 'job'; job: unknown }
  | { type: 'job_event'; job: string; event: unknown }
  | { type: 'message'; message: unknown }
  | { type: 'changed'; entity: string; name?: string }
  | { type: 'notify'; title: string; body: string; message?: string };

export class Bus extends EventEmitter {
  emitEvent(e: BusEvent): void {
    this.emit('event', e);
  }
}
