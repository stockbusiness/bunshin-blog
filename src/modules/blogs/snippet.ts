import { AppError } from '@/lib/errors';

/**
 * `bunshin-go.php` を組み立てる（TASKS I-9、D-12）。
 *
 * ## なぜ組み立てて渡すのか
 *
 * これまでは、手引き（`WORDPRESS_SNIPPET.md`）のPHPを写して
 * **トークンと受信APIのURLを手で貼っていた**（段10）。
 *
 * **貼る作業がある限り、貼り間違いが起きる。** トークンは一度しか
 * 表示できず（DBにはハッシュしか無い・D-12）、**間違えたことに
 * 気づくのはリンクが404になったとき**である。
 *
 * **埋めたものを渡せば、置くだけで済む。**
 *
 * ## 書き換えの版を持たせる
 *
 * `mu-plugins` には有効化の合図が無い（通常のプラグインと違い、
 * 置いた瞬間から動く）。**`/go/` の書き換え規則は、一度
 * `flush_rewrite_rules()` を呼ばないと効かない。**
 *
 * これまでは手引きで「パーマリンクを保存し直す」と案内していたが、
 * **版を覚えておいて、違っていたら自分で1回だけ流す**ようにした。
 *
 * ## 埋める値を検査する
 *
 * **PHPの文字列リテラルへ入れる。** 引用符や改行が混ざると、
 * **プラグインが構文エラーで丸ごと動かない**（リンクが全部404になる）。
 * 値の形を先に確かめ、危なければ組み立てない。
 */

/**
 * 書き換え規則の版。
 *
 * **規則を変えたら上げる。** 上げないと、既に置いてあるサイトで
 * 古い規則が残り続ける。
 */
export const SNIPPET_RULES_VERSION = '1';

/** トークンの形（D-12 の `generateLinkEventToken` が作る文字種） */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * 受信APIのURLを確かめる。
 *
 * **単独で呼べるようにしてある。** トークンを発行する前に確かめたい
 * ため — 発行してから組み立てに失敗すると、**古いトークンが無効に
 * なったのに新しいファイルが手に入らない**状態になる。
 */
export function assertSnippetEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw AppError.validationFailed('受信APIのURLが不正です');
  }

  // **`https` だけ。** トークンを `Authorization` に載せて送る
  if (url.protocol !== 'https:') {
    throw AppError.validationFailed(
      '受信APIのURLは https である必要があります',
    );
  }

  // 引用符・改行・バックスラッシュが混ざったURLは組み立てない
  if (/['"\\\r\n]/.test(endpoint)) {
    throw AppError.validationFailed('受信APIのURLに使えない文字があります');
  }
}

/**
 * そのブログ専用の `bunshin-go.php` を組み立てる。
 *
 * **トークンは呼び出し側が発行したものを受け取る。** ここでは
 * 作らない（発行は `issueLinkEventTokenForUser` の仕事で、
 * **原文を持つ場所を増やさない**）。
 */
