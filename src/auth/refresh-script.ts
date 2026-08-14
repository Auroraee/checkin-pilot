/// <reference types="chrome" />

import type { NormalizedOutcome } from '../shared/domain';
import type { ModernProbeResult } from './types';

/**
 * Self-contained scripts executed in the ISOLATED world of an exact
 * same-origin tab via `browser.scripting.executeScript`. They are
 * serialized with `Function.prototype.toString`, so they must not close
 * over module scope: every helper lives inside the exported function body
 * and only built-ins (`fetch`, `URL`, `chrome`, `crypto`, ...) are used.
 *
 * Security boundary (decision doc):
 * - `/api/user/auth/refresh` runs here; the resulting bearer token is kept
 *   in local variables of this function and never crosses into extension
 *   messages, storage, logs, notifications or exceptions.
 * - PoW solving only receives `prefix/difficulty/challengeId` through the
 *   strict `target/type/taskId` routed message; the nonce comes back and
 *   the page submits immediately.
 */

export interface ModernScriptPlan {
  op: 'probe' | 'checkin';
  month: string;
  userId: number;
  powEnabled: boolean;
  powMode: string;
  turnstileCheck: boolean;
  maxPowAttempts: number;
  powMaxMs: number;
  tabId: number;
}

export type ModernScriptRawResult = Record<string, unknown>;

