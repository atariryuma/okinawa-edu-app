# CLAUDE.md — 開発引き継ぎメモ

沖縄県 管理職試験対策アプリ。**依存ゼロの単一ページWebアプリ**（ビルド工程なし）。
このファイルは Claude Code（や次の担当）がすぐ状況を把握するための設計メモ。

## ゴール / 文脈
- 利用者：教職10年以上、沖縄県の管理職（教頭・校長）試験の受験者。
- 目的：①試験対策（間隔反復で暗記）②日々の学校経営での「判断の根拠」を引ける。
- 公開：GitHub Pages（静的HTTPS）。進捗は端末の localStorage、任意で Google Drive 同期。

## ファイル構成
- `index.html` … アプリ本体。**HTML/CSS/JS すべてインライン**。外部依存はGoogle Identity Services(`gsi/client`)とDrive REST APIのみ。
- `questions.json` … **問題データの正本**（`QUESTIONS`）。起動時に同一オリジンfetchで読み込む（CORSなし）。**問題の修正・追加はこのファイルを編集**→ `sw.js` の `CACHE` を上げる、だけで全利用者に反映（index.html再編集・再ビルド不要）。`index.html` 側は `let QUESTIONS=[]` で、`boot()`→`BASE_QUESTIONS`＋`store.userQuestions` を連結して構成。
- `sw.js` … Service Worker。アプリシェル＋`questions.json`＋`privacy.html`/`about.html`/`terms.html` をキャッシュしオフライン動作。
- `about.html`（使い方・このアプリについて）/ `terms.html`（利用規約・UGC共有のルール）/ `privacy.html`（プライバシー）… 静的ページ。アプリ内「⚙️同期・データ管理」からリンク。
- `manifest.webmanifest` / `icon.svg` … PWA。
- `README.md` … 公開手順＋Google OAuth設定手順。
- ※親フォルダ `../沖縄県_教育法規_学習アプリ.html` は同一物の旧コピー。**正本はこの `index.html`**。混乱を避けるなら親コピーは削除可。

