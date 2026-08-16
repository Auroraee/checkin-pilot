import { browser } from 'wxt/browser';
import type {
  ActionReason,
  GlobalSettings,
  NormalizedOutcome,
  SiteConfig,
} from '../shared/domain';

const NOTIFICATION_PREFIX = 'checkin-pilot:site:';
const UPGRADE_NOTIFICATION_ID = 'checkin-pilot:auth-upgrade';

interface NotificationCopy {
  actionTitle: string;
  failureTitle: string;
  failureBody: string;
  successTitle: string;
  successBody: string;
  upgradeTitle: string;
  upgradeBody: string;
}

function isEnglishLocale(): boolean {
  return browser.i18n.getUILanguage().toLowerCase().startsWith('en');
}

function copyForCurrentLocale(): NotificationCopy {
  return isEnglishLocale()
    ? {
        actionTitle: 'Check-in needs your attention',
        failureTitle: 'Check-in failed',
        failureBody: 'The final bounded attempt failed. Open CheckinPilot for details.',
        successTitle: 'Check-in complete',
        successBody: 'The site confirmed today’s check-in.',
        upgradeTitle: 'Update the sign-in method',
        upgradeBody: 'Some sites now require a refreshed login. Open the site page and click “Update current site” to re-enable them.',
      }
    : {
        actionTitle: '签到需要你的处理',
        failureTitle: '签到失败',
        failureBody: '有限次数的最终尝试仍失败，请打开 CheckinPilot 查看。',
        successTitle: '签到完成',
        successBody: '站点已确认今天的签到。',
        upgradeTitle: '更新登录方式',
        upgradeBody: '部分站点已改用新的登录方式。打开站点页面并点击「更新当前网站」即可重新启用。',
      };
}

function actionBodyForReason(reason: ActionReason | undefined): string {
  const english = isEnglishLocale();
  switch (reason) {
    case 'sign_in':
      return english
        ? 'Your site session expired. Sign in on the site again.'
        : '站点登录已失效，请到站点重新登录。';
    case 'account_changed':
    case 'rebind_required':
      return english
        ? 'The signed-in account changed. Rebind the site from its page.'
        : '站点登录账号已变化，请在站点页面重新绑定。';
    case 'auth_upgrade_required':
      return english
        ? 'The site switched to a new sign-in method. Open the site page and click “Update current site”.'
        : '站点已切换新的登录方式，请打开站点页面点击「更新当前网站」。';
    case 'turnstile':
    case 'captcha':
    case 'unknown_challenge':
      return english
        ? 'The site requires verification that cannot be automated. Check in on the site.'
        : '站点要求无法自动完成的验证，请到站点手动签到。';
    case 'permission_missing':
      return english
        ? 'Grant CheckinPilot access to this site again.'
        : '请重新授予扩展访问该站点的权限。';
    default:
      return english
        ? 'Open the site to sign in again or complete its verification.'
        : '请打开站点重新登录或完成交互验证。';
  }
}

function notificationId(origin: string): string {
  return `${NOTIFICATION_PREFIX}${encodeURIComponent(origin)}`;
}

/**
 * A retryable failure only notifies when no retry job follows it, so the
 * "final bounded attempt" message matches the attempts actually left.
 */
export async function notifyForOutcome(
  site: SiteConfig,
  outcome: NormalizedOutcome,
  settings: GlobalSettings,
  willRetry = false,
): Promise<void> {
  const copy = copyForCurrentLocale();
  let title: string | undefined;
  let message: string | undefined;

  if (outcome.code === 'action_required') {
    title = copy.actionTitle;
    message = actionBodyForReason(outcome.actionReason);
  } else if (outcome.code === 'failed' && (!outcome.retryable || !willRetry)) {
    title = copy.failureTitle;
    message = copy.failureBody;
  } else if (
    settings.notifyOnSuccess &&
    (outcome.code === 'success' || outcome.code === 'already_checked')
  ) {
    title = copy.successTitle;
    message = copy.successBody;
  }
  // 'unverified' (visit mode) is a terminal result but never notifies.

  if (!title || !message) return;

  await browser.notifications.create(notificationId(site.origin), {
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/128.png'),
    title,
    message: `${site.label}: ${message}`,
  });
}

/** One-time migration notice telling the user to update the login method. */
export async function notifyAuthUpgradeOnce(): Promise<void> {
  const copy = copyForCurrentLocale();
  await browser.notifications.create(UPGRADE_NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/128.png'),
    title: copy.upgradeTitle,
    message: copy.upgradeBody,
  });
}

export function registerNotificationNavigation(): void {
  browser.notifications.onClicked.addListener((id) => {
    if (id === UPGRADE_NOTIFICATION_ID) {
      void browser.runtime.openOptionsPage();
      return;
    }
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
