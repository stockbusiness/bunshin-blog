import { describe, expect, it } from 'vitest';
import {
  addJstDays,
  atJstTime,
  isJstDate,
  JST_OFFSET_MINUTES,
  jstDayRange,
  jstHour,
  jstWeekNumber,
  jstWeekRange,
  jstWeeksBetween,
  jstDateColumn,
  startOfJstDay,
  startOfJstWeek,
  todayInJst,
  toJstDate,
} from '@/lib/datetime';

describe('toJstDate', () => {
  it('UTCの瞬間をJSTの暦日に変換する', () => {
    expect(toJstDate(new Date('2026-08-06T03:00:00Z'))).toBe('2026-08-06');
  });

  // UTCで日付を切ると、JSTの朝9時までの記事が前日に計上される
  it('JSTの午前0時直後はUTCでは前日でも当日として扱う', () => {
    // 2026-08-06 00:00 JST = 2026-08-05 15:00 UTC
    expect(toJstDate(new Date('2026-08-05T15:00:00Z'))).toBe('2026-08-06');
    expect(toJstDate(new Date('2026-08-05T14:59:59Z'))).toBe('2026-08-05');
  });

  it('JSTの午前9時より前でも当日として扱う', () => {
    expect(toJstDate(new Date('2026-08-06T00:00:00Z'))).toBe('2026-08-06');
  });

  it('月と年をまたぐ', () => {
    // 2026-01-01 00:00 JST = 2025-12-31 15:00 UTC
    expect(toJstDate(new Date('2025-12-31T15:00:00Z'))).toBe('2026-01-01');
    expect(toJstDate(new Date('2025-12-31T14:59:59Z'))).toBe('2025-12-31');
  });

  it('うるう日を扱える', () => {
    expect(toJstDate(new Date('2028-02-28T15:00:00Z'))).toBe('2028-02-29');
  });

  it('Invalid Date で例外を投げる', () => {
    expect(() => toJstDate(new Date('nonsense'))).toThrow();
  });
});

describe('startOfJstDay', () => {
  it('JSTの00:00に対応するUTCの瞬間を返す', () => {
    expect(startOfJstDay('2026-08-06').toISOString()).toBe(
      '2026-08-05T15:00:00.000Z',
    );
  });

  it('toJstDate と往復する', () => {
    for (const date of ['2026-01-01', '2026-08-06', '2028-02-29']) {
      expect(toJstDate(startOfJstDay(date))).toBe(date);
    }
  });

  it('不正な日付で例外を投げる', () => {
    for (const value of ['2026-13-01', '2026-02-30', '2026-8-6', 'abc', '']) {
      expect(() => startOfJstDay(value)).toThrow();
    }
  });
});

/**
 * `date` 型の列へ入れる値（OPEN_QUESTIONS Q-031）。
 *
 * **`startOfJstDay` を `date` 型の列へ渡すと1日前が保存される。**
 * ここはその取り違えを防ぐための関数で、両者が**別物であること**を
 * 試験として固定しておく。
 */
describe('jstDateColumn', () => {
  it('暦日そのもの（UTCの真夜中）を返す', () => {
    expect(jstDateColumn('2026-08-11').toISOString()).toBe(
      '2026-08-11T00:00:00.000Z',
    );
  });

  /** **ここが Q-031 の中身。** 9時間ずれる */
  it('startOfJstDay とは別の値になる', () => {
    expect(jstDateColumn('2026-08-11').toISOString()).not.toBe(
      startOfJstDay('2026-08-11').toISOString(),
    );
    expect(startOfJstDay('2026-08-11').toISOString()).toBe(
      '2026-08-10T15:00:00.000Z',
    );
  });

  /** **`date` 型の列が取るのはUTCの日付部分。** そこが暦日と一致すること */
  it.each(['2026-01-01', '2026-08-11', '2028-02-29'])(
    '%s のUTC日付部分が暦日と一致する',
    (date) => {
      expect(jstDateColumn(date).toISOString().slice(0, 10)).toBe(date);
    },
  );

  it('不正な日付で例外を投げる', () => {
    for (const value of ['2026-13-01', '2026-02-30', '2026-8-6', 'abc', '']) {
      expect(() => jstDateColumn(value)).toThrow();
    }
  });
});