export function modernAuthScript(
  plan: ModernScriptPlan,
): Promise<ModernScriptRawResult> {
  const ALREADY = [
    /already\s+(?:checked|check(?:ed)?[ -]?in)/i,
    /checked\s+in\s+today/i,
    /今日已签到/u,
    /今天已签到/u,
    /已经签到/u,
    /已签过到/u,
  ];
  const AUTH = [
    /not\s+(?:logged|signed)\s+in/i,
    /unauthori[sz]ed/i,
    /invalid\s+(?:session|user)/i,
    /please\s+(?:log|sign)\s+in/i,
    /未登录/u,
    /请(?:先)?登录/u,
    /登录(?:已)?失效/u,
    /用户不存在/u,
  ];
  const TURNSTILE = [/turnstile/i, /人机验证/u, /安全验证/u];
  const CAPTCHA = [/captcha/i, /验证码/u];
  const STALE_POW = [
    /(?:pow|proof[ -]?of[ -]?work|challenge).*(?:expired|invalid|not found|used)/i,
    /(?:expired|invalid).*(?:pow|proof[ -]?of[ -]?work|challenge)/i,
    /(?:工作量证明|挑战).*(?:过期|无效|不存在|已使用)/u,
  ];

  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  return plan.op === 'probe' ? probe(plan) : checkin(plan);

  async function probe(scriptPlan: ModernScriptPlan): Promise<ModernScriptRawResult> {
    const refreshed = await refresh();
    if (refreshed.kind === 'needs_login') return { kind: 'needs_login' };
    if (refreshed.kind === 'legacy_only') return { kind: 'legacy_only' };
    if (refreshed.kind !== 'ok') return failureFromKind(refreshed);
    const current = await status(scriptPlan.month, refreshed.auth, refreshed.account);
    if (current.kind === 'ok') {
      return { kind: 'probe', userId: refreshed.account, checkedInToday: current.checked };
    }
    if (current.kind === 'already_checked') {
      return { kind: 'probe', userId: refreshed.account, checkedInToday: true };
    }
    // A protected status failure never collapses a working refresh into
    // "incompatible": the site is modern-capable, just possibly needs login.
    return { kind: 'probe', userId: refreshed.account };
  }

  async function checkin(scriptPlan: ModernScriptPlan): Promise<ModernScriptRawResult> {
    const refreshed = await refresh();
    if (refreshed.kind === 'needs_login') return actionSignIn();
    if (refreshed.kind === 'legacy_only') {
      return { code: 'unsupported', errorCode: 'unsupported_protocol', retryable: false };
    }
    if (refreshed.kind !== 'ok') return outcomeFromKind(refreshed);
    if (refreshed.account !== scriptPlan.userId) {
      return { code: 'action_required', actionReason: 'account_changed', retryable: false };
    }

    const current = await status(scriptPlan.month, refreshed.auth, refreshed.account);
    if (current.kind === 'already_checked') return { code: 'already_checked', retryable: false };
    if (current.kind === 'needs_login') return actionSignIn();
    if (current.kind !== 'ok') return outcomeFromKind(current);
    if (current.checked) return { code: 'already_checked', retryable: false };

    if (!scriptPlan.powEnabled) {
      if (scriptPlan.turnstileCheck) {
        return { code: 'action_required', actionReason: 'turnstile', retryable: false };
      }
      return submit(refreshed.auth, refreshed.account, {});
    }

    switch (scriptPlan.powMode) {
      case 'supplement':
        return { code: 'action_required', actionReason: 'turnstile', retryable: false };
      case 'fallback':
        if (scriptPlan.turnstileCheck) {
          return { code: 'action_required', actionReason: 'turnstile', retryable: false };
        }
        break;
      case 'replace':
        break;
      default:
        return { code: 'action_required', actionReason: 'unknown_challenge', retryable: false };
    }
    if (scriptPlan.maxPowAttempts <= 0) {
      return {
        code: 'action_required',
        actionReason: 'unknown_challenge',
        errorCode: 'unsupported_protocol',
        retryable: false,
      };
    }
    return powFlow(scriptPlan, refreshed.auth, refreshed.account);
  }

  async function powFlow(
    scriptPlan: ModernScriptPlan,
    auth: string,
    account: number,
  ): Promise<ModernScriptRawResult> {
    for (let attempt = 0; attempt < scriptPlan.maxPowAttempts; attempt += 1) {
      const acquired = await challenge(auth, account);
      if (acquired.kind === 'needs_login') return actionSignIn();
      if (acquired.kind === 'already_checked') return { code: 'already_checked', retryable: false };
      if (acquired.kind !== 'ok') return outcomeFromKind(acquired);

      const solved = await solvePow(scriptPlan, acquired.prefix, acquired.difficulty);
      if (solved.errorCode === 'pow_budget_exhausted') {
        return {
          code: 'action_required',
          actionReason: 'unknown_challenge',
          errorCode: 'pow_budget_exhausted',
          retryable: false,
        };
      }
      if (solved.status === 'cancelled') return { code: 'cancelled', retryable: false };
      if (solved.status === 'error') {
        return { code: 'failed', errorCode: 'unknown', retryable: false };
      }
      if (
        solved.status === 'solved' &&
        typeof solved.nonce === 'string' &&
        /^[0-9a-f]{8}$/.test(solved.nonce)
      ) {
        const submitted = await submit(auth, account, {
          powChallenge: acquired.challengeId,
          powNonce: solved.nonce,
        });
        if (submitted.errorCode !== 'pow_timeout') return submitted;
      }

      const rechecked = await status(scriptPlan.month, auth, account);
      if (rechecked.kind === 'already_checked') return { code: 'already_checked', retryable: false };
      if (rechecked.kind === 'ok' && rechecked.checked) {
        return { code: 'already_checked', retryable: false };
      }
      if (rechecked.kind === 'needs_login') return actionSignIn();
      if (rechecked.kind !== 'ok') return outcomeFromKind(rechecked);
    }
    return {
      code: 'action_required',
      actionReason: 'unknown_challenge',
      errorCode: 'pow_budget_exhausted',
      retryable: false,
    };
  }

  async function refresh(): Promise<RefreshRaw> {
    // Deployments differ: try POST first (current New API mainline), then
    // GET; only when BOTH return 404/405 is the protocol considered absent.
    const post = await attemptRefresh('POST');
    if (post.kind !== 'legacy_only') return post;
    return attemptRefresh('GET');
  }

  async function attemptRefresh(method: 'GET' | 'POST'): Promise<RefreshRaw> {
    let response: Response;
    try {
      response = await fetch('/api/user/auth/refresh', {
        method: method,
        credentials: 'include',
        cache: 'no-store',
        redirect: 'manual',
        headers: { Accept: 'application/json' },
      });
    } catch {
      return { kind: 'network' };
    }
    const html = isHtml(response);
    const redirect = response.type === 'opaqueredirect' || (response.status >= 300 && response.status <= 399);
    if (redirect || html) return { kind: 'needs_login' };
    if (response.status === 401 || response.status === 403) return { kind: 'needs_login' };
    if (response.status === 404 || response.status === 405) return { kind: 'legacy_only' };
    if (response.status === 429) {
      const rateLimited: RefreshRaw = { kind: 'rate_limited' };
      const retryAfter = retryAfterMs(response);
      if (retryAfter !== undefined) rateLimited.retryAfterMs = retryAfter;
      return rateLimited;
    }
    if (response.status >= 500 && response.status <= 599) return { kind: 'server_error' };
    if (!response.ok) return { kind: 'http_error' };
    const payload = await readJson(response);
    if (payload === undefined || payload.success !== true) return { kind: 'invalid_response' };
    const data = payload.data as Record<string, unknown> | null | undefined;
    if (typeof data !== 'object' || data === null) return { kind: 'invalid_response' };
    const token =
      typeof data.access_token === 'string' && data.access_token.length > 0
        ? data.access_token
        : undefined;
    const account = extractAccount(data);
    if (token === undefined || account === undefined) return { kind: 'invalid_response' };
    const tokenType =
      typeof data.token_type === 'string' && data.token_type.length > 0
        ? data.token_type
        : 'Bearer';
    // The full Authorization value stays in this function's local variables.
    const auth = /^[A-Za-z]+\s+/.test(token) ? token : `${tokenType} ${token}`;
    return { kind: 'ok', token, account, auth };
  }

  function extractAccount(data: Record<string, unknown>): number | undefined {
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
    if (typeof user === 'object' && user !== null) {
      return positive((user as Record<string, unknown>).id);
    }
    return undefined;
  }

  async function status(
    month: string,
    auth: string,
    account: number,
  ): Promise<StatusRaw> {
    let response: Response;
    try {
      response = await fetch('/api/user/checkin?month=' + encodeURIComponent(month), {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'manual',
        headers: authHeaders(auth, account),
      });
    } catch {
      return { kind: 'network' };
    }
    if (isHtml(response) || response.type === 'opaqueredirect' || (response.status >= 300 && response.status <= 399)) {
      return { kind: 'needs_login' };
    }
    if (response.status === 401 || response.status === 403) return { kind: 'needs_login' };
    if (response.status === 429) {
      const rateLimited: StatusRaw = { kind: 'rate_limited' };
      const retryAfter = retryAfterMs(response);
      if (retryAfter !== undefined) rateLimited.retryAfterMs = retryAfter;
      return rateLimited;
    }
    if (response.status >= 500 && response.status <= 599) return { kind: 'server_error' };
    if (!response.ok) return { kind: 'http_error' };
    const payload = await readJson(response);
    if (payload === undefined) return { kind: 'invalid_response' };
    if (payload.success !== true) {
      const classified = classifyMessage(payload.message);
      if (classified.code === 'already_checked') return { kind: 'already_checked' };
      return { kind: 'business_rejected', outcome: classified };
    }
    const data = payload.data as Record<string, unknown> | null | undefined;
    const stats = (typeof data === 'object' && data !== null ? data.stats : undefined) as
      | Record<string, unknown>
      | undefined;
    if (typeof stats !== 'object' || stats === null || typeof stats.checked_in_today !== 'boolean') {
      return { kind: 'invalid_response' };
    }
    return { kind: 'ok', checked: stats.checked_in_today };
  }

  async function challenge(
    auth: string,
    account: number,
  ): Promise<ChallengeRaw> {
    let response: Response;
    try {
      response = await fetch('/api/user/pow/challenge?action=checkin', {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'manual',
        headers: authHeaders(auth, account),
      });
    } catch {
      return { kind: 'network' };
    }
    if (isHtml(response) || response.type === 'opaqueredirect' || (response.status >= 300 && response.status <= 399)) {
      return { kind: 'needs_login' };
    }
    if (response.status === 401 || response.status === 403) return { kind: 'needs_login' };
    if (response.status === 429) {
      const rateLimited: ChallengeRaw = { kind: 'rate_limited' };
      const retryAfter = retryAfterMs(response);
      if (retryAfter !== undefined) rateLimited.retryAfterMs = retryAfter;
      return rateLimited;
    }
    if (response.status >= 500 && response.status <= 599) return { kind: 'server_error' };
    if (!response.ok) return { kind: 'http_error' };
    const payload = await readJson(response);
    if (payload === undefined) return { kind: 'invalid_response' };
    if (payload.success !== true) {
      const classified = classifyMessage(payload.message);
      if (classified.code === 'already_checked') return { kind: 'already_checked' };
      return { kind: 'business_rejected', outcome: classified };
    }
    const data = payload.data as Record<string, unknown> | null | undefined;
    if (typeof data !== 'object' || data === null) return { kind: 'invalid_response' };
    const challengeId = data.challenge_id;
    const prefix = data.prefix;
    const difficulty = data.difficulty;
    if (
      typeof challengeId !== 'string' ||
      challengeId.length === 0 ||
      challengeId.length > 512 ||
      typeof prefix !== 'string' ||
      prefix.length === 0 ||
      prefix.length > 4096 ||
      typeof difficulty !== 'number' ||
      !Number.isInteger(difficulty)
    ) {
      return { kind: 'invalid_response' };
    }
    if (difficulty < 10 || difficulty > 20) {
      return { kind: 'difficulty_out_of_range' };
    }
    return { kind: 'ok', challengeId, prefix, difficulty };
  }

  async function submit(
    auth: string,
    account: number,
    options: { powChallenge?: string; powNonce?: string },
  ): Promise<ModernScriptRawResult> {
    let url = '/api/user/checkin';
    if (options.powChallenge !== undefined && options.powNonce !== undefined) {
      url =
        url +
        '?pow_challenge=' +
        encodeURIComponent(options.powChallenge) +
        '&pow_nonce=' +
        encodeURIComponent(options.powNonce);
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'manual',
        headers: authHeaders(auth, account),
      });
    } catch {
      return { code: 'failed', errorCode: 'network', retryable: true };
    }
    if (isHtml(response) || response.type === 'opaqueredirect' || (response.status >= 300 && response.status <= 399)) {
      return actionSignIn();
    }
    if (response.status === 401 || response.status === 403) return actionSignIn();
    if (response.status === 429) {
      return {
        code: 'failed',
        errorCode: 'rate_limited',
        retryable: true,
        retryAfterMs: retryAfterMs(response),
      };
    }
    if (response.status >= 500 && response.status <= 599) {
      return { code: 'failed', errorCode: 'server_error', retryable: true };
    }
    if (!response.ok) {
      return { code: 'failed', errorCode: 'business_rejected', retryable: false };
    }
    const payload = await readJson(response);
    if (payload === undefined) {
      return { code: 'failed', errorCode: 'invalid_response', retryable: false };
    }
    if (payload.success !== true) return classifyMessage(payload.message);
    const reward = extractReward(payload.data);
    const result: ModernScriptRawResult = { code: 'success', retryable: false };
    if (reward !== undefined) result.reward = reward;
    return result;
  }

  async function solvePow(
    scriptPlan: ModernScriptPlan,
    prefix: string,
    difficulty: number,
  ): Promise<SolveRaw> {
    const taskId = crypto.randomUUID();
    let response: unknown;
    try {
      response = await chrome.runtime.sendMessage({
        target: 'background',
        type: 'pow:solve',
        tabId: scriptPlan.tabId,
        taskId: taskId,
        prefix: prefix,
        difficulty: difficulty,
        maxMs: Math.max(0, Math.floor(scriptPlan.powMaxMs)),
      });
    } catch {
      return { status: 'error', elapsedMs: 0 };
    }
    if (typeof response !== 'object' || response === null) {
      return { status: 'error', elapsedMs: 0 };
    }
    const candidate = response as Partial<SolveRaw>;
    if (
      candidate.status !== 'solved' &&
      candidate.status !== 'timeout' &&
      candidate.status !== 'cancelled' &&
      candidate.status !== 'error'
    ) {
      return { status: 'error', elapsedMs: 0 };
    }
    const result: SolveRaw = {
      status: candidate.status,
      elapsedMs:
        typeof candidate.elapsedMs === 'number' && Number.isFinite(candidate.elapsedMs)
          ? Math.max(0, candidate.elapsedMs)
          : 0,
    };
    if (typeof candidate.nonce === 'string' && /^[0-9a-f]{8}$/.test(candidate.nonce)) {
      result.nonce = candidate.nonce;
    }
    if (candidate.errorCode === 'pow_budget_exhausted') {
      result.errorCode = 'pow_budget_exhausted';
    }
    return result;
  }

  function authHeaders(auth: string, account: number): Record<string, string> {
    return {
      Accept: 'application/json',
      Authorization: auth,
      'New-Api-User': String(account),
    };
  }

  async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
    if (isHtml(response)) return undefined;
    try {
      const value: unknown = await response.json();
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Parser details and response data intentionally never cross the boundary.
    }
    return undefined;
  }

  function isHtml(response: Response): boolean {
    return (response.headers.get('Content-Type') ?? '').toLowerCase().includes('text/html');
  }

  function retryAfterMs(response: Response): number | undefined {
    const value = response.headers.get('Retry-After');
    if (value === null) return undefined;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const seconds = Number.parseInt(trimmed, 10);
      if (Number.isSafeInteger(seconds)) return seconds * 1000;
    }
    const timestamp = Date.parse(trimmed);
    if (!Number.isFinite(timestamp)) return undefined;
    return Math.max(0, timestamp - Date.now());
  }

  function extractReward(dataValue: unknown): string | undefined {
    if (typeof dataValue !== 'object' || dataValue === null || Array.isArray(dataValue)) return undefined;
    for (const key of ['reward', 'amount', 'quota_awarded']) {
      const reward = sanitizeReward((dataValue as Record<string, unknown>)[key]);
      if (reward !== undefined) return reward;
    }
    return undefined;
  }

  function sanitizeReward(value: unknown): string | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value !== 'string') return undefined;
    const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (cleaned.length === 0) return undefined;
    return cleaned.slice(0, 64);
  }

  function classifyMessage(message: unknown): ModernScriptRawResult {
    const text = typeof message === 'string' ? message.slice(0, 256) : '';
    if (ALREADY.some((pattern) => pattern.test(text))) {
      return { code: 'already_checked', retryable: false };
    }
    if (AUTH.some((pattern) => pattern.test(text))) return actionSignIn();
    if (TURNSTILE.some((pattern) => pattern.test(text))) {
      return { code: 'action_required', actionReason: 'turnstile', retryable: false };
    }
    if (CAPTCHA.some((pattern) => pattern.test(text))) {
      return { code: 'action_required', actionReason: 'captcha', retryable: false };
    }
    if (STALE_POW.some((pattern) => pattern.test(text))) {
      return { code: 'failed', errorCode: 'pow_timeout', retryable: false };
    }
    return { code: 'failed', errorCode: 'business_rejected', retryable: false };
  }

  function actionSignIn(): ModernScriptRawResult {
    return {
      code: 'action_required',
      actionReason: 'sign_in',
      errorCode: 'auth_failed',
      retryable: false,
    };
  }

  function failureFromKind(kind: RefreshRaw | StatusRaw | ChallengeRaw): ModernScriptRawResult {
    if (kind.kind === 'network') return { kind: 'failure', errorCode: 'network', retryable: true };
    if (kind.kind === 'rate_limited') {
      const result: ModernScriptRawResult = { kind: 'failure', errorCode: 'rate_limited', retryable: true };
      if (kind.retryAfterMs !== undefined) result.retryAfterMs = kind.retryAfterMs;
      return result;
    }
    if (kind.kind === 'server_error') {
      return { kind: 'failure', errorCode: 'server_error', retryable: true };
    }
    if (kind.kind === 'invalid_response') {
      return { kind: 'failure', errorCode: 'invalid_response', retryable: false };
    }
    return { kind: 'failure', errorCode: 'business_rejected', retryable: false };
  }

  function outcomeFromKind(kind: RefreshRaw | StatusRaw | ChallengeRaw): ModernScriptRawResult {
    if (kind.kind === 'network') return { code: 'failed', errorCode: 'network', retryable: true };
    if (kind.kind === 'rate_limited') {
      const result: ModernScriptRawResult = { code: 'failed', errorCode: 'rate_limited', retryable: true };
      if (kind.retryAfterMs !== undefined) result.retryAfterMs = kind.retryAfterMs;
      return result;
    }
    if (kind.kind === 'server_error') {
      return { code: 'failed', errorCode: 'server_error', retryable: true };
    }
    if (kind.kind === 'invalid_response') {
      return { code: 'failed', errorCode: 'invalid_response', retryable: false };
    }
    if (kind.kind === 'difficulty_out_of_range') {
      return { code: 'failed', errorCode: 'pow_difficulty_out_of_range', retryable: false };
    }
    if (kind.kind === 'business_rejected' && kind.outcome !== undefined) return kind.outcome;
    return { code: 'failed', errorCode: 'business_rejected', retryable: false };
  }
}

