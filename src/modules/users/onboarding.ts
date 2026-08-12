/**
 * オンボーディングの現在地（TASKS H-2a、SPEC 6.1、OPEN_QUESTIONS Q-035）。
 *
 * DBもネットワークも触らない純粋な処理。集める側は `onboarding-service.ts`。
 *
 * ## 現在地を保存しない
 *
 * **どこまで済んだかは、データから毎回導く。** 段の番号を列に持つと、
 * 別の画面で作業したときに食い違う（分身の画面で分身を作っても、
 * オンボーディングの番号は進まない）。**二重管理は必ずずれる。**
 *
 * `monitor_profiles.onboarding_status` は残すが、**ここから導いた結果を
 * 書くだけ**にする（管理画面の一覧が使う。B-7）。**書き込みは H-2b** —
 * `monitor_profiles` の行を作る経路がまだ無い。
 *
 * ## 段4は「分身を作る」
 *
 * SPEC 6.1 は「目標登録」だが、**目標（収益方針・KPI・撤退条件）は分身の
 * `business` そのもの**なので、分けて聞くと2回同じ話をさせることになる
 * （Q-035、2026-08-12 に (a) を採用）。SPEC 本文の書き換えは W-7。
 *
 * ## 済んだ段へは戻れる
 *
 * 済んだ段も画面に出し、**開けるようにする。** 設定を直したくなるのは
 * 普通のことで、「先へ進む」だけにすると、直すために最初からやり直す
 * ことになる。
 */

/** 段の識別子。**番号ではなく名前で持つ**（間に段が挟まっても意味が変わらない） */
export const ONBOARDING_STEPS = [
  'LINE_LOGIN',
  'TERMS',
  'DATA_CONSENT',
  'PERSONA',
  'BLOG',
  'WORDPRESS',
  'GENRE',
  'OFFER',
  'NOTIFICATION',
  'SNIPPET',
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/**
 * 判定に要る事実。**「済んだか」だけを持つ。**
 *
 * 件数や中身を渡すと、ここで業務の判断（何件あれば十分か）を持つことになる。
 * それは各モジュールの担当。
 */
export interface OnboardingFacts {
  /** LINEでログインできている（ここへ来られる時点で真） */
  lineLogin: boolean;
  termsAccepted: boolean;
  dataConsented: boolean;
  /** 使い始めた分身が1体以上ある（`DRAFT` は数えない） */
  hasActivePersona: boolean;
  hasBlog: boolean;
  /** 接続テストまで通っている（C-2）。**繋いだだけでは済みにしない** */
  hasConnectedWordpress: boolean;
  /** ジャンルが決まっている（E-4 の審査を経る） */
  hasGenre: boolean;
  hasOffer: boolean;
  hasNotificationSetting: boolean;
  /** `/go/` のスニペットが入っている（トークンを発行したか・D-12） */
  hasLinkEventToken: boolean;
}

export interface OnboardingStepState {
  step: OnboardingStep;
  done: boolean;
  /** いま取り組む段。**未了のうち最初の1つだけが真** */
  current: boolean;
}

export interface OnboardingProgress {
  steps: OnboardingStepState[];
  /** いま取り組む段。全部済んでいれば `null` */
  currentStep: OnboardingStep | null;
  completed: boolean;
  doneCount: number;
  totalCount: number;
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
}

function isDone(step: OnboardingStep, facts: OnboardingFacts): boolean {
  switch (step) {
    case 'LINE_LOGIN':
      return facts.lineLogin;
    case 'TERMS':
      return facts.termsAccepted;
    case 'DATA_CONSENT':
      return facts.dataConsented;
    case 'PERSONA':
      return facts.hasActivePersona;
    case 'BLOG':
      return facts.hasBlog;
    case 'WORDPRESS':
      return facts.hasConnectedWordpress;
    case 'GENRE':
      return facts.hasGenre;
    case 'OFFER':
      return facts.hasOffer;
    case 'NOTIFICATION':
      return facts.hasNotificationSetting;
    case 'SNIPPET':
      return facts.hasLinkEventToken;
  }
}

/**
 * 現在地を導く。
 *
 * **飛ばした段も「済んでいない」ものとして残す。** 例えばジャンルを
 * 決めないまま案件を登録した場合、案件の段は済みになるが、
 * ジャンルの段は未了のまま — **いま取り組む段はジャンルになる。**
 * 順に埋めさせるより、抜けを見せるほうが直しやすい。
 */
export function resolveOnboardingProgress(
  facts: OnboardingFacts,
): OnboardingProgress {
  const done = ONBOARDING_STEPS.map((step) => isDone(step, facts));
  const currentIndex = done.indexOf(false);

  const steps = ONBOARDING_STEPS.map((step, index) => ({
    step,
    done: done[index] ?? false,
    current: index === currentIndex,
  }));

  const doneCount = done.filter(Boolean).length;
  const completed = currentIndex === -1;

  return {
    steps,
    currentStep: completed ? null : (ONBOARDING_STEPS[currentIndex] ?? null),
    completed,
    doneCount,
    totalCount: ONBOARDING_STEPS.length,
    // **`LINE_LOGIN` だけ済んだ状態は「始まっていない」。**
    // ここへ来られる時点で必ず真なので、進捗として数えると
    // 全員が最初から「進行中」に見える
    status: completed
      ? 'COMPLETED'
      : doneCount <= 1
        ? 'NOT_STARTED'
        : 'IN_PROGRESS',
  };
}
