/**
 * ============================================================================
 *  沖縄県 管理職試験対策アプリ ── ユーザー投稿問題 共有バックエンド (GAS Web App)
 * ============================================================================
 *
 *  役割：静的SPA（GitHub Pages）から投稿された「学習問題」を承認制で共有する。
 *        ストアは Google スプレッドシート。バックエンドはこの 1 ファイルのみ。
 *
 *  クライアント契約（変更不可）：
 *   - doGet():  approved の問題だけ {"ok":true,"questions":[ ... ]} で返す
 *   - doPost(): Content-Type: text/plain の本文に1問のJSON文字列。
 *               JSON.parse→検証→1行追記→{"ok":true} / 失敗 {"ok":false,"error":"..."}
 *
 *  ── セットアップ手順（詳細は community-gas/README.md 参照）────────────────
 *   1) drive.google.com で「空白のスプレッドシート」を新規作成（名前任意）。
 *   2) 拡張機能 → Apps Script を開き、既定の Code.gs を全消ししてこの全文を貼る。
 *   3) 保存後、関数選択で setup を選び「実行」（初回は権限承認を許可）。
 *   4) デプロイ → 新しいデプロイ → ウェブアプリ。実行ユーザー=自分／
 *      アクセス=全員。表示される /exec URL を SPA の DEFAULT_COMMUNITY_URL に設定。
 *   5) 承認：シートの status セルを "approved" にした問題だけが doGet で配信される。
 * ----------------------------------------------------------------------------
 */

/* ===== 設定値 ===== */
var SHEET_NAME      = 'questions';      // データシート名（無ければ作成）
var HEADERS         = ['timestamp', 'status', 'id', 'type', 'cat', 'json', 'q', 'src'];
var VALID_TYPES     = ['qa', 'mc', 'cloze', 'order', 'match'];
var MAX_BODY_BYTES  = 16 * 1024;        // 本文(text/plain)全体の上限 16KB
var MAX_FIELD_LEN   = 4000;             // 任意の文字列フィールド1個の上限
var MAX_ARRAY_LEN   = 50;               // choices/items/pairs/parts の要素数上限
var MAX_ID_LEN      = 64;               // id の上限長
var LOCK_WAIT_MS    = 10000;            // 追記時のロック待ち上限
var MAX_ROWS        = 5000;             // データ総行数の上限（無認証POSTのスパム肥大対策）
var MAX_PENDING     = 300;              // 未承認(pending)滞留の上限（承認で消化されるまで新規受付停止）
var DOGET_CACHE_SEC = 45;              // doGet 応答のキャッシュ秒数（読み取り負荷の軽減）
var ID_RE           = /^[A-Za-z0-9_\-]{1,64}$/; // id 許可形式（数式/制御文字/空白を排除）
// 本アプリのOAuthクライアントID。投稿トークンの発行先(aud/azp)がこれと一致すれば
// 「本アプリの正規ログイン」とみなし trusted（自動公開）。それ以外（匿名）は審査(pending)。
var CLIENT_ID       = '773737222519-k2gpp483dqmnghfiuuv48kde10c2khog.apps.googleusercontent.com';
var RATE_PER_HOUR   = 20;                       // 1端末あたり1時間の投稿上限
var BLOCKLIST       = ['<script', 'javascript:', 'onerror=', 'onload=', 'onclick=']; // 危険/スパム断片

/* 列インデックス（0始まり）。HEADERS と一致させる */
var COL = { ts:0, status:1, id:2, type:3, cat:4, json:5, q:6, src:7 };

/* スタンドアロン（clasp 等）でデプロイする場合は、ここに対象スプレッドシートの
   ID を入れる。空ならコンテナバインド（拡張機能→Apps Script で作成）として
   getActiveSpreadsheet を使う。 */
var SHEET_ID = '';

/* ============================================================================
 *  setup(): ヘッダ行の自動作成（手動実行用）
 * ========================================================================== */
