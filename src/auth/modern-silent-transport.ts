import type { NormalizedOutcome } from '../shared/domain';
import {
  getCheckinStatus,
  postCheckin,
  type NewApiRequestContext,
} from '../adapters/new-api';
import type {
  FetchLike,
  PowAttemptBudget,
  PowSolver,
} from '../adapters/types';
import { fetchLegacyPowChallenge } from './legacy-transport';
import { runCheckinFlowWithOps } from './flow';
import { fetchModernRefresh } from './modern-refresh';
import type {
  AuthTransport,
  CheckinFlowOps,
  CheckinFlowPlan,
} from './types';

export interface ModernSilentOptions {
  origin: string;
  userId: number;
  fetch?: FetchLike;
  signal?: AbortSignal;
  solvePow?: PowSolver;
  powMaxMs?: number;
  getPowAttemptBudget?: (attempt: number) => PowAttemptBudget | Promise<PowAttemptBudget>;
  onPowChallengeAcquired?: () => void | Promise<void>;
  onPowWorkerUsed?: (elapsedMs: number) => void | Promise<void>;
  /**
   * Opens a page-session transport when the silent path reports the browser
   * session unauthenticated. Deployments that reject extension-origin
   * requests still work there; `undefined` keeps the silent sign-in result.
   */
  openPageFallback?: () => Promise<AuthTransport | undefined>;
}

/**
 * `same-origin-refresh` transport that runs entirely in the service worker:
 * refresh, status, challenge and submit go through host-permission fetches
 * with the bearer value confined to local variables, so no site tab opens.
 * Only an unauthenticated refresh falls back to the page-session transport.
 */
export class ModernSilentTransport implements AuthTransport {
  readonly authMode = 'same-origin-refresh' as const;
  private pageFallback: AuthTransport | undefined;

  constructor(private readonly options: ModernSilentOptions) {}

  async runCheckinFlow(plan: CheckinFlowPlan): Promise<NormalizedOutcome> {
    const refreshed = await fetchModernRefresh({
      origin: this.options.origin,
      ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
      ...(this.options.signal !== undefined ? { signal: this.options.signal } : {}),
    });
    if (refreshed.kind === 'legacy_only') {
      return { code: 'unsupported', errorCode: 'unsupported_protocol', retryable: false };
    }
    if (refreshed.kind === 'needs_login') {
      this.pageFallback = await this.options.openPageFallback?.().catch(() => undefined);
      if (this.pageFallback !== undefined) return this.pageFallback.runCheckinFlow(plan);
      return { code: 'action_required', actionReason: 'sign_in', retryable: false };
    }
    if (refreshed.kind === 'failed') return refreshed.outcome;
    if (refreshed.account !== plan.userId) {
      return { code: 'action_required', actionReason: 'account_changed', retryable: false };
    }
    return runCheckinFlowWithOps(this.buildOps(refreshed.authorization), plan);
  }

  async close(): Promise<void> {
    const fallback = this.pageFallback;
    this.pageFallback = undefined;
    await fallback?.close().catch(() => undefined);
  }

  private buildOps(authorization: string): CheckinFlowOps {
    const context: NewApiRequestContext = {
      origin: this.options.origin,
      userId: this.options.userId,
      authorization,
      ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
      ...(this.options.signal !== undefined ? { signal: this.options.signal } : {}),
    };
    const ops: CheckinFlowOps = {
      checkinStatus: (month) => getCheckinStatus({ ...context, month }),
      getPowChallenge: (action) => fetchLegacyPowChallenge(context, action),
      submitCheckin: (options) => postCheckin(context, options),
      solvePow: (input) => {
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
