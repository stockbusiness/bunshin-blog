# CONTENT_PLANNING.md — 構成表生成のAI仕様

対象タスク：E-4 〜 E-12
対応仕様：`docs/SPEC.md` v2.1 第9章
参照：`docs/DATA_MODEL.md`

---

## 1. 原則

### 1.1 AIとコードの境界

| 担当 | 範囲 |
|---|---|
| **AI** | ジャンルの妥当性コメント、隣接ジャンルの提案、キーワード案、タイトル案、検索意図の言語化、記事本文の生成、記事内の事実主張の抽出 |
| **コード** | 足切り、スコア計算、記事本数の算出、リンク本数の集計、重複検出、再生成ループの制御、制約チェックの合否判定、facts との照合判定 |

**AIに「制約を満たしているか」を判断させてはならない。** AIは案を出す係であり、可否を決めるのはコードである。

この境界を破る実装の例（いずれも禁止）：

- プロンプトに「各収益記事に集客記事を3本以上割り当ててください」と書いて、その結果を検証せずに保存する
- AIに「この案件は足切り対象ですか」と尋ねる
- AIの出力に含まれる `score` をそのまま `selection_score` に保存する

### 1.2 出力形式

- 全プロンプトはJSONのみを返させる。前置き・後書き・Markdownのコードフェンスを禁止する
- 受信側は必ずZodスキーマで検証する。検証に失敗したら**1回だけ再試行**し、それでも失敗ならジョブを `FAILED` にする
- `temperature` は案出し系 0.7、抽出・分類系 0.0

### 1.3 モデルの指定

コードにモデル名を直書きしない。以下の役割名で参照し、実体は環境変数と `prompt_versions` で管理する（SPEC 9.8）。

| 役割 | 用途 |
|---|---|
| `MODEL_LOW` | 分類、抽出、重複判定、通知文 |
| `MODEL_STANDARD` | 集客記事の本文、キーワード案、検索意図 |
| `MODEL_HIGH` | 収益記事の本文、比較記事、ジャンル審査の所見 |

### 1.4 プロンプトのキー命名

`prompt_versions.key` は以下に固定する。

```text
planning.step1.genre_review
planning.step1.alternative_genres
planning.step2.search_demand
planning.step3.revenue_titles
planning.step4.search_intents
planning.step4.keywords
planning.repair.keyword_conflict
generation.article
generation.claim_extraction
```

---

## 2. STEP 1：ジャンル審査（E-4）

### 2.1 コードが判定すること

停止条件・警告条件の判定は全てコードで行う。AIの出力は判定に使わない。

```ts
type Step1Input = {
  genreName: string;
  ymylRisk: "HIGH" | "MEDIUM" | "LOW";   // genres マスタから
  offerCount: number;                     // 該当ASPの案件数
  serpTop10: { domainType: "official" | "major_comparison" | "personal" | "other" }[];
  userHasExperience: boolean;
};

// 停止：ymylRisk === "HIGH" | offerCount === 0 | official+major_comparison >= 8
// 警告：personal <= 2 | !userHasExperience | offerCount === 1
```

`serpTop10` が取得できない場合はADMINの手動入力値を使う（SPEC 9.2.2 フォールバック）。**取得できないことを理由に停止条件をスキップしてはならない。**

### 2.2 AI呼び出し：`planning.step1.genre_review`

判定結果を利用者に伝える文章を作らせる。判定そのものは渡された結果を言い換えるだけ。

入力

```json
{
  "genreName": "string",
  "decision": "PASSED | WARNED | BLOCKED",
  "reasons": ["ymyl_high", "serp_dominated_by_major"],
  "userHasExperience": true
}
```

出力

```json
{
  "summary": "string（120字以内。判定理由を平易に説明する）",
  "cautions": ["string（最大3件。進める場合の注意点）"]
}
```

**`decision` をAIに再判定させない。** 入力の値をそのまま説明させる。

### 2.3 AI呼び出し：`planning.step1.alternative_genres`

`BLOCKED` のときのみ実行する。

入力

```json
{ "genreName": "string", "blockedReasons": ["string"], "userProfile": { "experiences": ["string"] } }
```