function setup() {
  var sh = getSheet_(true);
  var firstRow = sh.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  var needInit = false;
  for (var i = 0; i < HEADERS.length; i++) {
    if (String(firstRow[i]) !== HEADERS[i]) { needInit = true; break; }
  }
  if (needInit) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sh.setFrozenRows(1);
  }
  // 外部リクエスト権限(UrlFetchApp)の承認を促す（トークン検証に必要）。一度ここで呼んで同意させる。
  try { UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?access_token=warmup', { muteHttpExceptions: true }); } catch (e) {}
  return 'setup done: sheet="' + sh.getName() + '"';
}

/* ============================================================================
 *  doGet(e): approved の問題だけを JSON で返す
 * ========================================================================== */
function doGet(e) {
  try {
    // 直近の応答をキャッシュして読み取り負荷を抑える（承認反映は最大 DOGET_CACHE_SEC 秒遅延）
    var cache = null;
    try { cache = CacheService.getScriptCache(); } catch (_c) {}
    if (cache) { var hit = cache.get('doget'); if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON); }

    var sh = getSheet_(false);
    if (!sh) return json_({ ok: true, questions: [] });

    var lastRow = sh.getLastRow();
    if (lastRow < 2) return json_({ ok: true, questions: [] });

    // ── パフォーマンス鉄則：1回の getValues で全データを一括取得 ──
    var rows = sh.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
    var out = [];
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      if (String(row[COL.status]).trim().toLowerCase() !== 'approved') continue;
      var raw = row[COL.json];
      if (!raw) continue;
      try {
        var q = JSON.parse(raw);            // 壊れた行は catch でスキップ
        if (q && typeof q === 'object') out.push(q);
      } catch (parseErr) {
        try { console.warn('doGet skip broken row ' + (r + 2)); } catch (_ig) {}
      }
    }
    var payload = JSON.stringify({ ok: true, questions: out });
    if (cache) { try { cache.put('doget', payload, DOGET_CACHE_SEC); } catch (_p) {} }
    return ContentService.createTextOutput(payload).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err), questions: [] });
  }
}

/* ============================================================================
 *  doPost(e): 1問を検証して追記（pending）
 * ========================================================================== */
