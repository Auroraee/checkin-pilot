import { describe, expect, it } from 'vitest';
import { recoveryForSite } from '../../../src/ui/recovery';
import { site, record } from '../core/fixtures';
import type { ActionReason, SiteView } from '../../../src/shared/domain';

describe('site recovery actions', () => {
  it.each<[ActionReason, string]>([
    ['sign_in', 'open'], ['permission_missing', 'permission'], ['account_changed', 'update'],
    ['rebind_required', 'update'], ['auth_upgrade_required', 'update'], ['identity_missing', 'update'],
    ['captcha', 'open'], ['turnstile', 'open'], ['unknown_challenge', 'open'],
  ])('routes %s to %s', (reason, kind) => {
    const view: SiteView = { ...site(), isPreviousBindingRecordExcluded: false,
      today: { status: 'attention', record: record({ outcome: 'action_required', actionReason: reason }) } };
    expect(recoveryForSite(view)?.kind).toBe(kind);
  });

  it('does not offer a stale recovery or imply that a pending retry is final', () => {
    const view: SiteView = { ...site(), isPreviousBindingRecordExcluded: false,
      latestRecord: record({ outcome: 'action_required', actionReason: 'sign_in' }), today: { status: 'pending' } };
    expect(recoveryForSite(view)).toBeUndefined();
    view.today = { status: 'retrying', record: record({ outcome: 'failed' }) };
    expect(recoveryForSite(view)).toBeUndefined();
    view.today.status = 'failed';
    expect(recoveryForSite(view)?.kind).toBe('retry');
  });
});
