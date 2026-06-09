#!/usr/bin/env node
/* ============================================================================
 *  沖縄 教育法規ナビ — 依存ゼロのロジックテスト（`node test.js`）
 * ----------------------------------------------------------------------------
 *  方針：抽出コピーではなく index.html の「実コードそのもの」を軽量DOMスタブ上で
 *  評価し、純粋ロジック関数を検証する（テストと本体がズレない）。ビルド・npm不要。
 *  過去に起きた実バグ（データ破壊・XSS・SRS逆行 等）を回帰テストとして固定する。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

// ---- index.html からインラインのアプリJSを取り出す（GSIの外部scriptは除外） ----
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const appJs = (() => {
  const lines = html.split('\n');
  let inScript = false, out = [];
  for (const ln of lines) {
    if (/<script src="https:\/\/accounts/.test(ln)) continue;       // GSI外部script
    if (/<script>/.test(ln)) { inScript = true; continue; }
    if (/<\/script>/.test(ln)) { inScript = false; continue; }
    if (inScript) out.push(ln);
  }
  return out.join('\n');
})();

// ---- 軽量DOMスタブ：任意のプロパティ/メソッド/呼び出しに耐える deep no-op ----
function deepNoop() {
  const f = function () { return proxy; };
  const proxy = new Proxy(f, {
    get(t, p) {
      if (p === 'style' || p === 'dataset') return {};
      if (p === 'classList') return { add(){}, remove(){}, toggle(){}, contains(){ return false; } };
      if (p === 'length') return 0;
      if (p === 'innerHTML' || p === 'textContent' || p === 'value' || p === 'href' || p === 'className') return '';
      if (p === 'hidden' || p === 'disabled' || p === 'checked') return false;
      if (p === Symbol.iterator) return function* () {};
      if (p in t) return t[p];
      return proxy;                 // それ以外は自分を返す（連鎖呼び出しに耐える）
    },
    set() { return true; },
    apply() { return proxy; },
  });
  return proxy;
}
const docStub = deepNoop();
const memStore = {};
const localStorageStub = {
  getItem: k => (k in memStore ? memStore[k] : null),
  setItem: (k, v) => { memStore[k] = String(v); },
  removeItem: k => { delete memStore[k]; },
};
const windowStub = { addEventListener(){}, removeEventListener(){}, scrollTo(){}, matchMedia: () => ({ matches:false, addEventListener(){}, addListener(){} }) };
const navigatorStub = { platform:'Test', maxTouchPoints:0, userAgent:'node', vibrate(){} };
const locationStub = { href:'http://localhost/', reload(){}, origin:'http://localhost' };
const fetchStub = () => Promise.resolve({ ok:true, json:()=>Promise.resolve([]), text:()=>Promise.resolve('[]') });

// ---- 実コードを評価し、テスト対象の関数とstoreアクセサを取り出す ----
const EXPORTS = [
  'review','mergeStore','sanitizeImport','validQuestion','srcLink','clampIvl','boxFromIvl',
  'stateOf','isDue','isWeak','isMastered','getCard','dueList','bucketShuffle','dailyCount',
  'bmKey','isBM','toggleBM','bmCount','pushRecent','lastAct','ymdNum','esc','shuffle',
  'examDaysLeft','todayISO','norm','pruneDailyDone','filterNetErr','saveGTok','loadGTok','clearGTok','load',
];
const exposeSrc = '\n;return {' +
  EXPORTS.map(n => `${n}:(typeof ${n}!=='undefined'?${n}:undefined)`).join(',') +
  `,__setStore:(s)=>{store=s},__getStore:()=>store,__setQuestions:(q)=>{QUESTIONS=q},__setBase:(q)=>{BASE_QUESTIONS=q}};`;

let APP;
try {
  const factory = new Function(
    'window','document','localStorage','navigator','location','matchMedia','fetch',
    appJs + exposeSrc
  );
  APP = factory(windowStub, docStub, localStorageStub, navigatorStub, locationStub, windowStub.matchMedia, fetchStub);
} catch (e) {
  console.error('✗ アプリJSの評価に失敗:', e && e.stack || e);
  process.exit(1);
}

// ---- 極小テストランナー ----
let pass = 0, fail = 0; const fails = [];
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function ok(name, cond) { if (cond) { pass++; } else { fail++; fails.push(name); console.log('  ✗ ' + name); } }
function section(t) { console.log('\n— ' + t + ' —'); }
function freshStore(over) {
  const s = { cards:{}, streak:0, lastDate:null, theme:'light', examDate:null, examDateT:0,
    userQuestions:[], totalAnswered:0, totalCorrect:0, dailyDone:{}, session:null,
    bookmarks:[], recent:[], ronbunDrafts:{} };
  Object.assign(s, over||{}); APP.__setStore(s); return s;
}

// =========================== validQuestion ===========================
section('validQuestion: 5形式の受理/拒否');
ok('qa 正常', APP.validQuestion({id:'q1',type:'qa',q:'a',a:'b'}) === true);
ok('mc 正常', APP.validQuestion({id:'q1',type:'mc',q:'a',choices:['x','y'],ans:1}) === true);
ok('mc ans範囲外を拒否', APP.validQuestion({id:'q1',type:'mc',q:'a',choices:['x','y'],ans:5}) === false);
ok('mc 7択を拒否', APP.validQuestion({id:'q1',type:'mc',q:'a',choices:['a','b','c','d','e','f','g'],ans:0}) === false);
ok('cloze 空欄ありを受理', APP.validQuestion({id:'q1',type:'cloze',parts:['x',{b:'y'}]}) === true);
ok('cloze 空欄なしを拒否', APP.validQuestion({id:'q1',type:'cloze',parts:['x','y']}) === false);
ok('cloze null part を拒否（renderCloze クラッシュ防止）', APP.validQuestion({id:'q1',type:'cloze',parts:[null,{b:'y'}]}) === false);
ok('cloze 不正object part を拒否', APP.validQuestion({id:'q1',type:'cloze',parts:[{b:''},{b:'y'}]}) === false);
ok('cloze 配列 part を拒否', APP.validQuestion({id:'q1',type:'cloze',parts:[['x'],{b:'y'}]}) === false);
ok('cloze 数値 part を拒否', APP.validQuestion({id:'q1',type:'cloze',parts:[5,{b:'y'}]}) === false);
ok('order items<2を拒否', APP.validQuestion({id:'q1',type:'order',q:'a',items:['x']}) === false);
ok('match pair形不正を拒否', APP.validQuestion({id:'q1',type:'match',q:'a',pairs:[['x']]}) === false);
ok('id無しを拒否', APP.validQuestion({type:'qa',q:'a',a:'b'}) === false);
ok('id形式違反を拒否', APP.validQuestion({id:'a b!<x>',type:'qa',q:'a',a:'b'}) === false);
ok('未知typeを拒否', APP.validQuestion({id:'q1',type:'evil',q:'a'}) === false);

// =========================== load: 改竄/非配列フィールドの正規化（起動クラッシュ防止） ===========================
section('load: 改竄localStorageでも安全な形に正規化');
if (APP.load) {
  memStore['okinawa_edu_app_v3'] = JSON.stringify({ userQuestions:{}, dailyDone:[1,2], bookmarks:'x', recent:5, cards:[] });
  const s = APP.load();
  ok('userQuestions 非配列→[]（rebuildQuestionsのspread落ち防止）', Array.isArray(s.userQuestions) && s.userQuestions.length===0);
  ok('dailyDone 配列→{}', s.dailyDone && typeof s.dailyDone==='object' && !Array.isArray(s.dailyDone));
  ok('bookmarks 非配列→[]', Array.isArray(s.bookmarks) && s.bookmarks.length===0);
  ok('recent 非配列→[]', Array.isArray(s.recent) && s.recent.length===0);
  ok('cards 配列→{}', s.cards && typeof s.cards==='object' && !Array.isArray(s.cards));
  delete memStore['okinawa_edu_app_v3'];
} else { ok('load 露出（スキップ可）', true); }

// =========================== norm（検索の表記ゆれ吸収）===========================
section('norm: カタ→ひら・全半角NFKC・小文字を同一視');
ok('カタカナ＝ひらがな', APP.norm('イジメ') === APP.norm('いじめ'));
ok('全角英数＝半角', APP.norm('ＧＩＧＡ') === APP.norm('giga'));
ok('大文字＝小文字', APP.norm('SNS') === APP.norm('sns'));
ok('混在も一致', APP.norm('コウチョウ') === APP.norm('こうちょう'));

// =========================== pruneDailyDone ===========================
section('pruneDailyDone: 140件以下はそのまま・超過で古い日を剪定');
{
  const small={'2026-6-1':3,'2026-6-2':5}; ok('小さいデータは不変', APP.pruneDailyDone(small)===small);
  const big={}; for(let i=0;i<200;i++){big['2020-1-'+(i+1)]=1;} big['2026-6-7']=9;
  const pruned=APP.pruneDailyDone(big); ok('超過で剪定される', Object.keys(pruned).length<Object.keys(big).length && pruned['2026-6-7']===9);
  ok('非オブジェクトは空に', JSON.stringify(APP.pruneDailyDone(null))==='{}');
}

// =========================== filterNetErr（通信起因の共有エラーを🐞ログから除外）===========================
section('filterNetErr: 通信失敗の共有エラーは除外・実バグは残す');
{
  const log=[
    {t:1,type:'community',msg:'共有問題の取得に失敗: Failed to fetch'},   // 除外
    {t:2,type:'community',msg:'共有問題の取得に失敗: HTTP 500'},           // 除外
    {t:3,type:'community',msg:'共有問題の応答が不正（HTTP200だがJSON解析失敗）'}, // 残す(実バグ手掛かり)
    {t:4,type:'runtime',msg:'TypeError: x is not a function'},             // 残す(別種)
    {t:5,type:'community',msg:'NetworkError when attempting to fetch'},    // 除外
  ];
  const out=APP.filterNetErr(log);
  ok('Failed to fetch を除外', !out.some(e=>/Failed to fetch/.test(e.msg)));
  ok('HTTP 5xx を除外', !out.some(e=>/HTTP 500/.test(e.msg)));
  ok('NetworkError を除外', !out.some(e=>/NetworkError/.test(e.msg)));
  ok('JSON解析失敗(実バグ)は残す', out.some(e=>/JSON解析失敗/.test(e.msg)));
  ok('community以外は残す', out.some(e=>e.type==='runtime'));
  ok('残ったのは2件', out.length===2);
  ok('非配列は空配列を返す', Array.isArray(APP.filterNetErr(null))&&APP.filterNetErr(null).length===0);
}
{
  // load（questions.json）：一時失敗は誤検知として掃除、キャッシュも無い真の失敗は残す
  const log=[
    {t:1,type:'load',msg:'questions.json 読み込み失敗: HTTP 503'},               // 旧版の一時失敗記録＝除外
    {t:2,type:'load',msg:'questions.json 読み込み失敗: Failed to fetch'},        // 一時失敗＝除外
    {t:3,type:'load',msg:'questions.json 読み込み失敗（キャッシュも無し）: HTTP 503'}, // 真の失敗＝残す
  ];
  const out=APP.filterNetErr(log);
  ok('load一時失敗(HTTP 503)を除外', !out.some(e=>e.t===1));
  ok('load一時失敗(Failed to fetch)を除外', !out.some(e=>e.t===2));
  ok('loadキャッシュも無し(真の失敗)は残す', out.some(e=>e.t===3));
  ok('残ったのは1件', out.length===1);
}

// =========================== アクセストークンの保存・再利用（リロードで再ログインを求めない）===========================
section('gTok: 期限内は再利用・期限切れ/壊れは破棄');
{
  APP.clearGTok();
  ok('未保存は null', APP.loadGTok()===null);
  APP.saveGTok('TOKEN_ABC', 3600);
  const o=APP.loadGTok();
  ok('保存→読み出しでトークン一致', o && o.t==='TOKEN_ABC');
  ok('期限はexpires_in(3600s)に概ね従う', o && o.e>Date.now()+3000000 && o.e<=Date.now()+3600000);
  APP.clearGTok();
  ok('clearGTok で破棄', APP.loadGTok()===null);
  // 期限切れは復帰させない（毎リロードの再ログインを防ぐ要）
  APP.saveGTok('TOKEN_OLD', -100);   // 既に過去
  ok('期限切れトークンは null（復帰しない）', APP.loadGTok()===null);
}

// =========================== srcLink ===========================
section('srcLink: 出典→公式ソース解決（アンカーは付けない）');
{
  const a = APP.srcLink('学校保健安全法第19条');
  ok('法令→e-Gov', a && /laws\.e-gov\.go\.jp\/law\//.test(a.u) && !/#/.test(a.u));
  ok('ラベル=条文を読む', a && a.t.indexOf('条文') >= 0);
  const d = APP.srcLink('生徒指導提要');
  ok('資料→DOC', d && /mext\.go\.jp/.test(d.u));
  ok('未知出典→null(検索フォールバック)', APP.srcLink('俺の自作メモ') === null);
}

// =========================== SRS: review ===========================
section('SRS review: 失敗で全消去しない・成功で間隔拡大・試験日キャップ');
{
  freshStore();
  APP.review('c1', true);  let c = APP.getCard ? APP.getCard('c1') : APP.__getStore().cards.c1;
  c = APP.__getStore().cards.c1;
  ok('初回正解 ivl=1', c.ivl === 1);
  APP.review('c1', true); c = APP.__getStore().cards.c1;
  ok('2回目正解 ivl=3', c.ivl === 3);
  const ivlBefore = c.ivl;
  APP.review('c1', false); c = APP.__getStore().cards.c1;
  ok('失敗でも pli退避（全消去しない）', typeof c.pli === 'number' && c.pli > 0);
  ok('失敗で当日再出題 ivl=0', c.ivl === 0);
  ok('失敗で ef 減点', c.ef < 2.5);
  ok('失敗で box<=2（弱点へ）', c.box <= 2);
  // 試験日キャップ
  freshStore({ examDate: new Date(Date.now()+3*86400000).toISOString().slice(0,10), examDateT: Date.now() });
  for (let i=0;i<8;i++) APP.review('c2', true);
  const due = APP.__getStore().cards.c2.due;
  ok('試験日が近いと間隔が残日数を越えない', (due - Date.now())/86400000 <= 4);
}
section('SRS review: grade=easy(楽勝)は間隔をより伸ばす（後方互換）');
{
  freshStore(); APP.review('g', true); APP.review('g', true);                 // good 2回 → ivl=3
  const ivlGood = APP.__getStore().cards.g.ivl, efGood = APP.__getStore().cards.g.ef;
  freshStore(); APP.review('e', true); APP.review('e', true, 'easy');         // 2回目を easy
  const ivlEasy = APP.__getStore().cards.e.ivl, efEasy = APP.__getStore().cards.e.ef;
  ok('easy は間隔がより長い', ivlEasy > ivlGood);
  ok('easy は ease をより上げる', efEasy > efGood);
  freshStore(); let crashed=false; try{ APP.review('x', true); }catch(e){ crashed=true; } // grade無し＝従来挙動
  ok('grade未指定でも動く（後方互換）', !crashed && APP.__getStore().cards.x.ivl===1);
}
section('SRS review: 回帰=hist欠落カードでも採点が落ちない');
{
  freshStore({ cards: { bad: { box:2, reps:1, due:0 } } });  // hist無し
  let crashed = false; try { APP.review('bad', true); } catch(e){ crashed = true; }
  ok('hist欠落でクラッシュしない', !crashed && Array.isArray(APP.__getStore().cards.bad.hist));
}

// =========================== mergeStore ===========================
section('mergeStore: 同期マージの安全性');
{
  // hist非配列でも例外を出さない
  let crashed=false, r;
  try { r = APP.mergeStore({cards:{q1:{hist:5,reps:1}},bookmarks:[],recent:[]},{cards:{q1:{hist:[{t:1,ok:true}],reps:2}},bookmarks:[],recent:[]}); } catch(e){ crashed=true; }
  ok('hist非配列で落ちない', !crashed && Array.isArray(r.cards.q1.hist));
  // 未来tsに乗っ取られない
  ok('lastAct: 未来tsを無視', APP.lastAct({hist:[{t:Date.now()+1e11,ok:false}]}) === 0);
  // userQuestions は mtime勝者
  const r2 = APP.mergeStore(
    {cards:{},userQuestions:[{id:'u1',type:'qa',q:'新',a:'x',mtime:200}],bookmarks:[],recent:[]},
    {cards:{},userQuestions:[{id:'u1',type:'qa',q:'旧',a:'x',mtime:100}],bookmarks:[],recent:[]});
  ok('自作問題は mtime新しい方が勝つ', r2.userQuestions.length===1 && r2.userQuestions[0].q==='新');
  // bookmarks 和集合 / recent 壊れ要素除外
  const r3 = APP.mergeStore(
    {cards:{},bookmarks:['q:a','q:b'],recent:[null,{t:'ref',id:'r1',ts:2}]},
    {cards:{},bookmarks:['q:b','q:c'],recent:[{t:'ref',id:'r1',ts:5}]});
  ok('bookmarks 和集合', eq([...r3.bookmarks].sort(), ['q:a','q:b','q:c']));
  ok('recent: null除外＋重複排除', r3.recent.length===1 && r3.recent[0].id==='r1');
  // 論文セルフチェックは深いOR、設定はlastDate勝者を採用
  const r4 = APP.mergeStore(
    {cards:{},lastDate:'2026-1-1',ronbunChecks:{t1:{0:true}},dailyGoal:10,bookmarks:[],recent:[]},
    {cards:{},lastDate:'2026-2-1',ronbunChecks:{t1:{1:true},t2:{0:true}},dailyGoal:20,bookmarks:[],recent:[]});
  ok('ronbunChecks 深いOR', r4.ronbunChecks.t1[0]===true && r4.ronbunChecks.t1[1]===true && r4.ronbunChecks.t2[0]===true);
  ok('dailyGoal は新しい端末(lastDate勝者)', r4.dailyGoal===20);
  // 破損したcloudカード(ivl/ef/due/box が NaN/文字列)を採用しても数値は有限に浄化される（NaN dueでの静かな死蔵を防ぐ）
  const rc = APP.mergeStore(
    {cards:{},bookmarks:[],recent:[]},
    {cards:{q9:{box:'evil',reps:'x',due:'NaN',ivl:'bad',ef:NaN,hist:[{t:1,ok:true}]}},bookmarks:[],recent:[]});
  const c9 = rc.cards.q9;
  ok('mergeStore: 破損カードの ivl を有限化(0..180)', Number.isFinite(c9.ivl) && c9.ivl>=0 && c9.ivl<=180);
  ok('mergeStore: 破損カードの ef を有限化', Number.isFinite(c9.ef));
  ok('mergeStore: 破損カードの due を有限化', Number.isFinite(c9.due));
  ok('mergeStore: 破損カードの box を1..5に', c9.box>=1 && c9.box<=5);
  // 両側に存在する場合も採用カードは浄化される
  const rc2 = APP.mergeStore(
    {cards:{q9:{box:2,reps:1,due:0,ivl:1,ef:2.5,hist:[{t:1,ok:true}]}},bookmarks:[],recent:[]},
    {cards:{q9:{box:3,reps:2,due:5,ivl:'x',ef:NaN,hist:[{t:9,ok:true}]}},bookmarks:[],recent:[]});
  ok('mergeStore: 両側ありでも勝者カードを浄化', Number.isFinite(rc2.cards.q9.ivl) && Number.isFinite(rc2.cards.q9.ef));
  // 浄化済みの破損カードを review しても NaN due を生まない（dueListから静かに消えない）
  freshStore({cards:{q9:c9}});
  APP.review('q9', true);
  const c9r = APP.__getStore().cards.q9;
  ok('review後も due が有限（NaN死蔵しない）', Number.isFinite(c9r.due) && c9r.due>0);
  ok('review後も ivl が有限', Number.isFinite(c9r.ivl));
}

// =========================== sanitizeImport ===========================
section('sanitizeImport: 不正/改竄バックアップの浄化');
{
  // examDate XSS を弾く
  ok('examDate XSSを破棄', APP.sanitizeImport({cards:{},examDate:'" onfocus=alert(1) autofocus x="'}).examDate === undefined);
  ok('正常examDateは通す', APP.sanitizeImport({cards:{},examDate:'2026-06-07'}).examDate === '2026-06-07');
  // 累積統計は履歴から再計算（巨大値を信用しない）
  const cl = APP.sanitizeImport({cards:{q1:{hist:[{t:1,ok:true},{t:2,ok:false}]}},totalAnswered:999999,totalCorrect:777});
  ok('totalAnswered は履歴から再計算', cl.totalAnswered===2 && cl.totalCorrect===1);
  // garbageカードの数値を健全化
  const g = APP.sanitizeImport({cards:{q1:{box:'evil',due:'NaN',ivl:-9999,ef:99,hist:[{t:1,ok:true}]}}}).cards.q1;
  ok('garbage card: box 1..5', g.box>=1 && g.box<=5);
  ok('garbage card: due 有限', Number.isFinite(g.due));
  ok('garbage card: ef 範囲内', g.ef<=2.7 && g.ef>=1.3);
  // userQuestions に mtime 補完
  const u = APP.sanitizeImport({cards:{},userQuestions:[{id:'u1',type:'qa',q:'a',a:'b',src:'x'}]});
  ok('import userQuestions に mtime 補完', typeof u.userQuestions[0].mtime === 'number');
  // 未来ts履歴を除去
  const fut = APP.sanitizeImport({cards:{q1:{hist:[{t:Date.now()+1e11,ok:true},{t:1,ok:true}]}}}).cards.q1;
  ok('未来ts履歴を除去', fut.hist.length===1);
}

// =========================== 付箋 / デイリー ===========================
section('付箋: トグルと実在カウント');
{
  freshStore();
  APP.__setQuestions([{id:'q1',type:'qa',q:'a',a:'b'},{id:'q2',type:'qa',q:'a',a:'b'}]);
  ok('isBM 初期false', APP.isBM('q','q1') === false);
  APP.toggleBM('q','q1');
  ok('toggleで付箋ON', APP.isBM('q','q1') === true);
  APP.__getStore().bookmarks.push('q:nonexistent'); // 孤児
  ok('bmCount は実在問題のみ計数', APP.bmCount('q') === 1);
}
section('デイリー: bucketShuffle はバケット間のdue昇順を保つ');
{
  freshStore({ cards: {
    a:{due:0*86400000+10,hist:[],box:2}, b:{due:0*86400000+20,hist:[],box:2}, // 同じ日バケット
    c:{due:5*86400000,hist:[],box:2},                                          // 後の日
  }});
  APP.__setQuestions([{id:'a',type:'qa',q:'',a:''},{id:'b',type:'qa',q:'',a:''},{id:'c',type:'qa',q:'',a:''}]);
  const order = APP.bucketShuffle([{id:'a'},{id:'b'},{id:'c'}].map(x=>({id:x.id})));
  ok('cは必ず最後（後の日バケット）', order[order.length-1].id === 'c');
}

// =========================== 結果 ===========================
console.log('\n========================================');
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) { console.log('  失敗: ' + fails.join(' / ')); process.exit(1); }
console.log('  ✅ all green'); process.exit(0);