function doPost(e) {
  try {
    if (!e || !e.postData || typeof e.postData.contents !== 'string') {
      return json_({ ok: false, error: 'no body' });
    }
    var body = e.postData.contents;
    if (byteLen_(body) > MAX_BODY_BYTES) {
      return json_({ ok: false, error: 'body too large' });
    }

    var env;
    try {
      env = JSON.parse(body);
    } catch (parseErr) {
      return json_({ ok: false, error: 'invalid JSON' });
    }
    // 新形式 {q, idtoken, device}（旧 token はアクセストークンだったが廃止。両キー受けるが検証はIDトークンとして行う）
    var q, idtoken = '', device = '';
    if (env && env.q && typeof env.q === 'object' && !env.type) {
      q = env.q; idtoken = String(env.idtoken || env.token || ''); device = String(env.device || '');
    } else { q = env; }

    var v = validate_(q);
    if (!v.ok) return json_({ ok: false, error: v.error });
    // ── 自動モデレーション（裏側のスパム対策。承認を“無意識化”するための門番）──
    if (hasUrl_(q))     return json_({ ok: false, error: 'links not allowed' });   // リンク禁止
    if (hasBlocked_(q)) return json_({ ok: false, error: 'blocked content' });     // NGワード
    if (device && !rateOk_(device)) return json_({ ok: false, error: 'rate limited' }); // 端末ごとレート制限
    // 本アプリ向けに発行されたIDトークン(JWT)で本人確認できれば trusted（=自動公開）。無効/無しは審査(pending)へ。
    var trusted = idtoken ? verifyToken_(idtoken) : false;

    // ── 排他制御つきで dedup → 追記 ──
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_WAIT_MS)) {
      return json_({ ok: false, error: 'busy, retry later' });
    }
    try {
      var sh = getSheet_(true);

      var lastRow = sh.getLastRow();
      // 総行数の上限（スパムによる無制限肥大の歯止め）
      if (lastRow - 1 >= MAX_ROWS) {
        return json_({ ok: false, error: 'storage full' });
      }
      if (lastRow >= 2) {
        // id 重複拒否 ＋ 未承認(pending)滞留数のカウント（必要2列だけ一括取得）
        var idCol = sh.getRange(2, COL.id + 1, lastRow - 1, 1).getValues();
        var stCol = sh.getRange(2, COL.status + 1, lastRow - 1, 1).getValues();
        var pending = 0;
        for (var i = 0; i < idCol.length; i++) {
          if (String(idCol[i][0]) === q.id) return json_({ ok: false, error: 'duplicate id' });
          if (String(stCol[i][0]).trim().toLowerCase() === 'pending') pending++;
        }
        if (pending >= MAX_PENDING) return json_({ ok: false, error: 'too many pending' });
      }

      // 未知キー/プロトタイプ汚染を物理的に落としてから保存（ホワイトリスト再構築）
      var clean = pick_(q);
      var summary = summarize_(clean);

      var status = trusted ? 'approved' : 'pending';
      var newRow = [];
      newRow[COL.ts]     = new Date();
      newRow[COL.status] = status;
      newRow[COL.id]     = deformula_(clean.id);
      newRow[COL.type]   = clean.type;
      newRow[COL.cat]    = deformula_(clean.cat || '');
      newRow[COL.json]   = deformula_(JSON.stringify(clean));
      newRow[COL.q]      = deformula_(summary);
      newRow[COL.src]    = deformula_(clean.src);

      sh.getRange(sh.getLastRow() + 1, 1, 1, HEADERS.length).setValues([newRow]);
      // 自動公開した場合は doGet キャッシュを破棄して即時反映
      if (trusted) { try { var c = CacheService.getScriptCache(); if (c) c.remove('doget'); } catch (_ig2) {} }

      return json_({ ok: true, status: status });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/* ============================================================================
 *  validate_(q): スキーマ＆内容の最低限検証
 * ========================================================================== */
function validate_(q) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return err_('not an object');

  if (!isNonEmptyStr_(q.id)) return err_('id required');
  if (!ID_RE.test(q.id)) return err_('bad id format'); // 英数・_・- のみ（数式/制御文字/空白を排除）

  if (VALID_TYPES.indexOf(q.type) < 0) return err_('invalid type');

  if (!isNonEmptyStr_(q.src)) return err_('src required');
  if (!okLen_(q.src)) return err_('src too long');

  if (q.cat != null && !okLen_(String(q.cat))) return err_('cat too long');

  switch (q.type) {
    case 'qa':
      if (!isNonEmptyStr_(q.q)) return err_('qa: q required');
      if (!isNonEmptyStr_(q.a)) return err_('qa: a required');
      if (!okLen_(q.q) || !okLen_(q.a)) return err_('qa: field too long');
      break;

    case 'mc':
      if (!isNonEmptyStr_(q.q)) return err_('mc: q required');
      if (!okLen_(q.q)) return err_('mc: q too long');
      if (!Array.isArray(q.choices) || q.choices.length < 2) return err_('mc: choices>=2');
      if (q.choices.length > MAX_ARRAY_LEN) return err_('mc: too many choices');
      for (var i = 0; i < q.choices.length; i++) {
        if (!isNonEmptyStr_(q.choices[i]) || !okLen_(q.choices[i])) return err_('mc: bad choice');
      }
      if (!isInt_(q.ans) || q.ans < 0 || q.ans >= q.choices.length) return err_('mc: ans out of range');
      if (q.exp != null && !okLen_(String(q.exp))) return err_('mc: exp too long');
      break;

    case 'cloze':
      if (!Array.isArray(q.parts) || q.parts.length === 0) return err_('cloze: parts required');
      if (q.parts.length > MAX_ARRAY_LEN) return err_('cloze: too many parts');
      var hasBlank = false;
      for (var p = 0; p < q.parts.length; p++) {
        var part = q.parts[p];
        if (typeof part === 'string') {
          if (!okLen_(part)) return err_('cloze: part too long');
        } else if (part && typeof part === 'object' && !Array.isArray(part)) {
          if (!isNonEmptyStr_(part.b)) return err_('cloze: blank needs b');
          if (!okLen_(part.b)) return err_('cloze: blank too long');
          hasBlank = true;
        } else {
          return err_('cloze: bad part');
        }
      }
      if (!hasBlank) return err_('cloze: needs at least one blank {b}');
      break;

    case 'order':
      if (!isNonEmptyStr_(q.q)) return err_('order: q required');
      if (!okLen_(q.q)) return err_('order: q too long');
      if (!Array.isArray(q.items) || q.items.length < 2) return err_('order: items>=2');
      if (q.items.length > MAX_ARRAY_LEN) return err_('order: too many items');
      for (var k = 0; k < q.items.length; k++) {
        if (!isNonEmptyStr_(q.items[k]) || !okLen_(q.items[k])) return err_('order: bad item');
      }
      if (q.exp != null && !okLen_(String(q.exp))) return err_('order: exp too long');
      break;

    case 'match':
      if (!isNonEmptyStr_(q.q)) return err_('match: q required');
      if (!okLen_(q.q)) return err_('match: q too long');
      if (!Array.isArray(q.pairs) || q.pairs.length < 1) return err_('match: pairs required');
      if (q.pairs.length > MAX_ARRAY_LEN) return err_('match: too many pairs');
      for (var m = 0; m < q.pairs.length; m++) {
        var pair = q.pairs[m];
        if (!Array.isArray(pair) || pair.length !== 2) return err_('match: pair must be [L,R]');
        if (!isNonEmptyStr_(pair[0]) || !isNonEmptyStr_(pair[1])) return err_('match: empty pair');
        if (!okLen_(pair[0]) || !okLen_(pair[1])) return err_('match: pair too long');
      }
      break;

    default:
      return err_('invalid type');
  }
  return { ok: true };
}

