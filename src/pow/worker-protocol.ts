import type { PowWorkerResult } from '../shared/messages';

export interface PowWorkerSolveMessage {
  type: 'solve';
  taskId: string;
  prefix: string;
  difficulty: number;
  maxMs: number;
}

export interface PowWorkerResponse extends PowWorkerResult {
  taskId: string;
}

export function isPowWorkerResponse(value: unknown): value is PowWorkerResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PowWorkerResponse>;
  return (
    typeof candidate.taskId === 'string' &&
    (candidate.status === 'solved' ||
      candidate.status === 'timeout' ||
      candidate.status === 'cancelled' ||
      candidate.status === 'error') &&
    typeof candidate.elapsedMs === 'number' &&
    Number.isFinite(candidate.elapsedMs) &&
    (candidate.nonce === undefined ||
      (typeof candidate.nonce === 'string' && /^[0-9a-f]{8}$/.test(candidate.nonce)))
  );
}

