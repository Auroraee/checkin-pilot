import { sha256 } from '@noble/hashes/sha2.js';
import {
  POW_MAX_DIFFICULTY,
  POW_MIN_DIFFICULTY,
} from '../shared/constants';

const HEX = '0123456789abcdef';

export interface FindNonceOptions {
  prefix: string;
  difficulty: number;
  maxMs: number;
  maxCounter?: number;
  now?: () => number;
}

export interface FindNonceResult {
  status: 'solved' | 'timeout' | 'exhausted' | 'invalid';
  elapsedMs: number;
  attempts: number;
  nonce?: string;
}

export function nonceForCounter(counter: number): string {
  if (!Number.isSafeInteger(counter) || counter < 0 || counter > 0xffff_ffff) {
    throw new RangeError('Counter must be an unsigned 32-bit integer.');
  }
  return counter.toString(16).padStart(8, '0');
}

export function countLeadingZeroBits(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      count += 8;
      continue;
    }
    count += Math.clz32(byte) - 24;
    break;
  }
  return count;
}

export function digestMeetsDifficulty(
  digest: Uint8Array,
  difficulty: number,
): boolean {
  return countLeadingZeroBits(digest) >= difficulty;
}

export function findNonce(options: FindNonceOptions): FindNonceResult {
  const now = options.now ?? (() => performance.now());
  const start = now();
  if (
    !Number.isInteger(options.difficulty) ||
    options.difficulty < POW_MIN_DIFFICULTY ||
    options.difficulty > POW_MAX_DIFFICULTY ||
    !Number.isFinite(options.maxMs) ||
    options.maxMs <= 0
  ) {
    return { status: 'invalid', elapsedMs: Math.max(0, now() - start), attempts: 0 };
  }

  const maxCounter = Math.min(
    0xffff_ffff,
    Math.max(0, Math.floor(options.maxCounter ?? 0xffff_ffff)),
  );
  const prefix = new TextEncoder().encode(options.prefix);
  const input = new Uint8Array(prefix.length + 8);
  input.set(prefix);
  const nonceOffset = prefix.length;
  const deadline = start + options.maxMs;

  let attempts = 0;
  for (let counter = 0; counter <= maxCounter; counter += 1) {
    if ((counter & 0xff) === 0 && now() >= deadline) {
      return {
        status: 'timeout',
        elapsedMs: Math.max(0, now() - start),
        attempts,
      };
    }
    writeCounterHex(input, nonceOffset, counter);
    attempts += 1;
    if (digestMeetsDifficulty(sha256(input), options.difficulty)) {
      return {
        status: 'solved',
        nonce: nonceForCounter(counter),
        elapsedMs: Math.max(0, now() - start),
        attempts,
      };
    }
  }
  return {
    status: 'exhausted',
    elapsedMs: Math.max(0, now() - start),
    attempts,
  };
}

function writeCounterHex(target: Uint8Array, offset: number, counter: number): void {
  let value = counter;
  for (let index = 7; index >= 0; index -= 1) {
    target[offset + index] = HEX.charCodeAt(value & 0x0f);
    value = Math.floor(value / 16);
  }
}

