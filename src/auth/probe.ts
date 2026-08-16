import type { IdentitySource } from '../shared/domain';
import {
  capabilitiesFromStatus,
  fetchPublicStatus,
  probeLegacySite,
  getCheckinStatus,
  RUNANYTIME_ORIGIN,
} from '../adapters';
import type { AdapterProbeResult, FetchLike } from '../adapters/types';
import { currentLocalMonth } from '../adapters/new-api';
import { fetchModernRefresh } from './modern-refresh';
import type { ModernProbeFn, ModernProbeResult } from './types';

export interface ProbeSiteContext {
  origin: string;
  userId?: number;
  identitySource?: IdentitySource;
  month: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/**
 * Modern-first probing. The refresh probe runs silently in the service
 * worker through the granted host permission; only an explicit 404/405 from
 * refresh falls back to legacy session probing; 401 means the user must sign
 * in, never "incompatible".
 */
export async function probeSite(
  context: ProbeSiteContext,
  modernProbe: ModernProbeFn = probeModernAuth,
): Promise<AdapterProbeResult> {
  const base = {
    origin: context.origin,
    userId: context.userId ?? 0,
    identitySource: context.identitySource ?? ('uid' as const),
  };
  const status = await fetchPublicStatus({
    origin: context.origin,
    userId: base.userId,
    ...(context.fetch !== undefined ? { fetch: context.fetch } : {}),
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });
  if (!status.ok) return reportFailure(base, status.outcome);
  if (!status.value.checkinEnabled) {
    return { ...base, supported: false, reason: 'unsupported_protocol' };
  }
  if (status.value.powEnabled && status.value.powMode === 'unknown') {
    // Unknown private challenge: explicitly unsupported for automation.
    return { ...base, supported: false, reason: 'unknown_challenge' };
  }

  const modern = await modernProbe(context.origin, context.month);
  if (modern.kind === 'modern') {
    const isRunanytime = context.origin === RUNANYTIME_ORIGIN;
    const report: AdapterProbeResult = {
      ...base,
      userId: modern.userId,
      identitySource: 'refresh',
      supported: true,
      adapterId: isRunanytime ? 'runanytime' : 'new-api',
      platform: isRunanytime ? 'runanytime' : 'new-api',
      authMode: 'same-origin-refresh',
      supportLevel: isRunanytime ? 'verified' : 'detected',
      capabilities: capabilitiesFromStatus(status.value),
    };
    if (modern.checkedInToday !== undefined) {
      report.checkedInToday = modern.checkedInToday;
    }
    return report;
  }
  if (modern.kind === 'needs_login') {
    return { ...base, supported: false, reason: 'sign_in' };
  }
  if (modern.kind === 'failure') {
    return reportFailure(base, modern.outcome);
  }

  // Legacy fallback needs a session identity read from the page (MAIN world).
  if (context.userId === undefined || context.identitySource === undefined) {
    return { ...base, supported: false, reason: 'identity_missing' };
  }
  return probeLegacySite({
    origin: context.origin,
    userId: context.userId,
    identitySource: context.identitySource,
    month: context.month,
    ...(context.fetch !== undefined ? { fetch: context.fetch } : {}),
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });
}

/** Runs the silent refresh probe in the service worker. */
export async function probeModernAuth(
  origin: string,
  month: string = currentLocalMonth(),
): Promise<ModernProbeResult> {
  const refreshed = await fetchModernRefresh({ origin });
  if (refreshed.kind === 'needs_login') return { kind: 'needs_login' };
  if (refreshed.kind === 'legacy_only') return { kind: 'legacy_only' };
  if (refreshed.kind === 'failed') return { kind: 'failure', outcome: refreshed.outcome };

  const status = await getCheckinStatus({
    origin,
    userId: refreshed.account,
    authorization: refreshed.authorization,
    month,
  });
  const result: ModernProbeResult = { kind: 'modern', userId: refreshed.account };
  if (status.ok) result.checkedInToday = status.value.checkedInToday;
  // A protected status failure never collapses a working refresh into
  // "incompatible": the site is modern-capable, just possibly needs login.
  return result;
}

function reportFailure(
  base: { origin: string; userId: number; identitySource: IdentitySource },
  outcome: { actionReason?: string; errorCode?: string },
): AdapterProbeResult {
  return {
    ...base,
    supported: false,
    reason: (outcome.actionReason ?? outcome.errorCode ?? 'unknown') as NonNullable<
      AdapterProbeResult['reason']
    >,
  };
}
