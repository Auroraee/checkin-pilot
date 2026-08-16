import { browser } from 'wxt/browser';
import { runAdapterCheckin } from '../src/adapters';
import {
  LegacySessionTransport,
  ModernRefreshTransport,
  ModernSilentTransport,
  openPageSession,
  probeSite,
  type AuthTransport,
} from '../src/auth';
import {
  createPersistentBatch,
  finishBatchOrigin,
  nextEligibleBatchOrigin,
} from '../src/background/batch';
import {
  notifyAuthUpgradeOnce,
  notifyForOutcome,
  registerNotificationNavigation,
} from '../src/background/notifications';
import { setOutcomeBadge } from '../src/background/badge';
import { safeLog } from '../src/background/redaction';
import {
  isSafeEnrollmentLabel,
  validateAuthMode,
  validateCapabilities,
  validateIdentitySource,
  validateOrigin,
  validateSettingsPatch,
  validateUserId,
} from '../src/background/validation';
import {
  readPowBudget,
  recordPowUsage,
  reservePowChallenge,
} from '../src/core/pow-ledger';
import { isStoppedForTheDay, randomSerialDelayMs, selectSitesForTrigger } from '../src/core/queue';
import { createRetryJob, isRetryJobDue } from '../src/core/retry';
import {
  createDailySchedule,
  ensureDailySchedule,
  getDueTrigger,
  markScheduleComplete,
  markScheduleRunning,
  type ScheduleWakeCause,
} from '../src/core/schedule';
import { buildSiteViews, hasSuccessfulCheckinToday, removeSite } from '../src/core/sites';
import { createStateRepository } from '../src/core/storage';
import { localMonthQuery, localScheduleDay } from '../src/core/time';
import { solvePowOffscreen } from '../src/pow/offscreen-client';
import {
  BATCH_ALARM_NAME,
  POW_MAX_DIFFICULTY,
  POW_MAX_WORKER_MS_PER_CHALLENGE,
  POW_MIN_DIFFICULTY,
  RETRY_ALARM_PREFIX,
  SCHEDULE_ALARM_PREFIX,
} from '../src/shared/constants';
import type {
  AppSnapshot,
  CheckinRecord,
  NormalizedOutcome,
  SiteConfig,
  StorageState,
  TriggerKind,
} from '../src/shared/domain';
import {
  isAppRequest,
  isPagePowSolveRequest,
  type AppRequest,
  type AppResponse,
  type EnrollmentConfirmation,
  type PagePowSolveResponse,
} from '../src/shared/messages';
import {
  clearPendingEnrollment,
  readPendingEnrollment,
  writePendingEnrollment,
} from '../src/shared/pending-enrollment';
import { isPageIdentityResult, readPageIdentity } from '../src/shared/identity';
import { originPermissionPattern } from '../src/shared/url';

const DAILY_TICK_ALARM = 'checkin-pilot:daily-tick';

