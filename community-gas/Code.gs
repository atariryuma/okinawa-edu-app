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
var HEADERS         = ['timestamp', 'status', 'id', 'type', 'cat', 'json', 'q', 'src', 'device', 'reports'];
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
// ── 自動承認（段階可視性）の門番パラメータ ──────────────────────────────────
var REP_TRUST       = 2;     // この端末の「承認済み」実績がこの数以上なら、匿名でも自動公開の資格（段階信頼）
var REPORT_LIMIT    = 3;     // 通報がこの数に達したら approved→pending へ自動降格（可逆）
var REPORT_RATE_HR  = 30;    // 1端末あたり1時間の通報上限（通報の悪用対策）
// 出典が公式ソースに解決するかの判定パターン（アプリの LAW_LINKS/DOC_LINKS の p を移植）。
// src がこのいずれかを含めば「出典あり」とみなし、自動公開の必須条件にする（正確さの門番）。
var SRC_PATTERNS = ["義務教育の段階における普通教育に相当する教育の機会の確保等に関する法律","公立義務教育諸学校の学級編制及び教職員定数の標準に関する法律","公立の義務教育諸学校等の教育職員の給与等に関する特別措置法","教育職員等による児童生徒性暴力等の防止等に関する法律","義務教育諸学校の教科用図書の無償措置に関する法律","障害を理由とする差別の解消の推進に関する法律","地方教育行政の組織及び運営に関する法律","児童虐待の防止等に関する法律","個人情報の保護に関する法律","市町村立学校職員給与負担法","学校教育法施行令（政令）","学校保健安全法施行規則","児童生徒性暴力等防止法","いじめ防止対策推進法","わいせつ教員対策新法","学校教育法施行規則","学校保健安全法施規","保健安全法施行規則","わいせつ教員対策法","教育公務員特例法","教科書無償措置法","障害者差別解消法","教員性暴力防止法","学校教育法施行令","発達障害者支援法","学校法施行規則","学教法施行規則","地方教育行政法","教育職員免許法","学校保健安全法","教育機会確保法","児童虐待防止法","個人情報保護法","労働安全衛生法","行政不服審査法","地方公務員法","いじめ防止法","こども基本法","子ども基本法","性暴力防止法","学教法施行令","障害者基本法","教育基本法","学校教育法","学校保健法","機会確保法","虐待防止法","児童福祉法","国家賠償法","義務標準法","無償措置法","差別解消法","社会教育法","給与負担法","県費負担法","日本国憲法","労働基準法","行政手続法","学校給食法","食育基本法","地教行法","労安衛法","著作権法","教基法","学教法","学校法","地公法","教特法","免許法","教免法","学保法","児福法","個情法","国賠法","給特法","標準法","社教法","労基法","安衛法","行手法","行審法","行服法","熱中症対策ガイドライン","GIGAスクール構想","中教審答申(H27)","チームとしての学校","個別の教育支援計画","GIGAスクール","中教審第185号","個別の指導計画","特別支援教育","熱中症","中央教育審議会答申(令和3年1月)","教育振興基本計画（第4期","教育振興基本計画（第４期","中教審答申(R3.1)","令和答申","「自立した学習者」育成プロジェクト","新・沖縄21世紀ビジョン基本計画","学校教育における指導の努力点","沖縄県キャリア教育の基本方針","学校安全の推進に関する計画","学校事故対応に関する指針","第4期教育振興基本計画","第４期教育振興基本計画","沖縄県教育振興基本計画","キャリア教育の基本方針","令和の日本型学校教育","沖縄21世紀ビジョン","危機管理マニュアル","学習指導要領解説","いじめの重大事態","学校環境衛生基準","幼稚園教育要領","地域クラブ活動","重大事態の調査","食物アレルギー","勤務時間の上限","第3次学校安全","自立した学習者","学習指導要領","生徒指導提要","COCOLO","指導の努力点","生成AI","学習評価","指導要録","部活動"];

