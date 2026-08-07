import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * 画面テストの前後処理（TASKS B-9）。
 *
 * **描画したDOMをテストごとに片付ける。** 残したままにすると、次のテストの
 * `getByRole` が前のテストの要素に当たり、落ち方が実行順に依存する。
 */
afterEach(() => {
  cleanup();
});