/* ============================================================================
 *  summarize_(q): 一覧用に q 列へ入れる読める文字列を作る
 * ========================================================================== */
function summarize_(q) {
  var s = '';
  switch (q.type) {
    case 'qa':
    case 'mc':
    case 'order':
    case 'match':
      s = q.q || '';
      break;
    case 'cloze':
      var buf = [];
      for (var i = 0; i < q.parts.length; i++) {
        var p = q.parts[i];
        buf.push(typeof p === 'string' ? p : ('〔' + (p && p.b || '') + '〕'));
      }
      s = buf.join('');
      break;
    default:
      s = '';
  }
  s = String(s);
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

/* ============================================================================
 *  onEdit(e): （任意）status セルに a/ok/承認/true を入れたら approved に正規化
 * ========================================================================== */
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    if (sh.getName() !== SHEET_NAME) return;
    if (e.range.getColumn() !== (COL.status + 1)) return;
    if (e.range.getRow() < 2) return;
    var val = String(e.value == null ? '' : e.value).trim().toLowerCase();
    if (val === 'a' || val === 'ok' || val === 'true' || val === '承認') {
      e.range.setValue('approved');
    }
  } catch (_ig) { /* トリガ内は握りつぶす */ }
}

/* ============================================================================
 *  ヘルパ
 * ========================================================================== */
function getSheet_(createIfMissing) {
  var ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('no spreadsheet (set SHEET_ID, or create as container-bound)');
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh && createIfMissing) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sh.setFrozenRows(1);
  }
  return sh || null;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function err_(msg) { return { ok: false, error: msg }; }

function isNonEmptyStr_(v) { return typeof v === 'string' && v.trim().length > 0; }

function okLen_(v) { return String(v).length <= MAX_FIELD_LEN; }

function isInt_(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }

