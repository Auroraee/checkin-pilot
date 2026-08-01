import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import {
  createPowLedger,
  planPowAttempt,
  recordChallengeAcquired,
  recordWorkerUsage,
} from '../../../src/pow/budget';
import {
  countLeadingZeroBits,
  digestMeetsDifficulty,
  findNonce,
  nonceForCounter,
} from '../../../src/pow/solver';

describe('PoW solver', () => {
  it('formats an unsigned counter as eight lower hexadecimal characters', () => {
    expect(nonceForCounter(0)).toBe('00000000');
    expect(nonceForCounter(0x1a2b)).toBe('00001a2b');
    expect(nonceForCounter(0xffff_ffff)).toBe('ffffffff');
    expect(() => nonceForCounter(0x1_0000_0000)).toThrow(RangeError);
  });

  it('counts leading zero bits exactly', () => {
    expect(countLeadingZeroBits(new Uint8Array([0, 0, 0x08]))).toBe(20);
    expect(countLeadingZeroBits(new Uint8Array([0x7f]))).toBe(1);
    expect(countLeadingZeroBits(new Uint8Array([0xff]))).toBe(0);
  });

  it('finds the first valid nonce for SHA256(prefix + nonce)', () => {
    const result = findNonce({ prefix: 'fixture:', difficulty: 10, maxMs: 5_000 });
    expect(result.status).toBe('solved');
    expect(result.nonce).toMatch(/^[0-9a-f]{8}$/);
    const digest = sha256(new TextEncoder().encode(`fixture:${result.nonce}`));
    expect(digestMeetsDifficulty(digest, 10)).toBe(true);
    const counter = Number.parseInt(result.nonce ?? '', 16);
    if (counter > 0) {
      const previous = nonceForCounter(counter - 1);
      expect(
        digestMeetsDifficulty(
          sha256(new TextEncoder().encode(`fixture:${previous}`)),
          10,
        ),
      ).toBe(false);
    }
  });

  it('fails closed for unsupported difficulty and times out on a hard deadline', () => {
    expect(findNonce({ prefix: 'x', difficulty: 21, maxMs: 10 })).toMatchObject({
      status: 'invalid',
      attempts: 0,
    });
    let time = 0;
    const result = findNonce({
      prefix: 'timeout:',
      difficulty: 20,
      maxMs: 1,
      now: () => {
        time += 1;
        return time;
      },
    });
    expect(result.status).toBe('timeout');
  });
});

describe('PoW daily budget helpers', () => {
  it('shares two challenges and 24 seconds across all triggers', () => {
    let ledger = createPowLedger('https://panel.example', '2026-07-31');
    expect(planPowAttempt(ledger)).toEqual({ allowed: true, maxWorkerMs: 12_000 });
    ledger = recordChallengeAcquired(ledger);
    ledger = recordWorkerUsage(ledger, 11_500.1);
    expect(ledger.workerMsUsed).toBe(11_501);
    expect(planPowAttempt(ledger)).toEqual({ allowed: true, maxWorkerMs: 12_000 });
    ledger = recordChallengeAcquired(ledger);
    expect(planPowAttempt(ledger)).toEqual({
      allowed: false,
      maxWorkerMs: 0,
      reason: 'pow_budget_exhausted',
    });
  });

  it('preserves the removal tombstone while recording usage immutably', () => {
    const original = createPowLedger('https://panel.example', '2026-07-31', true);
    const updated = recordWorkerUsage(original, Number.NaN);
    expect(original.workerMsUsed).toBe(0);
    expect(updated).toMatchObject({
      removedSiteTombstone: true,
      workerMsUsed: 12_000,
    });
  });
});