## データモデル
`QUESTIONS` は **`questions.json`（外部・正本）**。`REF/LOOKUP/RONBUN/COLORS` は `index.html` 内のJS配列リテラル（編集はそこ）。現状 Q218（法規59/指導要領28/生徒指導27/危機管理20/自立15/時事15/働き方9/服務9/計画7/学校経営6/学校運営5/ビジョン4/体系4/情報管理4/苦情対応3/努力点3） / REF / LOOKUP / RONBUN8。**出典→公式ソース直リンク**（`srcChk`/`LAW_LINKS`=e-Gov・`DOC_LINKS`=文科省/県、法令優先・長い順照合）。**法令リンクは法令ページへ直リンク**（条単位アンカーは付けない）。※実機検証でe-Govの条アンカーは `#Mp-Ch_2-Se_4-At_19` のように章・節パスを含み**条番号だけからは合成不可**と判明（旧 `egovAnchor`=`#Mp-At_19` は構造化法令で一致せず先頭着地だったため撤去）。出典テキストに条番号を明示しているのでページ内目次から辿れる。条単位ジャンプを真にやるなら(law,article)→フルアンカーの対応表が必要。
- **問題の編集・追加** → `questions.json` を直接編集（JSON配列）。検証はリポジトリ同梱の手順 or `node -e`（下記「検証」）。編集後は `sw.js` の `CACHE` を上げる。アプリ内「✍️ 作成」フォームは **qa/mc/cloze/order/match の5形式すべて**入力可（cloze=`[[答え]]`記法、order=1行1項目の正順、match=`左 | 右`）。
- **ユーザー作成問題** … アプリ内「✍️ 問題の作成・共有」フォームで追加 → `store.userQuestions[]` に保存（Drive同期対象）。`mergeStore` が id で和集合。エクスポート(JSON DL)/インポート(file)で共有。
- **みんなの問題（コミュニティ共有）** … `DEFAULT_COMMUNITY_URL`（GAS /exec）で有効。受け取り＝起動時 `fetchCommunity()` GET→`COMMUNITY_QUESTIONS`キャッシュ。投稿＝`submitCommunity()` が `{q,idtoken,device}` を `text/plain` POST（旧 `token` キーも後方互換受理）。**無意識共有モデル（段階可視性＋可逆）**：サインイン済みは**IDトークン(JWT・身元のみ／アクセス権なし)**を黙って同梱→GASが `aud`/`azp`=`CLIENT_ID`＋`email_verified` を tokeninfo で検証(`trusted`)。**自動公開(approved)の条件＝`sourceOk && (trusted || rep>=REP_TRUST)`**：①**出典ゲート**`srcResolves_`（`src`が公式ソース＝アプリの LAW_LINKS/DOC_LINKS 相当の `SRC_PATTERNS` に解決するか。identityだけでなく公式出典を必須化し誤条文の即拡散を防ぐ）、②**段階信頼** `rep`＝この端末(`device`)の承認済み実績が `REP_TRUST(=2)` 以上なら匿名でも自動公開資格。条件を満たさなければ審査(pending)。**通報→自動降格(可逆)**：出題画面の「⚠️通報」(`reportCommunity`→`{action:'report',id,idtoken}`)が `REPORT_LIMIT(=3)` 到達で approved→pending に自動降格＋doGetキャッシュ破棄。**通報も本人確認(IDトークン)必須＝1 Google アカウント1通報**（`handleReport_`が`verifyTokenSub_`で`sub`検証、未ログインは`{error:'login required'}`、レート/二重通報抑止は`sub`基準`rprl_<sub>`/`rpd_<sub>`）。**降格には「異なる検証済みアカウント」が `REPORT_LIMIT` 名必要**＝端末ID偽装で良問を不正に非公開化(suppression)できない（投票と対称・3巡目レビュー#1対応）。**👍評価→浮上＆自動昇格(正の制御)**：出題画面の「👍 役に立った」(`voteCommunity`→`{action:'vote',id,idtoken,device}`)→GASが `up` 列を加算。**投票は本人確認(IDトークン)必須＝1 Google アカウント1票**（`handleVote_`が`verifyTokenSub_`で検証し`sub`を取得、未ログイン/検証失敗は`{error:'login required'}`）。**集計・レート・二重投票抑止は検証済み`sub`基準**（`vrl_<sub>`/`vd_<sub>_<id>`）＝端末ID偽装で👍を水増しできない（バッジ偽造防止＝2巡目レビュー#7対応）。クライアントは`freshIdToken()`が無ければ`requestIdToken()`して「ログインが必要」をトースト。doGetは各問に `up`/`v`(検証済みフラグ＝`up>=UP_VERIFY(3) && reports<REPORT_LIMIT`)を付与し**`up`降順(人気順)で配信**。アプリはバッジを `v` で出し分け（緑「✓検証済み」／橙「未検証」＋👍数）、横断検索も `_up` でブースト（良問が上位）。投票レート(`VOTE_RATE_HR`)＋二重投票抑止は`sub`単位。通報も同様に`sub`基準（上記参照）。**`device`(匿名識別子)は現在「投稿(submit)」のレート/`rep`実績集計にのみ使用**（投票・通報は`sub`基準に移行済み）。シート列に `up` 追加。裏でスパム対策（URL禁止/NGワード/端末レート制限/数式無害化/上限）。共有問題は出題時に「みんなの問題・未検証」バッジ（`COMMUNITY_IDS`）。シート列に `device`/`reports` を追加（GAS更新後は `setup` 再実行でヘッダ整備＋`script.external_request` 承認）。契約: GET→`{ok,questions:[]}`／POST→`{ok,status}`（投稿は `reason` も付与・後方互換）。
- **合成順（dedup by id）**：`QUESTIONS = BASE_QUESTIONS(公式) ＞ COMMUNITY_QUESTIONS(共有) ＞ store.userQuestions(自作)`（`rebuildQuestions()`）。
- **セキュリティ規約（重要・回帰厳禁）**：問題文は**第三者由来（共有/自作/インポート）**を含むため、**描画は必ず `esc()` でHTMLエスケープ**（`render*`/`srcLine`/`showQ`のmeta）。新しい描画コードを足す時も第三者フィールドは `esc()` 必須（公式 REF/RONBUN はHTML可で別扱い）。`rebuildQuestions`/import/fetchCommunity は `validQuestion()` で**型検証して不正は除外**（描画/採点クラッシュ防止）。GAS側は `deformula_`(数式インジェクション無害化)＋`pick_`(未知/プロト汚染キー除去)＋`ID_RE`(id形式)＋行/未承認上限。
- **4択(mc)は出題時に選択肢をシャッフル**（`renderMC`：`{c,orig}` 配列＋`ansPos`で正答追跡）。データの `ans` は元の並びのindexのまま。