/* 列インデックス（0始まり）。HEADERS と一致させる */
var COL = { ts:0, status:1, id:2, type:3, cat:4, json:5, q:6, src:7, device:8, reports:9 };

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
    // 通報アクション（共有問題の誤り報告→自動降格の起点）。問題投稿とは別経路で先に処理。
    if (env && typeof env === 'object' && env.action === 'report') {
      return handleReport_(String(env.id || ''), String(env.device || ''));
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
    // 本人確認（IDトークン）＋出典が公式ソースに解決するか。自動公開はこの両軸で判断する。
    var trusted = idtoken ? verifyToken_(idtoken) : false;
    var sourceOk = srcResolves_(q.src);   // 出典が e-Gov/文科省/県 の公式ソースに解決するか（正確さの門番）

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
      var rep = 0;   // この端末の「承認済み」実績（段階信頼：実績があれば匿名でも自動公開資格）
      if (lastRow >= 2) {
        // id重複拒否＋pending滞留数＋この端末の承認実績を、1回の一括取得で集計
        var rows = sh.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
        var pending = 0;
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          if (String(row[COL.id]) === q.id) return json_({ ok: false, error: 'duplicate id' });
          var st = String(row[COL.status]).trim().toLowerCase();
          if (st === 'pending') pending++;
          if (st === 'approved' && device && String(row[COL.device]) === device) rep++;
        }
        if (pending >= MAX_PENDING) return json_({ ok: false, error: 'too many pending' });
      }

      // 未知キー/プロトタイプ汚染を物理的に落としてから保存（ホワイトリスト再構築）
      var clean = pick_(q);
      var summary = summarize_(clean);

      // 自動公開の条件：出典が公式に解決し、かつ（本人確認済み or この端末に承認実績がある）。
      // identity だけでなく「公式出典」を必須にすることで、誤った条文の即時拡散を防ぐ。
      var eligible = sourceOk && (trusted || rep >= REP_TRUST);
      var status = eligible ? 'approved' : 'pending';
      var newRow = [];
      newRow[COL.ts]      = new Date();
      newRow[COL.status]  = status;
      newRow[COL.id]      = deformula_(clean.id);
      newRow[COL.type]    = clean.type;
      newRow[COL.cat]     = deformula_(clean.cat || '');
      newRow[COL.json]    = deformula_(JSON.stringify(clean));
      newRow[COL.q]       = deformula_(summary);
      newRow[COL.src]     = deformula_(clean.src);
      newRow[COL.device]  = deformula_(device || '');
      newRow[COL.reports] = 0;

      sh.getRange(sh.getLastRow() + 1, 1, 1, HEADERS.length).setValues([newRow]);
      // 自動公開した場合は doGet キャッシュを破棄して即時反映
      if (eligible) { try { var c = CacheService.getScriptCache(); if (c) c.remove('doget'); } catch (_ig2) {} }

      // status と、自動公開されなかった理由（任意・後方互換）を返す
      var reason = eligible ? '' : (!sourceOk ? 'source-unresolved' : 'untrusted');
      return json_({ ok: true, status: status, reason: reason });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/* ============================================================================
 *  srcResolves_(src): 出典が公式ソース（e-Gov/文科省/県）に解決するか
 *   アプリ側 LAW_LINKS/DOC_LINKS の p を移植。含めば true（=自動公開の必須条件）。
 * ========================================================================== */
function srcResolves_(src) {
  var s = String(src == null ? '' : src);
  if (!s) return false;
  for (var i = 0; i < SRC_PATTERNS.length; i++) {
    if (s.indexOf(SRC_PATTERNS[i]) >= 0) return true;
  }
  return false;
}

/* ============================================================================
 *  handleReport_(id, device): 共有問題の通報。一定数で approved→pending に自動降格。
 *   - 端末ごとの通報レート制限＋同一問題の二重通報抑止（CacheService）
 *   - REPORT_LIMIT 到達かつ approved の時だけ pending へ降格（再審査）＋doGetキャッシュ破棄
 * ========================================================================== */
function handleReport_(id, device) {
  if (!ID_RE.test(String(id || ''))) return json_({ ok: false, error: 'bad id' });
  if (!device) return json_({ ok: false, error: 'no device' });
  // レート制限＆重複通報の抑止
  try {
    var c = CacheService.getScriptCache();
    if (c) {
      var rk = 'rprl_' + device, rn = parseInt(c.get(rk) || '0', 10);
      if (rn >= REPORT_RATE_HR) return json_({ ok: false, error: 'rate limited' });
      var dk = 'rpd_' + device + '_' + id;
      if (c.get(dk)) return json_({ ok: true, status: 'already' }); // 同端末×同一問題の二重通報は無視（成功扱い）
      c.put(rk, String(rn + 1), 3600);
      c.put(dk, '1', 21600); // 6時間は同一問題の再通報を抑止
    }
  } catch (e) { /* キャッシュ不可でも続行 */ }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return json_({ ok: false, error: 'busy, retry later' });
  try {
    var sh = getSheet_(false);
    if (!sh) return json_({ ok: false, error: 'no sheet' });
    var lastRow = sh.getLastRow();
    if (lastRow < 2) return json_({ ok: false, error: 'not found' });
    var ids = sh.getRange(2, COL.id + 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === id) {
        var rowNum = i + 2;
        var rpCell = sh.getRange(rowNum, COL.reports + 1);
        var n = parseInt(rpCell.getValue() || '0', 10) + 1;
        rpCell.setValue(n);
        var stCell = sh.getRange(rowNum, COL.status + 1);
        var st = String(stCell.getValue()).trim().toLowerCase();
        if (st === 'approved' && n >= REPORT_LIMIT) {
          stCell.setValue('pending');   // 自動降格＝配信停止して再審査へ
          try { var c2 = CacheService.getScriptCache(); if (c2) c2.remove('doget'); } catch (_g) {}
        }
        return json_({ ok: true, status: 'reported', reports: n });
      }
    }
    return json_({ ok: false, error: 'not found' });
  } finally {
    lock.releaseLock();
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
