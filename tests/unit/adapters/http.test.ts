import { describe, expect, it } from 'vitest';
import {
  outcomeFromApiFailure,
  outcomeFromHttpStatus,
  parseRetryAfter,
  readJsonObject,
} from '../../../src/adapters/http';

describe('adapter HTTP normalization', () => {
  it('parses both Retry-After forms without exposing response data', () => {
    expect(parseRetryAfter('15', 0)).toBe(15_000);
    expect(
      parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('2015-10-21T07:27:30Z')),
    ).toBe(30_000);
    expect(parseRetryAfter('not-a-date', 0)).toBeUndefined();
  });

  it('only marks 429 and 5xx HTTP failures retryable', () => {
    const rateLimited = outcomeFromHttpStatus(
      new Response('', { status: 429, headers: { 'Retry-After': '7' } }),
      0,
    );
    expect(rateLimited).toMatchObject({
      code: 'failed',
      errorCode: 'rate_limited',
      retryable: true,
      retryAfterMs: 7_000,
    });
    expect(outcomeFromHttpStatus(new Response('', { status: 503 }))).toMatchObject({
      errorCode: 'server_error',
      retryable: true,
    });
    expect(outcomeFromHttpStatus(new Response('', { status: 400 }))).toMatchObject({
      errorCode: 'business_rejected',
      retryable: false,
    });
  });

  it('normalizes authentication and idempotent business messages', () => {
    expect(outcomeFromApiFailure('今日已签到')).toEqual({
      code: 'already_checked',
      retryable: false,
    });
    expect(outcomeFromApiFailure('Please sign in')).toMatchObject({
      code: 'action_required',
      actionReason: 'sign_in',
      errorCode: 'auth_failed',
    });
    expect(outcomeFromApiFailure('turnstile required')).toMatchObject({
      code: 'action_required',
      actionReason: 'turnstile',
    });
  });

  it('does not try to parse an HTML login page as an API response', async () => {
    const response = new Response('<html>secret login page</html>', {
      headers: { 'Content-Type': 'text/html' },
    });
    await expect(readJsonObject(response)).resolves.toBeUndefined();
  });
});