- `REF[]` … 要点カード。`{id, cls, map?, name, tag, cat, points[](HTML可), src}`。
  `cls` は色キー（`law/vision/plan/doryoku/proj/extra`、`COLORS`参照）。`map:1` の項目だけ「関係図」に描画（`renderMap` が id 指定で拾う）。
- `LOOKUP[]` … 逆引き（現状26件）。`{sit, kw(検索語), based:[[資料名, 説明], ...]}`。**先頭12件は実務の急性シナリオ**（体罰/児童虐待の通告/教員不祥事/感染症の権限者[19条=校長・20条=設置者]/いじめ重大事態/学校事故/個人情報漏えい/著作権35条/出席停止と懲戒の違い/開示請求・苦情/食物アレルギー/勤務時間管理）。生成→一次資料で検証して追加。`based`の名称は条文/公式資料名にし `srcChk` で公式リンクへ。**結果に「📋根拠をコピー」**（`renderLookup`の`.lkcopy`）。残り14件は施策寄り（論文・施策説明向け）。
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

## 学習エンジン（SRS = OkiSRS v2：SM-2基礎＋間隔反復研究の知見）
旧Leitner（全カード一律・最長16日・失敗で完全リセット）から、学習科学に基づき改良。出典は `index.html` の `OkiSRS v2` コメント参照（SM-2 Woźniak1990 / Cepeda2008 / Roediger&Karpicke2006 / FSRS / Murre&Dros2015）。
- 保存キー：`localStorage['okinawa_edu_app_v3']`（定数 `KEY`）。**互換維持のため据え置き**（フィールドは加算のみ）。
- `store = {cards:{}, streak, lastDate, theme, dailyDate, examDate, examDateT, userQuestions:[], totalAnswered, totalCorrect, dailyDone:{ymd:n}, session, fontScale}`。`examDate`=本番日(ISO|null)、`examDateT`=変更時刻(同期解決用)、`userQuestions`=作成/インポート問題、`totalAnswered/totalCorrect/dailyDone`=累積統計、`session={mode,ids,idx,cat}`=中断復帰用、`fontScale`='s'|'m'|'l'|'xl'。すべて加算（KEY据え置き）。
- **UX/IA（10ペルソナレビュー反映）**：ホーム＝初回CTA出し分け・試験カウントダウン・⏯続きから・🔥継続警告・box用語は平易語表示。進捗＝統計/試験日/要復習を上、Google同期/エラーログ/リセットは「⚙️同期・データ管理」details へ集約。作成導線はクイズタブにも(`openCreate`)。文字サイズ切替・タブ矢印キー・採点結果のSRフォーカス。
- **定番機能パック＋デイリー形式バグ修正**：①**今日の学習の形式偏りを修正**＝`startQuiz('daily')` の未習問題を `shuffle` してから6問取得（questions.json先頭がqa偏重なので、無修正だと新規ユーザーにqaばかり出ていた）。②**付箋(ブックマーク)** `store.bookmarks[]`（`"q:id"/"ref:id"/"lk:sit"`、`isBM/toggleBM/bmCount`）＝クイズに☆/⭐＋「⭐付箋」モード(`startQuiz('bookmark')`)、要点/逆引きは⭐で上部固定。③**最近見た** `store.recent[]`（`pushRecent`、要点を開く/逆引きの特定状況表示で記録、ホームに🕘chips→`openRef`/`openLk`で再オープン）。④**PWAインストール促進** `beforeinstallprompt`捕捉→`a2hsBar`バナー（iOSは`maybeIOSInstallHint`で手順案内、`oki_a2hs`で抑止）。⑤**進捗バックアップ/復元**（⚙️内で`store`をJSON書き出し→`mergeStore`で統合復元＝Google不要の引き継ぎ）。`bookmarks`/`recent` は `mergeStore` で和集合/時刻順マージ（Drive同期対象）。リマインダ通知は静的PWAの制約で見送り（要プッシュサーバ）。
- **UX強化（Webベストプラクティス5領域のサブエージェント判断を反映）**：ホーム先頭に**横断検索**（`buildSearchIndex`/`runSearch`：REF/LOOKUP/RONBUN/QUESTIONS を `.includes` で横断、種別グループ表示、タップで該当箇所へ `openRef`等）。初回**ウェルカム＋試験日フロントロード**（`oki_welcome`/`oki_exam_skip`）。ホームに**同期入口**(`openSync`)・**論文入口**(quickgrid `data-act=ronbun`)。関係図は二段タップ廃止＝ノードを `div[role=button]`＋「→要点で詳しく」`.reflink`。継続=**1日グレース**(`touchStreak`：昨日 or 一昨日で継続)＋**デイリーゴール**(`store.dailyGoal`,既定10,ホームにドット)＋**節目のお祝い**(`celebrate()`軽量confetti, reduced-motion尊重)。操作感=クイズ「次へ」を `.qstick` で親指圏に固定＋`answer()`で `navigator.vibrate` 触覚。見送り(次回)：下部ナビ移行/PWAインストール促進/達成バッジ。
- **10ペルソナ操作フローレビュー反映（confirmed指摘の修正）**：①**ログイン永続化**＝前回サインイン済み(`localStorage['oki_gsign']`)なら `boot()`→`trySilentSignIn()` が GSI ready後に `requestAccessToken({prompt:''})` で**無音再認証**→`cloudSync()`でpull（`gSilent`中はトースト抑制、`error_callback`で静かに縮退）。②**背景同期**＝`visibilitychange` で hidden時push/visible時 `bgSync()`(700msデバウンス)、いずれも `cloudSync(quiet)` で失敗トースト抑制。③**初回オンボーディング**＝`firstRun`(未学習＋ようこそ未閉じ)時はファーストビューを「ようこそ＋▶まず1問」に集中させ**空の検索欄を出さない**(`searchBlock`)、ウェルカム主ボタン`#welcomeStart`は**押下で即 `startQuiz('daily')`**（旧`welcomeOk`のラベル/挙動不一致を解消）。④模試結果に「解説閲覧時間を含む参考値」注記。※相互検証で棄却＝カテゴリチップ非表示説(実装上モード選択で最初から可視)。
- **同レビューの残り3点(partial/medium)も対応**：⑤**模試の中断復帰**＝`startQuiz('mock')`も`store.session={mode:'mock',ids,idx,cat,mockElapsed}`を保存、`go()`離脱時に経過を`mockElapsed`へ退避し`startMockTimer(resumeSec)`で**離脱中は加算せず**再開（`resumeSession`が`startMockTimer(s.mockElapsed)`）。⑥**横断検索の関連度順**＝`runSearch`を複数語AND(`terms.every`)化＋`score()`(タイトル一致＞本文・一致位置前ほど高い・短タイトル微優遇)で各グループ内ソート、`buildSearchIndex`に`_ht`(タイトル小文字)を事前計算。⑦**共有の初回同意**＝個別追加の共有は`localStorage['oki_shareok']`未設定なら`confirm`で一度だけ明示同意→以降は無確認(無意識共有を維持)、辞退時はローカル追加のみで投稿しない。
- **低優先ポリッシュも対応**：⑧**作成UIに cloze/order/match を追加**＝`#uqType`に穴埋め/並べ替え/対応づけを追加、`#uqCloze`(`[[答え]]`記法→`parts[]`にパース)/`#uqOrder`(1行1項目・正しい順)/`#uqMatch`(`左 | 右`を1行1組)を形式切替で出し分け、保存前に`validQuestion()`で型検証。⑨**横断検索**を`type=search`(ネイティブ×)＋**Enterで先頭結果へ**遷移。⑩試験日`<input type=date>`に`min=todayISO()`(過去日選択を抑止／`todayStr`は非ゼロ埋めのため`todayISO()`を追加)。
- `store.cards[id] = {box(1-5), reps, fails, due(ms), last, hist:[{t,ok}], ef(ease 1.3-2.7), ivl(間隔日), pli?(失敗復帰の種間隔)}`。
  - 旧データ（ef/ivl無し）は `review()` 冒頭で `ef=2.5`／`ivl=旧box換算(OLD_BOX_IVL)` を補完して移行（KEY据え置き）。
