/**
 * users モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * `users` テーブルを触ってよいのはこのモジュールだけ。
 */

export {
  findByLineUserId,
  findById,
  findOrCreateByLineUserId,
  recordConsent,
  type UsersDb,
  type UsersDeps,
} from './repository';

export {
  hasAllConsents,
  missingConsents,
  isActiveUser,
  CONSENT_KINDS,
  type AppUser,
  type ConsentKind,
} from './types';
