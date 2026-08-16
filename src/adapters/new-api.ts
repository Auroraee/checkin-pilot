import type {
  NormalizedOutcome,
  PowMode,
  SiteCapabilities,
} from '../shared/domain';
import {
  actionRequiredOutcome,
  failedOutcome,
  getApiMessage,
  isApiSuccess,
  isHtmlResponse,
  isRecord,
  outcomeFromApiFailure,
  outcomeFromHttpStatus,
  outcomeFromThrown,
  readJsonObject,
  sanitizeReward,
} from './http';
import type {
  AdapterContext,
  AdapterOperationResult,
  CheckinStatus,
  FetchLike,
  PublicSiteStatus,
} from './types';
import type { CheckinFlowPlan } from '../auth/types';

export interface NewApiRequestContext {
  origin: string;
  userId: number;
  month?: string;
  /** Full Authorization header value (bearer) for refresh-authenticated calls. */
  authorization?: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

export interface CheckinSubmitOptions {
  powChallenge?: string;
  powNonce?: string;
}

export function currentLocalMonth(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export async function fetchPublicStatus(
  context: NewApiRequestContext,
): Promise<AdapterOperationResult<PublicSiteStatus>> {
  const request = getPublicRequestParts(context);
  if (!request.ok) return request;

  try {
    const response = await request.fetch(
      new URL('/api/status', request.origin),
      requestInit('GET', context.signal, false),
    );
    const httpFailure = outcomeFromHttpStatus(response);
    if (httpFailure !== undefined) return { ok: false, outcome: httpFailure };
    if (isHtmlResponse(response)) {
      return {
        ok: false,
        outcome: actionRequiredOutcome('sign_in', 'auth_failed'),
      };
    }
    const payload = await readJsonObject(response);
    if (payload === undefined || !isApiSuccess(payload)) {
      return { ok: false, outcome: failedOutcome('unsupported_protocol') };
    }
    const data = isRecord(payload.data) ? payload.data : undefined;
    if (data === undefined || typeof data.checkin_enabled !== 'boolean') {
      return { ok: false, outcome: failedOutcome('unsupported_protocol') };
    }

    const powMode = parsePowMode(data.pow_mode);
    return {
      ok: true,
      value: {
        checkinEnabled: data.checkin_enabled,
        turnstileCheck: data.turnstile_check === true,
        powEnabled: data.pow_enabled === true,
        powMode,
      },
    };
  } catch (error) {
    return { ok: false, outcome: outcomeFromThrown(error, context.signal) };
  }
}

export async function getCheckinStatus(
  context: NewApiRequestContext,
): Promise<AdapterOperationResult<CheckinStatus>> {
  const request = getRequestParts(context);
  if (!request.ok) return request;
  const month = context.month ?? currentLocalMonth();
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) {
    return { ok: false, outcome: failedOutcome('invalid_response') };
  }

  const url = new URL('/api/user/checkin', request.origin);
  url.searchParams.set('month', month);
  try {
    const response = await request.fetch(
      url,
      requestInit('GET', context.signal, true, request.userId, request.authorization),
    );
    const httpFailure = outcomeFromHttpStatus(response);
    if (httpFailure !== undefined) return { ok: false, outcome: httpFailure };
    if (isHtmlResponse(response)) {
      return {
        ok: false,
        outcome: actionRequiredOutcome('sign_in', 'auth_failed'),
      };
    }
    const payload = await readJsonObject(response);
    if (payload === undefined) {
      return { ok: false, outcome: failedOutcome('invalid_response') };
    }
    if (!isApiSuccess(payload)) {
      const outcome = outcomeFromApiFailure(getApiMessage(payload));
      if (outcome.code === 'already_checked') {
        return { ok: true, value: { checkedInToday: true } };
      }
      return { ok: false, outcome };
    }

    const data = isRecord(payload.data) ? payload.data : undefined;
    const stats = data !== undefined && isRecord(data.stats) ? data.stats : undefined;
    if (stats === undefined || typeof stats.checked_in_today !== 'boolean') {
      return { ok: false, outcome: failedOutcome('invalid_response') };
    }
    return {
      ok: true,
      value: { checkedInToday: stats.checked_in_today },
    };
  } catch (error) {
    return { ok: false, outcome: outcomeFromThrown(error, context.signal) };
  }
}

export async function postCheckin(
  context: NewApiRequestContext,
  options: CheckinSubmitOptions = {},
): Promise<NormalizedOutcome> {
  const request = getRequestParts(context);
  if (!request.ok) return request.outcome;

  const url = new URL('/api/user/checkin', request.origin);
  if (options.powChallenge !== undefined) {
    url.searchParams.set('pow_challenge', options.powChallenge);
  }
  if (options.powNonce !== undefined) {
    url.searchParams.set('pow_nonce', options.powNonce);
  }

  try {
    const response = await request.fetch(
      url,
      requestInit('POST', context.signal, true, request.userId, request.authorization),
    );
    const httpFailure = outcomeFromHttpStatus(response);
    if (httpFailure !== undefined) return httpFailure;
    if (isHtmlResponse(response)) {
      return actionRequiredOutcome('sign_in', 'auth_failed');
    }
    const payload = await readJsonObject(response);
    if (payload === undefined) return failedOutcome('invalid_response');
    if (!isApiSuccess(payload)) return outcomeFromApiFailure(getApiMessage(payload));

    const outcome: NormalizedOutcome = { code: 'success', retryable: false };
    const reward = extractReward(payload.data);
    if (reward !== undefined) outcome.reward = reward;
    return outcome;
  } catch (error) {
    return outcomeFromThrown(error, context.signal);
  }
}

export async function runNewApiCheckin(
  context: AdapterContext,
): Promise<NormalizedOutcome> {
  const publicStatus = await fetchPublicStatus({
    origin: context.origin,
    userId: context.userId,
    ...(context.fetch !== undefined ? { fetch: context.fetch } : {}),
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });
  if (!publicStatus.ok) return publicStatus.outcome;
  if (!publicStatus.value.checkinEnabled) {
    return { code: 'unsupported', errorCode: 'unsupported_protocol', retryable: false };
  }
  const plan: CheckinFlowPlan = {
    month: context.month,
    userId: context.userId,
    powEnabled: publicStatus.value.powEnabled,
    powMode: publicStatus.value.powMode,
    turnstileCheck: publicStatus.value.turnstileCheck,
    maxPowAttempts: 0,
    powMaxMs: 0,
  };
  return context.transport.runCheckinFlow(plan);
}

export function capabilitiesFromStatus(status: PublicSiteStatus): SiteCapabilities {
  const capabilities: SiteCapabilities = {
    checkin: status.checkinEnabled,
    statusEndpoint: true,
  };
  if (status.powEnabled) {
    capabilities.pow = {
      enabled: true,
      mode: status.powMode,
      turnstileCheck: status.turnstileCheck,
    };
  }
  return capabilities;
}

/** Public endpoints need an origin only; no session identity is required. */
function getPublicRequestParts(
  context: NewApiRequestContext,
):
  | { ok: true; origin: string; fetch: FetchLike }
  | { ok: false; outcome: NormalizedOutcome } {
  try {
    const parsed = new URL(context.origin);
    if (parsed.protocol !== 'https:' || parsed.origin !== context.origin) {
      return { ok: false, outcome: failedOutcome('unsupported_protocol') };
    }
    return {
      ok: true,
      origin: parsed.origin,
      fetch: context.fetch ?? globalThis.fetch.bind(globalThis),
    };
  } catch {
    return { ok: false, outcome: failedOutcome('unsupported_protocol') };
  }
}

function getRequestParts(
  context: NewApiRequestContext,
):
  | { ok: true; origin: string; userId: number; authorization?: string; fetch: FetchLike }
  | { ok: false; outcome: NormalizedOutcome } {
  if (!Number.isSafeInteger(context.userId) || context.userId <= 0) {
    return { ok: false, outcome: actionRequiredOutcome('rebind_required', 'auth_failed') };
  }
  try {
    const parsed = new URL(context.origin);
    if (parsed.protocol !== 'https:' || parsed.origin !== context.origin) {
      return { ok: false, outcome: failedOutcome('unsupported_protocol') };
    }
    return {
      ok: true,
      origin: parsed.origin,
      userId: context.userId,
      ...(context.authorization !== undefined ? { authorization: context.authorization } : {}),
      fetch: context.fetch ?? globalThis.fetch.bind(globalThis),
    };
  } catch {
    return { ok: false, outcome: failedOutcome('unsupported_protocol') };
  }
}

function requestInit(
  method: 'GET' | 'POST',
  signal: AbortSignal | undefined,
  authenticated: boolean,
  userId?: number,
  authorization?: string,
): RequestInit {
  const headers = new Headers({ Accept: 'application/json' });
  if (authenticated && userId !== undefined) {
    headers.set('New-Api-User', String(userId));
  }
  if (authenticated && authorization !== undefined) {
    headers.set('Authorization', authorization);
  }
  const init: RequestInit = {
    method,
    credentials: 'include',
    cache: 'no-store',
    redirect: 'manual',
    headers,
  };
  if (signal !== undefined) init.signal = signal;
  return init;
}

function parsePowMode(value: unknown): PowMode {
  if (value === 'replace' || value === 'supplement' || value === 'fallback') {
    return value;
  }
  return 'unknown';
}

function extractReward(dataValue: unknown): string | undefined {
  if (!isRecord(dataValue)) return undefined;
  for (const key of ['reward', 'amount', 'quota_awarded']) {
    const reward = sanitizeReward(dataValue[key]);
    if (reward !== undefined) return reward;
  }
  return undefined;
}
