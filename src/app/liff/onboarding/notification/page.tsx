'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  OnboardingApiError,
  fetchNotificationSchedule,
  saveNotificationSchedule,
} from '../../_lib/onboarding-api';

/**
 * `/liff/onboarding/notification` 通知の曜日と時刻（TASKS H-2b、SPEC 8.3）。
 *
 * **曜日を1日も選ばずには保存できない。** 保存はできるが通知が一度も
 * 飛ばない状態を作ると、**「設定済みなのに来ない」**という一番分かり
 * にくい形になる（判定は `normalizeNotificationSchedule`）。
 *
 * 時刻は**JSTの壁掛け時計**として扱う。画面に出す値と保存する値が同じ。
 */

const DAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

/** 既定。**平日の朝**（SPEC 8.3 の「提案は朝に届く」に合わせる） */
const DEFAULT_DAYS = [1, 2, 3, 4, 5];
const DEFAULT_TIME = '07:00';

export default function NotificationPage() {
  const [days, setDays] = useState<number[]>(DEFAULT_DAYS);
  const [time, setTime] = useState(DEFAULT_TIME);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void fetchNotificationSchedule().then(
      (result) => {
        if (cancelled) return;
        if (result.schedule !== null) {
          setDays(result.schedule.days);
          setTime(result.schedule.time);
        }
        setLoading(false);
      },
      () => {
        // **読めなくても既定値で始められる。** 新規の人はまだ設定が無い
        if (!cancelled) setLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <p className="p-6 text-sm">読み込んでいます</p>;
  }

  return (
    <main className="min-h-dvh p-4">
      <h1 className="text-lg font-bold">通知の曜日と時刻</h1>
      <p className="mt-1 text-xs leading-relaxed">
        記事の提案が届く時間です。1日1件までにしています。
      </p>

      <fieldset className="mt-4 rounded-lg border p-4">
        <legend className="px-1 text-sm font-bold">曜日</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {DAY_LABELS.map((label, day) => {
            const on = days.includes(day);

            return (
              <button
                key={label}
                type="button"
                aria-pressed={on}
                className={`rounded border px-3 py-2 text-sm ${on ? 'font-bold underline' : ''}`}
                onClick={() => {
                  setSaved(false);
                  setDays((current) =>
                    current.includes(day)
                      ? current.filter((value) => value !== day)
                      : [...current, day].sort((a, b) => a - b),
                  );
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <p className="mt-4">
        <label htmlFor="time" className="text-xs font-bold">
          時刻
        </label>
        <input
          id="time"
          type="time"
          className="mt-1 w-full rounded border p-2 text-sm"
          value={time}
          onChange={(event) => {
            setSaved(false);
            setTime(event.target.value);
          }}
        />
      </p>

      {error === null ? null : (
        <p role="alert" className="mt-4 text-sm leading-relaxed">
          {error}
        </p>
      )}
      {saved ? <p className="mt-4 text-xs">保存しました</p> : null}

      <button
        type="button"
        disabled={saving}
        className="mt-4 w-full rounded-lg border p-3 text-sm font-bold disabled:opacity-50"
        onClick={() => {
          setSaving(true);
          setError(null);
          setSaved(false);

          void saveNotificationSchedule({ days, time }).then(
            (result) => {
              setSaving(false);
              setDays(result.schedule.days);
              setTime(result.schedule.time);
              setSaved(true);
            },
            (thrown: unknown) => {
              setSaving(false);
              setError(
                thrown instanceof OnboardingApiError
                  ? thrown.message
                  : '保存できませんでした',
              );
            },
          );
        }}
      >
        {saving ? '保存しています' : '保存する'}
      </button>

      <Link
        href="/liff/onboarding"
        className="mt-4 block text-center text-xs underline"
      >
        はじめの設定へ戻る
      </Link>
    </main>
  );
}
