import type {
  AppSnapshot,
  GlobalSettings,
  IdentitySource,
  NormalizedOutcome,
  ProbeReport,
  SiteCapabilities,
  AdapterId,
  PlatformFamily,
  SupportLevel,
} from './domain';

export interface EnrollmentConfirmation {
  origin: string;
  label: string;
  userId: number;
  identitySource: IdentitySource;
  adapterId: AdapterId;
  platform: PlatformFamily;
  supportLevel: SupportLevel;
  capabilities: SiteCapabilities;
}

export type AppRequest =
  | { type: 'snapshot:get' }
  | {
      type: 'site:probe';
      origin: string;
      userId: number;
      identitySource: IdentitySource;
    }
  | { type: 'site:confirm'; enrollment: EnrollmentConfirmation }
  | {
      type: 'site:rebind';
      origin: string;
      userId: number;
      identitySource: IdentitySource;
    }
  | { type: 'site:set-enabled'; origin: string; enabled: boolean }
  | { type: 'site:remove'; origin: string }
  | { type: 'site:manual-checkin'; origin: string }
  | { type: 'batch:run-all' }
  | { type: 'settings:update'; patch: Partial<GlobalSettings> }
  | { type: 'permission:revoke'; origin: string }
  | { type: 'pow:solve-result'; taskId: string; result: PowWorkerResult };

export interface PowWorkerResult {
  status: 'solved' | 'timeout' | 'cancelled' | 'error';
  nonce?: string;
  elapsedMs: number;
}

export type AppResponse =
  | { ok: true; type: 'snapshot'; snapshot: AppSnapshot }
  | { ok: true; type: 'probe'; report: ProbeReport }
  | { ok: true; type: 'mutation'; snapshot: AppSnapshot }
  | { ok: true; type: 'checkin'; outcome: NormalizedOutcome; snapshot: AppSnapshot }
  | { ok: true; type: 'batch'; snapshot: AppSnapshot }
  | { ok: true; type: 'pow-ack' }
  | { ok: false; errorCode: string };

export interface PowSolveRequest {
  type: 'pow:solve';
  taskId: string;
  prefix: string;
  difficulty: number;
  maxMs: number;
}

export interface PowCancelRequest {
  type: 'pow:cancel';
  taskId: string;
}

export type OffscreenRequest = PowSolveRequest | PowCancelRequest;

export function isAppRequest(value: unknown): value is AppRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string'
  );
}