describe('jstDayRange', () => {
  it('JSTの1日を start 以上 endExclusive 未満で表す', () => {
    const { start, endExclusive } = jstDayRange('2026-08-06');

    expect(start.toISOString()).toBe('2026-08-05T15:00:00.000Z');
    expect(endExclusive.toISOString()).toBe('2026-08-06T15:00:00.000Z');
  });

  it('区間の端がその日に属するかどうかを正しく分ける', () => {
    const { start, endExclusive } = jstDayRange('2026-08-06');

    expect(toJstDate(start)).toBe('2026-08-06');
    expect(toJstDate(new Date(endExclusive.getTime() - 1))).toBe('2026-08-06');
    expect(toJstDate(endExclusive)).toBe('2026-08-07');
  });
});

describe('atJstTime', () => {
  // monitor_profiles.notification_time はJSTの壁時計時刻
  it('JSTの壁時計時刻をUTCの瞬間に変換する', () => {
    expect(atJstTime('2026-08-06', '09:00').toISOString()).toBe(
      '2026-08-06T00:00:00.000Z',
    );
    expect(atJstTime('2026-08-06', '00:00').toISOString()).toBe(
      '2026-08-05T15:00:00.000Z',
    );
  });

  it('秒を受け付ける', () => {
    expect(atJstTime('2026-08-06', '09:00:30').toISOString()).toBe(
      '2026-08-06T00:00:30.000Z',
    );
  });

  it('不正な時刻で例外を投げる', () => {
    for (const value of ['24:00', '09:60', '9:00', '0900', '']) {
      expect(() => atJstTime('2026-08-06', value)).toThrow();
    }
  });
});

