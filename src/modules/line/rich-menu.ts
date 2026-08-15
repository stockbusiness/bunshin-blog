/**
 * リッチメニューの下書きと適用（Q-054、TASKS H-6）。
 *
 * ## なぜ管理画面で作るのか
 *
 * `docs/MANUAL.md` は「LINEのメニューから開く」と書いているのに、
 * **実物が無い。** モニターを迎える前に要る。
 *
 * LINE公式アカウントマネージャーでも作れるが、**行き先が
 * `NEXT_PUBLIC_LIFF_ID` を含む LIFF のURL**である。IDが変わると
 * **全部のボタンが黙って壊れる**（本番チャネルへ移すときに必ず起きる）。
 * 手で直すと4つのURLを入れ直しになる。ここから作れば押し直すだけで済む。
 *
 * ## 引き換えに失うもの
 *
 * **APIで作ったリッチメニューは、LINE公式アカウントマネージャーの
 * 画面から編集できなくなる**（LINE の仕様）。**両方から触る運用にはできない。**
 * これを承知のうえで、ここを唯一の入口にする。
 *
 * ## 保存と適用を分ける
 *
 * `save` は**LINEを触らない。** 下書きとして残るだけ。
 * `apply` で初めて LINE に出る。**途中で失敗したら既定を差し替えない** —
 * いま出ているメニューを壊さない。
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { readLineConfig } from '@/lib/line/messaging';
import { getRuntimeEnv } from '@/modules/settings';
import {
  createRichMenuClient,
  MAX_CHAT_BAR_TEXT_LENGTH,
  MAX_RICH_MENU_AREAS,
  MAX_RICH_MENU_NAME_LENGTH,
  RICH_MENU_CANVAS,
  type RemoteRichMenu,
  type RichMenuArea,
  type RichMenuCanvasName,
  type RichMenuClient,
  type RichMenuDefinition,
} from '@/lib/line/rich-menu';
import {
  inspectRichMenuImage,
  matchesCanvasAspect,
  type ImageMimeType,
} from '@/lib/line/rich-menu-image';
import {
  RICH_MENU_ERROR_CODES,
  lineNotConfiguredError,
  richMenuError,
} from './errors';

/** 押したときに開けるURLの長さ（LINE の仕様） */
const MAX_URI_LENGTH = 1000;

/** 押す場所の名前の長さ（LINE の仕様） */
const MAX_LABEL_LENGTH = 20;

/**
 * リッチメニューから開く LIFF の画面（Q-054）。
 *
 * **`LIFF_BASE_URL` からの相対で持つ。** `buildApprovalUrl` と同じ形で、
 * LIFF のエンドポイントが `/liff` を指しているぶんは base 側にある。
 *
 * **ここに並べる意味。** 行き先を手で打たせない。打たせると、
 * 打ち間違いが「押しても何も起きないボタン」として本番に出る。
 */
export const RICH_MENU_DESTINATIONS = [
  { label: 'はじめの設定', path: '/onboarding' },
  { label: '提案を見る', path: '/approvals' },
  { label: '今週の結果', path: '/results' },
  { label: 'ブログ', path: '/blogs' },
] as const;

export type RichMenuDestination = (typeof RICH_MENU_DESTINATIONS)[number];