export default defineBackground(() => {
  const repo = createStateRepository(browser.storage.local);
  const runningOrigins = new Set<string>();
  /** tabId -> origin for page sessions currently performing a check-in. */
  const pageSessionTabs = new Map<number, string>();
  /** Per-session task ids already routed, to reject replays. */
  const pagePowTaskIds = new Map<number, Set<string>>();
  let pumping = false;

  /** repo.update mutators receive a draft clone; helpers return fresh states. */
  function replaceState(draft: StorageState, next: StorageState): void {
    if (!('activeBatch' in next)) delete draft.activeBatch;
    Object.assign(draft, next);
  }

  function buildSnapshot(state: StorageState): AppSnapshot {
    const scheduleDay = localScheduleDay();
    const schedule = state.schedules[scheduleDay];
    const snapshot: AppSnapshot = {
      settings: state.settings,
      sites: buildSiteViews(state),
      records: state.records,
      scheduleDay,
      runningOrigins: [...runningOrigins],
    };
    if (schedule) {
      snapshot.currentSchedule = schedule;
      if (schedule.state === 'scheduled' && state.settings.scheduleMode === 'window') {
        snapshot.nextBatchAt = schedule.scheduledAt;
      }
    }
    return snapshot;
  }

  async function snapshotResponse(
    type: 'snapshot' | 'mutation' | 'batch',
  ): Promise<AppResponse> {
    return { ok: true, type, snapshot: buildSnapshot(await repo.read()) };
  }

  async function hasHostPermission(origin: string): Promise<boolean> {
    try {
      return await browser.permissions.contains({
        origins: [originPermissionPattern(origin)],
      });
    } catch {
      return false;
    }
  }

  function scheduleRetryAlarm(jobId: string, dueAt: string): void {
    const when = Date.parse(dueAt);
    if (Number.isFinite(when)) {
      browser.alarms.create(`${RETRY_ALARM_PREFIX}${jobId}`, { when });
    }
  }

  /** Visit mode: the site checks in on its own once a signed-in page loads. */
  async function runVisitCheckin(origin: string): Promise<NormalizedOutcome> {
    let tabId: number | undefined;
    try {
      const tab = await browser.tabs.create({ url: origin, active: false });
      tabId = tab.id;
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      // The site may or may not have checked in; the result is unverified.
      return { code: 'unverified', retryable: false };
    } catch {
      return { code: 'failed', errorCode: 'unknown', retryable: false };
    } finally {
      if (tabId !== undefined) {
        await browser.tabs.remove(tabId).catch(() => undefined);
      }
    }
  }

  /** PoW ledger wiring shared by both service-worker-side auth transports. */
  function buildPowHooks(origin: string, attemptDay: string) {
    return {
      getPowAttemptBudget: async () => {
        const budget = readPowBudget(await repo.read(), origin, attemptDay);
        return {
          allowed: budget.canStart,
          maxMs: Math.min(POW_MAX_WORKER_MS_PER_CHALLENGE, budget.workerMsRemaining),
        };
      },
      onPowChallengeAcquired: async () => {
        const { value } = await repo.update((draft) => {
          const reserved = reservePowChallenge(draft, origin, attemptDay);
          if (!reserved) return false;
          replaceState(draft, reserved);
          return true;
        });
        if (!value) throw new Error('pow_budget_exhausted');
      },
      onPowWorkerUsed: async (elapsedMs: number) => {
        await repo.update((draft) => {
          replaceState(draft, recordPowUsage(draft, origin, attemptDay, elapsedMs));
        });
      },
    };
  }

  /**
   * Builds the auth transport for a site's auth mode. Same-origin-refresh
   * sites run silently in the service worker; only an unauthenticated
   * refresh falls back to a temporary page session.
   */
  async function createTransport(
    site: SiteConfig,
    attemptDay: string,
    onPageFallbackOpened: (tabId: number) => void,
  ): Promise<{ transport: AuthTransport; pageTabId?: number } | undefined> {
    const powHooks = buildPowHooks(site.origin, attemptDay);
    if (site.authMode === 'same-origin-refresh') {
      return {
        transport: new ModernSilentTransport({
          origin: site.origin,
          userId: site.binding.userId,
          solvePow: solvePowOffscreen,
          powMaxMs: POW_MAX_WORKER_MS_PER_CHALLENGE,
          ...powHooks,
          openPageFallback: async () => {
            try {
              const session = await openPageSession(site.origin);
              pageSessionTabs.set(session.tabId, site.origin);
              pagePowTaskIds.set(session.tabId, new Set());
              onPageFallbackOpened(session.tabId);
              return new ModernRefreshTransport(session);
            } catch {
              return undefined;
            }
          },
        }),
      };
    }
    if (site.authMode === 'legacy-session') {
      return {
        transport: new LegacySessionTransport({
          origin: site.origin,
          userId: site.binding.userId,
          solvePow: solvePowOffscreen,
          powMaxMs: POW_MAX_WORKER_MS_PER_CHALLENGE,
          ...powHooks,
        }),
      };
    }
    return undefined;
  }

  /** Runs one bounded attempt for one site, records the outcome, and queues retries. */
  async function executeCheckin(
    origin: string,
    trigger: TriggerKind,
    completedRetries: 0 | 1 | 2 = 0,
    originalTrigger?: Exclude<TriggerKind, 'retry'>,
  ): Promise<NormalizedOutcome> {
    if (runningOrigins.has(origin)) {
      return { code: 'failed', errorCode: 'unknown', retryable: false };
    }
    runningOrigins.add(origin);
    const startedAt = Date.now();
    const attemptDay = localScheduleDay();
    let pageTabId: number | undefined;
    let transport: AuthTransport | undefined;
    try {
      const state = await repo.read();
      const site = state.sites[origin];
      if (!site) return { code: 'failed', errorCode: 'unknown', retryable: false };
      const priorRecords = state.records;

      let outcome: NormalizedOutcome;
      if (site.adapterId === 'visit-open') {
        outcome = await runVisitCheckin(origin);
      } else if (!(await hasHostPermission(origin))) {
        outcome = {
          code: 'action_required',
          actionReason: 'permission_missing',
          errorCode: 'permission_missing',
          retryable: false,
        };
      } else {
        const created = await createTransport(site, attemptDay, (tabId) => {
          pageTabId = tabId;
        });
        transport = created?.transport;
        pageTabId = created?.pageTabId;
        if (transport === undefined) {
          outcome = {
            code: 'action_required',
            actionReason: 'auth_upgrade_required',
            errorCode: 'unsupported_protocol',
            retryable: false,
          };
        } else {
          try {
            outcome = await runAdapterCheckin({
              origin,
              userId: site.binding.userId,
              adapterId: site.adapterId,
              authMode: site.authMode,
              month: localMonthQuery(),
              transport,
            });
          } catch {
            outcome = { code: 'failed', errorCode: 'unknown', retryable: false };
          }
        }
        if (
          outcome.code === 'action_required' &&
          outcome.actionReason === 'sign_in' &&
          site.authMode === 'legacy-session'
        ) {
          // First 401 on a legacy-session site: pause it and prompt the
          // user to update the login method via "Update current site".
          outcome = { ...outcome, actionReason: 'auth_upgrade_required' };
        }
      }

      const durationMs = Date.now() - startedAt;
      let retryScheduled = false;
      await repo.update((draft) => {
        const current = draft.sites[origin];
        if (!current) return;

        const record: CheckinRecord = {
          id: crypto.randomUUID(),
          origin,
          bindingGeneration: current.binding.generation,
          scheduleDay: attemptDay,
          attemptedAt: new Date(startedAt).toISOString(),
          trigger,
          outcome: outcome.code,
          durationMs,
          retryCount: completedRetries,
        };
        if (outcome.reward !== undefined) record.reward = outcome.reward;
        if (outcome.actionReason !== undefined) record.actionReason = outcome.actionReason;
        if (outcome.errorCode !== undefined) record.errorCode = outcome.errorCode;
        draft.records = [record, ...draft.records];

        if (outcome.code === 'success' || outcome.code === 'already_checked') {
          current.binding.state = 'active';
          delete current.binding.actionReason;
        } else if (
          outcome.code === 'action_required' &&
          (outcome.actionReason === 'sign_in' ||
            outcome.actionReason === 'account_changed' ||
            outcome.actionReason === 'rebind_required' ||
            outcome.actionReason === 'auth_upgrade_required')
        ) {
          current.binding.state = 'action_required';
          current.binding.actionReason = outcome.actionReason;
          if (outcome.actionReason === 'auth_upgrade_required') {
            // Paused until the user updates the login method on the site page.
            current.enabled = false;
          }
        }

        const retryBase = trigger === 'retry' ? originalTrigger : trigger;
        if (retryBase !== undefined && retryBase !== 'manual' && completedRetries < 2) {
          const job = createRetryJob({
            origin,
            bindingGeneration: current.binding.generation,
            scheduleDay: attemptDay,
            completedRetries: completedRetries as 0 | 1,
            originalTrigger: retryBase,
            outcome,
          });
          if (job) {
            retryScheduled = true;
            draft.retries = [...draft.retries.filter((existing) => existing.id !== job.id), job];
            scheduleRetryAlarm(job.id, job.dueAt);
          }
        }
      });

      const settings = (await repo.read()).settings;
      // "Notify only once per day" for a repeated action-required or failure condition.
      const alreadyNotified = priorRecords.some(
        (record) =>
          record.origin === origin &&
          record.scheduleDay === attemptDay &&
          record.outcome === outcome.code &&
          record.actionReason === outcome.actionReason &&
          record.errorCode === outcome.errorCode,
      );
      if (!alreadyNotified) {
        await notifyForOutcome(site, outcome, settings, retryScheduled).catch(() => undefined);
      }
      await setOutcomeBadge(outcome.code).catch(() => undefined);
      safeLog('info', 'checkin', {
        origin,
        trigger,
        outcome: outcome.code,
        errorCode: outcome.errorCode,
        durationMs,
      });
      return outcome;
    } finally {
      if (transport !== undefined) {
        await transport.close().catch(() => undefined);
      }
      if (pageTabId !== undefined) {
        pageSessionTabs.delete(pageTabId);
        pagePowTaskIds.delete(pageTabId);
      }
      runningOrigins.delete(origin);
    }
  }

  /** Strictly routed PoW solve from an ISOLATED-world page session. */
  function isValidPagePowRequest(message: {
    tabId: number;
    taskId: string;
    prefix: string;
    difficulty: number;
    maxMs: number;
  }): boolean {
    return (
      Number.isSafeInteger(message.tabId) &&
      message.taskId.length > 0 &&
      message.taskId.length <= 128 &&
      message.prefix.length > 0 &&
      message.prefix.length <= 4_096 &&
      Number.isInteger(message.difficulty) &&
      message.difficulty >= POW_MIN_DIFFICULTY &&
      message.difficulty <= POW_MAX_DIFFICULTY &&
      Number.isFinite(message.maxMs) &&
      message.maxMs > 0 &&
      message.maxMs <= POW_MAX_WORKER_MS_PER_CHALLENGE
    );
  }

  async function handlePagePowSolve(
    senderTabId: number,
    message: {
      tabId: number;
      taskId: string;
      prefix: string;
      difficulty: number;
      maxMs: number;
    },
  ): Promise<PagePowSolveResponse> {
    const origin = pageSessionTabs.get(senderTabId);
    if (origin === undefined || message.tabId !== senderTabId) {
      return { status: 'error', elapsedMs: 0 };
    }
    if (!isValidPagePowRequest(message)) {
      return { status: 'error', elapsedMs: 0 };
    }
    const taskIds = pagePowTaskIds.get(senderTabId);
    if (taskIds === undefined || taskIds.has(message.taskId)) {
      return { status: 'error', elapsedMs: 0 };
    }
    const attemptDay = localScheduleDay();
    const budget = readPowBudget(await repo.read(), origin, attemptDay);
    if (!budget.canStart || budget.workerMsRemaining <= 0) {
      return { status: 'error', elapsedMs: 0, errorCode: 'pow_budget_exhausted' };
    }
    const { value: reserved } = await repo.update((draft) => {
      const next = reservePowChallenge(draft, origin, attemptDay);
      if (!next) return false;
      replaceState(draft, next);
      return true;
    });
    if (!reserved) {
      return { status: 'error', elapsedMs: 0, errorCode: 'pow_budget_exhausted' };
    }
    const maxMs = Math.min(
      POW_MAX_WORKER_MS_PER_CHALLENGE,
      budget.workerMsRemaining,
      Math.max(0, Math.floor(message.maxMs)),
    );
    if (maxMs <= 0) {
      return { status: 'error', elapsedMs: 0, errorCode: 'pow_budget_exhausted' };
    }
    taskIds.add(message.taskId);
    try {
      const solved = await solvePowOffscreen({
        prefix: message.prefix,
        difficulty: message.difficulty,
        maxMs,
      });
      await repo.update((draft) => {
        replaceState(draft, recordPowUsage(draft, origin, attemptDay, solved.elapsedMs));
      });
      return solved;
    } catch {
      return { status: 'error', elapsedMs: 0 };
    }
  }

  function completeScheduleForBatch(
    draft: StorageState,
    trigger: 'scheduled' | 'catchup' | 'run_all',
    scheduleDay: string,
  ): void {
    const schedule = draft.schedules[scheduleDay];
    if (trigger !== 'run_all' && schedule) {
      draft.schedules[scheduleDay] = markScheduleComplete(schedule);
    }
  }

  async function startBatch(trigger: 'scheduled' | 'catchup' | 'run_all'): Promise<void> {
    const now = new Date();
    await repo.update((draft) => {
      if (draft.activeBatch) return;
      const scheduleDay = localScheduleDay(now);
      const sites = selectSitesForTrigger(Object.values(draft.sites), trigger).filter(
        // run_all is explicit; scheduled/catchup skip sites already done today.
        (site) => trigger === 'run_all' || !hasSuccessfulCheckinToday(site, draft.records, scheduleDay),
      ).filter((site) => !isStoppedForTheDay(site, draft.records, scheduleDay));
      const batch = createPersistentBatch(sites, trigger, scheduleDay, now);
      if (batch.pendingOrigins.length === 0) {
        completeScheduleForBatch(draft, trigger, scheduleDay);
        return;
      }
      draft.activeBatch = batch;
      const schedule = draft.schedules[scheduleDay];
      if (trigger !== 'run_all' && schedule) {
        draft.schedules[scheduleDay] = markScheduleRunning(schedule, now);
      }
    });
    void pumpBatch();
  }

  /** Drains the persisted batch one origin at a time; an alarm backstops SW death. */
  async function pumpBatch(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const state = await repo.read();
        const batch = state.activeBatch;
        if (!batch) break;
        if (batch.scheduleDay !== localScheduleDay()) {
          await repo.update((draft) => {
            delete draft.activeBatch;
          });
          break;
        }

        if (batch.nextOriginAt !== undefined) {
          const waitMs = Date.parse(batch.nextOriginAt) - Date.now();
          if (Number.isFinite(waitMs) && waitMs > 0) {
            browser.alarms.create(BATCH_ALARM_NAME, { when: Date.now() + waitMs + 30_000 });
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            continue;
          }
        }

        const origin = nextEligibleBatchOrigin(batch, state);
        if (origin === undefined) {
          await repo.update((draft) => {
            delete draft.activeBatch;
            completeScheduleForBatch(draft, batch.trigger, batch.scheduleDay);
          });
          break;
        }

        await executeCheckin(origin, batch.trigger);
        const nextOriginAt = new Date(Date.now() + randomSerialDelayMs());
        await repo.update((draft) => {
          if (!draft.activeBatch || draft.activeBatch.id !== batch.id) return;
          const remaining = finishBatchOrigin(draft.activeBatch, origin, nextOriginAt);
          if (remaining) {
            draft.activeBatch = remaining;
          } else {
            delete draft.activeBatch;
            completeScheduleForBatch(draft, batch.trigger, batch.scheduleDay);
          }
        });
      }
    } finally {
      pumping = false;
      void browser.alarms.clear(BATCH_ALARM_NAME);
    }
  }

  /** Ensures today's schedule + alarm exist, then runs anything already due. */
  async function ensureScheduleAndWake(cause: ScheduleWakeCause): Promise<void> {
    const now = new Date();
    const { state } = await repo.update((draft) => {
      replaceState(draft, ensureDailySchedule(draft, now).state);
    });
    const scheduleDay = localScheduleDay(now);
    const schedule = state.schedules[scheduleDay];
    if (!schedule) return;

    const scheduledAt = Date.parse(schedule.scheduledAt);
    if (schedule.state === 'scheduled' && scheduledAt > now.getTime()) {
      browser.alarms.create(`${SCHEDULE_ALARM_PREFIX}${scheduleDay}`, { when: scheduledAt });
    }

    for (const job of state.retries) {
      if (isRetryJobDue(job, now)) {
        scheduleRetryAlarm(job.id, new Date(now.getTime() + 1_000).toISOString());
      } else {
        scheduleRetryAlarm(job.id, job.dueAt);
      }
    }

    if (state.activeBatch) {
      void pumpBatch();
      return;
    }
    if (schedule.state === 'running') {
      // The batch died with a previous service worker and normalize dropped it.
      await repo.update((draft) => {
        const stale = draft.schedules[scheduleDay];
        if (stale) draft.schedules[scheduleDay] = markScheduleComplete(stale, now);
      });
      return;
    }

    const due = getDueTrigger(schedule, now, cause);
    if (due) await startBatch(due);
  }

  /** One-time v2 migration notice: "update the login method". */
  async function maybeSendAuthUpgradeNotice(): Promise<void> {
    const state = await repo.read();
    if (state.upgrade.authUpgradeNoticeSent) return;
    const needsNotice = Object.values(state.sites).some(
      (site) => site.binding.actionReason === 'auth_upgrade_required',
    );
    await repo.update((draft) => {
      draft.upgrade.authUpgradeNoticeSent = true;
    });
    if (needsNotice) {
      await notifyAuthUpgradeOnce().catch(() => undefined);
    }
  }

  async function handleRetryAlarm(alarmName: string): Promise<void> {
    const jobId = alarmName.slice(RETRY_ALARM_PREFIX.length);
    const state = await repo.read();
    const job = state.retries.find((candidate) => candidate.id === jobId);
    if (!job) return;
    if (!isRetryJobDue(job)) {
      scheduleRetryAlarm(job.id, job.dueAt);
      return;
    }
    // A site mid-check-in keeps its retry: re-arm briefly instead of burning it.
    if (runningOrigins.has(job.origin)) {
      scheduleRetryAlarm(job.id, new Date(Date.now() + 60_000).toISOString());
      return;
    }
    const site = state.sites[job.origin];
    if (!site || site.binding.generation !== job.bindingGeneration) {
      await repo.update((draft) => {
        draft.retries = draft.retries.filter((candidate) => candidate.id !== jobId);
      });
      return;
    }
    await executeCheckin(job.origin, 'retry', job.retryCount, job.originalTrigger);
    // Consume the job only after the attempt: a service-worker death mid-run
    // leaves a due job that the next wake re-arms and replays safely.
    await repo.update((draft) => {
      draft.retries = draft.retries.filter((candidate) => candidate.id !== jobId);
    });
  }

  function isValidEnrollment(enrollment: unknown): enrollment is EnrollmentConfirmation {
    if (typeof enrollment !== 'object' || enrollment === null) return false;
    const candidate = enrollment as Partial<EnrollmentConfirmation>;
    return (
      validateOrigin(candidate.origin) &&
      validateUserId(candidate.userId) &&
      isSafeEnrollmentLabel(candidate.label) &&
      validateIdentitySource(candidate.identitySource) &&
      validateAuthMode(candidate.authMode) &&
      (candidate.adapterId === 'new-api' ||
        candidate.adapterId === 'runanytime' ||
        candidate.adapterId === 'visit-open') &&
      (candidate.platform === 'new-api' ||
        candidate.platform === 'runanytime' ||
        candidate.platform === 'generic') &&
      (candidate.supportLevel === 'detected' || candidate.supportLevel === 'verified') &&
      validateCapabilities(candidate.capabilities)
    );
  }

  async function handleAppRequest(request: AppRequest): Promise<AppResponse> {
    switch (request.type) {
      case 'snapshot:get':
        return snapshotResponse('snapshot');

      case 'site:probe': {
        if (!validateOrigin(request.origin)) {
          return { ok: false, errorCode: 'invalid_request' };
        }
        if (request.userId !== undefined && !validateUserId(request.userId)) {
          return { ok: false, errorCode: 'invalid_request' };
        }
        if (request.identitySource !== undefined && !validateIdentitySource(request.identitySource)) {
          return { ok: false, errorCode: 'invalid_request' };
        }
        const report = await probeSite({
          origin: request.origin,
          ...(request.userId !== undefined ? { userId: request.userId } : {}),
          ...(request.identitySource !== undefined ? { identitySource: request.identitySource } : {}),
          month: localMonthQuery(),
        });
        return { ok: true, type: 'probe', report };
      }

      case 'site:confirm': {
        const enrollment = request.enrollment;
        if (!isValidEnrollment(enrollment)) {
          return { ok: false, errorCode: 'invalid_request' };
        }
        const existing = (await repo.read()).sites[enrollment.origin];
        await repo.update((draft) => {
          const nowIso = new Date().toISOString();
          const site: SiteConfig = {
            origin: enrollment.origin,
            label: enrollment.label,
            platform: enrollment.platform,
            adapterId: enrollment.adapterId,
            authMode: enrollment.authMode,
            supportLevel: enrollment.supportLevel,
            enabled: true,
            createdAt: existing?.createdAt ?? nowIso,
            updatedAt: nowIso,
            capabilities: enrollment.capabilities,
            binding: {
              userId: enrollment.userId,
              identitySource: enrollment.identitySource,
              generation: crypto.randomUUID(),
              boundAt: nowIso,
              state: 'active',
            },
          };
          draft.sites[enrollment.origin] = site;
        });
        return snapshotResponse('mutation');
      }

      case 'site:upgrade': {
        const enrollment = request.enrollment;
        if (!isValidEnrollment(enrollment)) {
          return { ok: false, errorCode: 'invalid_request' };
        }
        const { value } = await repo.update<
          'ok' | 'site_not_found' | 'account_changed'
        >((draft) => {
          const site = draft.sites[enrollment.origin];
          if (!site) return 'site_not_found';
          // An account change always needs a separately confirmed rebind.
          if (site.binding.userId !== enrollment.userId) return 'account_changed';
          const nowIso = new Date().toISOString();
          draft.sites[enrollment.origin] = {
            ...site,
            label: site.label || enrollment.label,
            platform: enrollment.platform,
            adapterId: enrollment.adapterId,
            authMode: enrollment.authMode,
            supportLevel: enrollment.supportLevel,
            capabilities: enrollment.capabilities,
            enabled: true,
            updatedAt: nowIso,
            binding: {
              userId: site.binding.userId,
              identitySource: enrollment.identitySource,
              generation: site.binding.generation,
              boundAt: site.binding.boundAt,
              state: 'active',
            },
          };
          return 'ok';
        });
        if (value !== 'ok') return { ok: false, errorCode: value };
        return snapshotResponse('mutation');
      }

      case 'site:rebind': {
        if (
          !validateOrigin(request.origin) ||
          !validateUserId(request.userId) ||
          !validateIdentitySource(request.identitySource)
        ) {
          return { ok: false, errorCode: 'invalid_request' };
        }
        if (request.authMode !== undefined && !validateAuthMode(request.authMode)) {
          return { ok: false, errorCode: 'invalid_request' };
        }
        if (
          request.adapterId !== undefined &&
          request.adapterId !== 'new-api' &&
          request.adapterId !== 'runanytime' &&
          request.adapterId !== 'visit-open'
        ) {
          return { ok: false, errorCode: 'invalid_request' };
        }
        if (
          request.platform !== undefined &&
          request.platform !== 'new-api' &&
          request.platform !== 'runanytime' &&
          request.platform !== 'generic'
        ) {
          return { ok: false, errorCode: 'invalid_request' };
        }
        if (
          request.supportLevel !== undefined &&
          request.supportLevel !== 'detected' &&
          request.supportLevel !== 'verified'
        ) {
          return { ok: false, errorCode: 'invalid_request' };
        }
        if (request.capabilities !== undefined && !validateCapabilities(request.capabilities)) {
          return { ok: false, errorCode: 'invalid_request' };
        }
        const { value } = await repo.update((draft) => {
          const site = draft.sites[request.origin];
          if (!site) return false;
          const nowIso = new Date().toISOString();
          draft.sites[request.origin] = {
            ...site,
            ...(request.authMode !== undefined ? { authMode: request.authMode } : {}),
            ...(request.adapterId !== undefined ? { adapterId: request.adapterId } : {}),
            ...(request.platform !== undefined ? { platform: request.platform } : {}),
            ...(request.supportLevel !== undefined ? { supportLevel: request.supportLevel } : {}),
            ...(request.capabilities !== undefined ? { capabilities: request.capabilities } : {}),
            enabled: true,
            updatedAt: nowIso,
            binding: {
              userId: request.userId,
              identitySource: request.identitySource,
              generation: crypto.randomUUID(),
              boundAt: nowIso,
              state: 'active',
            },
          };
          return true;
        });
        if (!value) return { ok: false, errorCode: 'site_not_found' };
        return snapshotResponse('mutation');
      }

      case 'site:set-enabled': {
        const { value } = await repo.update((draft) => {
          const site = draft.sites[request.origin];
          if (!site) return false;
          site.enabled = request.enabled === true;
          site.updatedAt = new Date().toISOString();
          return true;
        });
        if (!value) return { ok: false, errorCode: 'site_not_found' };
        return snapshotResponse('mutation');
      }

      case 'site:remove': {
        if (!validateOrigin(request.origin)) {
          return { ok: false, errorCode: 'invalid_request' };
        }
        const before = await repo.read();
        for (const job of before.retries) {
          if (job.origin === request.origin) {
            void browser.alarms.clear(`${RETRY_ALARM_PREFIX}${job.id}`);
          }
        }
        await repo.update((draft) => {
          replaceState(draft, removeSite(draft, request.origin, localScheduleDay()));
        });
        try {
          await browser.permissions.remove({
            origins: [originPermissionPattern(request.origin)],
          });
        } catch {
          // Removal already succeeded locally; a held permission is user-revocable.
        }
        return snapshotResponse('mutation');
      }

      case 'site:manual-checkin': {
        const state = await repo.read();
        if (!state.sites[request.origin]) {
          return { ok: false, errorCode: 'site_not_found' };
        }
        const outcome = await executeCheckin(request.origin, 'manual');
        return {
          ok: true,
          type: 'checkin',
          outcome,
          snapshot: buildSnapshot(await repo.read()),
        };
      }

      case 'batch:run-all': {
        await startBatch('run_all');
        return snapshotResponse('batch');
      }

      case 'settings:update': {
        const { value } = await repo.update((draft) => {
          const next = validateSettingsPatch(draft.settings, request.patch);
          if (!next) return false;
          const modeChanged = next.scheduleMode !== draft.settings.scheduleMode;
          draft.settings = next;
          if (modeChanged) {
            // Resample an unstarted schedule so the new mode applies today.
            const scheduleDay = localScheduleDay();
            const schedule = draft.schedules[scheduleDay];
            if (schedule && schedule.state === 'scheduled') {
              draft.schedules[scheduleDay] = createDailySchedule(scheduleDay, next);
            }
          }
          return true;
        });
        if (!value) return { ok: false, errorCode: 'invalid_settings' };
        await ensureScheduleAndWake('settings_changed');
        return snapshotResponse('mutation');
      }

      case 'permission:revoke': {
        try {
          await browser.permissions.remove({
            origins: [originPermissionPattern(request.origin)],
          });
        } catch {
          return { ok: false, errorCode: 'invalid_request' };
        }
        return snapshotResponse('mutation');
      }
    }
  }

  /**
   * The optional-permission dialog closes the popup, killing its enrollment
   * flow. When the grant lands, finish the flow here: probe (modern-first)
   * and enroll — or leave a visit-mode offer for the reopened popup.
   */
  async function resumeEnrollmentAfterGrant(): Promise<void> {
    // A surviving popup owns the flow and clears the marker within ~2s.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const marker = await readPendingEnrollment();
    if (!marker || marker.state !== 'awaiting-permission') return;

    if ((await repo.read()).sites[marker.origin]) {
      await clearPendingEnrollment();
      return;
    }
    if (!(await hasHostPermission(marker.origin))) return;

    const tabs = await browser.tabs
      .query({ url: `${marker.origin}/*` })
      .catch(() => []);
    const tabId = tabs.find((tab) => tab.id === marker.tabId)?.id ?? tabs[0]?.id;
    if (tabId === undefined) {
      await clearPendingEnrollment();
      return;
    }

    let identity: unknown;
    try {
      const results = await browser.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: readPageIdentity,
      });
      identity = results[0]?.result;
    } catch {
      identity = undefined;
    }

    const report = await probeSite({
      origin: marker.origin,
      ...(isPageIdentityResult(identity)
        ? { userId: identity.userId, identitySource: identity.identitySource }
        : {}),
      month: localMonthQuery(),
    });
    if (
      !report.supported ||
      !report.adapterId ||
      !report.platform ||
      !report.authMode ||
      !report.supportLevel ||
      !report.capabilities
    ) {
      // A sign-in requirement is not "incompatible": no visit-mode offer.
      if (report.reason === 'sign_in') {
        await clearPendingEnrollment();
        return;
      }
      await writePendingEnrollment({ ...marker, state: 'visit-offer' });
      return;
    }

    const response = await handleAppRequest({
      type: 'site:confirm',
      enrollment: {
        origin: marker.origin,
        label: marker.label,
        userId: report.userId,
        identitySource: report.identitySource,
        adapterId: report.adapterId,
        platform: report.platform,
        authMode: report.authMode,
        supportLevel: report.supportLevel,
        capabilities: report.capabilities,
      },
    });
    if (response.ok) {
      // In-browser feedback only: a toolbar badge now, plus the marker stays
      // so a reopened popup shows the "site enabled" notice and clears it.
      await setOutcomeBadge('success').catch(() => undefined);
    } else {
      await clearPendingEnrollment();
    }
  }

  browser.permissions.onAdded.addListener(() => void resumeEnrollmentAfterGrant());

  browser.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse) => {
      // Page-session PoW solving: strict target/type/taskId routing, and the
      // listener returns true synchronously so the async response survives.
      if (isPagePowSolveRequest(message) && sender.tab?.id !== undefined) {
        handlePagePowSolve(sender.tab.id, message)
          .catch((): PagePowSolveResponse => ({ status: 'error', elapsedMs: 0 }))
          .then(sendResponse);
        return true;
      }
      if (!isAppRequest(message)) return false;
      handleAppRequest(message)
        .catch((error: unknown): AppResponse => {
          safeLog('error', 'request_failed', {
            type: message.type,
            error: error instanceof Error ? error.name : 'unknown',
          });
          return { ok: false, errorCode: 'unknown' };
        })
        .then(sendResponse);
      return true;
    },
  );

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name.startsWith(SCHEDULE_ALARM_PREFIX)) {
      void ensureScheduleAndWake('alarm');
    } else if (alarm.name === BATCH_ALARM_NAME) {
      void pumpBatch();
    } else if (alarm.name.startsWith(RETRY_ALARM_PREFIX)) {
      void handleRetryAlarm(alarm.name);
    } else if (alarm.name === DAILY_TICK_ALARM) {
      void ensureScheduleAndWake('startup');
    }
  });

  registerNotificationNavigation();
  // The periodic tick survives service worker death and rolls the schedule day
  // past local midnight, which also prunes tombstones and stale retries on read.
  browser.alarms.create(DAILY_TICK_ALARM, { periodInMinutes: 30 });
  browser.runtime.onInstalled.addListener(() => {
    void maybeSendAuthUpgradeNotice();
    void ensureScheduleAndWake('startup');
  });
  browser.runtime.onStartup.addListener(() => {
    void maybeSendAuthUpgradeNotice();
    void ensureScheduleAndWake('startup');
  });
  void maybeSendAuthUpgradeNotice();
  void ensureScheduleAndWake('startup');
});
