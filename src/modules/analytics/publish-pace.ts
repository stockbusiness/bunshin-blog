/**
 * インデックス率による公開ペースの判定（TASKS G-8b、作業指示書 W-8）。
 *
 * DBも外部も触らない純粋な処理。
 *
 * ## 何を決めるのか
 *
 * | インデックス率 | 判断 |
 * |---|---|
 * | 80%以上 | 上限を **+1**（5本まで） |
 * | 50%未満 | **0本**にして ADMIN へ通知 |
 * | それ以外 | 変えない |
 *
 * **載っているなら増やしてよく、載らないなら増やしても無駄。**
 * インデックスされない記事を量産しても、検索からは1件も来ない。
 *
 * ## 公開後14日未満を母数に含めない
 *
 * **出したばかりの記事は、まだ載っていなくて当たり前。** 含めると
 * 「たくさん出したブログほどインデックス率が低い」ことになり、
 * **公開ペースを上げたブログが必ず次で下げられる。**
 *
 * ## 判定できないときは動かさない
 *
 * `metrics_daily.indexed` は `NULL` を取る（G-3。Google が判断を
 * 返さなかった日は書かない）。**「分からない」を「載っていない」に
 * 倒さない** — 倒すと、取得に失敗しただけのブログが停止される。
 *
 * 判定のある記事が少なすぎるときも動かさない。**1本で 100% や 0% に
 * なると、上限が毎回振れる。**
 *
 * ## 0本は「設定」ではない
 *
 * 利用者が選べる範囲は3〜5（SPEC 2.2・G-8a）。**0本はここだけが書く
 * 異常時の停止**で、ADMIN へ通知する。黙って止めない。
 */

/** インデックス率の判定に要る、判定のある記事の最少本数 */
export const MIN_JUDGED_ARTICLES = 5;

/** 公開してからこの日数が経った記事だけを数える */
export const MATURE_AFTER_DAYS = 14;

/** 上限を上げる境目 */
export const RAISE_RATE = 0.8;

/** 公開を止める境目 */
export const STOP_RATE = 0.5;

/** 停止したときの上限 */
export const STOPPED_CAP = 0;

export type PaceDecision =
  /** 上限を上げる */
  | 'RAISE'
  /** 公開を止める（ADMIN へ通知） */
  | 'STOP'
  /** 変えない */
  | 'KEEP'
  /** 判定できない。**変えないが、理由が別**（測れていない） */
  | 'NOT_ENOUGH_DATA';

export interface PaceInput {
  /** 公開後14日以上で、**インデックスの判定がある**記事の本数 */
  judged: number;
  /** そのうち載っていた本数 */
  indexed: number;
  /** いまの週の上限 */
  currentCap: number;
  /** 上限の上限（`WEEKLY_PUBLISH_CAP_MAX`。呼び出し側が渡す） */
  maxCap: number;
}

export interface PaceJudgement {
  decision: PaceDecision;
  /** 判定に使ったインデックス率。判定できなければ `null` */
  rate: number | null;
  /** 変更後の上限。変えないなら現在値のまま */
  nextCap: number;
}

/**
 * 公開ペースをどうするかを決める。
 *
 * **上限に達していれば上げない。** 上げられないことは「変えない」であって
 * 判定の失敗ではない。
 *
 * **止まっているブログを更に止めない。** 既に0本なら `KEEP` を返す
 * （同じ通知が2週間ごとに届き続けるのを避ける）。
 */
export function judgePublishPace(input: PaceInput): PaceJudgement {
  if (input.judged < MIN_JUDGED_ARTICLES) {
    // **測れていないことを「問題なし」にしない。** 別の値で返す
    return {
      decision: 'NOT_ENOUGH_DATA',
      rate: null,
      nextCap: input.currentCap,
    };
  }

  const rate = input.indexed / input.judged;

  if (rate < STOP_RATE) {
    return input.currentCap === STOPPED_CAP
      ? // 既に止まっている。**同じ通知を繰り返さない**
        { decision: 'KEEP', rate, nextCap: STOPPED_CAP }
      : { decision: 'STOP', rate, nextCap: STOPPED_CAP };
  }

  if (rate >= RAISE_RATE && input.currentCap < input.maxCap) {
    return { decision: 'RAISE', rate, nextCap: input.currentCap + 1 };
  }

  return { decision: 'KEEP', rate, nextCap: input.currentCap };
}

/**
 * その記事を母数に入れてよいかを決める。
 *
 * **公開していない記事は数えない。** Phase 0 で作るのは下書きで
 * （SPEC 7）、公開はモニターが WordPress 側で行う。**下書きのままの
 * 記事が載っていないのは当たり前。**
 */
export function isMatureArticle(params: {
  publishedAt: Date | null;
  now: Date;
}): boolean {
  if (params.publishedAt === null) {
    return false;
  }

  const ageDays =
    (params.now.getTime() - params.publishedAt.getTime()) /
    (24 * 60 * 60 * 1_000);

  return ageDays >= MATURE_AFTER_DAYS;
}
