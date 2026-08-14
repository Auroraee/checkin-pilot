import { POW_MAX_ATTEMPTS_PER_RUN, POW_MAX_WORKER_MS_PER_CHALLENGE } from '../shared/constants';
import type { NormalizedOutcome } from '../shared/domain';
import { actionRequiredOutcome } from './http';
import { fetchPublicStatus } from './new-api';
import type {
  AdapterContext,
  PublicSiteStatus,
} from './types';
import type { CheckinFlowPlan } from '../auth/types';

export const RUNANYTIME_ORIGIN = 'https://runanytime.hxi.me';

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

/**
 * runanytime private PoW protocol adapter. The security decision is derived
 * from the public status; the authenticated flow (refresh/status/challenge/
 * submit) runs through the injected transport — for `same-origin-refresh`
 * inside one page injection that keeps the bearer token in page context.
 */
export async function runRunanytimeCheckin(
  context: AdapterContext,
): Promise<NormalizedOutcome> {
  if (context.origin !== RUNANYTIME_ORIGIN) {
    return { code: 'unsupported', errorCode: 'unsupported_protocol', retryable: false };
  }

  const publicStatus = await fetchPublicStatus({
    origin: context.origin,
    userId: context.userId,
    ...(context.fetch !== undefined ? { fetch: context.fetch } : {}),
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });
  if (!publicStatus.ok) return publicStatus.outcome;
  if (!publicStatus.value.checkinEnabled) {
    return { code: 'unsupported', errorCode: 'unsupported_protocol', retryable: false };
  }

  const decision = decideRunanytimeSecurity(publicStatus.value);
  if (decision === 'unknown') {
    // Never guess an unknown private challenge protocol.
    return actionRequiredOutcome('unknown_challenge');
  }

  const plan: CheckinFlowPlan = {
    month: context.month,
    userId: context.userId,
    powEnabled: decision === 'pow',
    powMode: publicStatus.value.powMode,
    turnstileCheck: publicStatus.value.turnstileCheck,
    maxPowAttempts: decision === 'pow' ? POW_MAX_ATTEMPTS_PER_RUN : 0,
    powMaxMs: POW_MAX_WORKER_MS_PER_CHALLENGE,
  };
  return context.transport.runCheckinFlow(plan);
}