type RefreshRaw =
  | { kind: 'ok'; token: string; account: number; auth: string }
  | { kind: 'needs_login' }
  | { kind: 'legacy_only' }
  | { kind: 'network' }
  | { kind: 'rate_limited'; retryAfterMs?: number }
  | { kind: 'server_error' }
  | { kind: 'http_error' }
  | { kind: 'invalid_response' };

type StatusRaw =
  | { kind: 'ok'; checked: boolean }
  | { kind: 'already_checked' }
  | { kind: 'needs_login' }
  | { kind: 'network' }
  | { kind: 'rate_limited'; retryAfterMs?: number }
  | { kind: 'server_error' }
  | { kind: 'http_error' }
  | { kind: 'invalid_response' }
  | { kind: 'business_rejected'; outcome: ModernScriptRawResult };

type ChallengeRaw =
  | { kind: 'ok'; challengeId: string; prefix: string; difficulty: number }
  | { kind: 'already_checked' }
  | { kind: 'needs_login' }
  | { kind: 'network' }
  | { kind: 'rate_limited'; retryAfterMs?: number }
  | { kind: 'server_error' }
  | { kind: 'http_error' }
  | { kind: 'invalid_response' }
  | { kind: 'difficulty_out_of_range' }
  | { kind: 'business_rejected'; outcome: ModernScriptRawResult };

