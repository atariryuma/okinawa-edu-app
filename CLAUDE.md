# CLAUDE.md — 開発引き継ぎメモ

沖縄県 管理職試験対策アプリ。**依存ゼロの単一ページWebアプリ**（ビルド工程なし）。
このファイルは Claude Code（や次の担当）がすぐ状況を把握するための設計メモ。

## ゴール / 文脈
- 利用者：教職10年以上、沖縄県の管理職（教頭・校長）試験の受験者。
- 目的：①試験対策（間隔反復で暗記）②日々の学校経営での「判断の根拠」を引ける。
- 公開：GitHub Pages（静的HTTPS）。進捗は端末の localStorage、任意で Google Drive 同期。

## ファイル構成
- `index.html` … アプリ本体。**HTML/CSS/JS すべてインライン**。外部依存はGoogle Identity Services(`gsi/client`)とDrive REST APIのみ。
- `sw.js` … Service Worker。アプリシェルをキャッシュしオフライン動作。
- `manifest.webmanifest` / `icon.svg` … PWA。
- `README.md` … 公開手順＋Google OAuth設定手順。
- ※親フォルダ `../沖縄県_教育法規_学習アプリ.html` は同一物の旧コピー。**正本はこの `index.html`**。混乱を避けるなら親コピーは削除可。

## データモデル（`index.html` 内の定数）
すべてJSの配列リテラル。コンテンツ追加は基本ここを編集するだけ。現状 Q110 / REF12 / LOOKUP14 / RONBUN8。

- `REF[]` … 要点カード。`{id, cls, map?, name, tag, cat, points[](HTML可), src}`。
  `cls` は色キー（`law/vision/plan/doryoku/proj/extra`、`COLORS`参照）。`map:1` の項目だけ「関係図」に描画（`renderMap` が id 指定で拾う）。
- `LOOKUP[]` … 逆引き。`{sit, kw(検索語), based:[[資料名, 説明], ...]}`。
- `QUESTIONS[]` … 問題。共通 `{id, type, cat, src}` ＋ 形式別：
  - `qa`   : `q, a`
  - `mc`   : `q, choices[], ans(正解index), exp(解説)`
  - `cloze`: `parts[]`（文字列と `{b:'答え'}` の混在。`{b}` が空欄）
  - `order`: `q, items[]`（**正しい順で記述**。出題時にシャッフル）, `exp`
  - `match`: `q, pairs[[左,右],...]`
- `RONBUN[]` … 論文・面接テンプレ。`{t, q, jo, hon[], ketsu, konkyo[], jisaku, ng}`。

### コンテンツ追加のルール（重要）
- **`id` は一意かつ不変**（`q01`…連番）。既存問題の `id` を変えると、その問題の学習進捗（`store.cards[id]`）が孤児化する。文言修正は可、id変更は不可。
- 全問に `src`（出典）必須。年度で変わる内容は出典/タグに **【要更新】** を付ける。
- 追加後は必ず検証（下記「検証」）。`mc` の `ans` 範囲、`cloze` の `{b}` 有無などをチェック。
- **内容の正確性（リグレッション厳禁）**：`主要施策は6本`／`教育基本法第17条第2項`（地方）。過去に誤記（7本・条のみ）を修正済み。学校教育法第37条④校長の職務、地公法28分限/29懲戒、学校保健安全法19出席停止(校長)/20臨時休業(設置者) などは検証済み。

## 学習エンジン（SRS＝間隔反復, Leitner方式）
- 保存キー：`localStorage['okinawa_edu_app_v3']`（定数 `KEY`）。
- `store = {cards:{}, streak, lastDate, theme, dailyDate}`。
- `store.cards[id] = {box(1-5), reps, fails, due(ms), last('pass'|'fail'), hist:[{t,ok}]}`。
- `BOX_INTERVAL = {1:0, 2:1, 3:3, 4:7, 5:16}`（次回復習までの日数）。
- `review(id, ok)`：正解→box+1（最大5）、不正解→box=1にリセット。`due` を再計算し `touchStreak()`。
- 状態判定：`isMastered`=box≥4 ／ `stateOf`→ new/learn(1-2)/near(3)/mast(4-5) ／ `isWeak`=box≤2 ／ `isDue`=due≤now。
- 出題：`daily`=`dueList()`（due昇順）先頭12 ／ `review`=weak ／ 形式モード=type＋`quizCat`で絞り込み。
- `answer(id,ok)` がセッション得点＋`review()` を呼ぶ唯一の入口。

