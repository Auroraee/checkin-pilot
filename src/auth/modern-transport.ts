import type { NormalizedOutcome } from '../shared/domain';
import {
  modernAuthScript,
  normalizeFlowScriptResult,
  type ModernScriptPlan,
} from './refresh-script';
import type { AuthTransport, CheckinFlowPlan } from './types';
import type { PageSession } from './page-session';

/**
 * `same-origin-refresh` transport: the whole check-in flow (refresh, status,
 * challenge, submit) runs inside one injected function in the ISOLATED world
 * of the session tab. The bearer token lives only in that function's local
 * variables; PoW solving goes through the strict `target/type/taskId` routed
 * message and only `prefix/difficulty/challengeId` cross the boundary.
 */
export class ModernRefreshTransport implements AuthTransport {
  readonly authMode = 'same-origin-refresh' as const;
  private closed = false;

  constructor(private readonly session: PageSession) {}

  async runCheckinFlow(plan: CheckinFlowPlan): Promise<NormalizedOutcome> {
    if (this.closed) {
      return { code: 'failed', errorCode: 'unknown', retryable: false };
    }
    const scriptPlan: ModernScriptPlan = {
      op: 'checkin',
      month: plan.month,
      userId: plan.userId,
      powEnabled: plan.powEnabled,
      powMode: plan.powMode,
      turnstileCheck: plan.turnstileCheck,
      maxPowAttempts: plan.maxPowAttempts,
      powMaxMs: plan.powMaxMs,
      tabId: this.session.tabId,
    };
    try {
      const raw = await this.session.run<Record<string, unknown>>(
        modernAuthScript as (...args: never[]) => unknown,
        [scriptPlan],
      );
      return normalizeFlowScriptResult(raw);
    } catch {
      return { code: 'failed', errorCode: 'unknown', retryable: false };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.session.close();
  }
}