/** `LIFF_BASE_URL` と相対の道をつなぐ（`buildApprovalUrl` と同じ） */
export function buildLiffUrl(liffBaseUrl: string, path: string): string {
  return `${liffBaseUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * 行き先を、いまの `LIFF_BASE_URL` に合わせて入れ直す。
 *
 * **Q-054 で管理画面から作ることにした一番の理由がこれ。**
 * LIFF ID が変わると、リッチメニューのボタンは**全部が黙って壊れる**
 * （押しても何も起きない）。手作業だと4つのURLを入れ直しになる。
 *
 * **知っている画面だけを入れ直す。** それ以外のURL（外部のページなど）は
 * 触らない — 勝手に書き換えるほうが危ない。
 */
export function retargetAreasToLiffBase(
  areas: readonly RichMenuAreaInput[],
  liffBaseUrl: string,
): RichMenuAreaInput[] {
  return areas.map((area) => {
    const path = matchDestinationPath(area.uri);

    if (path === null) {
      return area;
    }

    return { ...area, uri: buildLiffUrl(liffBaseUrl, path) };
  });
}

/** 知っている画面のどれかなら、その相対の道を返す */
function matchDestinationPath(uri: string): string | null {
  let pathname: string;

  try {
    pathname = new URL(uri).pathname;
  } catch {
    return null;
  }

  for (const destination of RICH_MENU_DESTINATIONS) {
    // **末尾で見る。** 先頭は LIFF ID で、それが変わるからここに居る
    if (pathname.endsWith(destination.path)) {
      return destination.path;
    }
  }

  return null;
}

export interface RichMenuAreaInput {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  uri: string;
}

export interface RichMenuInput {
  name: string;
  chatBarText: string;
  canvas: RichMenuCanvasName;
  selected: boolean;
  areas: readonly RichMenuAreaInput[];
}

export interface StoredRichMenu extends RichMenuInput {
  /** 画像が入っているか。**中身はここに載せない**（重い） */
  hasImage: boolean;
  imageMimeType: ImageMimeType | null;
  imageWidth: number | null;
  imageHeight: number | null;
  /** 適用済みの LINE 側 ID。未適用なら `null` */
  lineRichMenuId: string | null;
  appliedAt: Date | null;
  updatedAt: Date | null;
}

/** まだ何も保存していないときに画面へ出す形 */
export const EMPTY_RICH_MENU: StoredRichMenu = {
  name: 'BUNSHIN BLOG',
  chatBarText: 'メニュー',
  canvas: 'LARGE',
  selected: true,
  areas: [],
  hasImage: false,
  imageMimeType: null,
  imageWidth: null,
  imageHeight: null,
  lineRichMenuId: null,
  appliedAt: null,
  updatedAt: null,
};

const SELECT = {
  name: true,
  chatBarText: true,
  canvas: true,
  selected: true,
  areas: true,
  imageMimeType: true,
  imageWidth: true,
  imageHeight: true,
  lineRichMenuId: true,
  appliedAt: true,
  updatedAt: true,
} satisfies Prisma.RichMenuSelect;

/**
 * 下書きを読む。
 *
 * **画像の中身は返さない。** 一覧のたびに1MBを運ばない。
 */
export async function readRichMenu(): Promise<StoredRichMenu> {
  const record = await prisma.richMenu.findUnique({
    where: { singleton: true },
    select: SELECT,
  });

  if (record === null) {
    return EMPTY_RICH_MENU;
  }

  return {
    name: record.name,
    chatBarText: record.chatBarText,
    canvas: record.canvas,
    selected: record.selected,
    areas: readAreas(record.areas),
    hasImage: record.imageMimeType !== null,
    imageMimeType: record.imageMimeType as ImageMimeType | null,
    imageWidth: record.imageWidth,
    imageHeight: record.imageHeight,
    lineRichMenuId: record.lineRichMenuId,
    appliedAt: record.appliedAt,
    updatedAt: record.updatedAt,
  };
}

/** 画像の中身を読む。**適用と、管理画面での下見にだけ使う** */
export async function readRichMenuImage(): Promise<{
  data: Uint8Array;
  mimeType: ImageMimeType;
} | null> {
  const record = await prisma.richMenu.findUnique({
    where: { singleton: true },
    select: { imageData: true, imageMimeType: true },
  });

  if (
    record === null ||
    record.imageData === null ||
    record.imageMimeType === null
  ) {
    return null;
  }

  return {
    data: Uint8Array.from(record.imageData),
    mimeType: record.imageMimeType as ImageMimeType,
  };
}

/**
 * 下書きを保存する。**LINEは触らない。**
 *
 * @throws {AppError} 値が LINE の決まりに合わないとき
 */
export async function saveRichMenu(
  input: RichMenuInput,
  updatedByUserId: string,
): Promise<StoredRichMenu> {
  validateRichMenu(input);

  const areas = input.areas.map(toStoredArea);

  await prisma.richMenu.upsert({
    where: { singleton: true },
    create: {
      singleton: true,
      name: input.name,
      chatBarText: input.chatBarText,
      canvas: input.canvas,
      selected: input.selected,
      areas,
      updatedByUserId,
    },
    update: {
      name: input.name,
      chatBarText: input.chatBarText,
      canvas: input.canvas,
      selected: input.selected,
      areas,
      updatedByUserId,
    },
  });

  return readRichMenu();
}

/**
 * 画像を差し替える。
 *
 * **枠の縦横比と合わないものは断る。** 合っていないと、管理画面で
 * 見た升目と、指で押す場所が食い違う。
 *
 * @throws {AppError} 画像が LINE の決まりに合わないとき
 */
export async function saveRichMenuImage(
  bytes: Uint8Array,
  updatedByUserId: string,
): Promise<StoredRichMenu> {
  const inspected = inspectRichMenuImage(bytes);

  if (!inspected.ok) {
    throw richMenuError(RICH_MENU_ERROR_CODES.imageRejected, inspected.message);
  }

  const current = await readRichMenu();
  const canvas = RICH_MENU_CANVAS[current.canvas];

  if (!matchesCanvasAspect(inspected.image, canvas)) {
    throw richMenuError(
      RICH_MENU_ERROR_CODES.imageRejected,
      `画像の縦横比が枠と違います（${String(inspected.image.width)}×${String(inspected.image.height)}）。${String(canvas.width)}×${String(canvas.height)} と同じ比にしてください`,
    );
  }

  const data = Buffer.from(bytes);

  await prisma.richMenu.upsert({
    where: { singleton: true },
    create: {
      singleton: true,
      name: current.name,
      chatBarText: current.chatBarText,
      canvas: current.canvas,
      selected: current.selected,
      areas: current.areas.map(toStoredArea),
      imageData: data,
      imageMimeType: inspected.image.mimeType,
      imageWidth: inspected.image.width,
      imageHeight: inspected.image.height,
      updatedByUserId,
    },
    update: {
      imageData: data,
      imageMimeType: inspected.image.mimeType,
      imageWidth: inspected.image.width,
      imageHeight: inspected.image.height,
      updatedByUserId,
    },
  });

  return readRichMenu();
}

export interface ApplyRichMenuDeps {
  client: RichMenuClient;
}

/**
 * 設定からクライアントを作る。
 *
 * **`notify.ts` と同じ道を通る**（`getRuntimeEnv` は環境変数と
 * `app_settings` を重ねたもの）。トークンの置き場所を2つにしない。
 *
 * @throws {AppError} `LINE_CHANNEL_ACCESS_TOKEN` が無いとき
 */
export async function createConfiguredRichMenuClient(): Promise<RichMenuClient> {
  const env = await getRuntimeEnv();
  const result = readLineConfig({ ...env });

  if (!result.ok) {
    // **足りない変数名だけを見せる。値はログにも出さない**（SPEC 14.2）
    throw lineNotConfiguredError(result.missing);
  }

  return createRichMenuClient(result.config);
}

export interface AppliedRichMenu {
  lineRichMenuId: string;
  /** 片づけそこねた古いメニュー。**黙って消さない** */
  staleRichMenuId: string | null;
}

/**
 * LINEへ出す。
 *
 * ## 順番を守る
 *
 * `create` → 画像 → 既定、の順。**画像の無いメニューは既定にできない**
 * （LINE が断る）。
 *
 * ## 途中で失敗したら、いま出ているものを壊さない
 *
 * 作りかけを片づけてから投げる。**既定は差し替えない。**
 *
 * @throws {AppError} 画像が未設定、または LINE が受け付けなかったとき
 */
export async function applyRichMenu(
  deps: ApplyRichMenuDeps,
  updatedByUserId: string,
): Promise<AppliedRichMenu> {
  const menu = await readRichMenu();

  if (menu.areas.length === 0) {
    throw richMenuError(
      RICH_MENU_ERROR_CODES.notReady,
      '押す場所がありません。先に配置を決めてください',
    );
  }

  const image = await readRichMenuImage();

  if (image === null) {
    throw richMenuError(
      RICH_MENU_ERROR_CODES.notReady,
      '画像がありません。先に画像を上げてください',
    );
  }

  validateRichMenu(menu);

  const definition: RichMenuDefinition = {
    canvas: menu.canvas,
    name: menu.name,
    chatBarText: menu.chatBarText,
    selected: menu.selected,
    areas: menu.areas.map(toClientArea),
  };

  const created = await deps.client.create(definition);

  try {
    await deps.client.uploadImage(created, image.data, image.mimeType);
    await deps.client.setDefault(created);
  } catch (error) {
    // **作りかけを残さない。** ここで消せなくても、投げるのは元の理由
    await deps.client.remove(created).catch((cause: unknown) => {
      logger.error('作りかけのリッチメニューを片づけられなかった', {
        richMenuId: created,
        cause,
      });
    });

    throw error;
  }

  const previous = menu.lineRichMenuId;
  let staleRichMenuId: string | null = null;

  if (previous !== null && previous !== created) {
    // **古いものは既定を差し替えた後で消す。** 先に消すと、
    // 差し替えに失敗したときに誰にもメニューが出なくなる
    try {
      await deps.client.remove(previous);
    } catch (cause) {
      // **消せなくても適用は成った。** 画面に出して人に片づけさせる
      logger.error('古いリッチメニューを片づけられなかった', {
        richMenuId: previous,
        cause,
      });
      staleRichMenuId = previous;
    }
  }

  await prisma.richMenu.update({
    where: { singleton: true },
    data: {
      lineRichMenuId: created,
      appliedAt: new Date(),
      updatedByUserId,
    },
  });

  return { lineRichMenuId: created, staleRichMenuId };
}

export interface RichMenuState {
  /** LINE 側にいま在るもの全部 */
  remote: RemoteRichMenu[];
  /** 全員に出ているもの。無ければ `null` */
  defaultRichMenuId: string | null;
  /** 保存してある下書きが、いま出ているものと同じか */
  applied: boolean;
}

/**
 * **いま LINE に何が出ているかを確かめる**（段6の「接続をためす」と同じ）。
 *
 * 保存した値ではなく **LINE に問い合わせる。** ここが食い違うのは、
 * 公式アカウントマネージャー側で触られたときなど。
 */
export async function describeRichMenuState(
  deps: ApplyRichMenuDeps,
): Promise<RichMenuState> {
  const [menu, remote, defaultRichMenuId] = await Promise.all([
    readRichMenu(),
    deps.client.list(),
    deps.client.getDefault(),
  ]);

  return {
    remote,
    defaultRichMenuId,
    applied:
      menu.lineRichMenuId !== null && menu.lineRichMenuId === defaultRichMenuId,
  };
}

/** LINE 側の要らないメニューを消す（片づけ） */
export async function removeRemoteRichMenu(
  deps: ApplyRichMenuDeps,
  richMenuId: string,
): Promise<void> {
  const menu = await readRichMenu();

  if (menu.lineRichMenuId === richMenuId) {
    throw richMenuError(
      RICH_MENU_ERROR_CODES.inUse,
      'いま出ているメニューは消せません。先に新しいものを適用してください',
    );
  }

  await deps.client.remove(richMenuId);
}

/**
 * 値が LINE の決まりに合っているかを見る。
 *
 * **LINE に断られる前に断る。** API のエラーは英語で、
 * 何を直せばよいかが画面に出せない。
 */
export function validateRichMenu(input: RichMenuInput): void {
  if (
    input.name.trim() === '' ||
    input.name.length > MAX_RICH_MENU_NAME_LENGTH
  ) {
    throw richMenuError(
      RICH_MENU_ERROR_CODES.invalid,
      `名前は1〜${String(MAX_RICH_MENU_NAME_LENGTH)}字にしてください`,
    );
  }

  if (
    input.chatBarText.trim() === '' ||
    [...input.chatBarText].length > MAX_CHAT_BAR_TEXT_LENGTH
  ) {
    throw richMenuError(
      RICH_MENU_ERROR_CODES.invalid,
      `メニューバーの文字は1〜${String(MAX_CHAT_BAR_TEXT_LENGTH)}字にしてください`,
    );
  }

  if (input.areas.length > MAX_RICH_MENU_AREAS) {
    throw richMenuError(
      RICH_MENU_ERROR_CODES.invalid,
      `押す場所は${String(MAX_RICH_MENU_AREAS)}個までです`,
    );
  }

  const canvas = RICH_MENU_CANVAS[input.canvas];

  for (const [index, area] of input.areas.entries()) {
    const where = `${String(index + 1)}つ目`;

    if (
      !isNonNegativeInteger(area.x) ||
      !isNonNegativeInteger(area.y) ||
      !isPositiveInteger(area.width) ||
      !isPositiveInteger(area.height)
    ) {
      throw richMenuError(
        RICH_MENU_ERROR_CODES.invalid,
        `${where}の押す場所の位置と大きさを確かめてください`,
      );
    }

    if (
      area.x + area.width > canvas.width ||
      area.y + area.height > canvas.height
    ) {
      throw richMenuError(
        RICH_MENU_ERROR_CODES.invalid,
        `${where}の押す場所が枠（${String(canvas.width)}×${String(canvas.height)}）からはみ出しています`,
      );
    }

    if (area.label.trim() === '' || [...area.label].length > MAX_LABEL_LENGTH) {
      throw richMenuError(
        RICH_MENU_ERROR_CODES.invalid,
        `${where}の名前は1〜${String(MAX_LABEL_LENGTH)}字にしてください`,
      );
    }

    // **https だけ。** LINE は tel: なども受けるが、この実験で要らない
    if (!isHttpsUrl(area.uri) || area.uri.length > MAX_URI_LENGTH) {
      throw richMenuError(
        RICH_MENU_ERROR_CODES.invalid,
        `${where}の行き先は https:// で始まるURLにしてください`,
      );
    }
  }

  // **重ならないようにする。** 重なると、どちらが押されたか決まらない
  for (let i = 0; i < input.areas.length; i += 1) {
    for (let j = i + 1; j < input.areas.length; j += 1) {
      const a = input.areas[i];
      const b = input.areas[j];

      if (a !== undefined && b !== undefined && overlaps(a, b)) {
        throw richMenuError(
          RICH_MENU_ERROR_CODES.invalid,
          `${String(i + 1)}つ目と${String(j + 1)}つ目の押す場所が重なっています`,
        );
      }
    }
  }
}

