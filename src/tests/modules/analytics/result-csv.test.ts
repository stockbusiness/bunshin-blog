import { describe, expect, it } from 'vitest';
import { parseCsv } from '@/lib/csv';
import {
  NOT_OUR_BLOG,
  applyResultMapping,
  isRejectedResult,
  normalizeOfferName,
  readResultDate,
  sanitizeResultMapping,
  summarizeResultCsv,
  type ResultCsvBlog,
} from '@/modules/analytics';

/**
 * ASPの成果レポートを週次の成果にまとめる（Q-059・Q-058）。
 *
 * 守りたいのは4つ。
 *
 * 1. **否認された成果を売上として数えない**（数えると報酬が実際より多く見える）
 * 2. **どのブログの成果かを推測しすぎない**（90日の一次データが静かに狂う）
 * 3. **期間の中の「成果が無かった週」を0として書く**
 *    （書かないと「未報告」と区別できない）
 * 4. **日付をタイムゾーン変換しない**（深夜の成果が前の週へ移る）
 */

const MAPPING = { occurredOn: 0, offerName: 1, rewardYen: 2, status: 3 };

const BLOGS: ResultCsvBlog[] = [
  { id: 'blog-1', name: '節約ブログ', offerNames: ['格安SIM A'] },
  { id: 'blog-2', name: '暮らしブログ', offerNames: ['電力会社B'] },
];

function rows(csv: string) {
  return applyResultMapping(
    parseCsv(`発生日,案件名,報酬額,状態\n${csv}`),
    MAPPING,
  );
}

function summarize(
  csv: string,
  blogs: ResultCsvBlog[] = BLOGS,
  assignments?: Record<string, string>,
) {
  return summarizeResultCsv(
    rows(csv),
    blogs,
    assignments === undefined ? {} : { assignments },
  );
}

function weekOf(summary: ReturnType<typeof summarize>, blogId: string) {
  return summary.blogs.find((blog) => blog.blogId === blogId);
}

describe('日付を読む', () => {
  it.each([
    ['2026-08-17', '2026-08-17'],
    ['2026/8/17', '2026-08-17'],
    ['2026/08/17 23:45:00', '2026-08-17'],
    ['2026年8月17日', '2026-08-17'],
    ['2026.08.17', '2026-08-17'],
  ])('%s を %s と読む', (input, expected) => {
    expect(readResultDate(input)).toBe(expected);
  });

  /**
   * **タイムゾーンを変換しない。** 日本のASPが書き出す日時は既にJSTで、
   * `new Date()` に食わせるとUTCへ寄り、**深夜の成果が前日＝前の週へ移る。**
   */
  it('深夜の成果が前の日にならない', () => {
    // 2026-08-17（月）の 00:30。UTCに寄せると 08-16（日）＝前の週
    expect(readResultDate('2026/08/17 00:30:00')).toBe('2026-08-17');
  });

  it('存在しない日付は読まない', () => {
    expect(readResultDate('2026-02-30')).toBeNull();
  });

  it('日付でなければ読まない', () => {
    expect(readResultDate('未確定')).toBeNull();
    expect(readResultDate('')).toBeNull();
  });
});

/**
 * **否認のほうを先に見る。** 「非承認」には「承認」が含まれるので、
 * 承認から判定すると**否認された成果が売上として数えられる**
 * （Q-056 の「一時停止」が「停止」に食われたのと同じ形）。
 */
describe('数えない状態を見分ける', () => {
  it.each(['否認', '非承認', 'キャンセル', '取消', '無効', '返品'])(
    '%s は数えない',
    (value) => {
      expect(isRejectedResult(value)).toBe(true);
    },
  );

  it.each(['承認', '確定', '発生', '未確定', ''])('%s は数える', (value) => {
    expect(isRejectedResult(value)).toBe(false);
  });
});