export function buildLinkSnippet(params: {
  token: string;
  /** 受信API（例 `https://bunshin.example/api/link-events`） */
  endpoint: string;
}): string {
  if (!TOKEN_PATTERN.test(params.token)) {
    throw AppError.validationFailed('トークンの形式が不正です');
  }

  assertSnippetEndpoint(params.endpoint);

  return `<?php
/**
 * Plugin Name: Bunshin リンク計測
 * Description: /go/{code} を処理し、クリックを Bunshin へ送る
 *
 * **このファイルは Bunshin が組み立てたものです。**
 * 中の値を書き換えないでください。作り直すときは Bunshin の
 * ブログ設定から改めて受け取ってください。
 */

if (!defined('ABSPATH')) {
    exit;
}

define('BUNSHIN_LINK_TOKEN', '${params.token}');
define('BUNSHIN_EVENT_ENDPOINT', '${params.endpoint}');
define('BUNSHIN_RULES_VERSION', '${SNIPPET_RULES_VERSION}');

const BUNSHIN_QUEUE_OPTION = 'bunshin_link_queue';
const BUNSHIN_MAP_PREFIX   = 'bunshin_go_';
const BUNSHIN_QUEUE_MAX    = 500;
const BUNSHIN_RULES_OPTION = 'bunshin_rules_version';

/**
 * /go/{code} を受け取れるようにする。
 *
 * **mu-plugins には有効化の合図が無い**ので、版が違うときだけ
 * 自分で1回流す。パーマリンクを保存し直す作業が要らない。
 */
add_action('init', function () {
    add_rewrite_rule('^go/([A-Za-z0-9_-]+)/?$', 'index.php?bunshin_go=$matches[1]', 'top');

    if (get_option(BUNSHIN_RULES_OPTION) !== BUNSHIN_RULES_VERSION) {
        flush_rewrite_rules(false);
        update_option(BUNSHIN_RULES_OPTION, BUNSHIN_RULES_VERSION, false);
    }
});

add_filter('query_vars', function ($vars) {
    $vars[] = 'bunshin_go';
    return $vars;
});

/** クリックを受けてリダイレクトする */
add_action('template_redirect', function () {
    $code = get_query_var('bunshin_go');

    if ($code === '') {
        return;
    }

    $destination = bunshin_lookup_destination($code);

    if ($destination === null) {
        status_header(404);
        nocache_headers();
        echo 'リンクが見つかりません';
        exit;
    }

    bunshin_enqueue_click($code);

    // 302。301 はブラウザが覚えてしまい、以後クリックを数えられない
    nocache_headers();
    wp_redirect($destination, 302);
    exit;
});

/**
 * 飛び先を引く。
 *
 * Bunshin へ問い合わせ、結果をキャッシュする。**キャッシュがあれば
 * Bunshin が落ちていても読者は広告主へ行ける。**
 */
function bunshin_lookup_destination($code) {
    $key    = BUNSHIN_MAP_PREFIX . $code;
    $cached = get_transient($key);

    if ($cached !== false) {
        return $cached === '' ? null : $cached;
    }

    $response = wp_remote_get(
        BUNSHIN_EVENT_ENDPOINT . '/resolve?code=' . rawurlencode($code),
        [
            'timeout' => 3,
            'headers' => ['Authorization' => 'Bearer ' . BUNSHIN_LINK_TOKEN],
        ]
    );

    if (is_wp_error($response) || wp_remote_retrieve_response_code($response) !== 200) {
        return null;
    }

    $body = json_decode(wp_remote_retrieve_body($response), true);
    $url  = isset($body['destinationUrl']) ? $body['destinationUrl'] : '';

    // 見つからなかったことも短く覚える（総当たりで毎回問い合わせない）
    set_transient($key, $url, $url === '' ? 300 : DAY_IN_SECONDS);

    return $url === '' ? null : $url;
}

/**
 * クリックを控える。
 *
 * **送信の成否で読者を待たせない。** 控えてからまとめて送る。
 * **IPアドレスは残さない。** UA は sha256 にしてから積む。
 */
function bunshin_enqueue_click($code) {
    $queue = get_option(BUNSHIN_QUEUE_OPTION, []);

    if (!is_array($queue)) {
        $queue = [];
    }

    if (count($queue) >= BUNSHIN_QUEUE_MAX) {
        return;
    }

    $agent = isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : '';

    $queue[] = [
        'code'          => $code,
        'occurredAt'    => gmdate('c'),
        'userAgentHash' => hash('sha256', $agent),
    ];

    update_option(BUNSHIN_QUEUE_OPTION, $queue, false);

    if (!wp_next_scheduled('bunshin_flush_clicks')) {
        wp_schedule_single_event(time() + 60, 'bunshin_flush_clicks');
    }
}

/** 控えたクリックをまとめて送る */
add_action('bunshin_flush_clicks', function () {
    $queue = get_option(BUNSHIN_QUEUE_OPTION, []);

    if (!is_array($queue) || count($queue) === 0) {
        return;
    }

    $response = wp_remote_post(
        BUNSHIN_EVENT_ENDPOINT,
        [
            'timeout' => 5,
            'headers' => [
                'Authorization' => 'Bearer ' . BUNSHIN_LINK_TOKEN,
                'Content-Type'  => 'application/json',
            ],
            'body'    => wp_json_encode(['events' => $queue]),
        ]
    );

    $status = is_wp_error($response) ? 0 : wp_remote_retrieve_response_code($response);

    // **2xx でなければ捨てない。** 落ちていた間のクリックを失わない。
    // 同じものが2回届いても、Bunshin 側が eventId で落とす
    if ($status >= 200 && $status < 300) {
        update_option(BUNSHIN_QUEUE_OPTION, [], false);
        return;
    }

    wp_schedule_single_event(time() + 300, 'bunshin_flush_clicks');
});
`;
}