- 主要定数：`EF_DEFAULT/MIN/MAX=2.5/1.3/2.7`、`IVL_MAX=180`、`LAPSE_KEEP=0.4`(失敗時に間隔を一部保持)、`LAPSE_PENALTY=0.2`(ease減点)。
- `review(id, ok)`：
  - 正解→ 初回`ivl=1`／2回目`=3`／以降`=ivl×ef`（指数拡大）。失敗復帰時は`pli`を引き継ぐ。`ivl≥4`で±5% fuzz。`reps++`,`ef+=0.03`。`box=boxFromIvl(ivl)`。
  - 不正解→ `ef-=0.2`、`pli=round(ivl×0.4)`を退避、`ivl=0`で当日再出題、`box=min(box,2)`（弱点へ）。**全消去しない**のが旧仕様との最大の違い。
  - `clampIvl`：`1..IVL_MAX`にクランプ＋`examDate`があれば残日数を越えない（Cepedaの最適間隔比）。`due` 再計算＋`touchStreak()`＋`save()`。
- 状態判定：`isMastered`=box≥4 ／ `stateOf`→ new/learn/near(3)/mast(4+) ／ `isWeak`=box≤2 ／ `isDue`=due≤now。**box は ivl から導出する“定着度表示”**で、実スケジュールは ivl+ef が決める。
- 出題：`daily`=`dueList()`（due昇順）先頭12 ／ `review`=weak ／ 形式モード=type＋`quizCat`で絞り込み。
- `answer(id,ok)` がセッション得点＋`review()` を呼ぶ唯一の入口。
- 検証：`/tmp/srs_test.js` 相当のシミュレーションで間隔拡大・失敗の部分保持・試験日キャップ・旧データ移行を確認できる。

