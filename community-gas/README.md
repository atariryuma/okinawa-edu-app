# みんなの問題（コミュニティ共有）バックエンド — セットアップ

利用者が作った問題を**承認制で全員に自動共有**するための Google Apps Script (GAS) Web App です。
バックエンドはこの GAS のみ（サーバ運用なし・無料）。ストアは Google スプレッドシート。

- 受け取り＝全自動：アプリは起動時に `doGet` を読み、承認済み問題を合成して出題。
- 投稿＝ワンタップ：アプリの「作成後に共有に出す」/「📣 自作を共有に出す」が `doPost`。
- 品質管理＝あなた：スプレッドシートの `status` を `approved` にした問題だけが配信される。

## クライアントとの契約（変更不可）
- `doGet()` → `{"ok":true,"questions":[ <問題オブジェクト>, ... ]}`（approved のみ）
- `doPost()` → 本文は `Content-Type: text/plain` の JSON。新形式 `{"q":<問題>, "idtoken":"<IDトークン(JWT)|空>", "device":"<端末ID>"}`（旧 `token` キー／問題そのものも後方互換）。送るのは身元アサーションのみの**IDトークン**で、Drive 等へのアクセス権は持たない。成功 `{"ok":true,"status":"approved"|"pending"}` / 失敗 `{"ok":false,"error":"..."}`

## 自動公開モデル（段階可視性＋可逆）
自動公開(`approved`)の条件は **`sourceOk && (trusted || rep>=REP_TRUST)`**。本人確認(identity)だけでなく「公式出典」を必須にして、誤った条文の即時拡散を防ぐ。
- **出典ゲート `srcResolves_`**：`src` が公式ソース（アプリの `LAW_LINKS`/`DOC_LINKS` を移植した `SRC_PATTERNS`＝e-Gov/文科省/県）に解決する時だけ自動公開の資格。解決しない曖昧出典は `pending`（人手へ）。
- **本人確認 `trusted`**：IDトークンの `aud`/`azp`=`CLIENT_ID`、`email_verified` 真、`iss`=Google、未失効を `verifyToken_()` が検証。
- **段階信頼 `rep`**：その端末(`device`)の「承認済み」実績が `REP_TRUST(=2)` 以上なら、匿名でも自動公開の資格（新規/匿名の一発毒入れは `pending` で止め、実績が貯まれば無人で流れる）。
- **匿名・出典なし・実績不足の投稿**：`pending`。あなたがシートで `approved` にした時だけ配信。
- **👍 役に立った→浮上＆検証済み昇格**：出題画面の「👍 役に立った」が `{action:'vote',id,idtoken}` を送る。**投票は本人確認(IDトークン)必須＝1 Google アカウント1票**（`handleVote_` が `verifyTokenSub_` で検証した `sub` 単位で集計・レート・二重投票抑止。未ログインは `{error:'login required'}`）。`up` が `UP_VERIFY(=3)` 以上（かつ `reports` が限度未満）で doGet が `v=1`＝「✓検証済み(コミュニティ)」を返し、`up` 降順（人気順）で配信。端末ID偽装でのバッジ水増しを封じる。
- **⚠️通報→自動降格（可逆）**：出題画面の「⚠️通報」が `{action:'report',id,idtoken}` を送る。**通報も本人確認(IDトークン)必須**（`handleReport_` が `verifyTokenSub_` で `sub` 検証。未ログインは `{error:'login required'}`。レート/二重通報抑止は `sub` 基準）。`reports` が `REPORT_LIMIT(=3)` に達すると `approved`→`pending` に自動降格＝再審査へ。**降格には「異なる検証済みアカウント」が `REPORT_LIMIT` 名必要**＝端末ID偽装で良問を不正に非公開化(suppression)できない（投票と対称）。
- シート列：`timestamp,status,id,type,cat,json,q,src,device,reports,up`（`device`/`reports`/`up` を追加。コード更新後は **`setup` を再実行**してヘッダを整える）。※`device` は現在「投稿(submit)」のレート/`rep`実績集計にのみ使用。投票・通報は `sub` 基準。
- **裏側のスパム対策（全投稿に適用）**：リンク(URL)禁止・NGワード・端末ごとレート制限（`RATE_PER_HOUR`）・id形式・重複排除・行/未承認上限・数式インジェクション無害化。
- IDトークン検証は Google の tokeninfo を `UrlFetchApp` で叩くため **`script.external_request` 権限が必要**。コード更新後は **新しいデプロイを作成**（既存デプロイの「編集」→バージョン更新）し、必要なら **一度 `setup` を再実行**して追加権限（外部リクエスト）を承認すること（承認するまで自動公開は働かず、全投稿が安全に `pending` になります）。

