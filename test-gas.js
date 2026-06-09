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
const UrlFetchApp = { fetch: () => ({ getResponseCode: () => (_tokeninfo ? 200 : 400), getContentText: () => JSON.stringify(_tokeninfo || {}) }) };
const Utilities = { newBlob: (s) => ({ getBytes: () => Buffer.from(String(s), 'utf8') }) };

// ---- 実コードを評価し、関数を取り出す ----
const EXPORTS = ['doGet','doPost','validate_','srcResolves_','deformula_','pick_','hasUrl_','hasBlocked_','verifyToken_','summarize_','isNonEmptyStr_','okLen_','isInt_'];
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
function reset() { sheet.rows = []; for (const k in _cache) delete _cache[k]; _tokeninfo = null; }
const post = (env) => JSON.parse(GAS.doPost({ postData: { contents: JSON.stringify(env) } })._s);
const get = () => JSON.parse(GAS.doGet({})._s);
const validToken = () => { _tokeninfo = { aud: CLIENT_ID, azp: CLIENT_ID, iss: 'accounts.google.com', email_verified: 'true', exp: String(Math.floor(Date.now()/1000)+3600) }; };
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
  validToken(); ok('全条件OK→true', GAS.verifyToken_('tok') === true);
  validToken(); _tokeninfo.aud = 'other'; ok('aud不一致→false', GAS.verifyToken_('tok') === false);
  validToken(); _tokeninfo.azp = 'other'; ok('azp不一致→false（aud偽装の素通し封じ）', GAS.verifyToken_('tok') === false);
  validToken(); _tokeninfo.email_verified = 'false'; ok('email未確認→false', GAS.verifyToken_('tok') === false);
  validToken(); _tokeninfo.iss = 'evil.com'; ok('iss不正→false', GAS.verifyToken_('tok') === false);
  validToken(); _tokeninfo.exp = String(Math.floor(Date.now()/1000) - 10); ok('失効→false', GAS.verifyToken_('tok') === false);
  validToken(); delete _tokeninfo.exp; ok('exp欠落→false（フェイルクローズ＝未失効を勝手に真としない）', GAS.verifyToken_('tok') === false);
  _tokeninfo = null; ok('tokeninfo 200以外→false', GAS.verifyToken_('tok') === false);
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
['x','y','z'].forEach(d => post({ action:'vote', id:'p2', device:d }));   // p2に👍3
post({ action:'vote', id:'p1', device:'w' });                              // p1に👍1
{
  const g = get().questions;
  ok('人気順：先頭が p2(👍3)', g[0].id === 'p2' && g[0].up === 3);
  ok('UP_VERIFY到達で v=1（検証済み）', g[0].v === 1);
  ok('👍不足の p1 は v=0', g.find(q => q.id === 'p1').v === 0);
}
ok('二重投票は already', post({ action:'vote', id:'p2', device:'x' }).status === 'already');
ok('未知idへの投票は not found', post({ action:'vote', id:'none', device:'q' }).error === 'not found');

// =========================== 通報→自動降格 ===========================
section('handleReport_: REPORT_LIMIT で approved→pending 自動降格');
reset(); validToken();
post({ q:Q('rp','学校教育法第37条'), idtoken:'tok', device:'d1' });
ok('降格前は配信される', get().questions.length === 1);
['dx','dy','dz'].forEach(d => post({ action:'report', id:'rp', device:d }));  // 通報3
ok('通報3件で非配信（pending降格）', get().questions.length === 0);
ok('二重通報は already', post({ action:'report', id:'rp', device:'dx' }).status === 'already');

// =========================== 通報/投票：not found は枠を消費しない ===========================
section('handleReport_/handleVote_: 未知idは枠を消費せず二重抑止キーも焼かない（成功時のみ確定）');
reset(); validToken();
post({ q:Q('real','学校教育法第37条'), idtoken:'tok', device:'dG' });   // approved な実在問題
{
  const r = post({ action:'report', id:'ghost', device:'dG' });
  ok('未知idへの通報は not found', r.error === 'not found');
  ok('未知id通報でレート枠を消費しない', _cache['rprl_dG'] === undefined || _cache['rprl_dG'] === null);
  ok('未知id通報で二重抑止キーを焼かない', !_cache['rpd_dG_ghost']);
  const v = post({ action:'vote', id:'ghost', device:'dG' });
  ok('未知idへの投票は not found', v.error === 'not found');
  ok('未知id投票でレート枠を消費しない', _cache['vrl_dG'] === undefined || _cache['vrl_dG'] === null);
  ok('未知id投票で二重抑止キーを焼かない', !_cache['vd_dG_ghost']);
}
{
  // 回帰防止：実在idの記録成功時には枠と二重抑止キーが確定すること
  post({ action:'report', id:'real', device:'dH' });
  ok('通報成功でレート枠を消費(=1)', String(_cache['rprl_dH']) === '1');
  ok('通報成功で二重抑止キーを確定', String(_cache['rpd_dH_real']) === '1');
  post({ action:'vote', id:'real', device:'dI' });
  ok('投票成功でレート枠を消費(=1)', String(_cache['vrl_dI']) === '1');
  ok('投票成功で二重抑止キーを確定', String(_cache['vd_dI_real']) === '1');
}

// =========================== 結果 ===========================
console.log('\n========================================');
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) { console.log('  失敗: ' + fails.join(' / ')); process.exit(1); }
console.log('  ✅ all green'); process.exit(0);
