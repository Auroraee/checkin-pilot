import { describe, expect, it, vi } from 'vitest';
import { fetchModernRefresh } from '../../../src/auth/modern-refresh';
import type { FetchLike } from '../../../src/adapters/types';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('service-worker refresh', () => {
  it('builds the bearer value and extracts the account', async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({
        success: true,
        data: { access_token: 'tok', token_type: 'Bearer', user: { id: 7 } },
      }),
    );
    await expect(fetchModernRefresh({ origin: 'https://panel.example', fetch: fetcher })).resolves.toEqual({
      kind: 'ok',
      authorization: 'Bearer tok',
      account: 7,
    });
    const [url, init] = fetcher.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://panel.example/api/user/auth/refresh');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
  });

  it('accepts string accounts and pre-composed token values', async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({ success: true, data: { access_token: 'Basic abc', user_id: '42' } }),
    );
    await expect(fetchModernRefresh({ origin: 'https://panel.example', fetch: fetcher })).resolves.toEqual({
      kind: 'ok',
      authorization: 'Basic abc',
      account: 42,
    });
  });

  it('retries with GET only when POST reports the endpoint absent', async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(new Response('', { status: 405 }))
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { access_token: 'tok', id: 9 } }),
      );
    await expect(fetchModernRefresh({ origin: 'https://panel.example', fetch: fetcher })).resolves.toEqual({
      kind: 'ok',
      authorization: 'Bearer tok',
      account: 9,
    });
    const [, secondInit] = fetcher.mock.calls[1] as [URL, RequestInit];
    expect(secondInit.method).toBe('GET');
  });

  it('treats 401/403 and login pages as needs-login, never incompatible', async () => {
    for (const response of [
      new Response('', { status: 401 }),
      new Response('', { status: 403 }),
      new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }),
    ]) {
      const fetcher = vi.fn<FetchLike>().mockResolvedValue(response);
      await expect(
        fetchModernRefresh({ origin: 'https://panel.example', fetch: fetcher }),
      ).resolves.toEqual({ kind: 'needs_login' });
    }
  });

  it('reports absence only when both methods miss', async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(fetchModernRefresh({ origin: 'https://panel.example', fetch: fetcher })).resolves.toEqual({
      kind: 'legacy_only',
    });
  });

  it('keeps rate limits and server errors retryable', async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(fetchModernRefresh({ origin: 'https://panel.example', fetch: fetcher })).resolves.toEqual({
      kind: 'failed',
      outcome: { code: 'failed', errorCode: 'rate_limited', retryable: true, retryAfterMs: 30_000 },
    });
  });

  it('rejects non-HTTPS origins outright', async () => {
    const fetcher = vi.fn<FetchLike>();
    await expect(fetchModernRefresh({ origin: 'http://panel.example', fetch: fetcher })).resolves.toMatchObject({
      kind: 'failed',
      outcome: { errorCode: 'unsupported_protocol' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
