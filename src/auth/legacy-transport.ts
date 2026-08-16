import type { NormalizedOutcome } from '../shared/domain';
import {
  getCheckinStatus,
  postCheckin,
  type NewApiRequestContext,
} from '../adapters/new-api';
import {
  actionRequiredOutcome,
  failedOutcome,
  getApiMessage,
  isApiSuccess,
  isHtmlResponse,
  isRecord,
  outcomeFromApiFailure,
  outcomeFromHttpStatus,
  outcomeFromThrown,
  readJsonObject,
} from '../adapters/http';
import type {
  FetchLike,
  PowAttemptBudget,
  PowChallenge,
  PowSolveInput,
  PowSolveResult,
  PowSolver,
} from '../adapters/types';
import { runCheckinFlowWithOps } from './flow';
import type {
  AuthTransport,
  CheckinFlowOps,
  CheckinFlowPlan,
  TransportResult,
} from './types';

export interface LegacyTransportOptions {
  origin: string;
  userId: number;
  fetch?: FetchLike;
  signal?: AbortSignal;
  solvePow?: PowSolver;
  powMaxMs?: number;
  getPowAttemptBudget?: (attempt: number) => PowAttemptBudget | Promise<PowAttemptBudget>;
  onPowChallengeAcquired?: () => void | Promise<void>;
  onPowWorkerUsed?: (elapsedMs: number) => void | Promise<void>;
}

/**
 * `legacy-session` transport: Cookie + `New-Api-User` requests issued from
 * the extension context. It is used for sites whose refresh endpoint is
 * absent (404/405) or for previously enrolled session-only sites.
 */
export class LegacySessionTransport implements AuthTransport {
  readonly authMode = 'legacy-session' as const;

  constructor(private readonly options: LegacyTransportOptions) {}

  async runCheckinFlow(plan: CheckinFlowPlan): Promise<NormalizedOutcome> {
    return runCheckinFlowWithOps(this.buildOps(), plan);
  }

  async close(): Promise<void> {
    // Legacy sessions hold no page or document resources.
  }

  private requestContext(): NewApiRequestContext {
    return {
      origin: this.options.origin,
      userId: this.options.userId,
      ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
      ...(this.options.signal !== undefined ? { signal: this.options.signal } : {}),
    };
  }

  private buildOps(): CheckinFlowOps {
    const context = this.requestContext();
    const ops: CheckinFlowOps = {
      checkinStatus: (month) => getCheckinStatus({ ...context, month }),
      getPowChallenge: (action) => fetchLegacyPowChallenge(context, action),
      submitCheckin: (options) => postCheckin(context, options),
      solvePow: (input: PowSolveInput): Promise<PowSolveResult> => {
        if (this.options.solvePow === undefined) {
          return Promise.resolve({ status: 'error', elapsedMs: 0 });
        }
        return this.options.solvePow(input);
      },
      ...(this.options.powMaxMs !== undefined ? { powMaxMs: this.options.powMaxMs } : {}),
      ...(this.options.getPowAttemptBudget !== undefined
        ? { getPowAttemptBudget: this.options.getPowAttemptBudget }
        : {}),
      ...(this.options.onPowChallengeAcquired !== undefined
        ? { onPowChallengeAcquired: this.options.onPowChallengeAcquired }
        : {}),
      ...(this.options.onPowWorkerUsed !== undefined
        ? { onPowWorkerUsed: this.options.onPowWorkerUsed }
        : {}),
      ...(this.options.signal !== undefined ? { signal: this.options.signal } : {}),
    };
    return ops;
  }
}

/** Fixed challenge operation for legacy-session transports. */
export async function fetchLegacyPowChallenge(
  context: NewApiRequestContext,
  action: string,
): Promise<TransportResult<PowChallenge>> {
  if (!Number.isSafeInteger(context.userId) || context.userId <= 0) {
    return {
      ok: false,
      outcome: actionRequiredOutcome('rebind_required', 'auth_failed'),
    };
  }
  const url = new URL('/api/user/pow/challenge', context.origin);
  url.searchParams.set('action', action);
  const headers = new Headers({
    Accept: 'application/json',
    'New-Api-User': String(context.userId),
  });
  if (context.authorization !== undefined) {
    headers.set('Authorization', context.authorization);
  }
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
    return {
      ok: true,
      value: { challengeId, prefix, difficulty },
    };
  } catch (error) {
    return { ok: false, outcome: outcomeFromThrown(error, context.signal) };
  }
}
