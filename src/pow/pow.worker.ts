/// <reference lib="webworker" />

import { findNonce } from './solver';
import type { PowWorkerResponse, PowWorkerSolveMessage } from './worker-protocol';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!isSolveMessage(event.data)) return;
  const message = event.data;
  const result = findNonce({
    prefix: message.prefix,
    difficulty: message.difficulty,
    maxMs: message.maxMs,
  });
  const response: PowWorkerResponse = {
    taskId: message.taskId,
    status:
      result.status === 'solved'
        ? 'solved'
        : result.status === 'timeout'
          ? 'timeout'
          : 'error',
    elapsedMs: result.elapsedMs,
  };
  if (result.nonce !== undefined) response.nonce = result.nonce;
  workerScope.postMessage(response);
});

function isSolveMessage(value: unknown): value is PowWorkerSolveMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Partial<PowWorkerSolveMessage>;
  return (
    message.type === 'solve' &&
    typeof message.taskId === 'string' &&
    typeof message.prefix === 'string' &&
    typeof message.difficulty === 'number' &&
    typeof message.maxMs === 'number'
  );
}

