import type { SettingGroup } from './catalog';

/** いまその設定がどこから来ているか */
export type SettingSource =
  /** DBに保存された値が効いている */
  | 'DB'
  /** DBに無く、環境変数の値が効いている */
  | 'ENV'
  /** どちらにも無い。コードの既定値が使われる */
  | 'UNSET'
  /**
   * DBに行はあるが**復号できない**。
   *
   * 鍵（`ENCRYPTION_KEY`）が変わったときに起きる。値としては使わず、
   * **画面にはこの状態を出す** — 黙って環境変数へ落とすと
   * 「設定したのに効かない」の理由が分からなくなる。
   */
  | 'UNREADABLE';

/** 管理画面へ返す1項目。**平文の秘密を含まない** */
export interface SettingView {
  key: string;
  group: SettingGroup;
  label: string;
  description: string;
  secret: boolean;
  /** 選べる値。決まっていなければ `null`（自由入力） */
  choices: readonly string[] | null;
  source: SettingSource;
  /**
   * 画面に出す値。秘密なら伏せ字、秘密でなければそのまま。
   * 未設定・復号不能なら `null`
   */
  display: string | null;
  /** DBに保存された値の更新日時。DB以外なら `null` */
  updatedAt: Date | null;
  /** 最後に変更した ADMIN。分からなければ `null` */
  updatedByUserId: string | null;
}
