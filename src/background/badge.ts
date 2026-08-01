import { browser } from 'wxt/browser';
import type { OutcomeCode } from '../shared/domain';

const badgeByOutcome: Partial<
  Record<OutcomeCode, { text: string; color: string }>
> = {
  success: { text: '✓', color: '#087f5b' },
  already_checked: { text: '✓', color: '#087f5b' },
  action_required: { text: '!', color: '#b45309' },
  failed: { text: '×', color: '#b42318' },
};

export async function setOutcomeBadge(outcome?: OutcomeCode): Promise<void> {
  const badge = outcome ? badgeByOutcome[outcome] : undefined;
  await browser.action.setBadgeText({ text: badge?.text ?? '' });
  if (badge) {
    await browser.action.setBadgeBackgroundColor({ color: badge.color });
  }
}