## 診断（バグ先回り検知）
バックエンドが無いため**端末内クライアントサイド診断**を搭載（外部送信なし）。
- `selfCheck()`：起動時にコンテンツ整合性（id重複/出典欠落/mc ans範囲/cloze空欄/order・match空）を点検。問題は `console.warn`＋エラーログへ記録。
- `window.onerror`/`unhandledrejection` を捕捉し `localStorage['okinawa_edu_errlog']`（最大20件のリング）へ記録。
- 進捗タブに「🐞 エラーログ」カード（コピー／消去）。利用者から開発者へ貼り付けて送れる。

> スキーマを破壊的に変える時だけ `KEY` を上げ、`load()` に移行処理を足す。安易に上げると既存ユーザーの進捗が消える。**加算フィールド（ef/ivl/pli/examDate）は破壊的でないので KEY据え置きでよい。**

## Google Drive 同期
- スコープ `drive.appdata`（アプリ専用の隠しフォルダ）。ファイル名 `progress.json`。
- クライアントID：`localStorage['gclient']`、または `index.html` に `const DEFAULT_CLIENT_ID=...` を定義（任意）。
- 主な関数：`initGoogle/signInGoogle/signOutGoogle`、`driveFind/driveGet/driveSave`(multipart)、`mergeStore`（カード単位で `hist` 最終時刻が新しい方を採用、streakはmax）、`cloudSync`（クイズ終了時＋手動）。UIは `mountSync()`（進捗タブ上部）。
- OAuth設定はユーザー作業（README手順2）。承認済みJSオリジン＝公開オリジンと完全一致が必須。個人利用は同意画面「テスト」状態＋テストユーザー登録でOK。