describe('addJstDays', () => {
  it('日数を加算・減算する', () => {
    expect(addJstDays('2026-08-06', 1)).toBe('2026-08-07');
    expect(addJstDays('2026-08-06', -1)).toBe('2026-08-05');
    expect(addJstDays('2026-08-06', 0)).toBe('2026-08-06');
  });

  it('月と年をまたぐ', () => {
    expect(addJstDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addJstDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addJstDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('うるう年をまたぐ', () => {
    expect(addJstDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addJstDays('2027-02-28', 1)).toBe('2027-03-01');
  });

  it('整数以外で例外を投げる', () => {
    expect(() => addJstDays('2026-08-06', 1.5)).toThrow();
  });
});

// DATA_MODEL 10章：週の開始は月曜
describe('startOfJstWeek', () => {
  it('週内のどの日からでも同じ月曜を返す', () => {
    // 2026-08-03(月) 〜 2026-08-09(日)
    const monday = '2026-08-03';
    const week = [
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
      '2026-08-09',
    ];

    for (const date of week) {
      expect(startOfJstWeek(date)).toBe(monday);
    }
  });

  it('日曜は前の月曜に属する（週の開始は日曜ではない）', () => {
    expect(startOfJstWeek('2026-08-09')).toBe('2026-08-03');
    expect(startOfJstWeek('2026-08-10')).toBe('2026-08-10');
  });

  it('月をまたぐ週を扱える', () => {
    // 2026-09-01 は火曜。属する週の月曜は 8/31
    expect(startOfJstWeek('2026-09-01')).toBe('2026-08-31');
  });
});

describe('jstWeekRange', () => {
  it('月曜00:00から次の月曜00:00までを返す', () => {
    const { start, endExclusive } = jstWeekRange('2026-08-06');

    expect(start.toISOString()).toBe('2026-08-02T15:00:00.000Z');
    expect(endExclusive.toISOString()).toBe('2026-08-09T15:00:00.000Z');
    expect(toJstDate(start)).toBe('2026-08-03');
  });

  it('区間の長さが7日である', () => {
    const { start, endExclusive } = jstWeekRange('2026-08-06');
    const days = (endExclusive.getTime() - start.getTime()) / 86_400_000;

    expect(days).toBe(7);
  });
});

describe('jstWeeksBetween', () => {
  it('同じ週なら0を返す', () => {
    expect(jstWeeksBetween('2026-08-03', '2026-08-09')).toBe(0);
  });

  it('翌週なら1を返す', () => {
    expect(jstWeeksBetween('2026-08-09', '2026-08-10')).toBe(1);
  });

  it('前の週なら負の値を返す', () => {
    expect(jstWeeksBetween('2026-08-10', '2026-08-09')).toBe(-1);
  });

  it('年をまたいでも数えられる', () => {
    expect(jstWeeksBetween('2026-12-28', '2027-01-04')).toBe(1);
  });
});

// SPEC 9.2.7：1〜2週目は収益記事、3週目以降は集客記事を週4本
describe('jstWeekNumber', () => {
  it('基準日の週を1週目とする', () => {
    expect(jstWeekNumber('2026-08-03', '2026-08-03')).toBe(1);
    expect(jstWeekNumber('2026-08-03', '2026-08-09')).toBe(1);
  });

  it('翌週を2週目とする', () => {
    expect(jstWeekNumber('2026-08-03', '2026-08-10')).toBe(2);
  });

  it('基準日が週の途中でも、その週が1週目になる', () => {
    // 2026-08-06(木)から開始しても、8/3(月)からの週が1週目
    expect(jstWeekNumber('2026-08-06', '2026-08-03')).toBe(1);
    expect(jstWeekNumber('2026-08-06', '2026-08-10')).toBe(2);
  });

  it('公開順序の判定に使える', () => {
    const launch = '2026-08-03';

    // 1〜2週目：収益記事
    expect(jstWeekNumber(launch, '2026-08-09')).toBeLessThanOrEqual(2);
    expect(jstWeekNumber(launch, '2026-08-16')).toBeLessThanOrEqual(2);
    // 3週目以降：集客記事
    expect(jstWeekNumber(launch, '2026-08-17')).toBe(3);
  });
});

describe('isJstDate', () => {
  it('妥当な日付を受け入れる', () => {
    expect(isJstDate('2026-08-06')).toBe(true);
    expect(isJstDate('2028-02-29')).toBe(true);
  });

  it('存在しない日付を拒否する', () => {
    expect(isJstDate('2026-02-30')).toBe(false);
    expect(isJstDate('2027-02-29')).toBe(false);
    expect(isJstDate('2026-13-01')).toBe(false);
    expect(isJstDate('2026-00-01')).toBe(false);
  });

  it('形式が違うものを拒否する', () => {
    for (const value of ['2026-8-6', '20260806', '2026/08/06', '', 'abc']) {
      expect(isJstDate(value)).toBe(false);
    }
  });
});

describe('todayInJst', () => {
  it('渡した瞬間のJST暦日を返す', () => {
    expect(todayInJst(new Date('2026-08-05T15:00:00Z'))).toBe('2026-08-06');
  });
});

describe('jstHour', () => {
  it('JSTの時を2桁で返す', () => {
    // 2026-08-06 12:00 JST
    expect(jstHour(new Date('2026-08-06T03:00:00Z'))).toBe('12');
  });

  it('1桁の時も0で埋める', () => {
    // 2026-08-06 09:00 JST
    expect(jstHour(new Date('2026-08-06T00:00:00Z'))).toBe('09');
  });

  /**
   * **暦日と組で使う**（I-2 の冪等キー）。日付だけJSTにして時をUTCで
   * 取ると、日付が変わる時刻に**同じ組が2回現れる**
   */
  it('JSTの日付が変わる瞬間は00時になる', () => {
    // 2026-08-06 00:00 JST = 2026-08-05 15:00 UTC
    expect(jstHour(new Date('2026-08-05T15:00:00Z'))).toBe('00');
    expect(todayInJst(new Date('2026-08-05T15:00:00Z'))).toBe('2026-08-06');

    // その1分前はまだ前日の23時
    expect(jstHour(new Date('2026-08-05T14:59:00Z'))).toBe('23');
    expect(todayInJst(new Date('2026-08-05T14:59:00Z'))).toBe('2026-08-05');
  });

  it('Invalid Date を拒む', () => {
    expect(() => jstHour(new Date('x'))).toThrow();
  });
});

describe('JST_OFFSET_MINUTES', () => {
  it('UTC+9である', () => {
    expect(JST_OFFSET_MINUTES).toBe(540);
  });
});
