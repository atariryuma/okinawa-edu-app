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
  return 'setup done: sheet="' + sh.getName() + '"';
}

/* ============================================================================
 *  doGet(e): approved の問題だけを JSON で返す
 * ========================================================================== */
function doGet(e) {
  try {
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
    return json_({ ok: true, questions: out });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
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

    var q;
    try {
      q = JSON.parse(body);
    } catch (parseErr) {
      return json_({ ok: false, error: 'invalid JSON' });
    }

    var v = validate_(q);
    if (!v.ok) return json_({ ok: false, error: v.error });

    // ── 排他制御つきで dedup → 追記 ──
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_WAIT_MS)) {
      return json_({ ok: false, error: 'busy, retry later' });
    }
    try {
      var sh = getSheet_(true);

      var lastRow = sh.getLastRow();
      if (lastRow >= 2) {
        var ids = sh.getRange(2, COL.id + 1, lastRow - 1, 1).getValues();
        for (var i = 0; i < ids.length; i++) {
          if (String(ids[i][0]) === q.id) {
            return json_({ ok: false, error: 'duplicate id' });
          }
        }
      }

      var summary = summarize_(q);

      var newRow = [];
      newRow[COL.ts]     = new Date();
      newRow[COL.status] = 'pending';
      newRow[COL.id]     = q.id;
      newRow[COL.type]   = q.type;
      newRow[COL.cat]    = q.cat || '';
      newRow[COL.json]   = JSON.stringify(q);
      newRow[COL.q]      = summary;
      newRow[COL.src]    = q.src;

      sh.getRange(sh.getLastRow() + 1, 1, 1, HEADERS.length).setValues([newRow]);

      return json_({ ok: true });
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
  if (q.id.length > MAX_ID_LEN) return err_('id too long');

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

function byteLen_(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
