import {
  POW_MAX_DIFFICULTY,
  POW_MAX_WORKER_MS_PER_CHALLENGE,
  POW_MIN_DIFFICULTY,
} from '../shared/constants';
import type { NormalizedOutcome } from '../shared/domain';
import {
  actionRequiredOutcome,
  cancelledOutcome,
  failedOutcome,
  getApiMessage,
  isApiSuccess,
  isHtmlResponse,
  isRecord,
  outcomeFromApiFailure,
  outcomeFromHttpStatus,
  outcomeFromThrown,
  readJsonObject,
} from './http';
import {
  fetchPublicStatus,
  getCheckinStatus,
  postCheckin,
  type NewApiRequestContext,
} from './new-api';
import type {
  AdapterOperationResult,
  PowAttemptBudget,
  PowChallenge,
  PowSolver,
  PublicSiteStatus,
} from './types';

export const RUNANYTIME_ORIGIN = 'https://runanytime.hxi.me';

export interface RunanytimeContext extends NewApiRequestContext {
  solvePow?: PowSolver;
  powMaxMs?: number;
  getPowAttemptBudget?: () => PowAttemptBudget | Promise<PowAttemptBudget>;
  onPowChallengeAcquired?: () => void | Promise<void>;
  onPowWorkerUsed?: (elapsedMs: number) => void | Promise<void>;
}

export type RunanytimeSecurityDecision =
  | 'direct'
  | 'pow'
  | 'turnstile'
  | 'unknown';

export function decideRunanytimeSecurity(
  status: PublicSiteStatus,
): RunanytimeSecurityDecision {
  if (!status.powEnabled) return status.turnstileCheck ? 'turnstile' : 'direct';
  switch (status.powMode) {
    case 'replace':
      return 'pow';
    case 'supplement':
      return 'turnstile';
    case 'fallback':
      return status.turnstileCheck ? 'turnstile' : 'pow';
    case 'unknown':
      return 'unknown';
  }
}

export async function fetchRunanytimeChallenge(
  context: RunanytimeContext,
): Promise<AdapterOperationResult<PowChallenge>> {
  if (context.origin !== RUNANYTIME_ORIGIN) {
    return { ok: false, outcome: failedOutcome('unsupported_protocol') };
  }
  if (!Number.isSafeInteger(context.userId) || context.userId <= 0) {
    return {
      ok: false,
      outcome: actionRequiredOutcome('rebind_required', 'auth_failed'),
    };
  }

  const url = new URL('/api/user/pow/challenge', RUNANYTIME_ORIGIN);
  url.searchParams.set('action', 'checkin');
  const headers = new Headers({
    Accept: 'application/json',
    'New-Api-User': String(context.userId),
  });
  const init: RequestInit = {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    redirect: 'manual',
    headers,
  };
  if (context.signal !== undefined) init.signal = context.signal;

  try {
    const fetcher = context.fetch ?? globalThis.fetch.bind(globalThis);
    const response = await fetcher(url, init);
    const httpFailure = outcomeFromHttpStatus(response);
    if (httpFailure !== undefined) return { ok: false, outcome: httpFailure };
    if (isHtmlResponse(response)) {
      return {
        ok: false,
        outcome: actionRequiredOutcome('sign_in', 'auth_failed'),
      };
    }
    const payload = await readJsonObject(response);
    if (payload === undefined) {
      return { ok: false, outcome: failedOutcome('invalid_response') };
    }
    if (!isApiSuccess(payload)) {
      return { ok: false, outcome: outcomeFromApiFailure(getApiMessage(payload)) };
    }
    const data = isRecord(payload.data) ? payload.data : undefined;
    if (data === undefined) {
      return { ok: false, outcome: failedOutcome('invalid_response') };
    }

    const challengeId = data.challenge_id;
    const prefix = data.prefix;
    const difficulty = data.difficulty;
    if (
      typeof challengeId !== 'string' ||
      challengeId.length === 0 ||
      challengeId.length > 512 ||
      typeof prefix !== 'string' ||
      prefix.length === 0 ||
      prefix.length > 4_096 ||
      typeof difficulty !== 'number' ||
      !Number.isInteger(difficulty)
    ) {
      return { ok: false, outcome: failedOutcome('invalid_response') };
    }
    try {
      await context.onPowChallengeAcquired?.();
    } catch {
      return {
        ok: false,
        outcome: actionRequiredOutcome(
          'unknown_challenge',
          'pow_budget_exhausted',
        ),
      };
    }
    if (difficulty < POW_MIN_DIFFICULTY || difficulty > POW_MAX_DIFFICULTY) {
      return {
        ok: false,
        outcome: failedOutcome('pow_difficulty_out_of_range'),
      };
    }
    return {
      ok: true,
      value: { challengeId, prefix, difficulty },
    };
  } catch (error) {
    return { ok: false, outcome: outcomeFromThrown(error, context.signal) };
  }
}

