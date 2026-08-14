import {
  POW_MAX_DIFFICULTY,
  POW_MAX_WORKER_MS_PER_CHALLENGE,
  POW_MIN_DIFFICULTY,
} from '../shared/constants';
import type {
  OffscreenRequest,
  PowCancelRequest,
  PowSolveRequest,
  PowWorkerResult,
} from '../shared/messages';
import { isPowWorkerResponse } from './worker-protocol';

interface ActiveWorker {
  taskId: string;
  worker: Worker;
  startedAt: number;
  timeoutId: ReturnType<typeof setTimeout>;
  resolve: (result: PowWorkerResult) => void;
}

export class SinglePowWorkerController {
  private active: ActiveWorker | undefined;

  solve(request: PowSolveRequest): Promise<PowWorkerResult> {
    if (this.active !== undefined || !isValidSolveRequest(request)) {
      return Promise.resolve({ status: 'error', elapsedMs: 0 });
    }

    const startedAt = performance.now();
    return new Promise<PowWorkerResult>((resolve) => {
      const worker = new Worker(new URL('./pow.worker.ts', import.meta.url), {
        type: 'module',
        name: 'checkin-pilot-pow',
      });
      const timeoutId = setTimeout(() => {
        this.finish(request.taskId, {
          status: 'timeout',
          elapsedMs: performance.now() - startedAt,
        });
      }, request.maxMs);

      this.active = {
        taskId: request.taskId,
        worker,
        startedAt,
        timeoutId,
        resolve,
      };
      worker.addEventListener('message', (event: MessageEvent<unknown>) => {
        if (!isPowWorkerResponse(event.data) || event.data.taskId !== request.taskId) {
          return;
        }
        const result: PowWorkerResult = {
          status: event.data.status,
          elapsedMs: Math.max(0, event.data.elapsedMs),
        };
        if (event.data.nonce !== undefined) result.nonce = event.data.nonce;
        this.finish(request.taskId, result);
      });
      worker.addEventListener('error', () => {
        this.finish(request.taskId, {
          status: 'error',
          elapsedMs: performance.now() - startedAt,
        });
      });
      worker.postMessage({
        type: 'solve',
        taskId: request.taskId,
        prefix: request.prefix,
        difficulty: request.difficulty,
        maxMs: request.maxMs,
      });
    });
  }

  cancel(request: PowCancelRequest): PowWorkerResult {
    const active = this.active;
    if (active === undefined || active.taskId !== request.taskId) {
      return { status: 'cancelled', elapsedMs: 0 };
    }
    const result: PowWorkerResult = {
      status: 'cancelled',
      elapsedMs: Math.max(0, performance.now() - active.startedAt),
    };
    this.finish(request.taskId, result);
    return result;
  }

  handle(request: OffscreenRequest): Promise<PowWorkerResult> {
    if (request.type === 'pow:solve') return this.solve(request);
    return Promise.resolve(this.cancel(request));
  }

  private finish(taskId: string, result: PowWorkerResult): void {
    const active = this.active;
    if (active === undefined || active.taskId !== taskId) return;
    this.active = undefined;
    clearTimeout(active.timeoutId);
    active.worker.terminate();
    active.resolve(result);
  }
}

export function isOffscreenRequest(value: unknown): value is OffscreenRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<OffscreenRequest>;
  if (candidate.target !== 'offscreen') return false;
  if (candidate.type === 'pow:cancel') return typeof candidate.taskId === 'string';
  return (
    candidate.type === 'pow:solve' &&
    typeof candidate.taskId === 'string' &&
    typeof candidate.prefix === 'string' &&
    typeof candidate.difficulty === 'number' &&
    typeof candidate.maxMs === 'number'
  );
}

function isValidSolveRequest(request: PowSolveRequest): boolean {
  return (
    request.taskId.length > 0 &&
    request.taskId.length <= 128 &&
    request.prefix.length > 0 &&
    request.prefix.length <= 4_096 &&
    Number.isInteger(request.difficulty) &&
    request.difficulty >= POW_MIN_DIFFICULTY &&
    request.difficulty <= POW_MAX_DIFFICULTY &&
    Number.isFinite(request.maxMs) &&
    request.maxMs > 0 &&
    request.maxMs <= POW_MAX_WORKER_MS_PER_CHALLENGE
  );
}
