/**
 * LINE メッセージ送信（TASKS F-2、SPEC 8）。
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