describe('案件名を突き合わせる形にする', () => {
  it('記号と空白と大小を落とす', () => {
    expect(normalizeOfferName('格安SIM A')).toBe(
      normalizeOfferName('格安sim　ａ'),
    );
  });

  /**
   * **飾りの語までは落とさない。** 「公式」を消すと、それを含む別の案件と
   * 同じ名前になりうる。ここは残し、**含む・含まれる**で拾う（`findBlogId`）。
   */
  it('飾りの語は残る', () => {
    expect(normalizeOfferName('【公式】格安SIM A')).toBe('公式格安sima');
  });
});

describe('列の対応を絞る', () => {
  it('知らない項目と範囲の外を落とす', () => {
    expect(
      sanitizeResultMapping({ occurredOn: 0, しらない: 1, rewardYen: 9 }, 3),
    ).toEqual({ occurredOn: 0 });
  });
});

describe('まとめる', () => {
  it('案件名から自動で振り分ける', () => {
    const summary = summarize(
      [
        '2026-08-17,格安SIM A,1480,承認',
        '2026-08-18,格安SIM A,1480,承認',
        '2026-08-19,電力会社B,3000,承認',
      ].join('\n'),
    );

    expect(summary.unassigned).toEqual([]);
    expect(weekOf(summary, 'blog-1')).toMatchObject({
      conversions: 2,
      revenueYen: 2_960,
    });
    expect(weekOf(summary, 'blog-2')).toMatchObject({
      conversions: 1,
      revenueYen: 3_000,
    });
  });

  /** **書き方の揺れで取りこぼさない**（「【公式】」が付くことがある） */
  it('名前が少し違っても振り分ける', () => {
    const summary = summarize('2026-08-17,【公式】格安SIM A 申込,1480,承認');

    expect(summary.unassigned).toEqual([]);
    expect(weekOf(summary, 'blog-1')?.conversions).toBe(1);
  });

  /** **数えると報酬が実際より多く見える** */
  it('否認された行を数えない', () => {
    const summary = summarize(
      ['2026-08-17,格安SIM A,1480,承認', '2026-08-18,格安SIM A,1480,否認'].join(
        '\n',
      ),
    );

    expect(summary.rejectedRows).toBe(1);
    expect(weekOf(summary, 'blog-1')).toMatchObject({
      conversions: 1,
      revenueYen: 1_480,
    });
  });

  /** **否認しか無かった週は「0件だった週」。** 期間からは外さない */
  it('否認しかない週も期間に入れる', () => {
    const summary = summarize(
      ['2026-08-10,格安SIM A,1480,承認', '2026-08-18,格安SIM A,1480,否認'].join(
        '\n',
      ),
    );

    expect(summary.weekStarts).toEqual(['2026-08-10', '2026-08-17']);
    expect(weekOf(summary, 'blog-1')?.weeks[1]).toMatchObject({
      weekStart: '2026-08-17',
      conversions: 0,
    });
  });

  /**
   * **期間の中で行が無い週は0件。** 書かないと `metrics_daily` に穴が空き、
   * 「成果が無かった」のか「報告されなかった」のかが読めなくなる
   * （`weekly-result.ts`）。
   */
  it('間の週を0として埋める', () => {
    const summary = summarize(
      ['2026-08-03,格安SIM A,1480,承認', '2026-08-17,格安SIM A,1480,承認'].join(
        '\n',
      ),
    );

    expect(summary.weekStarts).toEqual([
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
    ]);
    expect(weekOf(summary, 'blog-1')?.weeks[1]).toMatchObject({
      weekStart: '2026-08-10',
      conversions: 0,
      revenueYen: 0,
    });
  });

  /** **成果が1件も無いブログにも0を書く。** CSVはアカウント全体を覆う */
  it('成果が無いブログにも0の週を作る', () => {
    const summary = summarize('2026-08-17,格安SIM A,1480,承認');

    expect(weekOf(summary, 'blog-2')?.weeks).toEqual([
      { weekStart: '2026-08-17', conversions: 0, revenueYen: 0 },
    ]);
  });

  /** **日付が読めない行を黙って落とさない** */
  it('日付が読めない行を理由付きで返す', () => {
    const summary = summarize(
      ['2026-08-17,格安SIM A,1480,承認', '未確定,格安SIM A,1480,承認'].join(
        '\n',
      ),
    );

    expect(summary.unreadable).toEqual([
      { rowNumber: 2, problem: expect.stringContaining('読み取れません') },
    ]);
    expect(weekOf(summary, 'blog-1')?.conversions).toBe(1);
  });

  it('報酬額が読めなければ0円として数える', () => {
    const summary = summarize('2026-08-17,格安SIM A,-,承認');

    expect(weekOf(summary, 'blog-1')).toMatchObject({
      conversions: 1,
      revenueYen: 0,
    });
  });

  it('全部読めなければ週が1つも出ない', () => {
    const summary = summarize('未確定,格安SIM A,1480,承認');

    expect(summary.weekStarts).toEqual([]);
  });

  /**
   * **数年分の「全期間」CSVをそのまま通さない。** 通すと、覚えのない
   * 何百週へ0を書き込むことになる。
   */
  it('期間が長すぎれば断る', () => {
    expect(() =>
      summarize(
        [
          '2020-01-06,格安SIM A,1480,承認',
          '2026-08-17,格安SIM A,1480,承認',
        ].join('\n'),
      ),
    ).toThrow(/期間が長すぎます/);
  });
});

