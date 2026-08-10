/**
 * audit モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * `audit_logs` を触ってよいのはこのモジュールだけ。
 *
 * **記録するのは「普通ではないことが起きた」場面だけ**（SPEC 9.2.2 の
 * 「承知で進める」と、ADMIN の介入）。正常系を全部残すと、
 * 後から見たときに異常が埋もれる。
 */

export {
  recordAudit,
  recordAuditInTx,
  listAuditLogsForAdmin,
} from './repository';

export {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  type AuditAction,
  type AuditEntityType,
  type AppAuditLog,
  type RecordAuditInput,
} from './types';
