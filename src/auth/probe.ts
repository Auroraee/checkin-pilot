import type { IdentitySource } from '../shared/domain';
import {
  capabilitiesFromStatus,
  fetchPublicStatus,
  probeLegacySite,
  RUNANYTIME_ORIGIN,
} from '../adapters';
import type { AdapterProbeResult, FetchLike } from '../adapters/types';
import { currentLocalMonth } from '../adapters/new-api';
import { openPageSession } from './page-session';
import {
  modernAuthScript,
  normalizeProbeScriptResult,
  type ModernScriptPlan,
} from './refresh-script';
import type { ModernProbeFn, ModernProbeResult } from './types';

export interface ProbeSiteContext {
  origin: string;
  userId?: number;
  identitySource?: IdentitySource;
  month: string;
  tabId?: number;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/**
 * Modern-first probing: refresh inside a same-origin tab (reusing the user's
 * tab when possible, otherwise a temporary background tab that is always
 * closed). Only an explicit 404/405 from refresh falls back to legacy
 * session probing; 401 means the user must sign in, never "incompatible".
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

  const modern = await modernProbe(context.origin, context.tabId, context.month);
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

/** Runs the refresh probe in an ISOLATED-world page session. */
export async function probeModernAuth(
  origin: string,
  preferredTabId?: number,
  month: string = currentLocalMonth(),
): Promise<ModernProbeResult> {
  const session = await openPageSession(
    origin,
    preferredTabId !== undefined ? { preferredTabId } : {},
  );
  try {
    const scriptPlan: ModernScriptPlan = {
      op: 'probe',
      month,
      userId: 0,
      powEnabled: false,
      powMode: 'unknown',
      turnstileCheck: false,
      maxPowAttempts: 0,
      powMaxMs: 0,
      tabId: session.tabId,
    };
    const raw = await session.run<Record<string, unknown>>(
      modernAuthScript as (...args: never[]) => unknown,
      [scriptPlan],
    );
    return normalizeProbeScriptResult(raw);
  } catch {
    return {
      kind: 'failure',
      outcome: { code: 'failed', errorCode: 'unknown', retryable: false },
    };
  } finally {
    // A temporary tab is always closed; user tabs are never touched.
    await session.close();
  }
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