## セットアップ手順

1. **スプレッドシート作成**：[drive.google.com](https://drive.google.com) で空白のスプレッドシートを新規作成（名前任意、例「沖縄edu_共有問題」）。
2. **コード貼り付け**：そのシートで **拡張機能 → Apps Script**。既定の `Code.gs` を全消しして、本フォルダの [`Code.gs`](./Code.gs) 全文を貼って保存。
3. **ヘッダ初期化**：エディタ上部の関数選択で `setup` を選び **実行**。初回は権限承認ダイアログが出るので許可。`questions` シートとヘッダ行が作られる。
4. **デプロイ**：右上 **デプロイ → 新しいデプロイ → 種類「ウェブアプリ」**。
   - **次のユーザーとして実行：自分**
   - **アクセスできるユーザー：全員**
   - デプロイ → 表示される `…/exec` で終わる **ウェブアプリ URL** をコピー。
5. **アプリに設定**：`index.html` の `const DEFAULT_COMMUNITY_URL='';` の `''` に、その `…/exec` URL を貼る → コミット → `sw.js` の `CACHE` を上げて push。
   - これで全利用者の画面に「みんなの問題」共有が有効化される（埋め込み式なので各利用者の設定は不要）。
   - 試したいだけなら、アプリ側で `localStorage.setItem('community_url','…/exec')` でも有効化できる。
6. **承認の仕方**：投稿は `status=pending` で入る。スプレッドシートの **B列(status)** を `approved` に書き換えると `doGet` が配信。
   - 配信は最大45秒キャッシュされるため、承認の反映に十数秒〜45秒の遅延が出る。
   - 補助：`status` セルに `a` / `ok` / `承認` / `true` と打つと `approved` に正規化される（`onEdit`）。**ただしこれはコンテナバインド構成のみ**。`SHEET_ID` を設定したスタンドアロン（clasp）構成では `onEdit` が発火しないので、**`approved` と明示的に入力**すること。

## 再デプロイ時の注意（URL を変えないために）
- コードを直したら **デプロイ → デプロイを管理 → 対象の ✏️ → バージョン「新バージョン」→ デプロイ** で**更新**する。これなら **`/exec` URL は変わらない**（アプリ側の変更不要）。
- 「**新しいデプロイ**」を作り直すと**別 URL** が発行される。URL を変えたくない時は必ず既存デプロイの編集で更新。

## 動作確認（curl）
GAS はリダイレクトを挟むので `-L` 必須。

```bash
EXEC_URL='https://script.google.com/macros/s/XXXXXXXX/exec'

# 承認済みを取得
curl -sL "$EXEC_URL"
# → {"ok":true,"questions":[ ... ]}

# 1問投稿（text/plain で CORS プリフライト回避）
curl -sL -X POST "$EXEC_URL" -H 'Content-Type: text/plain' \
  --data '{"id":"u_test_001","type":"mc","cat":"教育法規","src":"学校教育法第37条","q":"校長の職務は？","choices":["校務をつかさどり所属職員を監督","授業を担任","予算を編成"],"ans":0,"exp":"第37条第4項"}'
# → {"ok":true}（シートで status を approved にすると doGet に出る）
```

## 設計メモ
- 取得・追記とも **getValues/setValues 1回**に集約（セル単位アクセスなし＝GASの性能鉄則）。
- `LockService` で同時追記の競合と id 重複(TOCTOU)を防止。`doGet` は壊れた行を個別スキップ。
- 受け取る個人情報なし（id は匿名 `u…`）。本文サイズ・フィールド長・配列要素数に上限あり（最低限の濫用ガード）。
- 必要権限は最小（`SpreadsheetApp` のみ）。コンテナバインド前提（必ずシートの拡張機能から作成）。
