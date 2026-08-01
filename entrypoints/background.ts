import { browser } from 'wxt/browser';
import {
  probeAdapter,
  runAdapterCheckin,
  RUNANYTIME_ORIGIN,
} from '../src/adapters';
import {
  createPersistentBatch,
  finishBatchOrigin,
  nextEligibleBatchOrigin,
} from '../src/background/batch';
import {
  notifyForOutcome,
  registerNotificationNavigation,
} from '../src/background/notifications';
import { setOutcomeBadge } from '../src/background/badge';
import { safeLog } from '../src/background/redaction';
import {
  isSafeEnrollmentLabel,
  validateOrigin,
  validateSettingsPatch,
  validateUserId,
} from '../src/background/validation';
import {
  readPowBudget,
  recordPowUsage,
  reservePowChallenge,
} from '../src/core/pow-ledger';
import { randomSerialDelayMs, selectSitesForTrigger } from '../src/core/queue';
import { createRetryJob, isRetryJobDue } from '../src/core/retry';
import {
  ensureDailySchedule,
  getDueTrigger,
  markScheduleComplete,
  markScheduleRunning,
  type ScheduleWakeCause,
} from '../src/core/schedule';
import { buildSiteViews, removeSite } from '../src/core/sites';
import { createStateRepository } from '../src/core/storage';
import { localMonthQuery, localScheduleDay } from '../src/core/time';
import { solvePowOffscreen } from '../src/pow/offscreen-client';
import {
  BATCH_ALARM_NAME,
  POW_MAX_WORKER_MS_PER_CHALLENGE,
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
  type AppRequest,
  type AppResponse,
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
      if (schedule.state === 'scheduled') snapshot.nextBatchAt = schedule.scheduledAt;
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
      return { code: 'success', retryable: false };
    } catch {
      return { code: 'failed', errorCode: 'unknown', retryable: false };
    } finally {
      if (tabId !== undefined) {
        await browser.tabs.remove(tabId).catch(() => undefined);
      }
    }
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
    try {
      const state = await repo.read();
      const site = state.sites[origin];
      if (!site) return { code: 'failed', errorCode: 'unknown', retryable: false };

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
        outcome = await runAdapterCheckin({
          origin,
          userId: site.binding.userId,
          adapterId: site.adapterId,
          month: localMonthQuery(),
          solvePow: solvePowOffscreen,
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
          onPowWorkerUsed: async (elapsedMs) => {
            await repo.update((draft) => {
              replaceState(draft, recordPowUsage(draft, origin, attemptDay, elapsedMs));
            });
          },
        });
      }

      const durationMs = Date.now() - startedAt;
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
            outcome.actionReason === 'rebind_required')
        ) {
          current.binding.state = 'action_required';
          current.binding.actionReason = outcome.actionReason;
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
            draft.retries = [...draft.retries.filter((existing) => existing.id !== job.id), job];
            scheduleRetryAlarm(job.id, job.dueAt);
          }
        }
      });

      const settings = (await repo.read()).settings;
      await notifyForOutcome(site, outcome, settings).catch(() => undefined);
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
      runningOrigins.delete(origin);
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
      const sites = selectSitesForTrigger(Object.values(draft.sites), trigger);
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

  async function handleRetryAlarm(alarmName: string): Promise<void> {
    const jobId = alarmName.slice(RETRY_ALARM_PREFIX.length);
    const state = await repo.read();
    const job = state.retries.find((candidate) => candidate.id === jobId);
    if (!job) return;
    if (!isRetryJobDue(job)) {
      scheduleRetryAlarm(job.id, job.dueAt);
      return;
    }
    await repo.update((draft) => {
      draft.retries = draft.retries.filter((candidate) => candidate.id !== jobId);
    });
    const site = state.sites[job.origin];
    if (!site || site.binding.generation !== job.bindingGeneration) return;
    await executeCheckin(job.origin, 'retry', job.retryCount, job.originalTrigger);
  }

  async function handleAppRequest(request: AppRequest): Promise<AppResponse> {
    switch (request.type) {
      case 'snapshot:get':
        return snapshotResponse('snapshot');

      case 'site:probe': {
        if (!validateOrigin(request.origin) || !validateUserId(request.userId)) {
          return { ok: false, errorCode: 'invalid_request' };
        }
        const report = await probeAdapter({
          origin: request.origin,
          userId: request.userId,
          identitySource: request.identitySource,
          month: localMonthQuery(),
        });
        return { ok: true, type: 'probe', report };
      }

      case 'site:confirm': {
        const enrollment = request.enrollment;
        if (
          !validateOrigin(enrollment.origin) ||
          !validateUserId(enrollment.userId) ||
          !isSafeEnrollmentLabel(enrollment.label) ||
          (enrollment.identitySource !== 'uid' && enrollment.identitySource !== 'user.id')
        ) {
          return { ok: false, errorCode: 'invalid_request' };
        }
        const isRunanytime = enrollment.origin === RUNANYTIME_ORIGIN;
        const isVisit = enrollment.adapterId === 'visit-open';
        await repo.update((draft) => {
          const nowIso = new Date().toISOString();
          const existing = draft.sites[enrollment.origin];
          const site: SiteConfig = {
            origin: enrollment.origin,
            label: enrollment.label,
            platform: isVisit ? 'generic' : isRunanytime ? 'runanytime' : 'new-api',
            adapterId: isVisit ? 'visit-open' : isRunanytime ? 'runanytime-pow' : 'new-api-session',
            supportLevel: isRunanytime ? 'verified' : 'detected',
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

      case 'site:rebind': {
        if (!validateOrigin(request.origin) || !validateUserId(request.userId)) {
          return { ok: false, errorCode: 'invalid_request' };
        }
        const { value } = await repo.update((draft) => {
          const site = draft.sites[request.origin];
          if (!site) return false;
          const nowIso = new Date().toISOString();
          draft.sites[request.origin] = {
            ...site,
            updatedAt: nowIso,
            binding: {
              userId: request.userId,
              identitySource: request.identitySource === 'uid' ? 'uid' : 'user.id',
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
          draft.settings = next;
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

      case 'pow:solve-result':
        return { ok: true, type: 'pow-ack' };
    }
  }

  /**
   * The optional-permission dialog closes the popup, killing its enrollment
   * flow. When the grant lands, finish the flow here: read the page identity,
   * probe, and enroll — or leave a visit-mode offer for the reopened popup.
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

    if (!isPageIdentityResult(identity)) {
      await writePendingEnrollment({ ...marker, state: 'visit-offer' });
      return;
    }

    const report = await probeAdapter({
      origin: marker.origin,
      userId: identity.userId,
      identitySource: identity.identitySource,
      month: localMonthQuery(),
    });
    if (
      !report.supported ||
      !report.adapterId ||
      !report.platform ||
      !report.supportLevel ||
      !report.capabilities
    ) {
      await writePendingEnrollment({ ...marker, state: 'visit-offer' });
      return;
    }

    const response = await handleAppRequest({
      type: 'site:confirm',
      enrollment: {
        origin: marker.origin,
        label: marker.label,
        userId: identity.userId,
        identitySource: identity.identitySource,
        adapterId: report.adapterId,
        platform: report.platform,
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
    (message: unknown, _sender, sendResponse: (response: AppResponse) => void) => {
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
  browser.runtime.onInstalled.addListener(() => void ensureScheduleAndWake('startup'));
  browser.runtime.onStartup.addListener(() => void ensureScheduleAndWake('startup'));
  void ensureScheduleAndWake('startup');
});
