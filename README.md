# 沖縄県 教育法規・計画 学習＆実務アプリ

沖縄県の管理職試験対策と、日々の学校経営の「判断の根拠」を1つにまとめた単一ページWebアプリです。

- **関係図** … 法令 → ビジョン → 教育振興基本計画 → 努力点 → 自立した学習者プロジェクトの体系を一望
- **要点** … 13資料の要点を出典付きで。「根拠をコピー」で起案文書にそのまま貼れる
- **逆引き** … 「不登校」「ICT」「研修」など状況から根拠の資料・条文を即提示
- **クイズ** … 一問一答／4択／穴埋め（赤シート）／並べ替え／関係づけ。**間隔反復(SRS)**で忘れた頃に自動再出題
- **論文・面接** … 頻出8テーマの「序論→本論→結論＋根拠＋自校の具体策」の型
- **進捗** … 定着率・連続日数・分野別・弱点リスト。**Googleログインで複数端末に同期**

ログインしなくても全機能が使えます（進捗はその端末に保存）。Google連携は任意です。

---

## 1. GitHub Pages で公開する

1. GitHub で新しいリポジトリを作成（例：`okinawa-edu-app`、Public）。
2. このフォルダ内の **`index.html` / `sw.js` / `manifest.webmanifest` / `icon.svg`**（と任意で `README.md`）をアップロード（ドラッグ＆ドロップでOK）。
3. リポジトリの **Settings → Pages** を開く。
4. **Build and deployment** の Source を **「Deploy from a branch」**、Branch を **`main` / `(root)`** にして **Save**。
5. 1〜2分待つと、ページ上部に公開URLが表示されます：
   `https://<あなたのユーザー名>.github.io/<リポジトリ名>/`
6. スマホでそのURLを開き、ブラウザの「ホーム画面に追加」でアプリのように使えます（PWA・オフライン対応）。

> HTTPSで配信されるため、Service Worker（オフライン）とGoogleログインが動作します。

---

## 2. Google Drive 同期を有効にする（任意）

進捗を各自のGoogleドライブの**アプリ専用フォルダ（appDataFolder：他から見えない隠しフォルダ）**に保存し、スマホ⇄PCで引き継げます。あなた自身がOAuthクライアントIDを発行する必要があります（無料）。

### 2-1. Google Cloud でクライアントIDを作る

1. [Google Cloud Console](https://console.cloud.google.com/) にログインし、**プロジェクトを新規作成**。
2. **「APIとサービス」→「ライブラリ」** で **Google Drive API** を検索し **有効化**。
3. **「OAuth 同意画面」** を設定：
   - User Type は **「外部(External)」** を選択して作成。
   - アプリ名・ユーザーサポートメール・デベロッパー連絡先を入力。
   - **スコープ**に `https://www.googleapis.com/auth/drive.appdata` を追加。
   - **テストユーザー**に自分のGoogleアカウントを追加（公開審査は不要。テスト状態のまま使えます）。
4. **「認証情報」→「認証情報を作成」→「OAuth クライアント ID」**：
   - アプリケーションの種類：**ウェブアプリケーション**。
   - **承認済みの JavaScript 生成元** に、公開URLの**オリジンだけ**を追加：
     `https://<ユーザー名>.github.io`
     （パスは含めない。ローカル確認用に `http://localhost:8000` 等も追加可）
   - 作成すると **クライアントID**（`〜.apps.googleusercontent.com`）が表示されます。コピー。

### 2-2. アプリに設定する

- 公開したアプリを開き、**「進捗」タブ**の上部にある同期カードに、コピーしたクライアントIDを貼り付けて **「IDを保存」**。
- **「Googleでログイン」** を押して許可すると、以後は進捗がDriveに自動同期されます（クイズ終了時・「今すぐ同期」ボタン）。
- 別の端末でも同じIDを設定して同じGoogleアカウントでログインすれば、進捗がマージされます。

> 毎回貼るのが面倒な場合は、`index.html` の `<script>` 直前に
> `<script>const DEFAULT_CLIENT_ID='〜.apps.googleusercontent.com';</script>`
> を追記すれば既定値になります（公開リポジトリに置く場合はクライアントIDが見えますが、承認済みオリジンを自分のドメインに限定していれば第三者は悪用できません）。

---

## 問題の修正・追加（コンテンツ運用）

問題データの**正本は `questions.json`**（JSON配列）です。アプリは起動時にこれを読み込みます。
**`index.html` を編集する必要はありません。**

### 誤りを直す / 問題を足す手順

1. `questions.json` を直接編集する（1問＝1オブジェクト）。
   - `id` は**一意かつ不変**。既存問題の `id` は変えない（学習進捗が孤児化します）。文言修正はOK。
   - 全問に `src`（出典）を入れる。形式別フィールド：
     - `qa`：`{id,type:"qa",cat,q,a,src}`
     - `mc`：`{id,type:"mc",cat,q,choices:[...],ans,exp,src}`（`ans` は元の並びでの正解index。出題時に自動シャッフル）
     - `cloze`：`{id,type:"cloze",cat,parts:[...],src}`（`{ "b":"答え" }` が空欄）
     - `order`：`{id,type:"order",cat,q,items:[...],exp,src}`（items は**正しい順**で記述）
     - `match`：`{id,type:"match",cat,q,pairs:[[左,右],...],src}`
2. **検証**（壊れたJSON・id重複・mcのans範囲などを事前チェック）：
   ```bash
   node -e 'const a=require("./questions.json");const ids=new Set();let e=0;
     a.forEach(q=>{if(ids.has(q.id)){console.log("重複id",q.id);e++}ids.add(q.id);
       if(!q.src){console.log("出典なし",q.id);e++}
       if(q.type==="mc"&&(q.ans<0||q.ans>=q.choices.length)){console.log("ans範囲外",q.id);e++}});
     console.log(a.length+"問 / 問題"+e+"件")'
   ```
   （アプリ起動時にも `selfCheck()` が自動点検し、問題は「進捗」タブの🐞エラーログに出ます）
3. **`sw.js` の `CACHE` 名を上げる**（例 `okinawa-edu-v10` → `v11`）。← これを忘れると利用者に旧版が出続けます。
4. コミット＆プッシュ：`git add -A && git commit -m "問題を修正" && git push`。GitHub Pages に自動反映。

> 利用者は何もしなくても、次回アクセス時に最新の問題を自動で受け取ります（`questions.json` が共有の正本のため）。

### 利用者が自分で作った問題

「進捗」タブの **✍️ 問題の作成・共有** から、利用者自身が一問一答・4択を追加できます。
**📤エクスポート**（JSONファイル）で他の人に渡し、**📥インポート**で受け取れます。
これらは `questions.json` とは別に各自の端末（＋Driveに同期）へ保存されます。

---

## データの保存場所

- ローカル：ブラウザの `localStorage`（端末内）。
- クラウド（任意）：Google Drive の `appDataFolder` 内 `progress.json`。アプリ専用の隠しフォルダで、他のアプリやDrive画面からは見えません。
- 同期はカード単位で「最後に学習した方」を採用してマージします（端末をまたいでも進捗が消えにくい設計）。

## 注意

- 出題・要点は公表資料に基づきますが、**年度依存の重点・施策・推進期間は受験年度の最新版で必ず確認**してください。
- 論文テンプレートは論点整理の骨子です。最新施策と自校の実態に合わせて加筆してください。

## ライセンス / 出典

学習用途。出典：沖縄県教育委員会／沖縄県／文部科学省 各公表資料。
