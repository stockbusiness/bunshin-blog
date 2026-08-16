/**
 * LINE メッセージ送信（TASKS F-2、SPEC 8）と Webhook の署名検証（D-7b）。
 *
 * `src/lib/mailer/` と同じ形。**呼び出し側は `LineClient` だけを見る。**
 */

export {
  type LineClient,
  type LineMessage,
  type LineTextMessage,
  type LineButtonsMessage,
  type LineAction,
  type LinePushRequest,
  LineSendError,
  LineNotConfiguredError,
} from './types';

export {
  createLineClient,
  requireLineClient,
  readLineConfig,
  LINE_PUSH_ENDPOINT,
  type LineConfig,
  type CreateLineClientOptions,
} from './messaging';

export { verifyLineSignature, readLineChannelSecret } from './signature';

export {
  createRichMenuClient,
  toLinePayload,
  MAX_CHAT_BAR_TEXT_LENGTH,
  MAX_RICH_MENU_AREAS,
  MAX_RICH_MENU_NAME_LENGTH,
  RICH_MENU_CANVAS,
  RICH_MENU_DATA_ENDPOINT,
  RICH_MENU_DEFAULT_ENDPOINT,
  RICH_MENU_ENDPOINT,
  type RemoteRichMenu,
  type RichMenuArea,
  type RichMenuBounds,
  type RichMenuCanvasName,
  type RichMenuClient,
  type RichMenuDefinition,
} from './rich-menu';

export {
  inspectRichMenuImage,
  matchesCanvasAspect,
  ASPECT_TOLERANCE,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_WIDTH,
  MIN_IMAGE_HEIGHT,
  MIN_IMAGE_WIDTH,
  type ImageMimeType,
  type InspectedImage,
  type InspectImageResult,
} from './rich-menu-image';
