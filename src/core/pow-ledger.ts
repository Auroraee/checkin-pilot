import {
  POW_MAX_CHALLENGES_PER_DAY,
  POW_MAX_WORKER_MS_PER_CHALLENGE,
  POW_MAX_WORKER_MS_PER_DAY,
} from '../shared/constants';
import type { PowLedger, StorageState } from '../shared/domain';

export interface PowBudgetView {
  ledger: PowLedger;
  challengesRemaining: number;
  workerMsRemaining: number;
  canStart: boolean;
}

export function powLedgerKey(origin: string, scheduleDay: string): string {
  return `${origin}\n${scheduleDay}`;
}

export function readPowBudget(
  state: StorageState,
  origin: string,
  scheduleDay: string,
): PowBudgetView {
  const ledger = state.powLedgers[powLedgerKey(origin, scheduleDay)] ?? {
    origin,
    scheduleDay,
    challengesUsed: 0,
    workerMsUsed: 0,
    removedSiteTombstone: false,
  };
  const challengesRemaining = Math.max(0, POW_MAX_CHALLENGES_PER_DAY - ledger.challengesUsed);
  const workerMsRemaining = Math.max(0, POW_MAX_WORKER_MS_PER_DAY - ledger.workerMsUsed);
  return {
    ledger,
    challengesRemaining,
    workerMsRemaining,
    canStart: challengesRemaining > 0 && workerMsRemaining > 0,
  };
}

/** Reserve immediately after challenge acquisition so crashes cannot reset usage. */
export function reservePowChallenge(
  state: StorageState,
  origin: string,
  scheduleDay: string,
): StorageState | undefined {
  const budget = readPowBudget(state, origin, scheduleDay);
  if (!budget.canStart) return undefined;
  const ledger = { ...budget.ledger, challengesUsed: budget.ledger.challengesUsed + 1 };
  return {
    ...state,
    powLedgers: {
      ...state.powLedgers,
      [powLedgerKey(origin, scheduleDay)]: ledger,
    },
  };
}

/** Adds measured worker wall time; one challenge can contribute at most 12 seconds. */
export function recordPowUsage(
  state: StorageState,
  origin: string,
  scheduleDay: string,
  workerMs: number,
): StorageState {
  const budget = readPowBudget(state, origin, scheduleDay);
  const measuredMs = Number.isFinite(workerMs)
    ? Math.min(Math.max(Math.ceil(workerMs), 0), POW_MAX_WORKER_MS_PER_CHALLENGE)
    : POW_MAX_WORKER_MS_PER_CHALLENGE;
  const ledger: PowLedger = {
    ...budget.ledger,
    workerMsUsed: Math.min(
      POW_MAX_WORKER_MS_PER_DAY,
      budget.ledger.workerMsUsed + measuredMs,
    ),
  };
  return {
    ...state,
    powLedgers: {
      ...state.powLedgers,
      [powLedgerKey(origin, scheduleDay)]: ledger,
    },
  };
}

export function markPowTombstone(
  state: StorageState,
  origin: string,
  scheduleDay: string,
): StorageState {
  const { ledger } = readPowBudget(state, origin, scheduleDay);
  return {
    ...state,
    powLedgers: {
      ...state.powLedgers,
      [powLedgerKey(origin, scheduleDay)]: {
        ...ledger,
        removedSiteTombstone: true,
      },
    },
  };
}

/** Ledgers have no purpose after local midnight, including removal tombstones. */
export function clearExpiredPowLedgers(
  state: StorageState,
  currentScheduleDay: string,
): StorageState {
  const powLedgers = Object.fromEntries(
    Object.entries(state.powLedgers).filter(([, ledger]) => ledger.scheduleDay === currentScheduleDay),
  );
  return { ...state, powLedgers };
}