// ── 投稿の身元判定（自動公開のための門番）──────────────────────────────────
// IDトークン(JWT)を Google の tokeninfo で検証。発行先 aud／認可当事者 azp が本アプリの CLIENT_ID、
// 発行者 iss が Google、メール確認済み(email_verified)、かつ未失効なら true（=本人確認OK）。
// それ以外/外部呼び出し失敗は false（=審査へ）。aud だけの検証は azp 偽装に弱いため azp/email も併せて見る。
// ※IDトークンは身元アサーションのみでアクセス権を持たない（旧: アクセストークン送信を廃止）。
function verifyToken_(idtoken) {
  try {
    var resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idtoken), { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return false;
    var info = JSON.parse(resp.getContentText());
    var iss = String(info.iss || '');
    var audOk = (String(info.aud || '') === CLIENT_ID);
    var azpOk = !info.azp || (String(info.azp) === CLIENT_ID);          // 認可された当事者(azp)も本アプリに限定（aud のみ検証の素通しを塞ぐ）
    var issOk = (iss === 'accounts.google.com' || iss === 'https://accounts.google.com');
    var emailOk = (String(info.email_verified) === 'true');             // 確認済みメールの本人のみ自動公開（未確認/不明は審査へ）
    var notExpired = !info.exp || (parseInt(info.exp, 10) * 1000 > Date.now());
    return audOk && azpOk && issOk && emailOk && notExpired;
  } catch (e) { return false; }
}
// 検査対象の全文字列を連結
function textOf_(q) {
  var parts = [q.id, q.cat, q.src, q.q, q.a, q.exp];
  if (Array.isArray(q.choices)) parts = parts.concat(q.choices);
  if (Array.isArray(q.items)) parts = parts.concat(q.items);
  if (Array.isArray(q.pairs)) q.pairs.forEach(function (p) { if (Array.isArray(p)) parts = parts.concat(p); });
  if (Array.isArray(q.parts)) q.parts.forEach(function (p) { parts.push(typeof p === 'string' ? p : (p && p.b)); });
  return parts.filter(function (x) { return x != null; }).join(' \n ');
}
function hasUrl_(q) { return /(https?:\/\/|www\.)/i.test(textOf_(q)); }
function hasBlocked_(q) {
  var t = textOf_(q).toLowerCase();
  for (var i = 0; i < BLOCKLIST.length; i++) { if (t.indexOf(String(BLOCKLIST[i]).toLowerCase()) >= 0) return true; }
  return false;
}
// 端末ごとの簡易レート制限（CacheService、1時間窓）。スキーマ変更不要。
function rateOk_(device) {
  try {
    var c = CacheService.getScriptCache(); if (!c) return true;
    var key = 'rl_' + device, n = parseInt(c.get(key) || '0', 10);
    if (n >= RATE_PER_HOUR) return false;
    c.put(key, String(n + 1), 3600);
    return true;
  } catch (e) { return true; }
}

// UTF-8 バイト長（孤立サロゲートでも破綻しないよう GAS の Blob を使用）
function byteLen_(s) {
  try { return Utilities.newBlob(String(s)).getBytes().length; }
  catch (e) { return String(s).length * 4; } // 念のための安全側フォールバック
}

// セル数式インジェクション対策：=,+,-,@,タブ,CR で始まる値は先頭にアポストロフィを付け、
// 承認者がシートを開いた際に数式として評価されないようにする。
function deformula_(v) {
  var s = String(v == null ? '' : v);
  return /^[=+\-@\t\r]/.test(s) ? ("'" + s) : s;
}

// 既知フィールドだけで問題オブジェクトを再構築（未知キー/__proto__等を物理的に除去）。
// validate_ 通過後に呼ぶ前提。
function pick_(q) {
  var o = { id: q.id, type: q.type, cat: (q.cat == null ? '' : String(q.cat)), src: q.src };
  if (q.type === 'qa') { o.q = q.q; o.a = q.a; }
  else if (q.type === 'mc') { o.q = q.q; o.choices = q.choices.slice(0, MAX_ARRAY_LEN); o.ans = q.ans; if (q.exp != null) o.exp = String(q.exp); }
  else if (q.type === 'cloze') { o.parts = q.parts.map(function (p) { return typeof p === 'string' ? p : { b: p.b }; }); }
  else if (q.type === 'order') { o.q = q.q; o.items = q.items.slice(0, MAX_ARRAY_LEN); if (q.exp != null) o.exp = String(q.exp); }
  else if (q.type === 'match') { o.q = q.q; o.pairs = q.pairs.slice(0, MAX_ARRAY_LEN).map(function (p) { return [p[0], p[1]]; }); }
  return o;
}
