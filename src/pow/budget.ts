import {
  POW_MAX_CHALLENGES_PER_DAY,
  POW_MAX_WORKER_MS_PER_CHALLENGE,
  POW_MAX_WORKER_MS_PER_DAY,
} from '../shared/constants';
import type { PowLedger, RedactedErrorCode } from '../shared/domain';

export interface PowAttemptPlan {
  allowed: boolean;
  maxWorkerMs: number;
  reason?: Extract<RedactedErrorCode, 'pow_budget_exhausted'>;
}

export function createPowLedger(
  origin: string,
  scheduleDay: string,
  removedSiteTombstone = false,
): PowLedger {
  return {
    origin,
    scheduleDay,
    challengesUsed: 0,
    workerMsUsed: 0,
    removedSiteTombstone,
  };
}

export function planPowAttempt(ledger: PowLedger): PowAttemptPlan {
  const remainingMs = Math.max(0, POW_MAX_WORKER_MS_PER_DAY - ledger.workerMsUsed);
  if (
    ledger.challengesUsed >= POW_MAX_CHALLENGES_PER_DAY ||
    remainingMs <= 0
  ) {
    return {
      allowed: false,
      maxWorkerMs: 0,
      reason: 'pow_budget_exhausted',
    };
  }
  return {
    allowed: true,
    maxWorkerMs: Math.min(POW_MAX_WORKER_MS_PER_CHALLENGE, remainingMs),
  };
}

export function recordChallengeAcquired(ledger: PowLedger): PowLedger {
  return {
    ...ledger,
    challengesUsed: Math.min(
      POW_MAX_CHALLENGES_PER_DAY,
      ledger.challengesUsed + 1,
    ),
  };
}

export function recordWorkerUsage(
  ledger: PowLedger,
  elapsedMs: number,
): PowLedger {
  const safeElapsed = Number.isFinite(elapsedMs)
    ? Math.min(
        POW_MAX_WORKER_MS_PER_CHALLENGE,
        Math.max(0, Math.ceil(elapsedMs)),
      )
    : POW_MAX_WORKER_MS_PER_CHALLENGE;
  return {
    ...ledger,
    workerMsUsed: Math.min(
      POW_MAX_WORKER_MS_PER_DAY,
      ledger.workerMsUsed + safeElapsed,
    ),
  };
}