function overlaps(a: RichMenuAreaInput, b: RichMenuAreaInput): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function toStoredArea(area: RichMenuAreaInput): Prisma.InputJsonValue {
  return {
    bounds: {
      x: area.x,
      y: area.y,
      width: area.width,
      height: area.height,
    },
    label: area.label,
    uri: area.uri,
  };
}

function toClientArea(area: RichMenuAreaInput): RichMenuArea {
  return {
    bounds: {
      x: area.x,
      y: area.y,
      width: area.width,
      height: area.height,
    },
    label: area.label,
    uri: area.uri,
  };
}

/**
 * 保存してある `areas` を読み直す。
 *
 * **読めない行は落とす。** 途中で形が変わっても画面が開かなくならない
 * ようにする（DATA_MODEL の jsonb の扱いと同じ）。
 */
function readAreas(value: Prisma.JsonValue): RichMenuAreaInput[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const areas: RichMenuAreaInput[] = [];

  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const bounds = record['bounds'];

    if (typeof bounds !== 'object' || bounds === null) {
      continue;
    }

    const box = bounds as Record<string, unknown>;
    const x = box['x'];
    const y = box['y'];
    const width = box['width'];
    const height = box['height'];
    const label = record['label'];
    const uri = record['uri'];

    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      typeof width !== 'number' ||
      typeof height !== 'number' ||
      typeof label !== 'string' ||
      typeof uri !== 'string'
    ) {
      continue;
    }

    areas.push({ x, y, width, height, label, uri });
  }

  return areas;
}
