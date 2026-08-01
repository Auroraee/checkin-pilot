/// <reference types="chrome" />

import { POW_MAX_WORKER_MS_PER_CHALLENGE } from '../shared/constants';
import type {
  OffscreenRequest,
  PowWorkerResult,
} from '../shared/messages';
import type { PowSolveInput, PowSolveResult } from '../adapters/types';

const OFFSCREEN_PATH = 'offscreen.html';
let activeTaskId: string | undefined;
let creationPromise: Promise<void> | undefined;

export async function solvePowOffscreen(
  input: PowSolveInput,
): Promise<PowSolveResult> {
  if (activeTaskId !== undefined) return { status: 'error', elapsedMs: 0 };
  const taskId = crypto.randomUUID();
  activeTaskId = taskId;
  let abortHandler: (() => void) | undefined;
  try {
    await ensureOffscreenDocument();
    if (input.signal?.aborted === true) {
      return { status: 'cancelled', elapsedMs: 0 };
    }
    abortHandler = () => {
      void cancelPowOffscreen(taskId);
    };
    input.signal?.addEventListener('abort', abortHandler, { once: true });
    const request: OffscreenRequest = {
      type: 'pow:solve',
      taskId,
      prefix: input.prefix,
      difficulty: input.difficulty,
      maxMs: Math.min(
        POW_MAX_WORKER_MS_PER_CHALLENGE,
        Math.max(0, Math.floor(input.maxMs)),
      ),
    };
    const response: unknown = await chrome.runtime.sendMessage(request);
    return normalizeWorkerResult(response);
  } catch {
    return input.signal?.aborted === true
      ? { status: 'cancelled', elapsedMs: 0 }
      : { status: 'error', elapsedMs: 0 };
  } finally {
    if (abortHandler !== undefined) {
      input.signal?.removeEventListener('abort', abortHandler);
    }
    activeTaskId = undefined;
    await closeOffscreenDocument();
  }
}

export async function cancelActivePow(): Promise<void> {
  if (activeTaskId !== undefined) await cancelPowOffscreen(activeTaskId);
}

export async function cancelPowOffscreen(taskId: string): Promise<void> {
  const request: OffscreenRequest = { type: 'pow:cancel', taskId };
  try {
    await chrome.runtime.sendMessage(request);
  } catch {
    // The solve call owns cleanup; cancellation remains best effort here.
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  if (creationPromise !== undefined) return creationPromise;
  creationPromise = (async () => {
    const hasDocument = await hasOffscreenDocument();
    if (hasDocument) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Run a bounded worker for an enabled site check-in challenge.',
    });
  })();
  try {
    await creationPromise;
  } finally {
    creationPromise = undefined;
  }
}

async function hasOffscreenDocument(): Promise<boolean> {
  if (typeof chrome.offscreen.hasDocument === 'function') {
    return chrome.offscreen.hasDocument();
  }
  const serviceWorkerClients = (
    globalThis as typeof globalThis & {
      clients?: { matchAll(): Promise<readonly { url: string }[]> };
    }
  ).clients;
  if (serviceWorkerClients === undefined) return false;
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const matches = await serviceWorkerClients.matchAll();
  return matches.some((client) => client.url === offscreenUrl);
}

async function closeOffscreenDocument(): Promise<void> {
  try {
    if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
  } catch {
    // A terminated or already closed document needs no further cleanup.
  }
}

function normalizeWorkerResult(value: unknown): PowWorkerResult {
  if (typeof value !== 'object' || value === null) {
    return { status: 'error', elapsedMs: 0 };
  }
  const result = value as Partial<PowWorkerResult>;
  if (
    result.status !== 'solved' &&
    result.status !== 'timeout' &&
    result.status !== 'cancelled' &&
    result.status !== 'error'
  ) {
    return { status: 'error', elapsedMs: 0 };
  }
  const normalized: PowWorkerResult = {
    status: result.status,
    elapsedMs:
      typeof result.elapsedMs === 'number' && Number.isFinite(result.elapsedMs)
        ? Math.max(0, result.elapsedMs)
        : 0,
  };
  if (typeof result.nonce === 'string' && /^[0-9a-f]{8}$/.test(result.nonce)) {
    normalized.nonce = result.nonce;
  }
  return normalized;
}
