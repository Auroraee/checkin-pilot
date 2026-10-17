import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SiteCard, TodayOverview, ScheduleCard } from '../../src/ui/components';
import { I18nProvider } from '../../src/ui/i18n';
import { site, record } from '../unit/core/fixtures';
import type { SiteView } from '../../src/shared/domain';

const permissionRequest = vi.hoisted(() => vi.fn(async () => true));
vi.mock('wxt/browser', () => ({ browser: {
  i18n: { getUILanguage: () => 'zh-CN' },
  permissions: { request: permissionRequest },
} }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  vi.clearAllMocks();
});

async function render(child: React.ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(I18nProvider, null, child)));
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find((element) => element.textContent === label);
  expect(match).toBeDefined();
  return match!;
}

const view = (): SiteView => ({ ...site(), isPreviousBindingRecordExcluded: false,
  today: { status: 'attention', record: record({ outcome: 'action_required', actionReason: 'permission_missing' }) } });

describe('overview and recovery UI', () => {
  it('requests only the selected origin and checks again after permission is granted', async () => {
    permissionRequest.mockResolvedValueOnce(true);
    const manual = vi.fn();
    await render(createElement(SiteCard, { site: view(), onManual: manual, onOpen: vi.fn(), onToggle: vi.fn() }));
    await act(async () => button('重新授权').click());
    expect(permissionRequest).toHaveBeenCalledWith({ origins: ['https://example.test/*'] });
    expect(manual).toHaveBeenCalledTimes(1);
  });

  it('keeps permission denial visible without starting a check-in', async () => {
    permissionRequest.mockResolvedValueOnce(false);
    const manual = vi.fn();
    await render(createElement(SiteCard, { site: view(), onManual: manual, onOpen: vi.fn(), onToggle: vi.fn() }));
    await act(async () => button('重新授权').click());
    expect(manual).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('未获得');
    expect(button('重新授权').disabled).toBe(false);
  });

  it('opens the login recovery path and keeps manual rechecking separate', async () => {
    const configured = view();
    configured.today!.record!.actionReason = 'sign_in';
    const open = vi.fn();
    const manual = vi.fn();
    await render(createElement(SiteCard, { site: configured, onManual: manual, onOpen: open, onToggle: vi.fn() }));
    await act(async () => button('打开网站登录').click());
    expect(open).toHaveBeenCalledTimes(1);
    expect(manual).not.toHaveBeenCalled();
    await act(async () => button('再次检查').click());
    expect(manual).toHaveBeenCalledTimes(1);
  });

  it('routes binding updates through the existing confirmation flow', async () => {
    const configured = view();
    configured.today!.record!.actionReason = 'account_changed';
    const update = vi.fn();
    const manual = vi.fn();
    await render(createElement(SiteCard, { site: configured, onManual: manual, onOpen: vi.fn(), onUpdate: update, onToggle: vi.fn() }));
    await act(async () => button('更新绑定').click());
    expect(update).toHaveBeenCalledTimes(1);
    expect(manual).not.toHaveBeenCalled();
    expect(container.textContent).toContain('需要确认重新绑定');
  });

  it('shows due retries and does not call a finished batch fully successful', async () => {
    const configured = view();
    configured.today = { status: 'retrying', retry: { dueAt: '2020-01-01T00:00:00Z', remaining: 1 }, record: record({ outcome: 'failed' }) };
    await render(createElement('div', null,
      createElement(TodayOverview, { summary: { total: 3, completed: 1, retrying: 1, unverified: 1, failed: 0, attention: 0, pending: 0, paused: 1, running: 0 } }),
      createElement(ScheduleCard, { nextBatchAt: undefined, state: 'complete', retrying: 1 }),
      createElement(SiteCard, { site: configured, onManual: vi.fn(), onOpen: vi.fn(), onToggle: vi.fn() }),
    ));
    expect(container.textContent).toContain('已完成 1 / 3');
    expect(container.textContent).toContain('未验证');
    expect(container.textContent).toContain('仍有站点等待重试');
    expect(container.textContent).toContain('重试时间已到');
    expect(container.textContent).toContain('最多还可自动重试 1 次');
    expect(container.querySelector('progress')?.value).toBe(1);
  });
});