export async function runRunanytimeCheckin(
  context: RunanytimeContext,
): Promise<NormalizedOutcome> {
  if (context.origin !== RUNANYTIME_ORIGIN) {
    return { code: 'unsupported', errorCode: 'unsupported_protocol', retryable: false };
  }

  const publicStatus = await fetchPublicStatus(context);
  if (!publicStatus.ok) return publicStatus.outcome;
  if (!publicStatus.value.checkinEnabled) {
    return { code: 'unsupported', errorCode: 'unsupported_protocol', retryable: false };
  }

  // Every execution, including a retry, first asks the service whether today is done.
  const current = await getCheckinStatus(context);
  if (!current.ok) return current.outcome;
  if (current.value.checkedInToday) {
    return { code: 'already_checked', retryable: false };
  }

  const decision = decideRunanytimeSecurity(publicStatus.value);
  if (decision === 'direct') return postCheckin(context);
  if (decision === 'turnstile') return actionRequiredOutcome('turnstile');
  if (decision === 'unknown') return actionRequiredOutcome('unknown_challenge');
  if (context.solvePow === undefined) {
    return actionRequiredOutcome('unknown_challenge', 'unsupported_protocol');
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const budget = await resolveAttemptBudget(context, attempt);
    if (!budget.allowed || budget.maxMs <= 0) {
      return actionRequiredOutcome('unknown_challenge', 'pow_budget_exhausted');
    }

    // Budget is checked before acquisition so a used-up ledger never fetches
    // a third challenge. The callback records an acquisition only after a
    // structurally valid challenge response has arrived.
    const challenge = await fetchRunanytimeChallenge(context);
    if (!challenge.ok) return challenge.outcome;

    const solveInput = {
      prefix: challenge.value.prefix,
      difficulty: challenge.value.difficulty,
      maxMs: budget.maxMs,
    } as const;
    let solveResult;
    try {
      solveResult =
        context.signal === undefined
          ? await context.solvePow(solveInput)
          : await context.solvePow({ ...solveInput, signal: context.signal });
      await context.onPowWorkerUsed?.(Math.max(0, solveResult.elapsedMs));
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
      const submitted = await postCheckin(context, {
        powChallenge: challenge.value.challengeId,
        powNonce: solveResult.nonce,
      });
      if (submitted.errorCode !== 'pow_timeout') return submitted;
    }

    // A timed-out worker or an expired/rejected short-lived challenge may be
    // tried once more, but only after the service status is rechecked.
    const rechecked = await getCheckinStatus(context);
    if (!rechecked.ok) return rechecked.outcome;
    if (rechecked.value.checkedInToday) {
      return { code: 'already_checked', retryable: false };
    }
  }
  return actionRequiredOutcome('unknown_challenge', 'pow_budget_exhausted');
}

async function resolveAttemptBudget(
  context: RunanytimeContext,
  attempt: number,
): Promise<PowAttemptBudget> {
  if (context.getPowAttemptBudget !== undefined) {
    try {
      const budget = await context.getPowAttemptBudget();
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
    context.powMaxMs ?? POW_MAX_WORKER_MS_PER_CHALLENGE,
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
