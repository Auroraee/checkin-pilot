import { browser } from 'wxt/browser';
import type {
  GlobalSettings,
  NormalizedOutcome,
  SiteConfig,
} from '../shared/domain';

const NOTIFICATION_PREFIX = 'checkin-pilot:site:';

interface NotificationCopy {
  actionTitle: string;
  actionBody: string;
  failureTitle: string;
  failureBody: string;
  successTitle: string;
  successBody: string;
}

function copyForCurrentLocale(): NotificationCopy {
  const english = browser.i18n.getUILanguage().toLowerCase().startsWith('en');
  return english
    ? {
        actionTitle: 'Check-in needs your attention',
        actionBody: 'Open the site to sign in again or complete its verification.',
        failureTitle: 'Check-in failed',
        failureBody: 'The final bounded attempt failed. Open CheckinPilot for details.',
        successTitle: 'Check-in complete',
        successBody: 'The site confirmed today’s check-in.',
      }
    : {
        actionTitle: '签到需要你的处理',
        actionBody: '请打开站点重新登录或完成交互验证。',
        failureTitle: '签到失败',
        failureBody: '有限次数的最终尝试仍失败，请打开 CheckinPilot 查看。',
        successTitle: '签到完成',
        successBody: '站点已确认今天的签到。',
      };
}

function notificationId(origin: string): string {
  return `${NOTIFICATION_PREFIX}${encodeURIComponent(origin)}`;
}

export async function notifyForOutcome(
  site: SiteConfig,
  outcome: NormalizedOutcome,
  settings: GlobalSettings,
): Promise<void> {
  const copy = copyForCurrentLocale();
  let title: string | undefined;
  let message: string | undefined;

  if (outcome.code === 'action_required') {
    title = copy.actionTitle;
    message = copy.actionBody;
  } else if (outcome.code === 'failed' && !outcome.retryable) {
    title = copy.failureTitle;
    message = copy.failureBody;
  } else if (
    settings.notifyOnSuccess &&
    (outcome.code === 'success' || outcome.code === 'already_checked')
  ) {
    title = copy.successTitle;
    message = copy.successBody;
  }

  if (!title || !message) return;

  await browser.notifications.create(notificationId(site.origin), {
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/128.png'),
    title,
    message: `${site.label}: ${message}`,
  });
}

export function registerNotificationNavigation(): void {
  browser.notifications.onClicked.addListener((id) => {
    if (!id.startsWith(NOTIFICATION_PREFIX)) return;
    const encodedOrigin = id.slice(NOTIFICATION_PREFIX.length);
    try {
      const origin = decodeURIComponent(encodedOrigin);
      const url = new URL('/console/personal', origin).toString();
      void browser.tabs.create({ url });
    } catch {
      // Ignore malformed extension-owned notification IDs.
    }
  });
}
