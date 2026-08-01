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

export async function probeAdapter(
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

  const checkinStatus = await getCheckinStatus(context);
  if (!checkinStatus.ok) return reportFailure(base, checkinStatus.outcome);
  const isRunanytime = context.origin === RUNANYTIME_ORIGIN;
  return {
    ...base,
    supported: true,
    adapterId: isRunanytime ? 'runanytime-pow' : 'new-api-session',
    platform: isRunanytime ? 'runanytime' : 'new-api',
    supportLevel: isRunanytime ? 'verified' : 'detected',
    capabilities: capabilitiesFromStatus(status.value),
    checkedInToday: checkinStatus.value.checkedInToday,
  };
}

export async function runAdapterCheckin(
  context: AdapterContext,
): Promise<NormalizedOutcome> {
  if (context.adapterId === 'runanytime-pow') {
    return runRunanytimeCheckin(context);
  }
  if (context.adapterId === 'new-api-session') {
    return runNewApiCheckin(context);
  }
  return failedOutcome('unsupported_protocol');
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
