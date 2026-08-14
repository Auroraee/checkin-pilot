import type { NormalizedOutcome, ProbeReport } from '../shared/domain';
import { failedOutcome } from './http';
import {
  capabilitiesFromStatus,
  fetchPublicStatus,
  getCheckinStatus,
  runNewApiCheckin,
} from './new-api';
import { RUNANYTIME_ORIGIN, runRunanytimeCheckin } from './runanytime';
import type {
  AdapterContext,
  AdapterProbeResult,
  ProbeAdapterContext,
} from './types';

export * from './http';
export * from './new-api';
export * from './runanytime';
export * from './types';

export async function runAdapterCheckin(
  context: AdapterContext,
): Promise<NormalizedOutcome> {
  if (context.adapterId === 'runanytime') {
    return runRunanytimeCheckin(context);
  }
  if (context.adapterId === 'new-api') {
    return runNewApiCheckin(context);
  }
  return failedOutcome('unsupported_protocol');
}

/**
 * Legacy session probing (Cookie + `New-Api-User`). Only used as a fallback
 * when the modern refresh probe explicitly reports the protocol is absent
 * (404/405); a 401 here means "needs login", never "incompatible".
 */
export async function probeLegacySite(
  context: ProbeAdapterContext,
): Promise<AdapterProbeResult> {
  const base: Pick<ProbeReport, 'origin' | 'userId' | 'identitySource'> = {
    origin: context.origin,
    userId: context.userId,
    identitySource: context.identitySource,
  };
  const status = await fetchPublicStatus(context);
  if (!status.ok) return reportFailure(base, status.outcome);
  if (!status.value.checkinEnabled) {
    return { ...base, supported: false, reason: 'unsupported_protocol' };
  }
  if (status.value.powEnabled && status.value.powMode === 'unknown') {
    // Unknown private challenge: never guess the protocol.
    return { ...base, supported: false, reason: 'unknown_challenge' };
  }

  const checkinStatus = await getCheckinStatus(context);
  if (!checkinStatus.ok) return reportFailure(base, checkinStatus.outcome);
  const isRunanytime = context.origin === RUNANYTIME_ORIGIN;

  return {
    ...base,
    supported: true,
    adapterId: isRunanytime ? 'runanytime' : 'new-api',
    platform: isRunanytime ? 'runanytime' : 'new-api',
    authMode: 'legacy-session',
    supportLevel: isRunanytime ? 'verified' : 'detected',
    capabilities: capabilitiesFromStatus(status.value),
    checkedInToday: checkinStatus.value.checkedInToday,
  };
}

function reportFailure(
  base: Pick<ProbeReport, 'origin' | 'userId' | 'identitySource'>,
  outcome: NormalizedOutcome,
): ProbeReport {
  return {
    ...base,
    supported: false,
    reason: outcome.actionReason ?? outcome.errorCode ?? 'unknown',
  };
}