interface SolveRaw {
  status: 'solved' | 'timeout' | 'cancelled' | 'error';
  nonce?: string;
  elapsedMs: number;
  errorCode?: 'pow_budget_exhausted';
}

/**
 * Service-worker side validators: every branch of the raw script result is
 * checked before it becomes a domain outcome.
 */

const OUTCOME_CODES = [
  'success',
  'already_checked',
  'action_required',
  'failed',
  'unsupported',
  'cancelled',
] as const;
const ACTION_REASONS = [
  'sign_in',
  'account_changed',
  'turnstile',
  'captcha',
  'unknown_challenge',
] as const;
const ERROR_CODES = [
  'network',
  'rate_limited',
  'server_error',
  'auth_failed',
  'business_rejected',
  'invalid_response',
  'unsupported_protocol',
  'pow_budget_exhausted',
  'pow_difficulty_out_of_range',
  'pow_timeout',
  'unknown',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeOutcome(value: unknown): NormalizedOutcome | undefined {
  if (!isRecord(value) || typeof value.retryable !== 'boolean') return undefined;
  if (!OUTCOME_CODES.includes(value.code as (typeof OUTCOME_CODES)[number])) return undefined;
  const outcome: NormalizedOutcome = {
    code: value.code as (typeof OUTCOME_CODES)[number],
    retryable: value.retryable,
  };
  if (typeof value.reward === 'string' && value.reward.length <= 64) outcome.reward = value.reward;
  if (
    typeof value.actionReason === 'string' &&
    ACTION_REASONS.includes(value.actionReason as (typeof ACTION_REASONS)[number])
  ) {
    outcome.actionReason = value.actionReason as (typeof ACTION_REASONS)[number];
  }
  if (
    typeof value.errorCode === 'string' &&
    ERROR_CODES.includes(value.errorCode as (typeof ERROR_CODES)[number])
  ) {
    outcome.errorCode = value.errorCode as (typeof ERROR_CODES)[number];
  }
  if (typeof value.retryAfterMs === 'number' && Number.isFinite(value.retryAfterMs)) {
    outcome.retryAfterMs = Math.max(0, value.retryAfterMs);
  }
  return outcome;
}

export function normalizeProbeScriptResult(value: unknown): ModernProbeResult {
  if (!isRecord(value)) return { kind: 'failure', outcome: { code: 'failed', errorCode: 'invalid_response', retryable: false } };
  if (value.kind === 'needs_login') return { kind: 'needs_login' };
  if (value.kind === 'legacy_only') return { kind: 'legacy_only' };
  if (value.kind === 'probe') {
    if (
      typeof value.userId !== 'number' ||
      !Number.isSafeInteger(value.userId) ||
      value.userId <= 0
    ) {
      return { kind: 'failure', outcome: { code: 'failed', errorCode: 'invalid_response', retryable: false } };
    }
    const result: ModernProbeResult = { kind: 'modern', userId: value.userId };
    if (typeof value.checkedInToday === 'boolean') {
      result.checkedInToday = value.checkedInToday;
    }
    return result;
  }
  if (value.kind === 'failure') {
    const outcome = normalizeOutcome(value);
    if (outcome !== undefined) return { kind: 'failure', outcome };
  }
  return { kind: 'failure', outcome: { code: 'failed', errorCode: 'invalid_response', retryable: false } };
}

export function normalizeFlowScriptResult(value: unknown): NormalizedOutcome {
  const outcome = normalizeOutcome(value);
  if (outcome !== undefined) return outcome;
  return { code: 'failed', errorCode: 'invalid_response', retryable: false };
}