> スキーマを破壊的に変える時だけ `KEY` を上げ、`load()` に移行処理を足す。安易に上げると既存ユーザーの進捗が消える。

## Google Drive 同期
- スコープ `drive.appdata`（アプリ専用の隠しフォルダ）。ファイル名 `progress.json`。
- クライアントID：`localStorage['gclient']`、または `index.html` に `const DEFAULT_CLIENT_ID=...` を定義（任意）。
- 主な関数：`initGoogle/signInGoogle/signOutGoogle`、`driveFind/driveGet/driveSave`(multipart)、`mergeStore`（カード単位で `hist` 最終時刻が新しい方を採用、streakはmax）、`cloudSync`（クイズ終了時＋手動）。UIは `mountSync()`（進捗タブ上部）。
- OAuth設定はユーザー作業（README手順2）。承認済みJSオリジン＝公開オリジンと完全一致が必須。個人利用は同意画面「テスト」状態＋テストユーザー登録でOK。

## PWA / デプロイ時の注意
- **`sw.js` の `CACHE` 名（現 `okinawa-edu-v4`）を、index.html等を変更するたびに必ず上げる**（例 `v5`）。上げ忘れると利用者に旧版がキャッシュから出続ける。最重要のデプロイ作法。
- `sw.js` は同一オリジンGETのみキャッシュ。Google系(別オリジン)は素通し。

## ナビ / 描画
- ビュー：`home / map / ref / lookup / quiz / ronbun / prog`。`go(v)` が表示切替＋該当 `render*` を呼ぶ。タブは `role=tablist`、`aria-selected` 更新。
- 描画関数：`renderHome / renderMap / renderRef / renderLookup / renderQuiz / renderRonbun / renderProg`。クイズは `showQ()` が `type` で `renderQA/MC/Cloze/Order/Match` に分岐。

## アクセシビリティ（回帰させない）
`:focus-visible`、`#quiz`/`#toast` の `aria-live`、cloze空欄の `tabindex/role=button`＋Enter/Space、並べ替えの ▲▼ ボタン（キーボード代替）、正誤は色＋✓✗、`prefers-reduced-motion`、`env(safe-area-inset-*)`、タップ目標44px。

## 開発・検証フロー
ローカル確認（`file://` だとSW/Googleが動かないのでサーバ必須）：
```
cd okinawa-edu-app
python3 -m http.server 8000   # → http://localhost:8000
```
JS構文・データ検証（CIにしてもよい）：
```
awk '/<script src="https:\/\/accounts/{next}/<script>/{f=1;next}/<\/script>/{f=0}f' index.html > /tmp/app.js
node --check /tmp/app.js
# 必要なら QUESTIONS を eval して ans範囲/cloze空欄/一意id/出典 をチェック
```
デプロイ：`git add -A && git commit && git push`（mainへ）。**その際 `sw.js` の CACHE を上げる**。Pages有効化はREADME手順1。

## バグ修正の着手ポイント早見
- クイズ採点や進捗がおかしい → `review()` / `answer()` / `stateOf` / `renderProg`。
- 同期が合わない → `mergeStore`（採用条件）/ `cloudSync` / OAuthオリジン。
- 「直したのに反映されない」→ ほぼ **SWキャッシュ**。`CACHE` を上げる or DevToolsでunregister。
- 関係図に項目が出ない → REFに `map:1` があるか、`renderMap` の id 指定に含めたか。

## 既知のTODO / 伸びしろ
- 問題量（受験者レビューは200問規模を要望。現110）。`QUESTIONS` 追記で拡張可。
- 模試モード（時間制限・本番形式）、論文の字数別モデル答案、年度バッジでの絞り込み。
- 自己採点(qa/cloze)の客観化（テキスト入力照合）。
- 進捗のエクスポート/インポート（Google未使用者向け）。
