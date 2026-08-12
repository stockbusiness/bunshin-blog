# WordPress スニペットの導入手順

TASKS D-12。**各ブログのドメインで `/go/{code}` を処理する**ための小さなプラグイン。

この文書は**モニターに渡す手順書**である。作業する人の手元に WordPress の管理画面がある前提で書く。

---

## 0. なぜ入れるのか

アフィリエイトリンクは、記事の中では `https://あなたのブログ/go/xxxxx` という形になっている。**このスニペットが入っていないと、そのURLは 404 になり、読者が広告主のページへ行けない。**

**Bunshin の共通ドメインを経由しない理由。** 30ブログが同じ外部ドメインへリンクすると、**それらが同じ運営者のものであることが外から辿れる**（OPEN_QUESTIONS Q-001 の再決定・2026-08-11）。クリックの計測を一元化するより、この痕跡を残さないほうを優先している。

---

## 1. トークンを発行する

1. Bunshin のブログ設定を開く
2. 「クリック計測のトークンを発行」を押す
3. **表示された文字列をコピーする**

**トークンは一度しか表示されない。** Bunshin 側はハッシュしか保存しないので、後から見ることはできない。無くしたら作り直す（**作り直すと古いものはその場で効かなくなる**ので、スニペットの書き換えも必要）。

---

## 2. ファイルを置く

`wp-content/mu-plugins/bunshin-go.php` として保存する。`mu-plugins` フォルダが無ければ作る。

**`mu-plugins` に置く理由。** 通常のプラグインと違い、**管理画面から誤って停止できない。** 停止するとリンクが全部 404 になる。

```php
<?php
/**
 * Plugin Name: Bunshin リンク計測
 * Description: /go/{code} を処理し、クリックを Bunshin へ送る
 */

if (!defined('ABSPATH')) {
    exit;
}

// ── 設定 ──────────────────────────────────────────────
// 手順1でコピーしたトークン
define('BUNSHIN_LINK_TOKEN', 'ここにトークンを貼る');
// Bunshin の受信API
define('BUNSHIN_EVENT_ENDPOINT', 'https://<Bunshinのドメイン>/api/link-events');
// ─────────────────────────────────────────────────────

const BUNSHIN_QUEUE_OPTION = 'bunshin_link_queue';
const BUNSHIN_MAP_PREFIX   = 'bunshin_go_';
const BUNSHIN_QUEUE_MAX    = 500;

/** /go/{code} を受け取れるようにする */
add_action('init', function () {
    add_rewrite_rule('^go/([A-Za-z0-9_-]+)/?$', 'index.php?bunshin_go=$matches[1]', 'top');
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
        // 溜まりすぎたら古いものから捨てる（保存領域を食いつぶさない）
        array_shift($queue);
    }

    $referrer = isset($_SERVER['HTTP_REFERER']) ? wp_parse_url($_SERVER['HTTP_REFERER'], PHP_URL_HOST) : null;
    $agent    = isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : '';

    $queue[] = [
        'eventId'       => wp_generate_uuid4(),
        'code'          => $code,
        'clickedAt'     => gmdate('c'),
        'referrerHost'  => $referrer === false ? null : $referrer,
        'userAgentHash' => $agent === '' ? null : hash('sha256', $agent),
    ];

    update_option(BUNSHIN_QUEUE_OPTION, $queue, false);

    if (!wp_next_scheduled('bunshin_flush_clicks')) {
        wp_schedule_single_event(time() + 60, 'bunshin_flush_clicks');
    }
}

/** 控えたものをまとめて送る */
add_action('bunshin_flush_clicks', function () {
    $queue = get_option(BUNSHIN_QUEUE_OPTION, []);

    if (!is_array($queue) || count($queue) === 0) {
        return;
    }

    $response = wp_remote_post(BUNSHIN_EVENT_ENDPOINT, [
        'timeout' => 10,
        'headers' => [
            'Content-Type'  => 'application/json',
            'Authorization' => 'Bearer ' . BUNSHIN_LINK_TOKEN,
        ],
        'body' => wp_json_encode(['events' => $queue]),
    ]);

    $status = is_wp_error($response) ? 0 : wp_remote_retrieve_response_code($response);

    // **2xx でなければ消さない。** 次回まとめて送り直す。
    // 同じものが2回届いても、Bunshin 側が eventId で落とす
    if ($status >= 200 && $status < 300) {
        update_option(BUNSHIN_QUEUE_OPTION, [], false);
        return;
    }

    wp_schedule_single_event(time() + 600, 'bunshin_flush_clicks');
});
```

---

## 3. パーマリンクを保存し直す

管理画面の「設定 → パーマリンク」を開き、**何も変えずに「変更を保存」を押す。**

`/go/` の書き換え規則はこれで有効になる。押さないと 404 のままになる。

---

## 4. `robots.txt` に1行足す

```
Disallow: /go/
```

**検索エンジンに広告リンクを辿らせない。** 辿られると、クリック数に人でないものが混ざる。

---

## 5. 確かめる

1. 記事の中のアフィリエイトリンクを1つ踏む
2. 広告主のページへ飛べば成功
3. 1〜2分待って、Bunshin の管理画面でクリック数が増えることを確認する

**飛べなかったとき。**

| 症状 | 見るところ |
|---|---|
| 404 になる | 手順3（パーマリンクの保存し直し）をしたか |
| 飛ぶがクリックが増えない | トークンが正しいか（手順1）。作り直したなら貼り直す |
| しばらくして増える | 正常。**まとめて送っている**ので、最大10分ほど遅れる |

---

## 6. 送るもの・送らないもの

| 送る | 送らない |
|---|---|
| コード（`/go/` の後ろ） | **IPアドレス** |
| クリックの時刻 | **参照元のURL全体**（ホスト名だけ送る） |
| 参照元のホスト名 | **User-Agent の原文**（sha256 にしてから送る） |
| User-Agent の sha256 | 読者を特定できるもの全般 |

**Bunshin 側も同じものしか保存しない**（`link_clicks`・SPEC 14.2）。
