import { browser } from 'wxt/browser';
import type { TodaySummary } from '../shared/domain';

export function badgeForToday(today: TodaySummary): { text: string; color: string } {
  const problems = today.attention + today.failed;
  if (problems) return { text: problems > 99 ? '99+' : String(problems), color: '#b42318' };
  if (today.running || today.retrying) return { text: '…', color: '#b45309' };
  if (today.unverified) return { text: '?', color: '#6b7280' };
  if (today.total > 0 && today.completed === today.total) return { text: '✓', color: '#087f5b' };
  return { text: '', color: '#6b7280' };
}

export async function setTodayBadge(today: TodaySummary): Promise<void> {
  const badge = badgeForToday(today);
  await browser.action.setBadgeBackgroundColor({ color: badge.color });
  await browser.action.setBadgeText({ text: badge.text });
}
