import type { SiteView } from '../shared/domain';
import type { TranslationKey } from '../locales/translations';

export interface RecoveryAction {
  kind: 'permission' | 'open' | 'update' | 'retry';
  label: TranslationKey;
  hint: TranslationKey;
}

export function recoveryForSite(site: SiteView): RecoveryAction | undefined {
  const record = site.today?.record;
  const reason = site.binding.state === 'action_required'
    ? site.binding.actionReason : record?.actionReason;
  switch (reason) {
    case 'permission_missing':
      return { kind: 'permission', label: 'recoverPermission', hint: 'recoverPermissionHint' };
    case 'sign_in':
      return { kind: 'open', label: 'recoverSignIn', hint: 'recoverSignInHint' };
    case 'account_changed':
    case 'rebind_required':
    case 'identity_missing':
    case 'auth_upgrade_required':
      return { kind: 'update', label: 'recoverBinding', hint: 'recoverBindingHint' };
    case 'turnstile':
    case 'captcha':
    case 'unknown_challenge':
      return { kind: 'open', label: 'recoverVerify', hint: 'recoverVerifyHint' };
  }
  if (record?.outcome === 'unsupported') {
    return { kind: 'update', label: 'recoverBinding', hint: 'recoverUnsupportedHint' };
  }
  if (record?.outcome === 'failed' && site.today?.status !== 'retrying') {
    return { kind: 'retry', label: 'recoverCheck', hint: 'recoverFailedHint' };
  }
  return undefined;
}
