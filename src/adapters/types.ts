import type {
  AdapterId,
  AuthMode,
  IdentitySource,
  NormalizedOutcome,
  PowMode,
  ProbeReport,
  SiteCapabilities,
} from '../shared/domain';
import type { AuthTransport } from '../auth/types';

export type { AuthTransport } from '../auth/types';

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface PowSolveInput {
  prefix: string;
  difficulty: number;
  maxMs: number;
  signal?: AbortSignal;
}

export interface PowSolveResult {
  status: 'solved' | 'timeout' | 'cancelled' | 'error';
  elapsedMs: number;
  nonce?: string;
}

export type PowSolver = (input: PowSolveInput) => Promise<PowSolveResult>;

export interface PowAttemptBudget {
  allowed: boolean;
  maxMs: number;
}

/**
 * Protocol adapter run context. Protocol logic (new-api, runanytime) is
 * decoupled from the auth method: every authenticated operation goes through
 * the injected `AuthTransport`, while `fetch` is only used for public status.
 */
export interface AdapterContext {
  origin: string;
  userId: number;
  adapterId: AdapterId;
  authMode: AuthMode;
  month: string;
  transport: AuthTransport;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

export interface ProbeAdapterContext {
  origin: string;
  userId: number;
  identitySource: IdentitySource;
  month?: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

export interface PublicSiteStatus {
  checkinEnabled: boolean;
  turnstileCheck: boolean;
  powEnabled: boolean;
  powMode: PowMode;
}

export type AdapterOperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; outcome: NormalizedOutcome };

export interface CheckinStatus {
  checkedInToday: boolean;
}

export interface PowChallenge {
  challengeId: string;
  prefix: string;
  difficulty: number;
}

export interface AdapterDescriptor {
  adapterId: AdapterId;
  supportLevel: 'detected' | 'verified';
  capabilities: SiteCapabilities;
}

export type AdapterProbeResult = ProbeReport;