出力

```json
{
  "candidates": [
    { "name": "string", "reason": "string（80字以内）", "expectedYmylRisk": "LOW | MEDIUM" }
  ]
}
```

- `candidates` は3件
- **受信後、コードで `expectedYmylRisk = "HIGH"` を含む候補と、既に `BLOCKED` になったジャンルを除外する**
- 差し戻しは2回まで。3回目は続行選択肢を出し、選択を `planning_runs.overridden_at` と `audit_logs` に記録する

---

## 3. STEP 2：案件選定（E-5）

### 3.1 コードが判定すること

足切りとスコアの**全項目**をコードで計算する。

```ts
// 足切り
status === "ENDED" || status === "PAUSED"
conversionType === "PURCHASE" && rewardYen < 3000
conversionType === "FREE_SIGNUP" && rewardYen < 800
denyConditions.length >= 3
lpMobileReady === false
// ブログ掲載禁止フラグ

// スコア
conversionPoint: FREE_SIGNUP 30 / REQUEST 20 / TRIAL 15 / PURCHASE 10
reward:    >=10000 →20 / >=5000 →15 / >=3000 →10 / >=1000 →5 / else 0
lpQuality: lpFormFields <=5 →20 / <=10 →10 / else 0
searchDemand: AI判定（3.2）を 0|8|15 に写像
experience: USED 10 / UNKNOWN 3 / NOT_USED 0
denyConditions: 0件5 / 1件3 / 2件1
```

`lpFormFields` と `lpMobileReady` は D-2 の自動評価結果を使う。未評価の案件はスコアリング対象外とし、ADMINに通知する。

### 3.2 AI呼び出し：`planning.step2.search_demand`

商品名の検索需要の有無だけを判定させる。**スコアは返させない。**

入力

```json
{ "offerName": "string", "advertiserName": "string|null", "genreName": "string" }
```

出力

```json
{ "demand": "HIGH | MEDIUM | NONE", "note": "string（60字以内）" }
```

写像は `HIGH → 15 / MEDIUM → 8 / NONE → 0`。**この写像はコード側の定数とする。**

### 3.3 採用

`total >= 60` の上位3件を採用する。0件なら STEP 1 へ差し戻す。
結果は `affiliate_offers.selection_score` と `score_breakdown` に保存する。

---

## 4. STEP 3：収益記事の設計（E-6）

### 4.1 コードが決めること

```ts
const revenueCount = Math.min(selectedOffers.length * 2 + 1, 10);
// 案件ごとに「口コミ・評判」「料金・解約」、全体で「比較」1本
```

記事の**種類と本数はコードが決め、AIはタイトルと検索意図の文言のみ**を作る。

### 4.2 AI呼び出し：`planning.step3.revenue_titles`

入力

```json
{
  "blogPersona": { "penName": "string", "targetReader": {}, "tone": {} },
  "slots": [
    { "slotId": "string", "offerName": "string", "pattern": "REVIEW | PRICING | COMPARISON", "offerFacts": {} }
  ]
}
```

出力

```json
{
  "items": [
    {
      "slotId": "string",
      "title": "string（40字以内）",
      "primaryKeyword": "string",
      "searchIntent": "string（読者の状態を50字以内で）"
    }
  ]
}
```

検証：`items.length === slots.length`、`slotId` が一致すること、`primaryKeyword` が空でないこと。

---

## 5. STEP 4：集客記事とリンク設計（E-7）

### 5.1 手順

```text
1. 収益記事ごとに、そこへ繋ぐ検索意図を3つ以上列挙させる（AI）
2. 検索意図をキーワードへ変換させる（AI）
3. 重複を検出する（コード）
4. 重複があれば差し替え案を作らせる（AI）
5. リンク本数を集計する（コード）
6. 不足する収益記事に、追加の集客記事を割り当てる（コード＋AI）
```

### 5.2 AI呼び出し：`planning.step4.search_intents`

入力

```json
{
  "revenueItems": [
    { "itemId": "string", "title": "string", "pattern": "REVIEW | PRICING | COMPARISON", "offerName": "string" }
  ],
  "genreName": "string",
  "targetReader": {}
}
```