## PWA / デプロイ時の注意
- **`sw.js` の `CACHE` 名（現 `okinawa-edu-v36`）を、index.html等を変更するたびに必ず上げる**（例 `v37`）。上げ忘れると利用者に旧版がキャッシュから出続ける。最重要のデプロイ作法。
- `sw.js` は同一オリジンGETのみキャッシュ。Google系(別オリジン)は素通し。
- **キャッシュ戦略＝stale-while-revalidate**：キャッシュを即返しつつ裏でネットワーク取得→キャッシュ更新。これにより `CACHE` バンプを忘れても `questions.json` 等の更新が次回起動で追従する（保険）。それでも index.html 等の確実な反映には CACHE バンプが正道。
- **プリキャッシュは `cache:'reload'`** でHTTPキャッシュをバイパス（GitHub Pages の `max-age` 越しに古い実体を焼き直す事故を防止）。
- **更新通知UX**：`install` で自動 `skipWaiting()` せず待機。ページ側(`swUpdateReady`)が待機中の新SWを検知し**トースト「🆕 新しい版があります（タップで更新）」**を出す→タップで `postMessage({type:'SKIP_WAITING'})`→`controllerchange`で**適用時のみ**`location.reload()`（`_swSkip` ガードで初回インストール時の誤リロードを防止）。アイコンは `icon-192/512.png`＋`icon-maskable.png`＋`apple-touch-icon.png`（SVGは `icon.svg`、source は `icon-maskable.svg`）。

## GAS（みんなの問題）のデプロイと clasp アカウント（重要・取り違え厳禁）
このマシンの clasp は**複数 Google アカウント**を名前付きプロファイルで保持（`~/.clasprc.json`、永続）。**プロジェクトごとに使うアカウントが違う**。取り違えると `The caller does not have permission` で全操作が弾かれる（APIトグルやトークン期限ではなく**アカウント不一致**が主因）。
- **`--user gmail`** = `ryuma.atari@gmail.com` … **community-gas プロジェクトの所有者**。みんなの問題のGASは必ずこれ。
- **`--user school`** = `t260781p@naha-okinawa.ed.jp` … 学校アカウントの別プロジェクト（スタディクエスト等10件）。community-gas には**権限なし**。
- 素の `clasp login`（=`default` プロファイル）は上書きされやすい。**常に `--user gmail` / `--user school` を明示**すること。`default`/`organization` にも同じ実体が入っているが名前が紛らわしいので使わない。プロファイルが壊れたら `clasp login --user gmail`（or `--user school`）で入れ直す（`clasp show-authorized-user --user gmail` で確認）。
- **デプロイは helper 一発**：`bash community-gas/deploy.sh "更新メモ"`。中で①gmailアカウント検証→②正本 `Code.gs` に `SHEET_ID` を注入（公開リポジトリにIDを出さない）→③`clasp push --user gmail`→④**既存デプロイを `-i <DEPLOYMENT_ID>` で新バージョン更新**（`/exec` URL 不変＝アプリの `DEFAULT_COMMUNITY_URL` 変更不要）。
- 秘密値（`SCRIPT_ID`/`SHEET_ID`/`DEPLOYMENT_ID`）は **`community-gas/.deploy.env`（git管理外）** に置く。雛形は `community-gas/.deploy.env.example`（コミット済）。
- コード更新後の初回のみ、シートのエディタで関数 `setup` を1回実行（`device`/`reports` 列のヘッダ整備。コードは列番号で動くので未実行でも機能はする）。`script.external_request` の承認も初回必要。

