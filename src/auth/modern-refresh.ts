import { MODERN_REFRESH_PATH } from '../shared/constants';
import type { NormalizedOutcome } from '../shared/domain';
import {
  failedOutcome,
  isApiSuccess,
  isHtmlResponse,
  isRecord,
  outcomeFromHttpStatus,
  outcomeFromThrown,
  readJsonObject,
} from '../adapters/http';
import type { FetchLike } from '../adapters/types';

export type ModernRefreshResult =
  | { kind: 'ok'; authorization: string; account: number }
  | { kind: 'needs_login' }
  | { kind: 'legacy_only' }
  | { kind: 'failed'; outcome: NormalizedOutcome };

export interface ModernRefreshContext {
  origin: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/**
 * Service-worker side refresh for `same-origin-refresh` sites. The request
 * carries the site's cookies through the granted host permission, and the
 * resulting bearer value stays in the caller's local variables: it is never
 * persisted, logged, or forwarded through extension messages.
 */
export async function fetchModernRefresh(
  context: ModernRefreshContext,
): Promise<ModernRefreshResult> {
  // Deployments differ: try POST first (current New API mainline), then GET;
  // only when BOTH return 404/405 is the protocol considered absent.
  const post = await attemptModernRefresh(context, 'POST');
  if (post.kind !== 'legacy_only') return post;
  return attemptModernRefresh(context, 'GET');
}

async function attemptModernRefresh(
  context: ModernRefreshContext,
  method: 'GET' | 'POST',
): Promise<ModernRefreshResult> {
  let url: URL;
  try {
    const parsed = new URL(context.origin);
    if (parsed.protocol !== 'https:' || parsed.origin !== context.origin) {
      return { kind: 'failed', outcome: failedOutcome('unsupported_protocol') };
    }
    url = new URL(MODERN_REFRESH_PATH, parsed);
  } catch {
    return { kind: 'failed', outcome: failedOutcome('unsupported_protocol') };
  }

  const init: RequestInit = {
    method,
    credentials: 'include',
    cache: 'no-store',
    redirect: 'manual',
    headers: { Accept: 'application/json' },
  };
  if (context.signal !== undefined) init.signal = context.signal;

  try {
    const fetcher = context.fetch ?? globalThis.fetch.bind(globalThis);
    const response = await fetcher(url, init);
    if (response.status === 404 || response.status === 405) {
      return { kind: 'legacy_only' };
    }
    const httpFailure = outcomeFromHttpStatus(response);
    if (httpFailure !== undefined) {
      if (httpFailure.code === 'action_required') return { kind: 'needs_login' };
      return { kind: 'failed', outcome: httpFailure };
    }
    if (isHtmlResponse(response)) return { kind: 'needs_login' };
    const payload = await readJsonObject(response);
    if (payload === undefined || !isApiSuccess(payload)) {
      return { kind: 'failed', outcome: failedOutcome('invalid_response') };
    }
    const data = isRecord(payload.data) ? payload.data : undefined;
    if (data === undefined) {
      return { kind: 'failed', outcome: failedOutcome('invalid_response') };
    }
    const token =
      typeof data.access_token === 'string' && data.access_token.length > 0
        ? data.access_token
        : undefined;
    const account = extractRefreshAccount(data);
    if (token === undefined || account === undefined) {
      return { kind: 'failed', outcome: failedOutcome('invalid_response') };
    }
    const tokenType =
      typeof data.token_type === 'string' && data.token_type.length > 0
        ? data.token_type
        : 'Bearer';
    const authorization = /^[A-Za-z]+\s+/.test(token) ? token : `${tokenType} ${token}`;
    return { kind: 'ok', authorization, account };
  } catch (error) {
    return { kind: 'failed', outcome: outcomeFromThrown(error, context.signal) };
  }
}

function extractRefreshAccount(data: Record<string, unknown>): number | undefined {
  const positive = (value: unknown): number | undefined => {
    const candidate =
      typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : value;
    return typeof candidate === 'number' &&
      Number.isSafeInteger(candidate) &&
      candidate > 0
      ? candidate
      : undefined;
  };
  const direct = positive(data.user_id);
  if (direct !== undefined) return direct;
  const directId = positive(data.id);
  if (directId !== undefined) return directId;
  const user = data.user;
  if (isRecord(user)) return positive(user.id);
  return undefined;
}