/**
 * **推測で埋めない。** ASPのアカウントには**この実験の外のサイト**の
 * 成果も入りうる。ここを埋めると90日の一次データが静かに狂う。
 */
describe('どのブログか決められないとき', () => {
  it('登録していない案件は割り当てない', () => {
    const summary = summarize('2026-08-17,知らない案件,1480,承認');

    expect(summary.unassigned).toEqual([
      {
        key: normalizeOfferName('知らない案件'),
        offerName: '知らない案件',
        rows: 1,
        revenueYen: 1_480,
      },
    ]);
    expect(weekOf(summary, 'blog-1')?.conversions).toBe(0);
  });

  /** **ブログが1つでも推測しない。** 実験の外のサイトの成果がありうる */
  it('ブログが1つでも自動で入れない', () => {
    const summary = summarize('2026-08-17,知らない案件,1480,承認', [
      BLOGS[0] as ResultCsvBlog,
    ]);

    expect(summary.unassigned).toHaveLength(1);
  });

  /** **同じ案件を2つのブログで使える**（Q-055）。名前だけでは決まらない */
  it('同じ案件が2つのブログにあれば決めない', () => {
    const summary = summarize('2026-08-17,格安SIM A,1480,承認', [
      { id: 'blog-1', name: 'A', offerNames: ['格安SIM A'] },
      { id: 'blog-2', name: 'B', offerNames: ['格安SIM A'] },
    ]);

    expect(summary.unassigned).toHaveLength(1);
  });

  it('案件名の列が無ければ決めない', () => {
    const summary = summarizeResultCsv(
      applyResultMapping(parseCsv('発生日,報酬額\n2026-08-17,1480\n'), {
        occurredOn: 0,
        rewardYen: 1,
      }),
      BLOGS,
    );

    expect(summary.unassigned).toEqual([
      { key: '', offerName: '', rows: 1, revenueYen: 1_480 },
    ]);
  });

  it('人が選べば割り当てる', () => {
    const summary = summarize('2026-08-17,知らない案件,1480,承認', BLOGS, {
      [normalizeOfferName('知らない案件')]: 'blog-2',
    });

    expect(summary.unassigned).toEqual([]);
    expect(weekOf(summary, 'blog-2')?.conversions).toBe(1);
  });

  /** **実験の外のサイトの成果を混ぜない** */
  it('「数えない」を選べばどこにも入らない', () => {
    const summary = summarize('2026-08-17,知らない案件,1480,承認', BLOGS, {
      [normalizeOfferName('知らない案件')]: NOT_OUR_BLOG,
    });

    expect(summary.unassigned).toEqual([]);
    expect(weekOf(summary, 'blog-1')?.conversions).toBe(0);
    expect(weekOf(summary, 'blog-2')?.conversions).toBe(0);
    // **週は覆う**（0件として記録される）
    expect(summary.weekStarts).toEqual(['2026-08-17']);
  });
});
