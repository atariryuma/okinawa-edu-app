#!/usr/bin/env node
/* ============================================================================
 *  community-gas/Code.gs — 依存ゼロのロジックテスト（`node test-gas.js`）
 * ----------------------------------------------------------------------------
 *  GAS は「未認証の外部入力（投稿・通報・👍）」を捌くセキュリティ境界。
 *  Code.gs の実コードを GASスタブ（Sheet/Cache/Lock/UrlFetch をメモリ実装）上で
 *  評価し、検証/モデレーション/自動公開判定/通報降格/評価昇格を検証する。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const code = fs.readFileSync(path.join(__dirname, 'community-gas', 'Code.gs'), 'utf8');

const CLIENT_ID = '773737222519-k2gpp483dqmnghfiuuv48kde10c2khog.apps.googleusercontent.com';

// ---- GASランタイムのメモリ・スタブ ----
const sheet = { rows: [] };                       // 2行目以降のデータ（各行=配列）
const SH = {
  getName: () => 'questions',
  getLastRow: () => sheet.rows.length + 1,         // +1=ヘッダ
  getRange: (r, c, nr, nc) => ({
    getValues: () => { const o = []; for (let i = 0; i < nr; i++) { const row = sheet.rows[(r - 2) + i] || []; const s = []; for (let j = 0; j < nc; j++) s.push(row[(c - 1) + j]); o.push(s); } return o; },
    getValue: () => { const row = sheet.rows[r - 2] || []; return row[c - 1]; },
    setValue: (v) => { sheet.rows[r - 2] = sheet.rows[r - 2] || []; sheet.rows[r - 2][c - 1] = v; },
    setValues: (vals) => { vals.forEach((vr, k) => { sheet.rows[(r - 2) + k] = vr.slice(); }); },
  }),
  setFrozenRows: () => {},
};
const ss = { getSheetByName: () => SH, insertSheet: () => SH };
const SpreadsheetApp = { openById: () => ss, getActiveSpreadsheet: () => ss };
const _cache = {};
const CacheService = { getScriptCache: () => ({ get: k => (k in _cache ? _cache[k] : null), put: (k, v) => { _cache[k] = String(v); }, remove: k => { delete _cache[k]; } }) };
const LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
const ContentService = { createTextOutput: (s) => ({ _s: s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
let _tokeninfo = null;     // verifyToken_ が受け取る tokeninfo レスポンス（テストで差し替え）
let _fetchCount = 0;       // UrlFetchApp 呼び出し回数（トークン検証キャッシュの検証用）
const UrlFetchApp = { fetch: () => { _fetchCount++; return { getResponseCode: () => (_tokeninfo ? 200 : 400), getContentText: () => JSON.stringify(_tokeninfo || {}) }; } };
const crypto = require('crypto');
const Utilities = {
  newBlob: (s) => ({ getBytes: () => Buffer.from(String(s), 'utf8') }),
  computeDigest: (_alg, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()),
  DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
};

// ---- 実コードを評価し、関数を取り出す ----
const EXPORTS = ['doGet','doPost','validate_','srcResolves_','deformula_','pick_','hasUrl_','hasBlocked_','verifyToken_','verifyTokenSub_','summarize_','isNonEmptyStr_','okLen_','isInt_','hash_','parseJsonList_','rateOk_','anonOk_','fetchBudgetOk_'];
let GAS;
try {
  const factory = new Function('SpreadsheetApp','CacheService','LockService','ContentService','UrlFetchApp','Utilities','console',
    code + '\n;return {' + EXPORTS.map(n => `${n}:(typeof ${n}!=='undefined'?${n}:undefined)`).join(',') + '};');
  GAS = factory(SpreadsheetApp, CacheService, LockService, ContentService, UrlFetchApp, Utilities, console);
} catch (e) { console.error('✗ Code.gs の評価に失敗:', e && e.stack || e); process.exit(1); }

// ---- ランナー ----
let pass = 0, fail = 0; const fails = [];
function ok(name, cond) { if (cond) pass++; else { fail++; fails.push(name); console.log('  ✗ ' + name); } }
function section(t) { console.log('\n— ' + t + ' —'); }
function reset() { sheet.rows = []; for (const k in _cache) delete _cache[k]; _tokeninfo = null; _fetchCount = 0; }
const post = (env) => JSON.parse(GAS.doPost({ postData: { contents: JSON.stringify(env) } })._s);
const get = () => JSON.parse(GAS.doGet({})._s);
const validToken = () => { _tokeninfo = { sub: 'sub-default', aud: CLIENT_ID, azp: CLIENT_ID, iss: 'accounts.google.com', email_verified: 'true', exp: String(Math.floor(Date.now()/1000)+3600) }; };
// ※検証結果はトークン文字列単位でキャッシュされるため、別人(sub)を演じる時は必ず別トークン文字列を使う（実環境と同じ：同一トークン＝同一人物）
const voteAs = (id, sub) => { validToken(); _tokeninfo.sub = sub; return post({ action:'vote', id, idtoken:'tok-'+sub }); }; // 検証済み sub ごとに1票（端末ではなくGoogleアカウントで集計）
const reportAs = (id, sub) => { validToken(); _tokeninfo.sub = sub; return post({ action:'report', id, idtoken:'tok-'+sub }); }; // 通報も sub 基準（端末ID偽装での良問降格を防ぐ）
const Q = (id, src) => ({ id, type: 'qa', cat: '法規', q: '問' + id, a: '答', src: src || '学校教育法第37条' });

// =========================== validate_ ===========================
section('validate_: スキーマ・上限・id形式');
ok('qa 正常', GAS.validate_({ id:'q1', type:'qa', cat:'法規', src:'x', q:'a', a:'b' }).ok === true);
ok('id形式違反(空白)を拒否', GAS.validate_({ id:'a b', type:'qa', src:'x', q:'a', a:'b' }).ok === false);
ok('id形式違反(=式)を拒否', GAS.validate_({ id:'=cmd', type:'qa', src:'x', q:'a', a:'b' }).ok === false);
ok('src必須', GAS.validate_({ id:'q1', type:'qa', q:'a', a:'b' }).ok === false);
ok('未知typeを拒否', GAS.validate_({ id:'q1', type:'evil', src:'x' }).ok === false);
ok('mc ans範囲外を拒否', GAS.validate_({ id:'q1', type:'mc', src:'x', q:'a', choices:['x','y'], ans:9 }).ok === false);
ok('過長フィールドを拒否', GAS.validate_({ id:'q1', type:'qa', src:'x', q:'a'.repeat(5000), a:'b' }).ok === false);

// =========================== 自動モデレーション ===========================
section('スパム門番: hasUrl_ / hasBlocked_ / deformula_ / pick_');
ok('URL検出(http)', GAS.hasUrl_({ id:'q', type:'qa', q:'see http://x.com', a:'b', src:'x' }) === true);
ok('URL検出(www)', GAS.hasUrl_({ id:'q', type:'qa', q:'www.x.com', a:'b', src:'x' }) === true);
ok('NGワード<script検出', GAS.hasBlocked_({ id:'q', type:'qa', q:'<script>x', a:'b', src:'x' }) === true);
ok('deformula_: =始まりにアポストロフィ', GAS.deformula_('=SUM(A1)') === "'=SUM(A1)");
ok('deformula_: +始まり', GAS.deformula_('+1') === "'+1");
ok('deformula_: 通常文字列は素通し', GAS.deformula_('学校教育法') === '学校教育法');
{
  // pick_: ホワイトリスト再構築（未知キー/__proto__ 除去）
  const cleaned = GAS.pick_({ id:'q1', type:'qa', cat:'法規', q:'a', a:'b', src:'x', evilKey:1, __proto__:{ polluted:1 } });
  ok('pick_: 未知キーを落とす', cleaned.evilKey === undefined);
  ok('pick_: 必要キーは保持', cleaned.id==='q1' && cleaned.q==='a' && cleaned.a==='b' && cleaned.src==='x');
  ok('pick_: Object.prototype 非汚染', ({}).polluted === undefined);
}

// =========================== srcResolves_ ===========================
section('srcResolves_: 出典が公式ソースに解決するか（自動公開の門番）');
ok('学校教育法第37条→true', GAS.srcResolves_('学校教育法第37条') === true);
ok('地公法29条→true', GAS.srcResolves_('地公法29条') === true);
ok('自作メモ→false', GAS.srcResolves_('俺の自作メモ') === false);
ok('空→false', GAS.srcResolves_('') === false);

// =========================== verifyToken_ ===========================
section('verifyToken_: aud/azp/email_verified/iss/exp の全ゲート');
{
  // 検証結果はトークン単位でキャッシュされるので、ケースごとに固有のトークン文字列を使う
  validToken(); ok('全条件OK→true', GAS.verifyToken_('vt-ok') === true);
  validToken(); _tokeninfo.aud = 'other'; ok('aud不一致→false', GAS.verifyToken_('vt-aud') === false);
  validToken(); _tokeninfo.azp = 'other'; ok('azp不一致→false（aud偽装の素通し封じ）', GAS.verifyToken_('vt-azp') === false);
  validToken(); _tokeninfo.email_verified = 'false'; ok('email未確認→false', GAS.verifyToken_('vt-email') === false);
  validToken(); _tokeninfo.iss = 'evil.com'; ok('iss不正→false', GAS.verifyToken_('vt-iss') === false);
  validToken(); _tokeninfo.exp = String(Math.floor(Date.now()/1000) - 10); ok('失効→false', GAS.verifyToken_('vt-exp') === false);
  validToken(); delete _tokeninfo.exp; ok('exp欠落→false（フェイルクローズ＝未失効を勝手に真としない）', GAS.verifyToken_('vt-noexp') === false);
  _tokeninfo = null; ok('tokeninfo 200以外→false', GAS.verifyToken_('vt-http400') === false);
  // verifyTokenSub_：検証OKなら sub を返す／NGなら空文字（投票の本人確認に使用）
  validToken(); ok('verifyTokenSub_ 正常→subを返す', GAS.verifyTokenSub_('vt-sub') === 'sub-default');
  validToken(); _tokeninfo.sub = ''; ok('sub欠落→空（不可）', GAS.verifyTokenSub_('vt-nosub') === '');
  validToken(); _tokeninfo.aud = 'other'; ok('aud不一致→空', GAS.verifyTokenSub_('vt-aud2') === '');
  ok('idtoken空→空', GAS.verifyTokenSub_('') === '');
}

// =========================== トークン検証のキャッシュ＆クォータ予算（DoS耐性） ===========================
section('verifyTokenSub_: キャッシュで同一トークンの連打を1回のfetchに畳む／予算超過はフェイルクローズ');
{
  reset(); validToken();
  const before = _fetchCount;
  ok('初回はfetchする', GAS.verifyTokenSub_('cache-A') === 'sub-default' && _fetchCount === before + 1);
  _tokeninfo = null;   // 以降 tokeninfo が死んでいても…
  ok('2回目はキャッシュ（fetchしない・結果同一）', GAS.verifyTokenSub_('cache-A') === 'sub-default' && _fetchCount === before + 1);
  ok('無効トークンもネガティブキャッシュ', GAS.verifyTokenSub_('cache-bad') === '' && _fetchCount === before + 2 && GAS.verifyTokenSub_('cache-bad') === '' && _fetchCount === before + 2);
  // 予算超過＝tokeninfo を叩かずフェイルクローズ（UrlFetch日次クォータの枯渇＝「本人確認の静かな死」を攻撃で誘発させない）
  validToken(); _cache['tokfetch_hr'] = '500';
  const b2 = _fetchCount;
  ok('予算超過で検証はfetchせず失敗（フェイルクローズ）', GAS.verifyTokenSub_('cache-budget') === '' && _fetchCount === b2);
  delete _cache['tokfetch_hr'];
}

// =========================== 自動公開の判定マトリクス ===========================
section('doPost: 自動公開 = sourceOk && (trusted || rep>=REP_TRUST)');
reset();
// 空/未指定 device は拒否（空文字でレート制限をすり抜けるバイパスの封鎖・report/voteと整合）
ok('device空文字POSTは no device で拒否', post({ q:Q('nd','学校教育法第37条'), idtoken:'', device:'' }).error === 'no device');
ok('device未指定POSTも no device で拒否', post({ q:Q('nd2','学校教育法第37条'), idtoken:'' }).error === 'no device');
reset();
ok('① 匿名+出典あり → pending', post({ q:Q('a1','学校教育法第37条'), idtoken:'', device:'dA' }).status === 'pending');
reset(); validToken();
ok('② ログイン+出典あり → approved', post({ q:Q('a2','地公法29条'), idtoken:'tok', device:'dB' }).status === 'approved');
reset(); validToken();
ok('③ ログイン+出典なし → pending（出典ゲート）', post({ q:Q('a3','自作メモ'), idtoken:'tok', device:'dC' }).status === 'pending');
reset(); validToken();
post({ q:Q('r1','学校教育法第37条'), idtoken:'tok', device:'dR' });
post({ q:Q('r2','地公法29条'), idtoken:'tok', device:'dR' });   // dR の承認実績=2
_tokeninfo = null;                                              // 以降は匿名
ok('④ 匿名+出典あり+実績2 → approved（段階信頼）', post({ q:Q('r3','学校保健安全法第19条'), idtoken:'', device:'dR' }).status === 'approved');
reset(); validToken();
post({ q:Q('dup','学校教育法第37条'), idtoken:'tok', device:'dD' });
ok('⑤ 重複id → 拒否', post({ q:Q('dup','学校教育法第37条'), idtoken:'tok', device:'dD' }).ok === false);
reset();
ok('⑥ URL混入 → 拒否', post({ q:Object.assign(Q('u1'),{ a:'http://spam.com' }), idtoken:'', device:'dU' }).ok === false);

// =========================== doGet：承認のみ・人気順・検証バッジ ===========================
section('doGet: approved のみ配信・👍降順・検証フラグ');
reset(); validToken();
post({ q:Q('p1','学校教育法第37条'), idtoken:'tok', device:'d1' });
post({ q:Q('p2','地公法29条'), idtoken:'tok', device:'d2' });
ok('approved 2件配信', get().questions.length === 2);
['sa','sb','sc'].forEach(s => voteAs('p2', s));   // p2に👍3（3つの異なる Google アカウント）
voteAs('p1', 'sw');                                // p1に👍1
{
  const g = get().questions;
  ok('人気順：先頭が p2(👍3)', g[0].id === 'p2' && g[0].up === 3);
  ok('UP_VERIFY到達で v=1（検証済み）', g[0].v === 1);
  ok('👍不足の p1 は v=0', g.find(q => q.id === 'p1').v === 0);
}
ok('同一アカウントの二重投票は already', voteAs('p2', 'sa').status === 'already');
ok('未ログイン投票は login required', post({ action:'vote', id:'p2' }).error === 'login required');
ok('未ログイン投票は up を増やさない', get().questions.find(q => q.id === 'p2').up === 3);
ok('未知idへの投票(ログイン済)は not found', voteAs('none', 'sq').error === 'not found');

// =========================== 通報→自動降格（本人確認必須・3つの別アカウント） ===========================
section('handleReport_: REPORT_LIMIT(別アカウント3名)で approved→pending 自動降格');
reset(); validToken();
post({ q:Q('rp','学校教育法第37条'), idtoken:'tok', device:'d1' });
ok('降格前は配信される', get().questions.length === 1);
ok('未ログイン通報は login required', post({ action:'report', id:'rp' }).error === 'login required');
ok('未ログイン通報は降格させない', get().questions.length === 1);
// #1対策：同一アカウントが3回通報しても reports=1（端末ID偽装での suppression 不可）→降格しない
reportAs('rp','attacker'); reportAs('rp','attacker'); reportAs('rp','attacker');
ok('同一アカウント連投では降格しない（偽造不可）', get().questions.length === 1);
// 異なる3アカウントの通報が揃って初めて降格
reportAs('rp','rA'); reportAs('rp','rB');   // attacker(1) + rA + rB = 別3アカウント
ok('別3アカウントの通報で非配信（pending降格）', get().questions.length === 0);
ok('同一アカウントの二重通報は already', reportAs('rp','rA').status === 'already');

// =========================== 通報/投票：not found は枠を消費しない ===========================
section('handleReport_/handleVote_: 未知idは枠を消費せず二重抑止キーも焼かない（成功時のみ確定）');
reset(); validToken();
post({ q:Q('real','学校教育法第37条'), idtoken:'tok', device:'dG' });   // approved な実在問題
{
  const r = reportAs('ghost', 'rZ');
  ok('未知idへの通報は not found', r.error === 'not found');
  ok('未知id通報でレート枠を消費しない（sub基準）', !_cache['rprl_rZ']);
  ok('未知id通報で二重抑止キーを焼かない（sub基準）', !_cache['rpd_rZ_ghost']);
  const v = voteAs('ghost', 'sZ');
  ok('未知idへの投票は not found', v.error === 'not found');
  ok('未知id投票でレート枠を消費しない（sub基準）', !_cache['vrl_sZ']);
  ok('未知id投票で二重抑止キーを焼かない（sub基準）', !_cache['vd_sZ_ghost']);
}
{
  // 回帰防止：実在idの記録成功時には枠と二重抑止キーが確定すること
  reportAs('real', 'rH');
  ok('通報成功でレート枠を消費(=1・sub基準)', String(_cache['rprl_rH']) === '1');
  ok('通報成功で二重抑止キーを確定（sub基準）', String(_cache['rpd_rH_real']) === '1');
  voteAs('real', 'sI');
  ok('投票成功でレート枠を消費(=1・sub基準)', String(_cache['vrl_sI']) === '1');
  ok('投票成功で二重抑止キーを確定（sub基準）', String(_cache['vd_sI_real']) === '1');
}

// =========================== #7：投票バッジ偽造の防止（1アカウント1票） ===========================
section('handleVote_: 本人確認必須＝端末ID偽装で👍を水増しできない');
reset(); validToken();
post({ q:Q('forge','学校教育法第37条'), idtoken:'tok', device:'d1' });   // approved
{
  // 同一アカウント(sub)が3回投票しても up は1（端末IDを変えても無関係＝sub基準）
  voteAs('forge', 'attacker'); voteAs('forge', 'attacker'); voteAs('forge', 'attacker');
  ok('同一アカウントの連投は up=1（偽造不可）', get().questions.find(q => q.id === 'forge').up === 1);
  ok('1票では v=0（未検証）', get().questions.find(q => q.id === 'forge').v === 0);
  // 異なる3アカウントなら正当に up=3 → 検証済み
  voteAs('forge', 'realA'); voteAs('forge', 'realB');
  ok('3つの別アカウントで up=3', get().questions.find(q => q.id === 'forge').up === 3);
  ok('UP_VERIFY到達で v=1', get().questions.find(q => q.id === 'forge').v === 1);
}

// =========================== 永続二重投票/通報抑止（CacheService揮発でも保証） ===========================
section('voters/reporters列: キャッシュが消えても同一アカウントの再投票/再通報を抑止');
{
  reset(); validToken();
  post({ q:Q('pv','学校教育法第37条'), idtoken:'tok-owner', device:'d1' });   // approved
  voteAs('pv', 'sX');
  ok('投票で up=1', get().questions.find(q => q.id === 'pv').up === 1);
  for (const k in _cache) delete _cache[k];   // CacheService の全退去（6h経過/メモリ圧）をシミュレート
  ok('キャッシュ消滅後の再投票も already（シート永続）', voteAs('pv', 'sX').status === 'already');
  ok('up は水増しされない', get().questions.find(q => q.id === 'pv').up === 1);
  reportAs('pv', 'rX');
  for (const k in _cache) delete _cache[k];
  ok('キャッシュ消滅後の再通報も already（シート永続）', reportAs('pv', 'rX').status === 'already');
  ok('reports は二重加算されない', sheet.rows[0][9] === 1);
}

// =========================== pending行への投票/通報の仕込み防止 ===========================
section('handleVote_/handleReport_: approved 以外の行には作用しない');
{
  reset();
  post({ q:Q('pend','学校教育法第37条'), idtoken:'', device:'dAn' });   // 匿名→pending
  ok('pending行への投票は not found（公開と同時✓検証済みの細工防止）', voteAs('pend', 'sP').error === 'not found');
  ok('pending行の up は増えない', !sheet.rows[0][10]);
  ok('pending行への通報も not found', reportAs('pend', 'rP').error === 'not found');
}

// =========================== device偽装DoS対策（匿名の全体クォータ・pending上限は匿名のみ） ===========================
section('doPost: device偽装でレートを回避してもpending洪水でサービスを止められない');
{
  reset();
  _cache['anonq_hr'] = '30';   // 匿名全体クォータ消費済みをシミュレート（deviceを毎回変えても回避不能）
  ok('匿名はdeviceを変えても全体クォータで rate limited', post({ q:Q('an1','学校教育法第37条'), idtoken:'', device:'dEvil-new-each-time' }).error === 'rate limited');
  validToken();
  ok('本人確認済みは匿名クォータの影響を受けない', post({ q:Q('tr1','学校教育法第37条'), idtoken:'tok-trusted1', device:'dOK' }).status === 'approved');
  reset();
  // pending を MAX_PENDING(300) まで人工的に滞留させる
  for (let i = 0; i < 300; i++) sheet.rows.push([new Date(), 'pending', 'flood' + i, 'qa', '', '{}', 'q', 'src', 'dF', 0, 0, '', '']);
  ok('匿名投稿は too many pending で停止', post({ q:Q('an2','学校教育法第37条'), idtoken:'', device:'dAn2' }).error === 'too many pending');
  validToken();
  ok('本人確認済みはpending洪水でも投稿できる（DoS耐性）', post({ q:Q('tr2','地公法29条'), idtoken:'tok-trusted2', device:'dOK2' }).status === 'approved');
}

// =========================== device のハッシュ保存と評判(rep)の互換 ===========================
section('device: シートにはハッシュのみ保存・旧行(生device)の承認実績も引き継ぐ');
{
  reset(); validToken();
  post({ q:Q('dh1','学校教育法第37条'), idtoken:'tok-dh', device:'dRaw' });
  ok('シートのdevice列は16桁hexハッシュ（生値を残さない）', /^[0-9a-f]{16}$/.test(String(sheet.rows[0][8])) && sheet.rows[0][8] !== 'dRaw');
  reset();
  // 旧仕様の行（生deviceのまま）が2件 approved → 同じ端末の匿名投稿は段階信頼で自動公開
  sheet.rows.push([new Date(), 'approved', 'old1', 'qa', '', '{"id":"old1","type":"qa","q":"a","a":"b","src":"学校教育法"}', 'a', '学校教育法', 'dLegacy', 0, 0, '', '']);
  sheet.rows.push([new Date(), 'approved', 'old2', 'qa', '', '{"id":"old2","type":"qa","q":"a","a":"b","src":"地公法"}', 'a', '地公法', 'dLegacy', 0, 0, '', '']);
  ok('旧行の生deviceでも rep を引き継ぐ（匿名でも自動公開）', post({ q:Q('dh2','学校保健安全法第19条'), idtoken:'', device:'dLegacy' }).status === 'approved');
}

// =========================== 結果 ===========================
console.log('\n========================================');
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) { console.log('  失敗: ' + fails.join(' / ')); process.exit(1); }
console.log('  ✅ all green'); process.exit(0);
