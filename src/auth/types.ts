import type {
  AuthMode,
  NormalizedOutcome,
  PowMode,
} from '../shared/domain';
import type {
  CheckinStatus,
  PowAttemptBudget,
  PowChallenge,
  PowSolveInput,
  PowSolveResult,
} from '../adapters/types';

export type { PowAttemptBudget } from '../adapters/types';

export type TransportResult<T> =
  | { ok: true; value: T }
  | { ok: false; outcome: NormalizedOutcome };

export interface CheckinSubmitOptions {
  powChallenge?: string;
  powNonce?: string;
}

/**
 * Fixed-operation auth boundary. A transport never exposes raw HTTP, tokens,
 * or cookies; it only runs the named operations and returns normalized
 * outcomes. `runCheckinFlow` performs refresh, status, challenge and submit
 * inside one same-origin page injection for `same-origin-refresh`, keeping
 * the bearer token inside the injected function's local variables.
 */
export interface AuthTransport {
  readonly authMode: AuthMode;
  runCheckinFlow(plan: CheckinFlowPlan): Promise<NormalizedOutcome>;
  /** Releases the page session; a temporary tab is always closed. */
  close(): Promise<void>;
}

export interface CheckinFlowPlan {
  month: string;
  userId: number;
  powEnabled: boolean;
  powMode: PowMode;
  turnstileCheck: boolean;
  maxPowAttempts: number;
  powMaxMs: number;
}

/** Fetch-bound operations used by the shared (legacy) flow implementation. */
export interface CheckinFlowOps {
  checkinStatus(month: string): Promise<TransportResult<CheckinStatus>>;
  getPowChallenge(action: string): Promise<TransportResult<PowChallenge>>;
  submitCheckin(options: CheckinSubmitOptions): Promise<NormalizedOutcome>;
  solvePow(input: PowSolveInput): Promise<PowSolveResult>;
  powMaxMs?: number;
  getPowAttemptBudget?: (attempt: number) => PowAttemptBudget | Promise<PowAttemptBudget>;
  onPowChallengeAcquired?: () => void | Promise<void>;
  onPowWorkerUsed?: (elapsedMs: number) => void | Promise<void>;
  signal?: AbortSignal;
}

export type ModernProbeResult =
  | { kind: 'modern'; userId: number; checkedInToday?: boolean }
  | { kind: 'needs_login' }
  | { kind: 'legacy_only' }
  | { kind: 'failure'; outcome: NormalizedOutcome };

export type ModernProbeFn = (
  origin: string,
  month?: string,
) => Promise<ModernProbeResult>;