出力

```json
{
  "intents": [
    { "revenueItemId": "string", "intent": "string（50字以内）", "readerState": "string" }
  ]
}
```

**`pattern = "PRICING"` の収益記事には、費用・相場・補助金・比較検討に関する意図を優先して割り当てるよう指示する（SPEC 9.2.5）。** 悩み系の意図は `REVIEW` に偏るため、放置すると料金記事への流入が3本を下回る。

検証：各 `revenueItemId` について3件以上あること。不足していれば当該IDのみ再実行する。

### 5.3 AI呼び出し：`planning.step4.keywords`

入力

```json
{
  "intents": [{ "intentId": "string", "intent": "string", "readerState": "string" }],
  "existingKeywords": ["string"],
  "genreName": "string"
}
```

出力

```json
{
  "items": [
    {
      "intentId": "string",
      "title": "string（40字以内）",
      "primaryKeyword": "string",
      "contentType": "INFORMATIONAL | EXPERIENCE | FAQ | COMPARISON"
    }
  ]
}
```

`existingKeywords` を渡しても重複は出る。**必ずコード側で正規化して突合する。**

```ts
const normalize = (k: string) =>
  k.normalize("NFKC").replace(/[\s　]+/g, " ").trim().toLowerCase();
```

### 5.4 AI呼び出し：`planning.repair.keyword_conflict`

重複した項目のみを対象に、差し替え案を作らせる。全体を作り直させない。

入力

```json
{ "conflicts": [{ "intentId": "string", "keyword": "string" }], "existingKeywords": ["string"] }
```

出力

```json
{ "items": [{ "intentId": "string", "title": "string", "primaryKeyword": "string" }] }
```

### 5.5 リンクの割り当て（コードのみ）

```ts
// 各集客記事は、由来した intent の revenueItemId を outbound に持つ（最大2件）
// 収益記事の inbound は、それを参照する集客記事の集合として算出する
// 収益記事は outbound を空にする
```

**`outbound_link_item_ids` に `contentType !== "AFFILIATE"` のIDが入っていないことを、保存直前に必ず検査する。** 手作業での検証では30本中9本でこの誤りが発生した。

---

## 6. 制約チェックと再生成ループ（E-8）

```ts
async function buildPlan(ctx: PlanningContext): Promise<PlanResult> {
  for (let retry = 0; retry <= 3; retry++) {
    const revenue = await designRevenueItems(ctx);        // STEP 3
    const traffic = await designTrafficItems(ctx, revenue); // STEP 4
    const result = checkConstraints(revenue, traffic);      // コードのみ

    await recordPlanningRun(ctx, { retry, result });

    if (result.passed) {
      return { revenue, traffic, result };
    }
    ctx = applyRepairHints(ctx, result); // 不足している収益記事IDなどを次回入力に渡す
  }
  throw new PlanningFailedError("constraints_not_satisfied");
}
```

- `checkConstraints` は `DATA_MODEL.md` 4章の制約1〜7を判定し、結果を `planning_runs.constraint_result` に保存する
- **3回で収束しない場合はジョブを `FAILED` とし、ADMINへ通知する。暫定的な構成表を承認依頼へ送ってはならない**（SPEC 9.2.6）
- 再試行時は全体を作り直さず、`applyRepairHints` で不足箇所のみを対象にする

---

## 7. 記事生成（E-10 / E-11）

### 7.1 AI呼び出し：`generation.article`

入力

```json
{
  "contentItem": { "title": "string", "primaryKeyword": "string", "searchIntent": "string", "contentType": "string" },
  "persona": { "penName": "string", "tone": {}, "writingRules": {}, "ngExpressions": ["string"] },
  "usableFacts": [{ "factId": "string", "content": "string", "usableFirstPerson": true }],
  "offer": { "name": "string", "facts": {}, "affiliateUrl": "string" },
  "internalLinks": [{ "itemId": "string", "title": "string", "url": "string" }],
  "existingTitles": ["string"]
}
```

出力

