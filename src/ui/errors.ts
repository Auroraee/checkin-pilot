import type { TranslationKey } from '../locales/translations';
import { EnrollmentError, type EnrollmentErrorCode } from './enrollment';

const enrollmentKeys: Record<EnrollmentErrorCode, TranslationKey> = {
  no_active_tab: 'errorNoActiveTab',
  https_required: 'errorNotHttps',
  permission_denied: 'errorPermission',
  identity_missing: 'errorIdentity',
  script_failed: 'errorGeneric',
};

export function errorTranslationKey(error: unknown): TranslationKey {
  if (error instanceof EnrollmentError) return enrollmentKeys[error.code];
  const code = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : '';
  if (code.includes('permission')) return 'errorPermission';
  if (code.includes('auth') || code.includes('sign_in')) return 'errorAuth';
  if (code.includes('account') || code.includes('rebind')) return 'errorAccountChanged';
  if (code.includes('network') || code.includes('fetch')) return 'errorNetwork';
  if (code.includes('server') || code.includes('rate_limited')) return 'errorServer';
  if (code.includes('business')) return 'errorBusiness';
  if (code.includes('invalid')) return 'errorInvalidResponse';
  if (code.includes('unsupported')) return 'errorUnsupported';
  if (code.includes('pow_budget')) return 'errorPowBudget';
  return 'errorGeneric';
}
