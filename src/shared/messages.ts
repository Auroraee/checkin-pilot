import type {
  AppSnapshot,
  AuthMode,
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
  authMode: AuthMode;
  supportLevel: SupportLevel;
  capabilities: SiteCapabilities;
}

export type AppRequest =
  | { type: 'snapshot:get' }
  | {
      type: 'site:probe';
      origin: string;
      userId?: number;
      identitySource?: IdentitySource;
    }
  | { type: 'site:confirm'; enrollment: EnrollmentConfirmation }
  | { type: 'site:upgrade'; enrollment: EnrollmentConfirmation }
  | {
      type: 'site:rebind';
      origin: string;
      userId: number;
      identitySource: IdentitySource;
      authMode?: AuthMode;
      adapterId?: AdapterId;
      platform?: PlatformFamily;
      supportLevel?: SupportLevel;
      capabilities?: SiteCapabilities;
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
  target: 'offscreen';
  type: 'pow:solve';
  taskId: string;
  prefix: string;
  difficulty: number;
  maxMs: number;
}

export interface PowCancelRequest {
  target: 'offscreen';
  type: 'pow:cancel';
  taskId: string;
}

export type OffscreenRequest = PowSolveRequest | PowCancelRequest;

/**
 * PoW solve request coming from an ISOLATED-world page session. Strict
 * routing by `target`/`type`/`taskId`: only the background responds, the
 * offscreen document ignores it, and only normalized data crosses.
 */
export interface PagePowSolveRequest {
  target: 'background';
  type: 'pow:solve';
  tabId: number;
  taskId: string;
  prefix: string;
  difficulty: number;
  maxMs: number;
}

export interface PagePowSolveResponse {
  status: 'solved' | 'timeout' | 'cancelled' | 'error';
  nonce?: string;
  elapsedMs: number;
  errorCode?: 'pow_budget_exhausted';
}

export function isPagePowSolveRequest(value: unknown): value is PagePowSolveRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PagePowSolveRequest>;
  return (
    candidate.target === 'background' &&
    candidate.type === 'pow:solve' &&
    typeof candidate.tabId === 'number' &&
    typeof candidate.taskId === 'string' &&
    candidate.taskId.length > 0 &&
    candidate.taskId.length <= 128 &&
    typeof candidate.prefix === 'string' &&
    candidate.prefix.length > 0 &&
    candidate.prefix.length <= 4_096 &&
    typeof candidate.difficulty === 'number' &&
    typeof candidate.maxMs === 'number'
  );
}

export function isAppRequest(value: unknown): value is AppRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    !('target' in value)
  );
}