## ナビ / 描画
- ビュー：`home / map / ref / lookup / quiz / ronbun / prog`。`go(v)` が表示切替＋該当 `render*` を呼ぶ。タブは `role=tablist`、`aria-selected` 更新。
- 描画関数：`renderHome / renderMap / renderRef / renderLookup / renderQuiz / renderRonbun / renderProg`。クイズは `showQ()` が `type` で `renderQA/MC/Cloze/Order/Match` に分岐。

## アクセシビリティ（回帰させない）
`:focus-visible`、`#toast`/`#gsres`/`#srlive` の `aria-live`（採点結果：mc/order/match は結果領域の `role=status`＋フォーカス移動で通知、即遷移する qa/cloze は `#quiz` 外の永続領域 `#srlive` を `srSay()` で通知）、cloze空欄の `tabindex/role=button`＋Enter/Space、並べ替えの ▲▼ ボタン（キーボード代替・タップ目標42×36px）、正誤は色＋✓✗、`prefers-reduced-motion`、`env(safe-area-inset-*)`、タップ目標44px。

## 開発・検証フロー
**変更したら必ず `node test.js`**（依存ゼロのロジックテスト。`index.html`の実コードを軽量DOMスタブ上で評価して検証＝抽出コピーでなく本体そのものをテスト）。構文エラーもここで弾ける。push/PRで GitHub Actions(`.github/workflows/ci.yml`)が自動実行。`npm test` でも可。
```
node test.js       # index.html：SRS(review)/mergeStore/sanitizeImport/validQuestion/srcLink/付箋/デイリー
node test-gas.js   # community-gas/Code.gs：validate_/srcResolves_/verifyToken_ゲート/自動公開判定/通報降格/👍昇格/pick_/deformula_
# npm test で両方。GAS は未認証入力の境界なのでこちらの安全網が重要。
```
**テストの育て方**：バグを直したら、その再現を `test.js` に1ケース足す（回帰固定）。新しい純粋関数は `EXPORTS` 配列に名前を足せばテストから呼べる（本体改変不要）。DOM/同期に強く依存する処理は preview 実機（下記）で確認。
ローカル確認（`file://` だとSW/Googleが動かないのでサーバ必須）：
```
cd okinawa-edu-app
python3 -m http.server 8000   # → http://localhost:8000
```
デプロイ：`git add -A && git commit && git push`（mainへ）。**その際 `sw.js` の CACHE を上げる**。Pages有効化はREADME手順1。

## バグ修正の着手ポイント早見
- クイズ採点や進捗がおかしい → `review()` / `answer()` / `stateOf` / `renderProg`。
- 同期が合わない → `mergeStore`（採用条件）/ `cloudSync` / OAuthオリジン。
- 「直したのに反映されない」→ ほぼ **SWキャッシュ**。`CACHE` を上げる or DevToolsでunregister。
- 関係図に項目が出ない → REFに `map:1` があるか、`renderMap` の id 指定に含めたか。

## 既知のTODO / 伸びしろ
- 問題量：218問。論文は「書く/自己添削」化済(`store.ronbunDrafts`)・模試モード(`mock`,時間計測)・苦手の分野別正答率可視化あり。`QUESTIONS`(questions.json)追記で拡張可。
- 残課題：自己採点(qa)の客観化。※共有投稿の認可は**IDトークン(JWT)化済**（`aud`/`azp`＋`email_verified` を tokeninfo 検証、アクセストークンは送らない／privacy.htmlで開示）。
- 模試モード（時間制限・本番形式）、論文の字数別モデル答案、年度バッジでの絞り込み。
- 自己採点(qa/cloze)の客観化（テキスト入力照合）。
- 進捗のエクスポート/インポート（Google未使用者向け）。
