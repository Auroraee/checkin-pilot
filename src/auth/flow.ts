import {
  POW_MAX_WORKER_MS_PER_CHALLENGE,
  POW_MIN_DIFFICULTY,
  POW_MAX_DIFFICULTY,
} from '../shared/constants';
import type { NormalizedOutcome } from '../shared/domain';
import {
  actionRequiredOutcome,
  cancelledOutcome,
  failedOutcome,
} from '../adapters/http';
import type {
  CheckinFlowOps,
  CheckinFlowPlan,
  PowAttemptBudget,
} from './types';

/**
 * Protocol-independent check-in flow shared by all auth transports on the
 * service-worker side (legacy-session). The same-origin-refresh transport
 * runs an equivalent self-contained flow inside the page context; see
 * `modern-checkin-flow.ts` and the mock-e2e suite which exercises both.
 */
export async function runCheckinFlowWithOps(
  ops: CheckinFlowOps,
  plan: CheckinFlowPlan,
): Promise<NormalizedOutcome> {
  const current = await ops.checkinStatus(plan.month);
  if (!current.ok) return current.outcome;
  if (current.value.checkedInToday) {
    return { code: 'already_checked', retryable: false };
  }

  if (!plan.powEnabled) {
    if (plan.turnstileCheck) return actionRequiredOutcome('turnstile');
    return ops.submitCheckin({});
  }

  switch (plan.powMode) {
    case 'supplement':
      return actionRequiredOutcome('turnstile');
    case 'fallback':
      if (plan.turnstileCheck) return actionRequiredOutcome('turnstile');
      break;
    case 'replace':
      break;
    default:
      return actionRequiredOutcome('unknown_challenge');
  }

  if (plan.maxPowAttempts <= 0) {
    return actionRequiredOutcome('unknown_challenge', 'unsupported_protocol');
  }

  for (let attempt = 0; attempt < plan.maxPowAttempts; attempt += 1) {
    const budget = await resolveAttemptBudget(ops, attempt);
    if (!budget.allowed || budget.maxMs <= 0) {
      return actionRequiredOutcome('unknown_challenge', 'pow_budget_exhausted');
    }

    const challenge = await ops.getPowChallenge('checkin');
    if (!challenge.ok) return challenge.outcome;

    // Reserve immediately after acquisition so crashes cannot reset usage.
    try {
      await ops.onPowChallengeAcquired?.();
    } catch {
      return actionRequiredOutcome('unknown_challenge', 'pow_budget_exhausted');
    }
    if (!isDifficultyInRange(challenge.value.difficulty)) {
      return failedOutcome('pow_difficulty_out_of_range');
    }

    const solveInput = {
      prefix: challenge.value.prefix,
      difficulty: challenge.value.difficulty,
      maxMs: budget.maxMs,
    } as const;
    let solveResult;
    try {
      solveResult =
        ops.signal === undefined
          ? await ops.solvePow(solveInput)
          : await ops.solvePow({ ...solveInput, signal: ops.signal });
      await ops.onPowWorkerUsed?.(Math.max(0, solveResult.elapsedMs));
    } catch {
      return failedOutcome('unknown');
    }
    if (solveResult.status === 'cancelled') return cancelledOutcome();
    if (solveResult.status === 'error') return failedOutcome('unknown');

    if (solveResult.status === 'solved') {
      if (
        solveResult.nonce === undefined ||
        !/^[0-9a-f]{8}$/.test(solveResult.nonce)
      ) {
        return failedOutcome('invalid_response');
      }
      const submitted = await ops.submitCheckin({
        powChallenge: challenge.value.challengeId,
        powNonce: solveResult.nonce,
      });
      if (submitted.errorCode !== 'pow_timeout') return submitted;
    }

    const rechecked = await ops.checkinStatus(plan.month);
    if (!rechecked.ok) return rechecked.outcome;
    if (rechecked.value.checkedInToday) {
      return { code: 'already_checked', retryable: false };
    }
  }
  return actionRequiredOutcome('unknown_challenge', 'pow_budget_exhausted');
}

async function resolveAttemptBudget(
  ops: CheckinFlowOps,
  attempt: number,
): Promise<PowAttemptBudget> {
  if (ops.getPowAttemptBudget !== undefined) {
    try {
      const budget = await ops.getPowAttemptBudget(attempt);
      return {
        allowed: budget.allowed,
        maxMs: clampWorkerMs(budget.maxMs),
      };
    } catch {
      return { allowed: false, maxMs: 0 };
    }
  }
  if (attempt > 0) return { allowed: false, maxMs: 0 };
  const maxMs = clampWorkerMs(
    ops.powMaxMs ?? POW_MAX_WORKER_MS_PER_CHALLENGE,
  );
  return { allowed: maxMs > 0, maxMs };
}

function clampWorkerMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(
    POW_MAX_WORKER_MS_PER_CHALLENGE,
    Math.max(0, Math.floor(value)),
  );
}

export function isDifficultyInRange(difficulty: number): boolean {
  return (
    Number.isInteger(difficulty) &&
    difficulty >= POW_MIN_DIFFICULTY &&
    difficulty <= POW_MAX_DIFFICULTY
  );
}
