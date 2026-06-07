#!/usr/bin/env bash
# ============================================================================
#  community-gas デプロイ helper
#  正本 Code.gs に SHEET_ID を注入し、正しい Google アカウント（gmail）で
#  push → 既存デプロイを新バージョンに更新（/exec URL は不変）する。
#
#  なぜ helper が要るか：このマシンの clasp は複数アカウントを持つ。
#   - gmail  = ryuma.atari@gmail.com … community-gas プロジェクトの所有者（これを使う）
#   - school = t260781p@naha-okinawa.ed.jp … 別プロジェクト用（混同するとpush不可）
#  素の `clasp login`（=default プロファイル）は上書きされやすいので、
#  このスクリプトは常に名前付きプロファイル（既定 gmail）を明示して使う。
#
#  使い方:
#    bash community-gas/deploy.sh "更新メモ"
#  必要: community-gas/.deploy.env（git管理外。.deploy.env.example をコピーして作成）
# ============================================================================
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HERE/.deploy.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "✋ $ENV_FILE がありません。'.deploy.env.example' をコピーして値を埋めてください。" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"
CLASP_USER="${CLASP_USER:-gmail}"
: "${SCRIPT_ID:?SCRIPT_ID 未設定（.deploy.env）}"
: "${SHEET_ID:?SHEET_ID 未設定（.deploy.env）}"
: "${DEPLOYMENT_ID:?DEPLOYMENT_ID 未設定（.deploy.env）}"
DESC="${1:-update $(date +%Y-%m-%d)}"

# 1) 正しいアカウントか確認（取り違え＝permission エラーを未然に防ぐ）
WHO="$(clasp show-authorized-user --user "$CLASP_USER" 2>&1 || true)"
echo "clasp[$CLASP_USER]: $WHO"
case "$WHO" in
  *ryuma.atari@gmail.com*) : ;;
  *) echo "✋ '$CLASP_USER' が ryuma.atari@gmail.com ではありません。"
     echo "   → clasp login --user gmail を実行し、ブラウザで ryuma.atari@gmail.com を選んでください。" >&2
     exit 1 ;;
esac

# 2) ビルド（SHEET_ID を注入。正本 Code.gs は SHEET_ID='' のまま＝公開リポジトリにIDを出さない）
BUILD="$HERE/.deploy"
mkdir -p "$BUILD"
sed "s/var SHEET_ID = '';/var SHEET_ID = '${SHEET_ID}';/" "$HERE/Code.gs" > "$BUILD/Code.js"
if ! grep -q "var SHEET_ID = '${SHEET_ID}'" "$BUILD/Code.js"; then
  echo "✋ SHEET_ID の注入に失敗（Code.gs の 'var SHEET_ID = '\'''\'';' 行を確認）" >&2
  exit 1
fi
cat > "$BUILD/appsscript.json" <<'JSON'
{
  "timeZone": "Asia/Tokyo",
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/script.external_request"
  ],
  "webapp": { "access": "ANYONE_ANONYMOUS", "executeAs": "USER_DEPLOYING" }
}
JSON
cat > "$BUILD/.clasp.json" <<JSON
{ "scriptId": "${SCRIPT_ID}", "rootDir": "" }
JSON

# 3) push → 既存デプロイを新バージョンへ更新（同じ DEPLOYMENT_ID＝/exec URL 不変）
( cd "$BUILD" && clasp push -f --user "$CLASP_USER" )
( cd "$BUILD" && clasp deploy -i "$DEPLOYMENT_ID" -d "$DESC" --user "$CLASP_USER" )

echo "✅ デプロイ完了（/exec URL は不変）。"
echo "   ・初回のみ：スプレッドシートのエディタで関数 setup を1回実行するとヘッダ(device/reports)が整います。"
echo "   ・承認運用：未ログイン投稿などの pending は、シートの B列(status) を approved で配信。"