```json
{
  "title": "string",
  "excerpt": "string（120字以内）",
  "answerCapsule": "string（80〜120字。H1直後に置く結論）",
  "bodyHtml": "string",
  "faq": [{ "question": "string（疑問形）", "answer": "string" }],
  "usedFactIds": ["string"],
  "claims": [{ "text": "string", "source": "offer_facts | persona_facts | general" }]
}
```

### 7.2 必ず守らせる制約

プロンプトに明記し、かつ**受信後にコードで検査する**。

- `usableFirstPerson = false` の fact を一人称体験として書かない
- `offer.facts` に無い価格・条件・機能を書かない
- `answerCapsule` は80〜120字（コードで文字数を検査。範囲外なら再生成）
- `faq` は3〜5件、`question` は疑問符で終わる
- `internalLinks` 以外へのリンクを本文に含めない
- 収益記事にはPR表記を含める

### 7.3 JSON-LD

**AIに生成させない。** `faq` から**コードで組み立てる**。

```ts
// 記事種別によらず FAQPage のみ
```

生成後に `JSON.parse` で構文を検証し、失敗したら記事を `READY_FOR_REVIEW` にせずジョブを失敗させる。

**`Review` は出さない**（E-16・OPEN_QUESTIONS Q-021）。当初は収益記事に `FAQPage` と `Review` を出す想定だったが、**評点の出どころが無い。** 分身は案件の `facts` の範囲でしか書けず（SPEC 9.6）、「5段階で4.5」という数字はどこにも存在しない。作り出せば SPEC 9.6 が禁じる「根拠のないランキング」そのものになる。

一方 Google の `Review` は `reviewRating` を必須としており、**評点なしで出してもリッチリザルトの対象にならない。** 目的を果たさないまま、根拠のない申告の形だけが残る。

承認画面でモニターに評点を入力させる案は、短期KPIが「承認率」と「1記事当たり確認時間」（SPEC 11.1）である以上、**承認1回あたりの負担を増やすので採らない。**

---

## 8. 事実チェック（E-12）

### 8.1 AI呼び出し：`generation.claim_extraction`

本文から事実主張を抽出させるだけ。**照合はコードで行う。**

入力

```json
{ "bodyHtml": "string" }
```

出力

```json
{
  "claims": [
    { "text": "string", "type": "PRICE | CONDITION | FEATURE | EXPERIENCE | GENERAL", "excerpt": "string" }
  ]
}
```

### 8.2 コードによる照合

```ts
// PRICE / CONDITION / FEATURE → offer.facts に対応があるか
// EXPERIENCE → usableFirstPerson = true の persona_facts に対応があるか
// 対応なし → unverifiedClaims に追加
```

判定（SPEC 9.7）

| 結果 | 条件 | 扱い |
|---|---|---|
| `PASSED` | 未確認主張が0件 | 承認依頼へ |
| `WARNING` | `GENERAL` のみ未確認 | リスク表示付きで承認依頼へ |
| `FAILED` | `PRICE` / `CONDITION` / `FEATURE` / `EXPERIENCE` に未確認あり | **承認依頼へ送らない。** 再生成または人手修正 |

`offer.facts.updatedAt` が90日より古い場合は、照合が一致しても `WARNING` とする。

---

## 9. 費用の記録

全てのAI呼び出しについて、`ai_usage_logs` に `operation`（上記のプロンプトキー）、トークン数、コストを記録する。**再生成ループの各試行も個別に記録する。** 再生成が何回発生しているかが、プロンプト改善の主要な指標になる。

---

## 10. 実装時の確認事項

- [ ] 全プロンプトの出力がZodスキーマで検証されている
- [ ] 判定・集計・スコア計算にAIの出力を使っていない
- [ ] `outbound_link_item_ids` の種別検査が保存直前にある
- [ ] 再生成ループが最大3回で打ち切られ、失敗がADMINへ通知される
- [ ] `answerCapsule` の文字数がコードで検査されている
- [ ] JSON-LDがコードで組み立てられ、構文検証されている
- [ ] `FAILED` の記事が承認依頼に流れない
- [ ] モデル名がコードに直書きされていない
