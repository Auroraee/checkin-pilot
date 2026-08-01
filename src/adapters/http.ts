import type {
  ActionReason,
  NormalizedOutcome,
  RedactedErrorCode,
} from '../shared/domain';

const ALREADY_CHECKED_PATTERNS = [
  /already\s+(?:checked|check(?:ed)?[ -]?in)/i,
  /checked\s+in\s+today/i,
  /今日已签到/u,
  /今天已签到/u,
  /已经签到/u,
  /已签过到/u,
];

const AUTH_PATTERNS = [
  /not\s+(?:logged|signed)\s+in/i,
  /unauthori[sz]ed/i,
  /invalid\s+(?:session|user)/i,
  /please\s+(?:log|sign)\s+in/i,
  /未登录/u,
  /请(?:先)?登录/u,
  /登录(?:已)?失效/u,
  /用户不存在/u,
];

const TURNSTILE_PATTERNS = [/turnstile/i, /人机验证/u, /安全验证/u];
const CAPTCHA_PATTERNS = [/captcha/i, /验证码/u];
const STALE_POW_PATTERNS = [
  /(?:pow|proof[ -]?of[ -]?work|challenge).*(?:expired|invalid|not found|used)/i,
  /(?:expired|invalid).*(?:pow|proof[ -]?of[ -]?work|challenge)/i,
  /(?:工作量证明|挑战).*(?:过期|无效|不存在|已使用)/u,
];

export function failedOutcome(
  errorCode: RedactedErrorCode,
  retryable = false,
  retryAfterMs?: number,
): NormalizedOutcome {
  const result: NormalizedOutcome = {
    code: 'failed',
    errorCode,
    retryable,
  };
  if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
  return result;
}

export function actionRequiredOutcome(
  actionReason: ActionReason,
  errorCode?: RedactedErrorCode,
): NormalizedOutcome {
  const result: NormalizedOutcome = {
    code: 'action_required',
    actionReason,
    retryable: false,
  };
  if (errorCode !== undefined) result.errorCode = errorCode;
  return result;
}

export function cancelledOutcome(): NormalizedOutcome {
  return { code: 'cancelled', retryable: false };
}

export function parseRetryAfter(
  value: string | null,
  nowMs = Date.now(),
): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (
      Number.isSafeInteger(seconds) &&
      seconds <= Number.MAX_SAFE_INTEGER / 1_000
    ) {
      return seconds * 1_000;
    }
  }

  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - nowMs);
}

export function outcomeFromHttpStatus(
  response: Response,
  nowMs = Date.now(),
): NormalizedOutcome | undefined {
  if (response.ok) return undefined;
  if (
    response.type === 'opaqueredirect' ||
    (response.status >= 300 && response.status <= 399)
  ) {
    return actionRequiredOutcome('sign_in', 'auth_failed');
  }
  if (response.status === 401 || response.status === 403) {
    return actionRequiredOutcome('sign_in', 'auth_failed');
  }
  if (response.status === 429) {
    return failedOutcome(
      'rate_limited',
      true,
      parseRetryAfter(response.headers.get('Retry-After'), nowMs),
    );
  }
  if (response.status >= 500 && response.status <= 599) {
    return failedOutcome('server_error', true);
  }
  return failedOutcome('business_rejected');
}

export function outcomeFromThrown(
  error: unknown,
  signal?: AbortSignal,
): NormalizedOutcome {
  if (
    signal?.aborted === true ||
    (error instanceof DOMException && error.name === 'AbortError')
  ) {
    return cancelledOutcome();
  }
  if (error instanceof TypeError) return failedOutcome('network', true);
  return failedOutcome('unknown');
}

export async function readJsonObject(
  response: Response,
): Promise<Record<string, unknown> | undefined> {
  const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
  if (contentType.includes('text/html')) return undefined;
  try {
    const value: unknown = await response.json();
    if (isRecord(value)) return value;
  } catch {
    // The normalized result intentionally omits parser details and response data.
  }
  return undefined;
}

export function isHtmlResponse(response: Response): boolean {
  return (
    response.headers.get('Content-Type')?.toLowerCase().includes('text/html') ===
    true
  );
}

export function outcomeFromApiFailure(
  message: unknown,
): NormalizedOutcome {
  const normalized = typeof message === 'string' ? message.slice(0, 256) : '';
  if (ALREADY_CHECKED_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { code: 'already_checked', retryable: false };
  }
  if (AUTH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return actionRequiredOutcome('sign_in', 'auth_failed');
  }
  if (TURNSTILE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return actionRequiredOutcome('turnstile');
  }
  if (CAPTCHA_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return actionRequiredOutcome('captcha');
  }
  if (STALE_POW_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return failedOutcome('pow_timeout');
  }
  return failedOutcome('business_rejected');
}

export function getApiMessage(value: Record<string, unknown>): unknown {
  return value.message;
}

export function isApiSuccess(value: Record<string, unknown>): boolean {
  return value.success === true;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sanitizeReward(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, 64);
}
