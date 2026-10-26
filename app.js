(() => {
'use strict';
/* ===== 定数 ===== */
const APP_VERSION = '1.10.0';
const PAL = ['#D9534F','#E8943A','#D2AE2F','#7FB04A','#3FA37A','#2FA4B5','#4B8BDB','#6C6FD6','#9B6BD3','#CB5FA8','#8A8F98','#A07A55'];
const DEFAULT_CATS = [
  ['food','食費','e',1],['daily','日用品','e',2],['transport','交通費','e',6],['rent','住居','e',7],
  ['utility','水道・光熱費','e',5],['phone','通信費','e',8],['fun','趣味・娯楽','e',9],['beauty','衣服・美容','e',0],
  ['health','健康・医療','e',4],['edu','教育・教養','e',3],['social','交際費','e',11],['insure','保険','e',10],
  ['tax','税金・社会保障','e',10],['other_e','その他支出','e',10],
  ['salary','給与','i',4],['bonus','賞与','i',3],['side','副業','i',6],['other_i','その他収入','i',10]
].map(([id,name,type,c]) => ({id,name,type,color:PAL[c]}));
const DEFAULT_PAYS = [
  {id:'cash',name:'現金',color:PAL[3]},
  {id:'card',name:'クレジットカード',color:PAL[6]},
  {id:'emoney',name:'電子マネー',color:PAL[1]},
  {id:'bank',name:'口座・振込',color:PAL[7]}
];
const WD = ['日','月','火','水','木','金','土'];
const LS_KEY = 'kakeibo-v2';
const LS_FLAG_INSTALL = 'kakeibo-install-dismissed';

/* ===== ヘルパー ===== */
const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2,'0');
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const yen = n => '¥' + Math.abs(n).toLocaleString('ja-JP');
const signed = n => n === 0 ? '¥0' : (n < 0 ? '−' : '+') + yen(n);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };
const curMonth = () => todayStr().slice(0,7);
const shiftMonth = (key, delta) => { const [y,m] = key.split('-').map(Number); const d = new Date(y, m-1+delta, 1); return `${d.getFullYear()}-${pad(d.getMonth()+1)}`; };
const normDigits = s => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k,v) => { try { localStorage.setItem(k,v); } catch (e) {} };
const cashflow = x => x.t === 'i' ? x.a : -x.a;   // 収入は+、支出は−（返金・値引きの負の支出は+になる）

/* ===== 状態 ===== */
let S = { cats: DEFAULT_CATS.map(c => ({...c})), pays: DEFAULT_PAYS.map(p => ({...p})), learn: {}, accts: [], acctNames: [], pointNames: [], entries: [], idels: {}, prices: {}, recSkips: {}, months: {}, lastBackup: null, dels: {}, sync: {url:'', key:'', auto:true, last:null} };
const store = { mode: 'init', persisted: null, error: false, loaded: false };
const ui = { acctOwner:'all', tab:'home', month:curMonth(), filter:'all', q:'', aType:'e', aBy:'cat', setType:'e', lastPay:'cash', lastType:'e' };

const catById = id => S.cats.find(c => c.id === id) || {id, name:'未分類', color:'#8A8F98', type:'e'};
const payById = id => S.pays.find(p => p.id === id) || {id, name:'その他', color:'#8A8F98'};
const payName = id => payById(id).name;
const allTx = () => Object.values(S.months).flat();
const realCount = () => Object.values(S.months).reduce((n,a) => n + a.length, 0);
const monthTx = k => S.months[k] || [];
const findTx = id => { for (const arr of Object.values(S.months)) { const x = arr.find(t => t.id === id); if (x) return x; } return null; };
const sortTx = a => a.slice().sort((x,y) => x.d < y.d ? 1 : x.d > y.d ? -1 : (y.s||0) - (x.s||0));

function totals(k, maxDay) {
  let i = 0, e = 0;
  for (const x of monthTx(k)) {
    if (maxDay && Number(x.d.slice(8)) > maxDay) continue;
    if (x.t === 'i') i += x.a; else e += x.a;
  }
  return {i, e};
}
function usageCount(id, field = 'c') {
  let n = 0;
  for (const arr of Object.values(S.months)) for (const x of arr) if (x[field] === id) n++;
  return n;
}

/* ===== 保存（この端末の IndexedDB。使えなければ localStorage） ===== */
let idb = null;
function idbTx(stores, mode, fn) {
  return new Promise((res, rej) => {
    const tx = idb.transaction(stores, mode);
    let out;
    try { out = fn(tx); } catch (e) { rej(e); try { tx.abort(); } catch (_) {} return; }
    tx.oncomplete = () => res(out);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('abort'));
  });
}
function openIdb() {
  return new Promise((res, rej) => {
    if (!('indexedDB' in window) || !window.indexedDB) { rej(new Error('IndexedDB なし')); return; }
    const r = indexedDB.open('kakeibo', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('months')) db.createObjectStore('months');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('blocked'));
  });
}
async function idbLoadAll() {
  const months = {}; let meta = null;
  await idbTx(['months','meta'], 'readonly', tx => {
    const c = tx.objectStore('months').openCursor();
    c.onsuccess = () => { const cur = c.result; if (cur) { months[cur.key] = cur.value; cur.continue(); } };
    const g = tx.objectStore('meta').get('settings');
    g.onsuccess = () => { meta = g.result || null; };
  });
  return {months, meta};
}
const metaDoc = () => ({cats:S.cats, pays:S.pays, learn:S.learn, accts:S.accts, acctNames:S.acctNames, pointNames:S.pointNames, entries:S.entries, idels:S.idels, prices:S.prices, recSkips:S.recSkips, lastBackup:S.lastBackup, dels:S.dels, sync:S.sync});
/* エントリー: {id, run(実行日), due(期限), title(内容), memo(詳細), pt(付与pt), done(達成日。空なら未達成), u} */
function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const title = String(e.title || '').trim().slice(0, 40);
  if (!title) return null;
  const dt = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '';
  const pt = Math.round(Number(e.pt));
  return {id: String(e.id || 'e' + uid()), run: dt(e.run), due: dt(e.due), title, memo: String(e.memo || '').slice(0, 200), pt: Number.isFinite(pt) && pt > 0 ? Math.min(pt, 999999999) : 0, done: dt(e.done), u: Number(e.u) || 0};
}
/* 現資産の項目: {id, kind(cash/stock/btc/eth), owner(h夫/w妻/j共有), name, bal(円)/qty(数量)/price(株価), note, color, u}。収支の記録とは別に持つ */
function cleanAcct(a) {
  if (!a || typeof a !== 'object') return null;
  const kind = (a.kind === 'stock' || a.kind === 'point' || (a.kind && COINS[a.kind])) ? a.kind : 'cash';
  const owner = Object.prototype.hasOwnProperty.call(OWNERS, a.owner) ? a.owner : '';
  let name = String(a.name || '').trim().slice(0, 20);
  if (!name) { if (COINS[kind]) name = COINS[kind].name; else return null; }
  const out = {id: String(a.id || 'a' + uid()), kind, owner, name, bal: 0, qty: 0, price: 0, note: String(a.note || '').slice(0, 30), color: String(a.color || '#8A8F98'), u: Number(a.u) || 0, m: Number(a.m) || 0};
  if (kind === 'cash' || kind === 'point') {
    const bal = Math.round(Number(a.bal));
    if (!Number.isFinite(bal) || bal < 0 || bal > 999999999999) return null;
    out.bal = bal;
  } else {
    const qty = Number(a.qty);
    if (!Number.isFinite(qty) || qty < 0 || qty > 1e12) return null;
    out.qty = Math.round(qty * 1e8) / 1e8;
    if (kind === 'stock') {
      const price = Number(a.price);
      if (!Number.isFinite(price) || price < 0 || price > 1e10) return null;
      out.price = price;
    }
  }
  return out;
}
function cleanTx(x) {
  if (!x || typeof x !== 'object') return null;
  const a = Number(x.a);
  if (!Number.isFinite(a) || a === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(String(x.d))) return null;
  const out = {id: String(x.id || uid()), d: String(x.d), t: x.t === 'i' ? 'i' : 'e', c: String(x.c || ''), a: Math.round(a), p: String(x.p || ''), n: String(x.n || '').slice(0, 120), s: Number(x.s) || 0, u: Number(x.u) || 0};
  if (x.mf) out.mf = String(x.mf);
  if (x.r) out.r = String(x.r);
  if (x.rid) { out.rid = String(x.rid); out.rd = Math.min(31, Math.max(1, Number(x.rd) || Number(out.d.slice(8)))); }   // 毎月の支払いの系列（rid）と支払日（rd）
  if (x.rid && x.rec) out.rec = 1;                                                                                    // 「毎月」のチェック
  return out;
}
function applyLoaded(months, meta) {
  const m = {};
  for (const k of Object.keys(months || {})) {
    if (!/^\d{4}-\d{2}$/.test(k) || !Array.isArray(months[k])) continue;
    const arr = months[k].map(cleanTx).filter(Boolean);
    if (arr.length) m[k] = arr;
  }
  S.months = m;
  if (meta) {
    const okCat = c => c && typeof c.id === 'string' && typeof c.name === 'string' && (c.type === 'e' || c.type === 'i');
    if (Array.isArray(meta.cats) && meta.cats.length && meta.cats.every(okCat)) S.cats = meta.cats.map(c => ({id:c.id, name:c.name, type:c.type, color:c.color || '#8A8F98'}));
    if (Array.isArray(meta.pays) && meta.pays.length && meta.pays.every(p => p && typeof p.id === 'string' && typeof p.name === 'string')) S.pays = meta.pays.map(p => ({id:p.id, name:p.name, color:p.color || '#8A8F98'}));
    if (meta.learn && typeof meta.learn === 'object' && !Array.isArray(meta.learn)) S.learn = meta.learn;
    S.lastBackup = Number(meta.lastBackup) || null;
    if (meta.dels && typeof meta.dels === 'object' && !Array.isArray(meta.dels)) { S.dels = {}; for (const k of Object.keys(meta.dels)) if (Number(meta.dels[k])) S.dels[k] = Number(meta.dels[k]); }
    if (Array.isArray(meta.accts)) S.accts = meta.accts.map(cleanAcct).filter(Boolean);
    if (meta.recSkips && typeof meta.recSkips === 'object' && !Array.isArray(meta.recSkips)) { S.recSkips = {}; for (const k of Object.keys(meta.recSkips).slice(-3000)) S.recSkips[k] = 1; }
    if (meta.idels && typeof meta.idels === 'object' && !Array.isArray(meta.idels)) { S.idels = {}; for (const k of Object.keys(meta.idels).slice(0, 2000)) { const v = meta.idels[k]; if (v && (v.k === 'acct' || v.k === 'entry') && Number(v.t)) S.idels[k] = {k: v.k, t: Number(v.t)}; } }
    if (Array.isArray(meta.entries)) S.entries = meta.entries.map(cleanEntry).filter(Boolean).slice(0, 2000);
    if (Array.isArray(meta.pointNames)) S.pointNames = meta.pointNames.map(x => String(x).trim().slice(0, 20)).filter(Boolean).slice(0, 40);
    if (Array.isArray(meta.acctNames)) S.acctNames = meta.acctNames.map(x => String(x).trim().slice(0, 20)).filter(Boolean).slice(0, 40);
    if (meta.prices && typeof meta.prices === 'object') {
      S.prices = {};
      for (const k of Object.keys(COINS)) { const q = meta.prices[k]; if (q && Number(q.p) > 0) S.prices[k] = {p: Number(q.p), t: Number(q.t) || 0, manual: !!q.manual}; }
    }
    if (meta.sync && typeof meta.sync === 'object') S.sync = {url:String(meta.sync.url || ''), key:String(meta.sync.key || ''), auto:meta.sync.auto !== false, last:Number(meta.sync.last) || null};
  }
}
function saveLs() {
  localStorage.setItem(LS_KEY, JSON.stringify({...metaDoc(), months:S.months}));
}

let writeChain = Promise.resolve();
let errorShown = false;
function enqueue(fn) {
  writeChain = writeChain.then(fn).then(() => { store.error = false; }).catch(e => {
    console.warn('保存エラー', e);
    store.error = true;
    if (!errorShown) { errorShown = true; toast('保存できませんでした。端末の空き容量を確認してください'); }
    if (store.loaded) render();
  });
  return writeChain;
}
function saveMonth(key) {
  return enqueue(async () => {
    if (store.mode === 'idb') {
      const arr = S.months[key];
      await idbTx(['months'], 'readwrite', tx => {
        const os = tx.objectStore('months');
        if (arr && arr.length) os.put(arr, key); else os.delete(key);
      });
    } else if (store.mode === 'ls') saveLs();
  });
}
function saveMeta() {
  return enqueue(async () => {
    if (store.mode === 'idb') await idbTx(['meta'], 'readwrite', tx => { tx.objectStore('meta').put(metaDoc(), 'settings'); });
    else if (store.mode === 'ls') saveLs();
  });
}
function saveAll() {
  return enqueue(async () => {
    if (store.mode === 'idb') {
      await idbTx(['months','meta'], 'readwrite', tx => {
        const os = tx.objectStore('months');
        os.clear();
        for (const k of Object.keys(S.months)) if (S.months[k].length) os.put(S.months[k], k);
        tx.objectStore('meta').put(metaDoc(), 'settings');
      });
    } else if (store.mode === 'ls') saveLs();
  });
}
async function askPersist() {
  try {
    if (navigator.storage && navigator.storage.persisted) {
      let p = await navigator.storage.persisted();
      if (!p && navigator.storage.persist) p = await navigator.storage.persist();
      store.persisted = !!p;
    }
  } catch (e) {}
}
async function initStore() {
  try {
    idb = await openIdb();
    const {months, meta} = await idbLoadAll();
    store.mode = 'idb';
    applyLoaded(months, meta);
  } catch (e) {
    idb = null;
    try {
      store.mode = 'ls';
      const raw = localStorage.getItem(LS_KEY);
      if (raw) { const o = JSON.parse(raw); applyLoaded(o.months, o); }
    } catch (e2) { store.mode = 'memory'; }
  }
  store.loaded = true;
  askPersist();
}

/* ===== データ操作 ===== */
let lastBatch = null;
function saveTx(tx, orig) {
  tx.u = Date.now();
  delete S.dels[tx.id];
  if (orig) {
    const ok = orig.d.slice(0,7);
    S.months[ok] = (S.months[ok] || []).filter(x => x.id !== orig.id);
    saveMonth(ok);
  }
  const nk = tx.d.slice(0,7);
  S.months[nk] = [...(S.months[nk] || []), tx];
  saveMonth(nk);
  askPersist();
  scheduleSync();
}
function deleteTx(orig) {
  const ok = orig.d.slice(0,7);
  S.months[ok] = (S.months[ok] || []).filter(x => x.id !== orig.id);
  saveMonth(ok);
  S.dels[orig.id] = Date.now();
  if (orig.rid) S.recSkips[orig.id] = 1;     // 毎月の支払いを削除した月は、自動で作り直さない
  saveMeta();
  scheduleSync();
}
/* まとめて追加（取り込み・レシート）。取り消し用に追加した分を覚える */
function addBatch(txs, created) {
  const months = new Set();
  const ids = new Set();
  const nowU = Date.now();
  for (const tx of txs) {
    tx.u = nowU;
    const k = tx.d.slice(0,7);
    (S.months[k] = S.months[k] || []).push(tx);
    months.add(k); ids.add(tx.id);
  }
  months.forEach(k => saveMonth(k));
  if (created && (created.cats.length || created.pays.length)) saveMeta();
  askPersist();
  scheduleSync();
  lastBatch = {ids, months, created: created || {cats:[], pays:[]}};
  return lastBatch;
}
function undoBatch(b) {
  if (!b) return;
  const tnow = Date.now();
  for (const id of b.ids) S.dels[id] = tnow;
  if (b.rec) for (const id of b.ids) S.recSkips[id] = 1;     // 「毎月」の自動記録を取り消したときも、同じ月は作り直さない
  saveMeta();
  scheduleSync();
  for (const k of b.months) {
    S.months[k] = (S.months[k] || []).filter(x => !b.ids.has(x.id));
    if (!S.months[k].length) delete S.months[k];
    saveMonth(k);
  }
  let metaChanged = false;
  for (const id of b.created.cats) if (!usageCount(id, 'c')) { S.cats = S.cats.filter(c => c.id !== id); metaChanged = true; }
  for (const id of b.created.pays) if (!usageCount(id, 'p')) { S.pays = S.pays.filter(p => p.id !== id); metaChanged = true; }
  if (metaChanged) saveMeta();
  if (lastBatch === b) lastBatch = null;
  render();
  toast('取り消しました');
}
/* ===== 毎月の支払い =====
   「毎月」にチェックした支出は、同じ系列（rid）の最新の記録をもとに、毎月の支払日（rd）に同じ内容を自動で記録する（支払日が来た月まで）。
   支払いが終わったら、最新の月の記録で「毎月」のチェックを外すと、それ以降は記録されない。 */
function latestOfSeries(rid) {
  let last = null;
  for (const x of allTx()) if (x.rid === rid && (!last || x.d > last.d || (x.d === last.d && (x.u || 0) > (last.u || 0)))) last = x;
  return last;
}
function materializeRecurring(quiet) {
  if (!store.loaded) return {n: 0};
  const today = todayStr(), cm = curMonth();
  const latest = new Map();
  for (const x of allTx()) {
    if (!x.rid) continue;
    const cur = latest.get(x.rid);
    if (!cur || x.d > cur.d || (x.d === cur.d && (x.u || 0) > (cur.u || 0))) latest.set(x.rid, x);
  }
  const txs = [];
  for (const [rid, last] of latest) {
    if (!last.rec || last.t !== 'e') continue;                 // 最新の記録のチェックが外れていれば停止中
    const rd = last.rd || Number(last.d.slice(8));
    let m = last.d.slice(0, 7);
    for (let i = 0; i < 120; i++) {
      m = shiftMonth(m, 1);
      if (m > cm) break;
      const [y, mo] = m.split('-').map(Number);
      const d = `${m}-${pad(Math.min(rd, new Date(y, mo, 0).getDate()))}`;   // 31日払いは、30日までの月は月末にする
      if (d > today) break;
      const id = `r${rid}_${m.replace('-', '')}`;
      if (S.recSkips[id] || S.dels[id] || findTx(id)) continue;
      txs.push({id, d, t: 'e', c: last.c, a: last.a, p: last.p, n: last.n, s: Date.now() + txs.length, rid, rd, rec: 1});
    }
  }
  if (!txs.length) return {n: 0};
  const batch = addBatch(txs);
  batch.rec = true;
  if (!quiet) {
    toast(`毎月の支払い${txs.length}件を記録しました`, {action: '取り消す', fn: () => undoBatch(batch), ms: 9000});
    render();
  }
  return {n: txs.length, batch};
}

/* ===== CSV 読み込み（MoneyForward ME / このアプリのCSV） ===== */
function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  try { return new TextDecoder('utf-8', {fatal:true}).decode(u8); } catch (e) {}
  try { return new TextDecoder('shift_jis').decode(u8); } catch (e) {}
  throw new Error('文字コードを変換できませんでした。UTF-8のCSVで保存し直してください');
}
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i+1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"' && f === '') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i+1] === '\n') i++; row.push(f); f = ''; rows.push(row); row = []; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0].trim() === ''));
}
function parseDateStr(s) {
  s = normDigits(String(s)).trim();
  const m = s.match(/^(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], da = +m[3];
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  return `${y}-${pad(mo)}-${pad(da)}`;
}
function parseAmountStr(s) {
  s = normDigits(String(s)).replace(/[,\s¥￥円]/g, '').replace(/[−‐-―]/g, '-');
  if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s));
}
/* 戻り値: {ok, own, rows[], errors, skipped…} 行は {d,t,a,n,big,mid,pay,id,excl,xfer} */
function parseMoneyCsv(text) {
  const rows = parseCsv(text);
  let hi = -1;
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const r = rows[i].map(s => s.trim());
    if (r.includes('日付') && r.some(x => x.startsWith('金額'))) { hi = i; break; }
  }
  if (hi < 0) return {ok:false, error:'「日付」「金額」の列が見つかりません。MoneyForward MEからダウンロードしたCSVか確認してください'};
  const h = rows[hi].map(s => s.trim());
  const idx = name => h.indexOf(name);
  const col = {calc:idx('計算対象'), date:idx('日付'), name:idx('内容'), amt:h.findIndex(x => x.startsWith('金額')), inst:idx('保有金融機関'),
    big:idx('大項目'), mid:idx('中項目'), memo:idx('メモ'), xfer:idx('振替'), id:idx('ID'), kind:idx('種別'), cat:idx('カテゴリ'), pay:idx('支払方法')};
  const own = col.kind >= 0 && col.cat >= 0;
  const cell = (r, i) => (i >= 0 && i < r.length) ? String(r[i]).trim() : '';
  const out = []; let errors = 0, zero = 0, noYear = 0;
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    const d = parseDateStr(cell(r, col.date));
    const amt = parseAmountStr(cell(r, col.amt));
    if (!d || amt === null) { errors++; if (!d && /^\d{1,2}\s*[\/\-]\s*\d{1,2}/.test(cell(r, col.date))) noYear++; continue; }
    if (amt === 0) { zero++; continue; }
    if (own) {
      const t = cell(r, col.kind) === '収入' ? 'i' : 'e';
      out.push({d, t, a: amt, n: cell(r, col.memo).slice(0, 80), big: cell(r, col.cat) || '未分類', mid: '', pay: cell(r, col.pay), id: '', excl: false, xfer: false});
    } else {
      const name = cell(r, col.name), memo = cell(r, col.memo);
      out.push({d, t: amt < 0 ? 'e' : 'i', a: Math.abs(amt), n: [name, memo].filter(Boolean).join(' / ').slice(0, 80),
        big: cell(r, col.big) || '未分類', mid: cell(r, col.mid), pay: cell(r, col.inst),
        id: cell(r, col.id), excl: cell(r, col.calc) === '0', xfer: cell(r, col.xfer) === '1'});
    }
  }
  if (!out.length) return {ok:false, error: noYear ? '日付に年が含まれていないため読み取れません。Web版の「ダウンロード」で出したCSVを使ってください' : '取り込める行がありません'};
  return {ok:true, own, rows:out, errors, zero};
}

/* ===== レシートの文字を解析 ===== */
const CJK = '\\u3000-\\u30ff\\u3400-\\u9fff\\uff00-\\uffef';
function fixNumToken(tok) {
  if (!/\d/.test(tok) || tok.length < 2 || !/^[¥\d,.\-OoIl|]+$/.test(tok)) return tok;
  return tok.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
}
function normLine(raw) {
  let s = String(raw).normalize('NFKC');
  s = s.replace(/[−‐-―]/g, '-').replace(/[▲△]\s*(?=[¥\\]?\d)/g, '-');
  // 「¥」が「$」「·」「*」に化けた「金額だけの行」を直す（例: 「·279」「$498」「·62)」）。「#」は桁区切り付きのときだけ（レジ番号と区別するため）
  s = s.replace(/^[·•・$*]\s?((?:\d{1,3}(?:,\s?\d{3})+|[1-9]\d*))\)?$/, '¥$1').replace(/^#\s?(\d{1,3}(?:,\s?\d{3})+)\)?$/, '¥$1');
  s = s.replace(/\\/g, '¥');
  s = s.replace(/([^A-Za-z\d]|^)[Yy]{1,2}(?=\s?¥?\d)/g, '$1¥').replace(/¥{2,}/g, '¥');
  for (let i = 0; i < 3; i++) s = s.replace(/(\d)\s?[.,。、]\s?(\d{3})(?!\d)/g, '$1$2');
  s = s.replace(new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g'), '$1');
  s = s.split(/(\s+)/).map(t => /\s/.test(t) ? t : fixNumToken(t)).join('');
  return s.replace(/[ \t]+/g, ' ').trim();
}
function validDate(y, m, d, now) {
  if (y < 2000 || y > now.getFullYear() + 1 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}
function findDate(l, now) {
  let m;
  if ((m = l.match(/(20\d{2})\s*[年\/.\-]\s*(\d{1,2})\s*[月\/.\-]\s*(\d{1,2})/))) return validDate(+m[1], +m[2], +m[3], now);
  if ((m = l.match(/令和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})/))) return validDate(2018 + +m[1], +m[2], +m[3], now);
  if ((m = l.match(/(?:^|[^\d])(\d{2})[\/.](\d{1,2})[\/.](\d{1,2})(?!\d)/))) return validDate(2000 + +m[1], +m[2], +m[3], now);
  return null;
}
const HEADER_RE = /(No\.?\s*\d|[ス責]\s*No|会計機|スキャン|領収証|事業者|端末番号|ご利用日|カード\s*[IiＩ][DdＤ]|[IiＩ][CcＣ]通番|取扱内容|売上金額|基本積立|店舗\s*[#＃]|端末\s*[#＃]|扱者|責任|[#＃]\s*\d{3,}|ランク|TEL|Tel|電話|FAX|〒|レジ|担当|取引|伝票|会員|責任者|領収|レシート|登録番号|No\.|http|www\.|\d{1,2}:\d{2}|\d{2,4}-\d{2,4}-\d{3,4}|\d{4}\s*[年\/.]\s*\d{1,2}\s*[月\/.]|ありがとう|またお越し|ご来店)/i;
const END_RE = /^(小計|合計|総合計|お?買上|お会計|ご?請求|お預|お釣|おつり|釣銭|釣り|税込|対象|外税|内税|内消費税|消費税|クレジット|現金|カード|電子マネー|支払|ポイント|点数|\(?\d+%対象)/;
const QTY_RE = /^\s*(\d+\s*(コ|個|点|本|袋|枚|パック)?\s*([xX×@]|\*\s*[\d単])|[@*]\s*\d|単\s*\d)/;   // 「0050* 品名」のような商品コードは数量行ではない
const DISC_RE = /(値引|割引|クーポン|値下|ポイント利用|ポイント値引|割\s*$|引\s*$)/;
const TOTAL_RE = /(合計|今計|合書|合話|お?買上|お会計|総合計|ご?請求|TOTAL|お支払い?金額)/i;
const NOT_TOTAL_RE = /(小計|対象|消費税|内税|外税|点数|ポイント|預|釣)/;
const hasLetter = s => /[A-Za-z぀-ヿ㐀-鿿]/.test(s);

function lastAmount(l) {
  const toks = l.split(/\s+/);
  const t = toks[toks.length - 1] || '';
  const m = t.match(/^(.*?)¥?(-?)¥?(\d{1,7})(-?)円?$/);
  if (!m || (/\d/.test(m[1]) && !/[぀-ヿ㐀-鿿]$/.test(m[1]))) return null;      // 「科420」のように文字と金額がくっついた読み取りは許す
  return {amount: Number(m[3]), neg: m[2] === '-' || m[4] === '-', head: toks.slice(0, -1).join(' ') + (m[1] ? ' ' + m[1] : '')};
}
function matchItem(l) {
  if (QTY_RE.test(l)) return null;
  let s = l;
  for (let i = 0; i < 2; i++) s = s.replace(/\s*(軽|※|\*|★|☆|外|内|\(\s*(?:8|10)\s*%\s*\)|8%|10%)\s*$/, '');
  const la = lastAmount(s);
  if (!la) return null;
  let label = la.head.replace(/^\d{3,}\s*[*＊]?\s*/, '').replace(/^[*＊・●○◆◇▪]\s*/, '').replace(/\s+/g, ' ').trim();   // 先頭の商品コード（0050*など）を除く
  if (!hasLetter(label) || label.length > 40) return null;
  if (la.amount <= 0 || la.amount > 9999999) return null;
  const nLetters = (label.match(/[A-Za-z぀-ヿ㐀-鿿]/g) || []).length;
  const hasYen = /¥\s*-?\d/.test(s);
  if (nLetters < 2 || (!hasYen && la.amount < 10)) return null;     // 「装 5」のような読み違いを品目にしない
  const neg = la.neg || DISC_RE.test(label);
  return {label, amount: la.amount, neg};
}
/* 「広島商工センター店082-270-3368」「フレスポ西風新都店 2131」→ 電話番号・末尾の店番号を除く */
function cleanStoreText(l) {
  return String(l).replace(/(TEL|Tel|電話)?[\s.:：]*\d{2,4}-\d{2,4}-\d{3,4}.*$/, '').replace(/\s+[#＃]?\d{1,6}$/, '').trim();
}
function isStoreLine(l) {
  if (HEADER_RE.test(l) || findDate(l, new Date())) return false;
  if (/^[\d\s\-¥,.:]+$/.test(l)) return false;
  if (/JAN|\d{8,}/.test(l)) return false;                                  // 「4984969010552JAN」のような商品コード行
  if (/[都道府県市区町村郡].*\d/.test(l) || /^〒/.test(l)) return false;
  const letters = (l.match(/[A-Za-z぀-ヿ㐀-鿿]/g) || []).length;
  return letters >= 2 && l.length <= 30;
}
const PAY_BRANDS = [['JCB',/JCB/i],['VISA',/VISA/i],['Mastercard',/master\s*card/i],['AMEX',/(AMEX|American\s*Express)/i],['Diners',/Diners/i],['QUICPay',/QUIC\s*Pay/i],['iD',/(^|[^A-Za-z])iD([^A-Za-z]|$)/],['Suica',/Suica|スイカ/i],['PASMO',/PASMO/i],['nanaco',/nanaco/i],['WAON',/WAON/i],['楽天Edy',/(楽天\s*Edy|Edy)/i],['楽天ペイ',/楽天\s*ペイ/],['PayPay',/PayPay/i],['d払い',/d払い/],['au PAY',/au\s*PAY/i],['メルペイ',/メルペイ/],['交通系IC',/交通系/]];
function detectBrand(text) {
  const t = String(text).normalize('NFKC');
  for (const [name, re] of PAY_BRANDS) if (re.test(t)) return name;
  return '';
}
/* レシートのカード名・電子マネー名と同じ名前の支払方法が登録済みなら、そのIDを返す */
function payByBrand(brand) {
  if (!brand) return null;
  const b = brand.toLowerCase();
  const p = S.pays.find(p => String(p.name).normalize('NFKC').toLowerCase().includes(b));
  return p ? p.id : null;
}
function detectPay(text) {
  const t = text.normalize('NFKC');
  let id = null;
  if (/(クレジット|VISA|JCB|Master|AMEX|ご利用カード)/i.test(t)) id = 'card';
  else if (/(電子マネー|Suica|PASMO|iD|QUICPay|nanaco|WAON|PayPay|楽天ペイ|d払い|交通系)/i.test(t)) id = 'emoney';
  else if (/(お預り|お預かり|お釣|おつり|現金)/.test(t)) id = 'cash';
  return id && S.pays.some(p => p.id === id) ? id : null;
}
/* 戻り値 {date, store, items:[{label,amount,neg}], total, pay, lines} */
function parseReceipt(text, now) {
  now = now || new Date();
  const lines = [];
  const joined = [];
  for (const l of String(text).split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
    const prev = joined[joined.length - 1];
    if (prev !== undefined && /\d[,，]\s?$/.test(prev) && /^\d{3}(?!\d)/.test(l)) joined[joined.length - 1] = prev + l;
    else joined.push(l);
  }
  const rawLines = joined.map(normLine).filter(Boolean);
  const isPriceOnly = l => { const m = l.match(/^¥?\s?-?\s?¥?(\d{1,7})$/); return !!m && (l.includes('¥') || (m[1].length >= 3 && m[1][0] !== '0')); };   // 「00978」のような番号は金額ではない
  const kind = rawLines.map(l => isPriceOnly(l) ? 'P' : (hasLetter(l) && !lastAmount(l) && l.length <= 40 ? 'L' : 'O'));
  for (let i = 0; i < rawLines.length; i++) {                      // 「品名」の次の行が金額だけのとき（文字認識が列を分けて出す場合）は1行にする
    let merge = kind[i] === 'L' && kind[i + 1] === 'P' && !HEADER_RE.test(rawLines[i]) && !/^(取扱|伝票|番号|売上$|ご利用|端末|カード)/.test(rawLines[i]);
    if (merge) {                                                  // 品名が何行も続き、そのあと金額が何行も続くとき（列ごとに出力）は、ここでは結合しない
      let lr = 0, pr = 0;
      for (let j = i; j >= 0 && kind[j] === 'L'; j--) lr++;
      for (let j = i + 1; j < rawLines.length && kind[j] === 'P'; j++) pr++;
      if (lr >= 2 && pr >= 2) merge = false;
    }
    if (merge) { lines.push(rawLines[i] + ' ' + rawLines[i + 1]); i++; }
    else lines.push(rawLines[i]);
  }
  const info = {date:null, store:'', items:[], total:null, pay:detectPay(text), brand:detectBrand(text), lines};
  const used = new Set();
  for (let i = 0; i < lines.length; i++) { const d = findDate(lines[i], now); if (d) { info.date = d; used.add(i); break; } }
  const cjkN = l => (l.match(/[぀-ヿ㐀-鿿]/g) || []).length;
  let si = lines.findIndex(l => /^店名\s*[:：]\s*\S/.test(l));
  if (si >= 0) lines[si] = lines[si].replace(/^店名\s*[:：]\s*/, '');
  for (let i = 1; i < Math.min(lines.length, 16) && si < 0; i++) {                // 電話番号の行の直前が店名のことが多い
    if (/(TEL|Tel|電話|\d{2,4}-\d{2,4}-\d{3,4})/.test(lines[i])) {
      const pre = lines[i].replace(/(TEL|Tel|電話)?[\s.:：]*\d{2,4}-\d{2,4}-\d{3,4}.*$/, '').trim();   // 「広島商工センター店082-270-3368」→「広島商工センター店」
      if (pre && pre !== lines[i] && cjkN(pre) >= 3 && isStoreLine(pre)) { lines[i] = pre; si = i; break; }
      for (let j = i - 1; j >= Math.max(0, i - 5) && si < 0; j--) {   // 住所行をはさんでいても「〜店」を優先
        const c = cleanStoreText(lines[j]);
        if (/店$/.test(c) && isStoreLine(c) && cjkN(c) >= 3) { lines[j] = c; si = j; }
      }
      if (si >= 0) break;
      for (let j = i - 1; j >= Math.max(0, i - 2); j--) if (isStoreLine(lines[j]) && cjkN(lines[j]) >= 3) { si = j; break; }
      break;
    }
  }
  if (si < 0) for (let i = 0; i < Math.min(lines.length, 14); i++) {
    const c = cleanStoreText(lines[i]);
    if (/店$/.test(c) && isStoreLine(c) && cjkN(c) >= 3) { lines[i] = c; si = i; break; }
  }
  if (si < 0) for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (/(店|院|クリニック|薬局|カフェ|マート|ストア|食堂|ホテル|ドラッグ)/.test(lines[i]) && isStoreLine(lines[i])) { si = i; break; }
  }
  if (si < 0) for (let i = 0; i < Math.min(lines.length, 8); i++) {
    if (isStoreLine(lines[i]) && (lines[i].match(/[A-Za-z぀-ヿ㐀-鿿]/g) || []).length >= 3) { si = i; break; }
  }
  if (si >= 0) { info.store = lines[si].replace(/^(店名|店)[:：]\s*/, '').slice(0, 24); used.add(si); }
  let started = false, ended = false;
  const firstEnd = lines.findIndex(l => END_RE.test(l));
  const dateIdx = lines.findIndex(l => findDate(l, now));
  const from = dateIdx >= 0 && (firstEnd < 0 || dateIdx < firstEnd) ? dateIdx + 1 : 0;   // 日付が上にあるレシートは、その下から品目
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (info.total === null && TOTAL_RE.test(l) && !NOT_TOTAL_RE.test(l)) {
      const la = lastAmount(l.replace(/\s*(\(?\d+点\)?|税込?|円|\))+\s*$/, ''));   // 「合計 ¥837 税」「合計 ¥420 (2点)」
      if (la && la.amount > 0) { info.total = la.amount; ended = true; }   // 合計より下は品目ではない
    }
    if (ended || used.has(i) || i < from) continue;
    if (END_RE.test(l)) { if (started) ended = true; continue; }
    if (HEADER_RE.test(l)) continue;
    const it = matchItem(l);
    if (it) { info.items.push(it); started = true; }
  }
  if (info.items.length < 2) {                                  // 品名の行と金額の行が別々に読まれた場合は、上から順に組み合わせる
    let to = lines.findIndex((l, i) => i >= from && (END_RE.test(l) || TOTAL_RE.test(l)));
    if (to < 0) to = lines.length;
    const names = [], prices = [];
    for (let i = from; i < to; i++) {
      const l = lines[i];
      if (used.has(i) || HEADER_RE.test(l)) continue;
      const pm = l.match(/^¥?\s?(-?)\s?¥?(\d{1,7})$/);
      if (pm && isPriceOnly(l)) prices.push({amount:Number(pm[2]), neg:pm[1] === '-'});
      else if (hasLetter(l) && !lastAmount(l) && l.length <= 30 && (l.match(/[A-Za-z぀-ヿ㐀-鿿]/g) || []).length >= 2) names.push(l);
    }
    if (prices.length >= 3) {                                   // 最後の金額が、その前の金額の合計と同じなら小計の重複表示なので除く
      const last = prices[prices.length - 1];
      const rest = prices.slice(0, -1).reduce((a, p) => a + (p.neg ? -p.amount : p.amount), 0);
      if (!last.neg && last.amount === rest) prices.pop();
    }
    if (names.length > prices.length) {                         // 「◆」などで始まらない行は前の品名の折り返しとみなして結合
      const merged = [];
      for (const l of names) { if (merged.length && !/^[*＊・●○◆◇▪※★☆]/.test(l)) merged[merged.length - 1] += l; else merged.push(l); }
      if (merged.length === prices.length) { names.length = 0; names.push(...merged); }
    }
    // 品名と金額の数が合わないときは、ずれた組み合わせを作らない（3件以下のときだけ従来どおり1件の差を許す）
    if (prices.length >= 2 && names.length >= 2 && (names.length === prices.length || (prices.length <= 3 && Math.abs(names.length - prices.length) <= 1))) {
      const n = Math.min(names.length, prices.length), items = [];
      for (let i = 0; i < n; i++) items.push({label:names[i], amount:prices[i].amount, neg:prices[i].neg || DISC_RE.test(names[i])});
      if (items.length > info.items.length) info.items = items;
    }
  }
  if (info.total === null) {                                    // 合計が読めないとき：支払いの行の金額 → なければ品目の合計
    for (const l of lines) {
      if (/(クレジット|JCB|VISA|カード|電子マネー|QUICPay|現金|PayPay|お支払)/i.test(l) && !/(ポイント|番号|\*{3})/.test(l)) {
        const la = lastAmount(l);
        if (la && la.amount >= 10) { info.total = la.amount; break; }
      }
    }
  }
  if (info.total === null && info.items.length) {               // 合計行の金額が離れて読まれた場合: 品目の合計と同じ金額がほかにあれば、それを合計とする
    const sum = info.items.reduce((a, it) => a + (it.neg ? -it.amount : it.amount), 0);
    const yens = new Set();
    for (const l of lines) for (const m of l.matchAll(/¥\s?(\d{1,7})/g)) yens.add(Number(m[1]));
    if (sum > 0 && yens.has(sum)) info.total = sum;
  }
  if (info.total === null) {                                    // それでも無いとき: 何度も出てくる金額を合計と推定（確認画面に「推定」と表示）
    const cnt = new Map();
    for (const l of lines) {
      if (/(ポイント|番号|\*{3}|消費税|内税|外税|対象|税率|お釣|釣|預|%|TEL|Tel)/.test(l)) continue;
      for (const m of l.matchAll(/¥\s?(\d{1,7})(?!\d)/g)) { const v = Number(m[1]); if (v >= 10) cnt.set(v, (cnt.get(v) || 0) + 1); }
    }
    const best = [...cnt].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    if (best && best[1] >= 2) { info.total = best[0]; info.totalGuess = true; }
  }
  return info;
}

/* ===== 分類の候補（学習 → キーワード → 店の種類） ===== */
const KEYWORDS = [
  ['food', /(牛乳|ミルク|卵|たまご|玉子|パン|米|飯|弁当|おにぎり|寿司|すし|麺|うどん|そば|ラーメン|パスタ|肉|豚|牛|鶏|魚|鮭|野菜|キャベツ|レタス|トマト|きゅうり|たまねぎ|玉ねぎ|にんじん|人参|じゃがいも|大根|果物|りんご|バナナ|みかん|いちご|豆腐|納豆|チーズ|ヨーグルト|バター|ハム|ソーセージ|ベーコン|惣菜|サラダ|菓子|チョコ|スナック|アイス|ジュース|茶|コーヒー|ビール|酒|ワイン|調味料|醤油|味噌|砂糖|ソース|カレー|冷凍|飲料|ドリンク|ランチ|ケーキ|プリン|ゼリー|もやし|ねぎ|ほうれん草|ブロッコリー|ピーマン|なす|きのこ|しいたけ|味付|だし|ふりかけ|海苔)/],
  ['daily', /(ティッシュ|ティシュ|トイレット|洗剤|シャンプー|リンス|コンディショナー|石鹸|せっけん|ハンドソープ|ボディソープ|歯ブラシ|歯磨|ハミガキ|タオル|ゴミ袋|ごみ袋|ラップ|アルミ|スポンジ|電池|マスク|生理|おむつ|オムツ|柔軟剤|消臭|除菌|綿棒|キッチンペーパー|ポリ袋|電球|洗濯)/],
  ['health', /(薬|錠|サプリ|目薬|湿布|絆創膏|バンドエイド|胃腸|風邪|頭痛|診察|処方|漢方)/],
  ['transport', /(切符|乗車|ICチャージ|チャージ|Suica|PASMO|ガソリン|駐車|高速|タクシー|バス|運賃)/],
  ['fun', /(映画|ゲーム|カラオケ|チケット|入場|ボウリング|玩具|おもちゃ)/],
  ['edu', /(書籍|本|雑誌|参考書|ノート|文具|ペン|コピー|漫画|マンガ)/],
  ['beauty', /(化粧|ファンデ|口紅|美容|シャツ|靴下|下着|ズボン|スカート|ネイル|香水)/]
];
const STORE_HINTS = [
  ['health', /(病院|クリニック|医院|歯科|診療|調剤)/],
  ['daily', /(ドラッグ|ドラック|薬局|マツモトキヨシ|ウエルシア|スギ薬局|ツルハ|サンドラッグ|ココカラ|ダイソー|セリア|ホームセンター|ニトリ|無印)/],
  ['food', /(スーパー|マート|ストア|ライフ|イオン|西友|コンビニ|ローソン|セブン|ファミリーマート|ミニストップ|マルエツ|ヨーカドー|いなげや|オーケー|サミット|成城石井|生協|食品|市場|青果|精肉|鮮魚|ベーカリー|カフェ|珈琲|レストラン|食堂|ラーメン|寿司|居酒屋|弁当|マクドナルド|吉野家|すき家|松屋)/],
  ['transport', /(駅|鉄道|電鉄|バス|タクシー|ガソリン|ENEOS|出光|コスモ|駐車|パーキング)/],
  ['edu', /(書店|ブックス|本屋|文具|文房具|TSUTAYA|蔦屋)/],
  ['fun', /(映画|シネマ|カラオケ|ボウリング|ゲーム)/],
  ['beauty', /(ユニクロ|GU|しまむら|洋服|ファッション|美容|サロン|化粧)/]
];
function labelKey(label) {
  const k = String(label).normalize('NFKC').toLowerCase()
    .replace(/\d+(\.\d+)?\s*(ml|kg|g|l|個|コ|点|本|袋|枚|パック|入|%|円)?/g, ' ')
    .replace(/[()\[\]*※・\-_/x×@]/g, ' ').replace(/\s+/g, '');
  return k.length ? k.slice(0, 16) : String(label).slice(0, 8);
}
const expCatExists = id => S.cats.some(c => c.id === id && c.type === 'e');
function storeHint(store) {
  for (const [id, re] of STORE_HINTS) if (store && re.test(store) && expCatExists(id)) return id;
  return null;
}
function suggestCat(label, store) {
  const key = labelKey(label);
  if (!key) return null;
  if (S.learn[key] && expCatExists(S.learn[key])) return {c:S.learn[key], src:'learn'};
  if (key.length >= 2) for (const k of Object.keys(S.learn)) {
    if (k.length >= 2 && (key.includes(k) || k.includes(key)) && expCatExists(S.learn[k])) return {c:S.learn[k], src:'learn'};
  }
  for (const [id, re] of KEYWORDS) if (re.test(key) && expCatExists(id)) return {c:id, src:'kw'};
  const sh = storeHint(store);
  if (sh) return {c:sh, src:'store'};
  return null;
}
function learnLabel(label, catId) {
  const key = labelKey(label);
  if (!key || key.length < 2) return;
  delete S.learn[key];
  S.learn[key] = catId;
  const keys = Object.keys(S.learn);
  if (keys.length > 600) for (const k of keys.slice(0, keys.length - 500)) delete S.learn[k];
}
/* ===== 通知・シート ===== */
let toastTimer = null;
function toast(msg, opt) {
  const el = $('#toast');
  el.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  el.classList.toggle('act', !!(opt && opt.action));
  if (opt && opt.action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = opt.action;
    b.onclick = () => { el.classList.remove('show'); opt.fn(); };
    el.appendChild(b);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), (opt && opt.ms) || 2600);
}
let lastFocus = null;
let sheetClose = null;
let sheetLocked = false;   // 入力内容が多いシートは、外側をタップしても閉じない
function openSheet(html, label, onClose) {
  if (!$('#overlay').hidden && sheetClose) { const f = sheetClose; sheetClose = null; f(); }
  if ($('#overlay').hidden) lastFocus = document.activeElement;
  $('#toast').classList.remove('show');
  const sheet = $('#sheet');
  sheet.onclick = sheet.onchange = sheet.oninput = null;
  sheetLocked = false;
  sheet.setAttribute('aria-label', label || '入力');
  sheet.innerHTML = html;
  sheetClose = onClose || null;
  $('#overlay').hidden = false;
  document.body.style.overflow = 'hidden';
  sheet.scrollTop = 0;
  return sheet;
}
function closeSheet() {
  $('#overlay').hidden = true;
  $('#sheet').innerHTML = '';
  document.body.style.overflow = '';
  sheetLocked = false;
  if (sheetClose) { const f = sheetClose; sheetClose = null; try { f(); } catch (e) {} }
  if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
}
const XICON = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const closeBtn = id => `<button type="button" class="icon-btn" id="${id}" aria-label="閉じる">${XICON}</button>`;

/* ===== 画面の描画 ===== */
function isStandalone() { return !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches)); }
function isIos() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
const DAY = 86400000;

function render() {
  renderBar(); updateEntryBadge();
  for (const id of ['home','stats','acct','entry','set']) $('#v-' + id).hidden = ui.tab !== id;
  document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-current', b.dataset.tab === ui.tab ? 'page' : 'false'));
  $('#fabwrap').hidden = ui.tab === 'set' || ui.tab === 'acct' || ui.tab === 'entry';
  if (ui.tab === 'home') { renderBanner(); renderSummary(); renderFilter(); renderList(); }
  else if (ui.tab === 'stats') renderStats();
  else if (ui.tab === 'acct') { renderAcct(); refreshPrices(false); }
  else if (ui.tab === 'entry') renderEntries();
  else renderSettings();
}

function renderBar() {
  const [y,m] = ui.month.split('-').map(Number);
  const isSet = ui.tab === 'set' || ui.tab === 'acct' || ui.tab === 'entry';   // 月の切り替えが要らない画面
  $('#mLabel').textContent = ui.tab === 'set' ? '設定' : ui.tab === 'acct' ? '現資産' : ui.tab === 'entry' ? 'エントリー' : `${y}年${m}月`;
  $('#navPrev').style.visibility = $('#navNext').style.visibility = isSet ? 'hidden' : 'visible';
  const nx = $('#navNext'), isEntry = ui.tab === 'entry';
  if (nx.dataset.mode !== (isEntry ? 'add' : 'next')) {
    if (!nx.dataset.orig) nx.dataset.orig = nx.innerHTML;
    nx.dataset.mode = isEntry ? 'add' : 'next';
    nx.innerHTML = isEntry ? '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>' : nx.dataset.orig;
    nx.dataset.act = isEntry ? 'addentry' : 'next';
    nx.setAttribute('aria-label', isEntry ? 'エントリーを追加' : '次の月');
  }
  if (isEntry) nx.style.visibility = 'visible';
  $('#todayBtn').hidden = isSet || ui.month === curMonth();
}

function renderBanner() {
  const parts = [];
  if (store.mode === 'memory' || store.error) {
    parts.push(`<div class="banner warn"><div><b>記録を保存できません。</b>このまま閉じると入力した内容が消えます。ブラウザの設定でサイトデータの保存を許可してください。</div></div>`);
  }
  if (isIos() && !isStandalone() && lsGet(LS_FLAG_INSTALL) !== '1') {
    parts.push(`<div class="banner warn"><div><b>ホーム画面に追加してください。</b>Safariのまま使うと、しばらく開かない間に記録が消えることがあります。共有ボタン →「ホーム画面に追加」で追加できます。</div><div class="acts"><button class="chip small" data-act="dismiss-install">閉じる</button></div></div>`);
  }
  const n = realCount();
  const days = S.lastBackup ? Math.floor((Date.now() - S.lastBackup) / DAY) : null;
  if (n >= 20 && (days === null || days >= 30)) {
    parts.push(`<div class="banner"><div><b>バックアップがありません。</b>${days === null ? '' : `最後に取ったのは${days}日前です。`}機種変更や端末の故障に備えて、ときどき書き出してください。</div><div class="acts"><button class="chip small" data-act="backup">書き出す</button></div></div>`);
  }
  $('#banner').innerHTML = parts.join('');
}

function renderSummary() {
  if (!store.loaded) { $('#summary').innerHTML = '<div class="card"><p class="muted" style="margin:0">読み込み中…</p></div>'; return; }
  const [y,m] = ui.month.split('-').map(Number);
  const t = totals(ui.month);
  const net = t.i - t.e;
  const isCur = ui.month === curMonth();
  const prev = totals(shiftMonth(ui.month, -1), isCur ? new Date().getDate() : 0);
  let cmp = '';
  if (prev.e > 0) {
    const pct = Math.round((t.e - prev.e) / prev.e * 100);
    cmp = `${isCur ? '前月の同日比' : '前月比'} ${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct)}%`;
  }
  const used = t.i > 0 ? Math.round(t.e / t.i * 100) : null;
  const meter = used === null
    ? (t.e > 0 ? '<div class="meter-cap">この月の収入がまだ記録されていません</div>' : '')
    : `<div class="meter${used > 100 ? ' over' : ''}" role="img" aria-label="収入の${used}%を支出"><i style="width:${Math.max(0, Math.min(100, used))}%"></i></div><div class="meter-cap">収入の${used}%を支出に使用</div>`;
  $('#summary').innerHTML = `
    <div class="card">
      <div class="lbl">${m}月の収支</div>
      <div class="big${net < 0 ? ' exp' : ''}">${signed(net)}</div>
      <div class="split">
        <div><span class="lbl">収入</span><b class="inc">${yen(t.i)}</b></div>
        <div><span class="lbl">支出</span><b class="exp">${yen(t.e)}</b>${cmp ? `<small>${cmp}</small>` : ''}</div>
      </div>
      ${meter}
    </div>`;
}

function renderFilter() {
  document.querySelectorAll('#filterSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === ui.filter)));
  $('#toolbar').hidden = store.loaded && realCount() === 0;
}

function renderList() {
  const box = $('#list');
  if (!store.loaded) { box.innerHTML = ''; return; }
  if (realCount() === 0) {
    box.innerHTML = `
      <div class="welcome card">
        <h2>最初の記録を入れましょう</h2>
        <p>この家計簿のデータは、この端末の中にだけ保存されます。</p>
        <button type="button" class="btn primary" data-act="import-csv">MoneyForwardのCSVを取り込む</button>
        <button type="button" class="btn" data-act="receipt">レシートを読み取る</button>
        <button type="button" class="btn" data-act="add">自分で入力する</button>
      </div>`;
    return;
  }
  const q = ui.q.trim().toLowerCase();
  const source = q ? allTx() : monthTx(ui.month);
  const list = sortTx(source).filter(x => {
    if (ui.filter !== 'all' && x.t !== ui.filter) return false;
    if (!q) return true;
    return (x.n || '').toLowerCase().includes(q) || catById(x.c).name.toLowerCase().includes(q) || payName(x.p).toLowerCase().includes(q);
  });
  if (!list.length) {
    box.innerHTML = q || ui.filter !== 'all'
      ? '<div class="empty">条件に合う記録がありません。</div>'
      : '<div class="empty">この月の記録はまだありません。<br>右下の「入力」か「レシート」から追加できます。</div>';
    return;
  }
  const shown = list.slice(0, 400);
  const groups = [];
  for (const x of shown) {
    const g = groups[groups.length - 1];
    if (g && g.d === x.d) g.items.push(x); else groups.push({d:x.d, items:[x]});
  }
  const today = todayStr();
  box.innerHTML = groups.map(g => {
    const [y,m,d] = g.d.split('-').map(Number);
    const wd = WD[new Date(y, m-1, d).getDay()];
    const ex = g.items.filter(x => x.t === 'e').reduce((s,x) => s + x.a, 0);
    const inc = g.items.filter(x => x.t === 'i').reduce((s,x) => s + x.a, 0);
    const sum = [inc ? `収入 ${yen(inc)}` : '', ex ? `支出 ${yen(ex)}` : ''].filter(Boolean).join('　');
    const rows = g.items.map(x => {
      const c = catById(x.c);
      const sub = [x.n, payName(x.p)].filter(Boolean).join(' · ');
      const cf = cashflow(x);
      return `<button type="button" class="row" data-act="edit" data-id="${esc(x.id)}">
        <i class="dot" style="background:${c.color}"></i>
        <span class="main"><span class="cat">${esc(c.name)}</span><span class="sub">${x.rec ? '<span class="otag">毎月</span>' : ''}${esc(sub)}</span></span>
        <span class="amt${cf > 0 ? ' inc' : ''}">${cf > 0 ? '+' : '−'}${yen(x.a)}</span>
      </button>`;
    }).join('');
    return `<div class="day"><div class="dayhead"><span>${q ? y + '年' : ''}${m}月${d}日（${wd}）${g.d === today ? '<span class="today">今日</span>' : ''}</span><span class="num">${sum}</span></div><div class="rows">${rows}</div></div>`;
  }).join('') + (list.length > shown.length ? `<div class="empty">ほか${list.length - shown.length}件。検索で絞り込んでください。</div>` : '');
}

function breakdown(key, type, by) {
  const map = {};
  for (const x of monthTx(key)) {
    if (x.t !== type) continue;
    const k = by === 'cat' ? x.c : x.p;
    map[k] = (map[k] || 0) + x.a;
  }
  return Object.entries(map).map(([id,v]) => {
    const o = by === 'cat' ? catById(id) : payById(id);
    return {name:o.name, color:o.color, v};
  }).sort((a,b) => b.v - a.v);
}

function renderStats() {
  document.querySelectorAll('#aTypeSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === ui.aType)));
  document.querySelectorAll('#aBySeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === ui.aBy)));
  if (!store.loaded) { $('#stats').innerHTML = ''; return; }
  const m = Number(ui.month.slice(5));
  const rows = breakdown(ui.month, ui.aType, ui.aBy);
  const total = rows.reduce((s,r) => s + r.v, 0);
  const max = rows.length ? Math.max(1, rows[0].v) : 0;
  const word = ui.aType === 'e' ? '支出' : '収入';
  const rankHtml = rows.length ? rows.map(r => {
    const pct = total > 0 ? r.v / total * 100 : 0;
    return `<div class="rank"><div class="rtop"><span class="rname"><i class="dot" style="background:${r.color}"></i>${esc(r.name)}</span><span class="rval"><span class="amt">${r.v < 0 ? '−' : ''}${yen(r.v)}</span><span class="pct">${pct < 1 && pct > 0 ? '<1' : Math.round(Math.max(0, pct))}%</span></span></div><div class="rbar"><i style="width:${max ? Math.max(0, r.v) / max * 100 : 0}%;background:${r.color}"></i></div></div>`;
  }).join('') : `<div class="empty">この月の${word}はまだありません。</div>`;

  const keys = [5,4,3,2,1,0].map(i => shiftMonth(ui.month, -i));
  const tt = keys.map(k => ({k, ...totals(k)}));
  const maxV = Math.max(1, ...tt.flatMap(t => [t.i, t.e]));
  const cols = tt.map(t => {
    const mm = Number(t.k.slice(5));
    const hi = t.i > 0 ? Math.max(2, t.i / maxV * 100) : 0;
    const he = t.e > 0 ? Math.max(2, t.e / maxV * 100) : 0;
    return `<button type="button" class="tcol" data-act="goto" data-m="${t.k}" aria-current="${t.k === ui.month}" aria-label="${mm}月 収入${yen(t.i)} 支出${yen(t.e)}"><span class="bars"><i class="ib" style="height:${hi}%"></i><i class="eb" style="height:${he}%"></i></span><span class="tl">${mm}月</span></button>`;
  }).join('');
  const cur = tt[tt.length - 1];
  $('#stats').innerHTML = `
    <div class="card">
      <div class="lbl">${m}月の${word}合計</div>
      <div class="big${ui.aType === 'e' ? ' exp' : ' inc'}" style="margin-bottom:8px">${yen(total)}</div>
      ${rankHtml}
    </div>
    <div class="section-title">直近6か月の推移</div>
    <div class="card">
      <div class="trend" role="group" aria-label="直近6か月の収入と支出">${cols}</div>
      <div class="legend"><span><i style="background:var(--income)"></i>収入</span><span><i style="background:var(--expense)"></i>支出</span><span>棒の最大値 ${yen(maxV)}</span></div>
      <p class="caption num">${m}月：収入 ${yen(cur.i)} ／ 支出 ${yen(cur.e)}</p>
    </div>`;
}

function dateRangeText() {
  const ds = allTx().map(x => x.d).sort();
  if (!ds.length) return '記録なし';
  const f = s => s.slice(0,4) + '年' + Number(s.slice(5,7)) + '月';
  return f(ds[0]) + (ds[0].slice(0,7) === ds[ds.length-1].slice(0,7) ? '' : ' 〜 ' + f(ds[ds.length-1]));
}

function renderSettings() {
  const cats = S.cats.filter(c => c.type === ui.setType);
  const modeName = {idb:'この端末（IndexedDB）', ls:'この端末（localStorage）', memory:'保存できていません', init:'確認中'}[store.mode];
  const catRows = cats.map(c => `<button type="button" class="row" data-act="editcat" data-id="${esc(c.id)}"><i class="dot" style="background:${c.color}"></i><span class="main"><span class="cat">${esc(c.name)}</span></span><span class="muted" style="font-size:13px">${usageCount(c.id)}件</span></button>`).join('') || '<div class="empty">カテゴリがありません。</div>';
  const payRows = S.pays.map(p => `<button type="button" class="row" data-act="editpay" data-id="${esc(p.id)}"><i class="dot" style="background:${p.color}"></i><span class="main"><span class="cat">${esc(p.name)}</span></span><span class="muted" style="font-size:13px">${usageCount(p.id, 'p')}件</span></button>`).join('') || '<div class="empty">支払方法がありません。</div>';
  const bk = S.lastBackup ? new Date(S.lastBackup).toLocaleDateString('ja-JP') : 'まだありません';
  $('#settings').innerHTML = `
    <div class="card">
      <p class="sub-title">データの保存</p>
      <dl class="kv">
        <dt>保存先</dt><dd>${modeName}</dd>
        <dt>記録</dt><dd>${realCount().toLocaleString('ja-JP')}件（${dateRangeText()}）</dd>
        <dt>最後のバックアップ</dt><dd>${bk}</dd>
        <dt>ホーム画面から起動</dt><dd>${isStandalone() ? 'はい' : 'いいえ'}</dd>
        <dt>自動削除の保護</dt><dd>${store.persisted === true ? '許可されています' : store.persisted === false ? '未許可' : '不明'}</dd>
      </dl>
      <p class="note" style="margin-left:0">記録はこの端末の中だけに保存され、外部のサーバーには送られません。端末を替えるときは、バックアップを書き出して新しい端末で復元してください。</p>
    </div>
    <div class="section-title">スプレッドシート連携</div>
    ${syncCardHtml()}
    <div class="section-title">取り込み</div>
    <div class="stack">
      <button type="button" class="btn" data-act="import-csv">MoneyForwardのCSVを取り込む</button>
    </div>
    <p class="note">MoneyForward MEの家計簿画面で月を選び、下の「ダウンロード」で保存したCSVです。複数の月をまとめて選べます。</p>
    <div class="section-title">カテゴリ</div>
    <div class="seg" id="setTypeSeg" role="group" aria-label="カテゴリの種類" style="margin-bottom:10px">
      <button type="button" class="e" data-act="settype" data-v="e" aria-pressed="${ui.setType === 'e'}">支出</button>
      <button type="button" class="i" data-act="settype" data-v="i" aria-pressed="${ui.setType === 'i'}">収入</button>
    </div>
    <div class="rows">${catRows}</div>
    <div style="margin-top:10px"><button type="button" class="btn" data-act="addcat" style="width:100%">＋ カテゴリを追加</button></div>
    <div class="section-title">支払方法</div>
    <div class="rows">${payRows}</div>
    <div style="margin-top:10px"><button type="button" class="btn" data-act="addpay" style="width:100%">＋ 支払方法を追加</button></div>
    <div class="section-title">バックアップ</div>
    <div class="stack">
      <button type="button" class="btn" data-act="backup">バックアップを書き出す</button>
      <button type="button" class="btn" data-act="restore">バックアップから復元する</button>
    </div>
    <p class="note">書き出したファイルは「ファイル」アプリやiCloud Driveに保存しておくと安全です。</p>
    <div class="section-title">CSVで書き出す</div>
    <div class="stack">
      <button type="button" class="btn" data-act="export-month">表示中の月をCSVで書き出す</button>
      <button type="button" class="btn" data-act="export-all">すべての記録をCSVで書き出す</button>
    </div>
    <p class="note">ExcelなどにそのままCSVを開けます。このアプリへ再び取り込むこともできます。</p>
    <div class="section-title">このアプリについて</div>
    <div class="card">
      <p class="note" style="margin:0">レシートの文字認識はこの端末の中で行い、画像は保存も送信もしません。バージョン ${APP_VERSION}</p>
      <button type="button" class="btn" data-act="update-app" style="width:100%;margin-top:12px">最新版に更新する</button>
      <p class="note" style="margin:8px 0 0">記録は消えません。新しい版が反映されないときに押してください。</p>
    </div>`;
}
/* ===== 現資産（預貯金・株式・暗号資産。収入・支出とは別に、いまの資産を持つ） ===== */
const ACCT_PRESETS = ['三井住友銀行','PayPay銀行','楽天銀行','ゆうちょ銀行','三菱UFJ銀行','みずほ銀行','現金（手元）'];
const POINT_PRESETS = ['楽天ポイント','Vポイント','PayPayポイント','dポイント','WAONポイント'];   // 1ポイント＝1円として評価
const OWNERS = {h:'夫', w:'妻', j:'共有', '':'未設定'};
const KINDS = {cash:'預貯金・現金', stock:'株式', btc:'ビットコイン', eth:'イーサリアム', point:'ポイント'};
const COINS = {btc:{name:'ビットコイン', sym:'BTC', bf:'BTC_JPY', cg:'bitcoin'}, eth:{name:'イーサリアム', sym:'ETH', bf:'ETH_JPY', cg:'ethereum'}};
const KIND_GROUPS = [['cash','預貯金・現金'], ['stock','株式'], ['crypto','暗号資産'], ['point','ポイント']];
const groupOf = k => COINS[k] ? 'crypto' : k;
const PRICE_TTL = 5 * 60 * 1000;
/* 1つの資産のいまの評価額（円）。預貯金は残高、株式は株数×株価、暗号資産は保有数量×取得済みの価格 */
const acctValue = a => a.kind === 'stock' ? Math.round((a.qty || 0) * (a.price || 0))
  : COINS[a.kind] ? (S.prices[a.kind] ? Math.round((a.qty || 0) * S.prices[a.kind].p) : 0) : a.bal;
const fmtQty = (q, dec) => Number(q).toLocaleString('ja-JP', {maximumFractionDigits: dec});
const fmtMD = u => { const d = new Date(u); return `${d.getMonth() + 1}/${d.getDate()}`; };
const fmtMDHM = u => { const d = new Date(u); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${pad(d.getMinutes())}`; };
/* 数字入力の整形（全角→半角、小数点は1つ、小数の桁数を制限） */
function numClean(v, dec) {
  let s = normDigits(String(v)).replace(/[^\d.]/g, '');
  const i = s.indexOf('.');
  if (i >= 0) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, '').slice(0, dec);
  if (dec === 0) s = s.replace(/\./g, '');
  return s.replace(/^0+(?=\d)/, '').slice(0, 14);
}

/* --- 暗号資産の価格（円）。取得元は順に試す。取れなければ前回の価格、手入力も可 --- */
let priceBusy = false, priceNote = '';
const lastPriceTry = {};   // 通貨ごとの最後に取得を試した時刻（失敗が続いても1分に1回まで）
async function fetchJson(url, ms = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, {signal: ctl.signal, cache: 'no-store'});
    if (!res.ok) throw new Error('http ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}
const PRICE_SOURCES = [
  async c => Number((await fetchJson('https://api.bitflyer.com/v1/ticker?product_code=' + COINS[c].bf)).ltp),
  async c => Number((await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=' + COINS[c].cg + '&vs_currencies=jpy'))[COINS[c].cg].jpy)
];
async function fetchPrice(c) {
  for (const src of PRICE_SOURCES) {
    try { const p = await src(c); if (Number.isFinite(p) && p > 0) return p; } catch (e) {}
  }
  return null;
}
async function refreshPrices(force) {
  const kinds = [...new Set(S.accts.map(a => a.kind).filter(k => COINS[k]))];
  if (!kinds.length || priceBusy) return;
  const now = Date.now();
  const need = kinds.filter(k => force || ((!S.prices[k] || S.prices[k].manual || now - S.prices[k].t > PRICE_TTL) && now - (lastPriceTry[k] || 0) >= 60000));
  if (!need.length) return;
  need.forEach(k => { lastPriceTry[k] = now; });
  if (navigator.onLine === false) {
    priceNote = 'オフラインのため価格を更新できません。前回の価格（または手入力した価格）で表示しています。';
    if (ui.tab === 'acct') renderAcct();
    return;
  }
  priceBusy = true; priceNote = '';
  if (ui.tab === 'acct') renderAcct();
  let ok = 0;
  await Promise.all(need.map(async k => { const p = await fetchPrice(k); if (p) { S.prices[k] = {p, t: Date.now(), manual: false}; ok++; } }));
  priceBusy = false;
  priceNote = ok === need.length ? '' : '一部の価格を取得できませんでした。前回の価格（または手入力した価格）で表示しています。資産の編集画面で価格を手入力することもできます。';
  if (ok) saveMeta();
  if (ui.tab === 'acct') renderAcct();
}

function acctDetail(a) {
  const parts = [];
  if (a.kind === 'stock') parts.push(`${fmtQty(a.qty, 4)}株 × ${yen(a.price)}`);
  else if (a.kind === 'point') parts.push(`${fmtQty(a.bal, 0)} pt`);
  else if (COINS[a.kind]) {
    const c = COINS[a.kind], p = S.prices[a.kind];
    parts.push(`${fmtQty(a.qty, 8)} ${c.sym}` + (p ? ` × ${yen(p.p)}` : '（価格未取得）'));
  }
  if (a.note) parts.push(a.note);
  if (a.u) parts.push(`${fmtMD(a.u)}更新`);
  return parts.join(' · ');
}

function renderAcct() {
  const box = $('#acct');
  if (!store.loaded) { box.innerHTML = '<div class="card"><p class="muted" style="margin:0">読み込み中…</p></div>'; return; }
  if (!S.accts.length) {
    box.innerHTML = `
      <div class="welcome card">
        <h2>現資産を登録しましょう</h2>
        <p>預貯金・現金、株式、ビットコイン・イーサリアム、ポイントを、夫・妻の持ち主ごとに登録すると、どこにいくらあるかを一覧で見られます。収入・支出の記録とは別に保存されます。</p>
        <div class="chips">${ACCT_PRESETS.slice(0, 5).map(n => `<button type="button" class="chip" data-act="acctpreset" data-name="${esc(n)}">${esc(n)}</button>`).join('')}</div>
        <button type="button" class="btn primary" data-act="addacct">資産を追加する</button>
      </div>`;
    return;
  }
  if (ui.acctOwner !== 'all' && !S.accts.some(a => a.owner === ui.acctOwner)) ui.acctOwner = 'all';
  const f = ui.acctOwner;
  const base = S.accts.filter(a => f === 'all' || a.owner === f);
  const total = base.reduce((sum, a) => sum + acctValue(a), 0);
  const ownerKeys = ['h', 'w', 'j', ''].filter(k => k === 'h' || k === 'w' || S.accts.some(a => a.owner === k));
  const sumBy = pred => S.accts.filter(pred).reduce((sum, a) => sum + acctValue(a), 0);
  const segBtn = (v, label) => `<button type="button" data-act="acctowner" data-v="${v}" aria-pressed="${f === v}">${label}</button>`;
  const seg = `<div class="seg" id="acctOwnerSeg" role="group" aria-label="持ち主で絞り込み" style="margin-bottom:12px">${segBtn('all', 'すべて')}${ownerKeys.map(k => segBtn(k, OWNERS[k])).join('')}</div>`;
  const ownerSplit = f === 'all'
    ? `<div class="split" style="grid-template-columns:repeat(${ownerKeys.length},minmax(0,1fr))">${ownerKeys.map(k => `<div><span class="lbl">${OWNERS[k]}</span><b>${yen(sumBy(a => a.owner === k))}</b></div>`).join('')}</div>`
    : '';
  const kindLines = KIND_GROUPS.filter(([gk]) => base.some(a => groupOf(a.kind) === gk))
    .map(([gk, gn]) => `<dt>${gn}</dt><dd>${yen(base.filter(a => groupOf(a.kind) === gk).reduce((sum, a) => sum + acctValue(a), 0))}</dd>`).join('');
  const coinKinds = Object.keys(COINS).filter(k => S.accts.some(a => a.kind === k));
  const latestPrice = Math.max(0, ...coinKinds.map(k => S.prices[k] ? S.prices[k].t : 0));
  const priceBox = coinKinds.length ? `
      <div class="meter-cap" style="margin-top:12px">${priceBusy ? '価格を取得中…' : coinKinds.map(k => `${COINS[k].sym} ${S.prices[k] ? yen(S.prices[k].p) + (S.prices[k].manual ? '（手入力）' : '') : '未取得'}`).join(' ／ ') + (latestPrice ? `（${fmtMDHM(latestPrice)}時点）` : '')}</div>
      ${priceNote ? `<div class="meter-cap" style="color:var(--warn)">${esc(priceNote)}</div>` : ''}
      <div style="margin-top:8px"><button type="button" class="chip small" data-act="acct-refresh"${priceBusy ? ' disabled' : ''}>価格を更新</button></div>` : '';
  const groups = KIND_GROUPS.map(([gk, gn]) => {
    const items = base.filter(a => groupOf(a.kind) === gk).sort((a, b) => acctValue(b) - acctValue(a) || a.name.localeCompare(b.name, 'ja'));
    if (!items.length) return '';
    const sub = items.reduce((sum, a) => sum + acctValue(a), 0);
    const rows = items.map(a => {
      const v = acctValue(a), pct = total > 0 ? Math.round(v / total * 100) : 0;
      return `<button type="button" class="row" data-act="editacct" data-id="${esc(a.id)}">
      <i class="dot" style="background:${esc(a.color)}"></i>
      <span class="main"><span class="cat">${esc(a.name)}</span><span class="sub" style="white-space:normal"><span class="otag">${OWNERS[a.owner]}</span>${esc(acctDetail(a))}</span></span>
      <span class="amt">${yen(v)}<small style="display:block;text-align:right;color:var(--muted);font-size:12px">${pct}%</small></span>
      <span class="rbar" style="grid-column:1 / -1;display:block;margin-top:0"><i style="width:${v > 0 ? Math.max(pct, 2) : 0}%;background:${esc(a.color)}"></i></span>
    </button>`;
    }).join('');
    return `<div class="day"><div class="dayhead"><span>${gn}</span><span class="num">${yen(sub)}</span></div><div class="rows">${rows}</div></div>`;
  }).join('');
  box.innerHTML = `
    ${seg}
    <div class="card">
      <div class="lbl">${f === 'all' ? '現資産の合計' : OWNERS[f] + 'の現資産'}</div>
      <div class="big">${yen(total)}</div>
      ${ownerSplit}
      ${kindLines ? `<dl class="kv" style="margin-top:12px">${kindLines}</dl>` : ''}
      ${priceBox}
    </div>
    ${groups}
    <div style="margin-top:14px"><button type="button" class="btn" data-act="addacct" style="width:100%">＋ 資産を追加</button></div>
    <p class="note">残高や数量が変わったら、その資産をタップして更新してください。株式の株価は手入力です。ビットコイン・イーサリアムの価格は自動で取得します（円換算）。ポイントは1ポイント＝1円として合計に含めます。ここの金額は収入・支出の記録には影響しません。</p>`;
}

function openAcctSheet(item, preset) {
  const isNew = !item;
  const nameList = () => [...new Set([...ACCT_PRESETS, ...S.acctNames])];
  const d = item ? {...item} : {id:'a' + uid()};
  const st = item
    ? {kind:item.kind, owner:item.owner, nameSel:'', name:item.name, bal:(item.kind === 'cash' || item.kind === 'point') ? String(item.bal) : '', qty:item.qty ? String(item.qty) : '',
       price:item.kind === 'stock' ? (item.price ? String(item.price) : '') : (COINS[item.kind] && S.prices[item.kind] ? String(S.prices[item.kind].p) : ''), note:item.note, color:item.color}
    : {kind:'cash', owner:(ui.acctOwner === 'h' || ui.acctOwner === 'w' || ui.acctOwner === 'j') ? ui.acctOwner : '', nameSel:'', name:preset || '', bal:'', qty:'', price:'', note:'', color:PAL[S.accts.length % PAL.length]};
  const isNamed = k => k === 'cash' || k === 'point';       // 一覧から名前を選ぶ種類（口座名・ポイント名）
  const namesFor = k => k === 'point' ? [...new Set([...POINT_PRESETS, ...S.pointNames])] : nameList();
  if (isNamed(st.kind) && st.name) st.nameSel = namesFor(st.kind).includes(st.name) ? st.name : '+';
  let confirming = false;
  const sheet = openSheet(`
    <div class="sheet-head"><h2>資産を${isNew ? '追加' : '編集'}</h2>${closeBtn('aClose')}</div>
    <div id="aTop"></div>
    <div id="aDyn"></div>
    <label class="field"><span class="flabel">メモ（任意）</span><input id="aNote" type="text" maxlength="30" autocomplete="off" placeholder="例：普通預金、NISA、取引所名"></label>
    <div class="field"><span class="flabel">色</span><div class="swatches" id="aSw"></div></div>
    ${!isNew && d.u ? `<p class="note" style="margin-left:0">最終更新：${esc(new Date(d.u).toLocaleDateString('ja-JP'))}</p>` : ''}
    <div class="sheet-foot"><p class="err" id="aErr" role="alert" style="min-height:0;margin:0 0 6px"></p><div id="aActions"></div></div>`, `資産を${isNew ? '追加' : '編集'}`);
  const $a = id => sheet.querySelector(id);
  const setErr = m => { $a('#aErr').textContent = m || ''; };
  $a('#aNote').value = st.note;

  const paintTop = () => {
    const chip = (attr, v, label, on) => `<button type="button" class="chip small" ${attr}="${v}" aria-pressed="${on}">${label}</button>`;
    $a('#aTop').innerHTML = `
      <div class="field" style="margin-top:0"><span class="flabel">種類</span>${isNew
        ? `<div class="chips" id="aKinds">${Object.entries(KINDS).map(([k, n]) => chip('data-k', k, n, st.kind === k)).join('')}</div>`
        : `<div style="font-weight:600">${KINDS[st.kind]}</div>`}</div>
      <div class="field"><span class="flabel">持ち主（夫・妻）</span><div class="chips" id="aOwners">${['h', 'w', 'j'].map(o => chip('data-o', o, OWNERS[o], st.owner === o)).join('')}</div></div>`;
  };
  const valueNow = () => {
    if (isNamed(st.kind)) return st.bal ? Number(st.bal) : null;
    const q = parseFloat(st.qty), p = parseFloat(st.price);
    return Number.isFinite(q) && Number.isFinite(p) ? Math.round(q * p) : null;
  };
  const paintPrev = () => {
    const el = $a('#aPrev'); if (!el) return;
    const v = valueNow();
    el.textContent = v === null ? '' : (st.kind === 'point' ? `＝ ${v.toLocaleString('ja-JP')} pt（1pt＝1円で評価）` : '＝ ' + yen(v));
  };
  const paintDyn = () => {
    const k = st.kind, c = COINS[k];
    let h = '';
    if (isNamed(k)) {
      const pt = k === 'point';
      h = `<div class="field"><span class="flabel">${pt ? 'ポイント名' : '口座名'}（一覧にないときは「＋ その他」で自由入力）</span><div class="chips" id="aNames">${namesFor(k).map(n => `<button type="button" class="chip small" data-n="${esc(n)}" aria-pressed="${st.nameSel === n}">${esc(n)}</button>`).join('')}<button type="button" class="chip small" data-n="+" aria-pressed="${st.nameSel === '+'}">＋ その他（自由入力）</button></div></div>
        ${st.nameSel === '+' ? `<label class="field"><span class="flabel">${pt ? 'ポイント名' : '口座名'}を入力</span><input id="aName" type="text" maxlength="20" autocomplete="off" placeholder="${pt ? '例：Pontaポイント、JALマイル' : '例：地方銀行、会社の財形'}" value="${esc(st.name)}"></label>` : ''}
        <label class="field"><span class="flabel">${pt ? '現在のポイント残高' : '現在の残高'}</span><span class="amount"><b>${pt ? 'pt' : '¥'}</b><input id="aBal" type="text" inputmode="numeric" autocomplete="off" placeholder="0" value="${esc(st.bal)}" aria-label="${pt ? '現在のポイント残高' : '現在の残高'}"></span></label>`;
    } else if (k === 'stock') {
      h = `<label class="field"><span class="flabel">銘柄名</span><input id="aName" type="text" maxlength="20" autocomplete="off" placeholder="例：トヨタ自動車、S&P500のインデックス" value="${esc(st.name)}"></label>
        <label class="field"><span class="flabel">保有株数</span><input id="aQty" type="text" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(st.qty)}"></label>
        <label class="field"><span class="flabel">1株の価格（円・手入力）</span><input id="aPrice" type="text" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(st.price)}"></label>`;
    } else {
      h = `<label class="field"><span class="flabel">保有数量（${c.sym}）</span><input id="aQty" type="text" inputmode="decimal" autocomplete="off" placeholder="例：0.05" value="${esc(st.qty)}"></label>
        <label class="field"><span class="flabel">1 ${c.sym} の価格（円）</span><input id="aPrice" type="text" inputmode="decimal" autocomplete="off" placeholder="自動で取得します" value="${esc(st.price)}"></label>
        <p class="note" style="margin:6px 4px 0">価格は自動で取得します。取得できないときだけ手入力してください。評価額は 数量 × 価格 で計算します。</p>`;
    }
    $a('#aDyn').innerHTML = h + `<p class="note" id="aPrev" style="margin:8px 4px 0;font-weight:600"></p>`;
    paintPrev();
  };
  const paintSw = () => { $a('#aSw').innerHTML = swatchesHtml(st.color); };
  const paintActions = () => {
    const box = $a('#aActions');
    if (confirming) {
      box.innerHTML = `<div class="confirm"><p><b>「${esc(d.name)}」を削除しますか？</b></p><div class="actions"><button type="button" class="btn" id="aNo">やめる</button><button type="button" class="btn danger solid primary" id="aYes">削除する</button></div></div>`;
      box.querySelector('#aNo').onclick = () => { confirming = false; paintActions(); };
      box.querySelector('#aYes').onclick = () => { S.accts = S.accts.filter(a => a.id !== d.id); S.idels[d.id] = {k:'acct', t:Date.now()}; saveMeta(); scheduleSync(); closeSheet(); toast('削除しました'); render(); };
    } else {
      box.innerHTML = `<div class="actions">${isNew ? '' : '<button type="button" class="btn danger" id="aDel">削除</button>'}<button type="button" class="btn primary" id="aSave">保存</button></div>`;
      const del = box.querySelector('#aDel');
      if (del) del.onclick = () => { confirming = true; paintActions(); };
      box.querySelector('#aSave').onclick = save;
    }
  };
  function save() {
    const k = st.kind;
    if (!st.owner) { setErr('持ち主（夫・妻・共有）を選んでください。'); return; }
    let name;
    if (isNamed(k)) {
      name = (st.nameSel === '+' ? st.name : st.nameSel).trim();
      if (!name) { setErr(`${k === 'point' ? 'ポイント名' : '口座名'}を選ぶか、「＋ その他」で入力してください。`); return; }
    } else if (k === 'stock') {
      name = st.name.trim();
      if (!name) { setErr('銘柄名を入力してください。'); return; }
    } else name = COINS[k].name;
    const out = {id:d.id, kind:k, owner:st.owner, name:name.slice(0, 20), bal:0, qty:0, price:0, note:$a('#aNote').value.trim().slice(0, 30), color:st.color, u:item ? item.u : 0};
    if (isNamed(k)) {
      if (!st.bal) { setErr(k === 'point' ? 'ポイント残高を入力してください（0でも入力できます）。' : '残高を入力してください（0円でも入力できます）。'); return; }
      out.bal = Number(st.bal);
    } else {
      const q = parseFloat(st.qty);
      if (st.qty === '' || !Number.isFinite(q)) { setErr(k === 'stock' ? '保有株数を入力してください。' : '保有数量を入力してください。'); return; }
      out.qty = Math.round(q * 1e8) / 1e8;
      const p = parseFloat(st.price);
      if (k === 'stock') {
        if (st.price === '' || !Number.isFinite(p)) { setErr('1株の価格を入力してください（円）。'); return; }
        out.price = p;
      } else if (st.price !== '' && Number.isFinite(p) && p > 0 && (!S.prices[k] || S.prices[k].p !== p)) {
        S.prices[k] = {p, t: Date.now(), manual: true};   // 取得できないときの手入力
      }
    }
    out.m = Date.now();
    const changed = isNew || out.bal !== item.bal || out.qty !== item.qty || out.price !== item.price;
    if (changed) out.u = Date.now();
    if (isNamed(k) && st.nameSel === '+' && !namesFor(k).includes(out.name)) {                                              // 次回から一覧に出る
      if (k === 'point') S.pointNames = [...S.pointNames, out.name].slice(-40); else S.acctNames = [...S.acctNames, out.name].slice(-40);
    }
    S.accts = isNew ? [...S.accts, out] : S.accts.map(a => a.id === out.id ? out : a);
    saveMeta(); scheduleSync(); closeSheet(); toast('保存しました'); render();
  }
  sheet.onclick = e => {
    const t = e.target;
    const kb = t.closest('#aKinds button[data-k]');
    if (kb) {
      st.kind = kb.dataset.k; st.qty = ''; st.bal = ''; st.nameSel = ''; st.name = '';
      st.price = COINS[st.kind] && S.prices[st.kind] ? String(S.prices[st.kind].p) : '';
      paintTop(); paintDyn(); setErr(''); return;
    }
    const ob = t.closest('#aOwners button[data-o]');
    if (ob) { st.owner = ob.dataset.o; paintTop(); setErr(''); return; }
    const nb = t.closest('#aNames button[data-n]');
    if (nb) {
      st.nameSel = nb.dataset.n;
      if (st.nameSel === '+') { if (namesFor(st.kind).includes(st.name)) st.name = ''; } else st.name = st.nameSel;
      paintDyn(); setErr('');
      if (st.nameSel === '+') { const n = $a('#aName'); if (n) n.focus(); } else { const b = $a('#aBal'); if (b) b.focus(); }
      return;
    }
    const cb = t.closest('#aSw button[data-c]');
    if (cb) { st.color = cb.dataset.c; paintSw(); }
  };
  sheet.oninput = e => {
    const t = e.target;
    setErr('');
    if (t.id === 'aName') st.name = t.value;
    else if (t.id === 'aBal') { st.bal = numClean(t.value, 0).slice(0, 12); if (t.value !== st.bal) t.value = st.bal; paintPrev(); }
    else if (t.id === 'aQty') { st.qty = numClean(t.value, st.kind === 'stock' ? 4 : 8); if (t.value !== st.qty) t.value = st.qty; paintPrev(); }
    else if (t.id === 'aPrice') { st.price = numClean(t.value, 2); if (t.value !== st.price) t.value = st.price; paintPrev(); }
  };
  $a('#aClose').onclick = closeSheet;
  paintTop(); paintDyn(); paintSw(); paintActions();
  if (isNew && isNamed(st.kind) && !st.nameSel) setTimeout(() => { try { $a('#aOwners button').focus(); } catch (e) {} }, 60);
}

/* ===== エントリー ===== */
const fmtYMD = s => { const [y, m, d] = s.split('-').map(Number); return y === new Date().getFullYear() ? `${m}/${d}` : `${y}/${m}/${d}`; };
const daysBetween = (a, b) => Math.round((Date.UTC(...b.split('-').map((n, i) => i === 1 ? n - 1 : +n)) - Date.UTC(...a.split('-').map((n, i) => i === 1 ? n - 1 : +n))) / DAY);
/* 未達成で、実行日か期限の日が来た（今日以前）エントリー */
const entryAlert = (e, today) => !e.done && ((e.run && e.run <= today) || (e.due && e.due <= today));
function updateEntryBadge() {
  const btn = document.querySelector('.tab[data-tab="entry"]'); if (!btn) return;
  const n = S.entries.filter(e => entryAlert(e, todayStr())).length;
  let b = btn.querySelector('.tbadge');
  if (!n) { if (b) b.remove(); btn.removeAttribute('data-alert'); return; }
  if (!b) { b = document.createElement('i'); b.className = 'tbadge'; btn.appendChild(b); }
  b.textContent = n > 9 ? '9+' : String(n);
  btn.dataset.alert = n;
  btn.setAttribute('aria-label', `エントリー（日付になった未達成が${n}件）`);
}
function toggleEntry(id) {
  const e = S.entries.find(x => x.id === id); if (!e) return;
  const was = e.done;
  e.done = was ? '' : todayStr(); e.u = Date.now();
  saveMeta(); scheduleSync(); renderEntries(); updateEntryBadge();
  toast(was ? '未達成に戻しました' : `達成しました${e.pt ? `（${e.pt.toLocaleString('ja-JP')} pt）` : ''}`, {action:'元に戻す', fn: () => { e.done = was; e.u = Date.now(); saveMeta(); scheduleSync(); renderEntries(); updateEntryBadge(); }});
}
function renderEntries() {
  const box = $('#entry');
  if (!store.loaded) { box.innerHTML = '<div class="card"><p class="muted" style="margin:0">読み込み中…</p></div>'; return; }
  if (!S.entries.length) {
    box.innerHTML = `<div class="welcome card"><h2>エントリーを登録しましょう</h2><p>キャンペーンなどの「実行日・期限・内容・付与pt」を登録し、済んだものにチェックを入れると達成日が自動で入り、行がグレーになります。右上の「＋」からも追加できます。</p><button type="button" class="btn primary" data-act="addentry">エントリーを追加する</button></div>`;
    return;
  }
  const today = todayStr();
  const key = v => v || '9999-99-99';
  const cmp = (a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
  const open = S.entries.filter(e => !e.done).sort((a, b) => cmp(a.due, b.due) || cmp(a.run, b.run) || a.u - b.u);
  const done = S.entries.filter(e => e.done).sort((a, b) => cmp(b.done, a.done));
  const sum = l => l.reduce((s, e) => s + e.pt, 0);
  const pt = n => n.toLocaleString('ja-JP');
  const row = e => {
    const runHit = !e.done && e.run && e.run <= today, dueHit = !e.done && e.due && e.due <= today;
    const cell = (cls, txt) => `<span class="ec ${cls}">${txt ? esc(txt) : ''}</span>`;
    return `<div class="etr${e.done ? ' done' : ''}" role="row" data-act="editentry" data-id="${esc(e.id)}">
      <span class="ec c-chk"><button type="button" class="echk" data-act="toggleentry" data-id="${esc(e.id)}" aria-pressed="${!!e.done}" aria-label="${esc(e.title)}を${e.done ? '未達成に戻す' : '達成にする'}"><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span></button></span>
      ${cell('c-run' + (runHit ? ' hit' : ''), e.run ? fmtYMD(e.run) : '')}
      ${cell('c-due' + (dueHit ? ' hit' : ''), e.due ? fmtYMD(e.due) : '')}
      <span class="ec c-title${runHit || dueHit ? ' alert' : ''}"><button type="button" class="elink" data-act="editentry" data-id="${esc(e.id)}">${esc(e.title)}</button></span>
      ${cell('c-memo', e.memo)}
      ${cell('c-pt', e.pt ? '+' + pt(e.pt) + ' pt' : '')}
      ${cell('c-done', e.done ? fmtYMD(e.done) : '')}
    </div>`;
  };
  box.innerHTML = `
    <div class="esum"><span>未達成 <b>${open.length}件</b>・<b>${pt(sum(open))} pt</b></span><span>達成済み <b>${done.length}件</b>・<b>${pt(sum(done))} pt</b></span></div>
    <div class="escroll" role="table" aria-label="エントリー一覧">
      <div class="etable">
        <div class="etr ehead" role="row"><span class="ec c-chk"><span class="sr">達成</span></span><span class="ec c-run">実行日</span><span class="ec c-due">期限</span><span class="ec c-title">内容</span><span class="ec c-memo">詳細</span><span class="ec c-pt">付与pt</span><span class="ec c-done">達成日</span></div>
        ${open.map(row).join('')}${done.map(row).join('')}
      </div>
    </div>
    <p class="note">左のチェックで達成日が自動で入り、行がグレーになります（もう一度押すと戻ります）。行をタップすると編集できます。表は左右にスクロールできます。右上の「＋」で追加します。</p>`;
}
function openEntrySheet(item) {
  const isNew = !item;
  const st = item ? {title:item.title, memo:item.memo, run:item.run, due:item.due, pt:item.pt ? String(item.pt) : ''} : {title:'', memo:'', run:'', due:'', pt:''};
  let confirming = false;
  const sheet = openSheet(`
    <div class="sheet-head"><h2>エントリーを${isNew ? '追加' : '編集'}</h2>${closeBtn('eClose')}</div>
    <label class="field" style="margin-top:0"><span class="flabel">内容</span><input id="eTitle" type="text" maxlength="40" autocomplete="off" placeholder="例：ポイント2倍キャンペーン"></label>
    <label class="field"><span class="flabel">詳細（任意）</span><textarea id="eMemo" maxlength="200" rows="3" style="min-height:84px;font-family:inherit;font-size:15px" placeholder="例：条件、対象店舗、URLなど"></textarea></label>
    <label class="field"><span class="flabel">実行日（任意）</span><input id="eRun" type="date"></label>
    <label class="field"><span class="flabel">期限（任意）</span><input id="eDue" type="date"></label>
    <label class="field"><span class="flabel">付与pt（任意）</span><span class="amount"><b>pt</b><input id="ePt" type="text" inputmode="numeric" autocomplete="off" placeholder="0" aria-label="付与pt"></span></label>
    ${!isNew && item.done ? `<p class="note" style="margin-left:0">達成日：${esc(fmtYMD(item.done))}（一覧のチェックを外すと未達成に戻ります）</p>` : ''}
    <div class="sheet-foot"><p class="err" id="eErr" role="alert" style="min-height:0;margin:0 0 6px"></p><div id="eActions"></div></div>`, `エントリーを${isNew ? '追加' : '編集'}`);
  const $e = id => sheet.querySelector(id);
  const setErr = m => { $e('#eErr').textContent = m || ''; };
  $e('#eTitle').value = st.title; $e('#eMemo').value = st.memo; $e('#eRun').value = st.run; $e('#eDue').value = st.due; $e('#ePt').value = st.pt;
  function save() {
    const title = $e('#eTitle').value.trim();
    if (!title) { setErr('内容を入力してください。'); return; }
    const out = cleanEntry({id: isNew ? 'e' + uid() : item.id, title, memo: $e('#eMemo').value.trim(), run: $e('#eRun').value, due: $e('#eDue').value, pt: $e('#ePt').value, done: isNew ? '' : item.done, u: Date.now()});
    S.entries = isNew ? [...S.entries, out] : S.entries.map(x => x.id === out.id ? out : x);
    saveMeta(); scheduleSync(); closeSheet(); toast('保存しました'); render();
  }
  const paintActions = () => {
    const box = $e('#eActions');
    if (confirming) {
      box.innerHTML = `<div class="confirm"><p><b>「${esc(item.title)}」を削除しますか？</b></p><div class="actions"><button type="button" class="btn" id="eNo">やめる</button><button type="button" class="btn danger solid primary" id="eYes">削除する</button></div></div>`;
      box.querySelector('#eNo').onclick = () => { confirming = false; paintActions(); };
      box.querySelector('#eYes').onclick = () => { S.entries = S.entries.filter(x => x.id !== item.id); S.idels[item.id] = {k:'entry', t:Date.now()}; saveMeta(); scheduleSync(); closeSheet(); toast('削除しました'); render(); };
    } else {
      box.innerHTML = `<div class="actions">${isNew ? '' : '<button type="button" class="btn danger" id="eDel">削除</button>'}<button type="button" class="btn primary" id="eSave">保存</button></div>`;
      const del = box.querySelector('#eDel');
      if (del) del.onclick = () => { confirming = true; paintActions(); };
      box.querySelector('#eSave').onclick = save;
    }
  };
  sheet.oninput = e => {
    setErr('');
    if (e.target.id === 'ePt') { const v = numClean(e.target.value, 0).slice(0, 9); if (e.target.value !== v) e.target.value = v; }
  };
  $e('#eClose').onclick = closeSheet;
  paintActions();
  if (isNew) setTimeout(() => { try { $e('#eTitle').focus(); } catch (err) {} }, 60);
}

/* ===== 入力シート ===== */
function defaultDate() { const t = todayStr(); return t.slice(0,7) === ui.month ? t : ui.month + '-01'; }
const payChips = (selected, orig) => {
  const list = S.pays.slice();
  if (orig && selected && !list.some(p => p.id === selected)) list.push({id:selected, name:'その他'});
  return list.map(p => `<button type="button" class="chip" data-p="${esc(p.id)}" aria-pressed="${p.id === selected}">${esc(p.name)}</button>`).join('');
};

function openTxSheet(orig) {
  const d = orig ? {...orig} : {d:defaultDate(), t:ui.lastType, c:null, a:0, p:S.pays.some(p => p.id === ui.lastPay) ? ui.lastPay : (S.pays[0] ? S.pays[0].id : ''), n:''};
  let confirming = false;
  const sheet = openSheet(`
    <div class="sheet-head"><h2 id="fTitle"></h2>${closeBtn('fClose')}</div>
    <div class="seg" id="fType" role="group" aria-label="種類">
      <button type="button" class="e" data-t="e">支出</button>
      <button type="button" class="i" data-t="i">収入</button>
    </div>
    <label class="field"><span class="flabel">金額</span><span class="amount"><b>¥</b><input id="fAmt" type="text" inputmode="numeric" autocomplete="off" placeholder="0" aria-label="金額"></span></label>
    <div class="field"><span class="flabel">カテゴリ</span><div class="chips" id="fCats"></div></div>
    <label class="field"><span class="flabel">日付</span><input id="fDate" type="date"></label>
    <div class="field"><span class="flabel">支払方法</span><div class="chips" id="fPays"></div></div>
    <label class="field"><span class="flabel">メモ</span><input id="fMemo" type="text" maxlength="80" placeholder="例：スーパー" autocomplete="off"></label>
    <div id="fRecBox"></div>
    <p class="err" id="fErr" role="alert"></p>
    <div class="sheet-foot" id="fActions"></div>`, orig ? '記録を編集' : '記録を入力');

  const fAmt = sheet.querySelector('#fAmt'), fDate = sheet.querySelector('#fDate'), fMemo = sheet.querySelector('#fMemo'), fErr = sheet.querySelector('#fErr');
  fAmt.value = d.a ? d.a.toLocaleString('ja-JP') : '';
  fDate.value = d.d;
  fMemo.value = d.n || '';
  const err = msg => { fErr.textContent = msg; };
  const paintHead = () => {
    sheet.querySelector('#fTitle').textContent = orig ? '記録を編集' : (d.t === 'e' ? '支出を入力' : '収入を入力');
    sheet.querySelectorAll('#fType button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.t === d.t)));
  };
  const paintCats = () => {
    const list = S.cats.filter(c => c.type === d.t);
    if (!list.some(c => c.id === d.c) && !(orig && orig.c === d.c && orig.t === d.t)) d.c = list[0] ? list[0].id : null;
    const items = list.slice();
    if (orig && orig.t === d.t && d.c && !items.some(c => c.id === d.c)) items.push(catById(d.c));
    sheet.querySelector('#fCats').innerHTML = items.length
      ? items.map(c => `<button type="button" class="chip" data-c="${esc(c.id)}" aria-pressed="${c.id === d.c}"><i class="dot" style="background:${c.color}"></i>${esc(c.name)}</button>`).join('')
      : '<span class="muted">カテゴリがありません。設定から追加してください。</span>';
  };
  const paintPays = () => { sheet.querySelector('#fPays').innerHTML = payChips(d.p, orig); };
  // 「毎月」のチェック（支出のみ）。同じ系列の最新の月でチェックを外すと停止する
  const series = orig && orig.rid ? latestOfSeries(orig.rid) : null;
  const notLatest = !!(series && series.id !== orig.id);
  d.rec = !!(orig && orig.rec);
  const paintRec = () => {
    const box = sheet.querySelector('#fRecBox');
    if (d.t !== 'e') { box.innerHTML = ''; return; }
    let note;
    if (notLatest) note = `この記録より新しい月（${series.d.slice(0, 4)}年${Number(series.d.slice(5, 7))}月）の記録があります。支払いを止めるときは、最新の月の記録で「毎月」のチェックを外してください。`;
    else if (orig && orig.rid && !orig.rec) note = '毎月の記録は停止中です。チェックを入れて保存すると、再開します。';
    else if (orig && orig.rec) note = '支払いが終わったら、チェックを外して保存してください。これ以降は自動で記録されません（記録済みの月は残ります）。';
    else note = '毎月の同じ日に、同じ金額・カテゴリで自動で記録します。支払いが終わったら、いちばん新しい月の記録でチェックを外してください。';
    box.innerHTML = `<label class="opt" style="margin-top:14px"><input type="checkbox" id="fRec" ${d.rec ? 'checked' : ''} ${notLatest ? 'disabled' : ''}>毎月支払う</label><p class="note" style="margin:0 4px">${esc(note)}</p>`;
  };
  const paintActions = () => {
    const box = sheet.querySelector('#fActions');
    if (confirming) {
      box.innerHTML = `<div class="confirm"><p><b>この記録を削除しますか？</b>元に戻せません。${orig && orig.rid ? '<br><span class="muted" style="font-size:13px">毎月の支払いを止めるときは、削除ではなく「毎月」のチェックを外してください。</span>' : ''}</p><div class="actions"><button type="button" class="btn" id="fNo">やめる</button><button type="button" class="btn danger solid primary" id="fYes">削除する</button></div></div>`;
      box.querySelector('#fNo').onclick = () => { confirming = false; paintActions(); };
      box.querySelector('#fYes').onclick = () => { deleteTx(orig); closeSheet(); toast('削除しました'); render(); };
    } else {
      box.innerHTML = `<div class="actions">${orig ? '<button type="button" class="btn danger" id="fDel">削除</button>' : ''}<button type="button" class="btn primary" id="fSave">保存</button></div>`;
      const del = box.querySelector('#fDel');
      if (del) del.onclick = () => { confirming = true; paintActions(); };
      box.querySelector('#fSave').onclick = save;
    }
  };
  const save = () => {
    const raw = normDigits(fAmt.value);
    const neg = /^\s*-/.test(raw);
    const a = parseInt(raw.replace(/\D/g, '') || '0', 10) * (neg ? -1 : 1);
    if (!a) { err('金額を入力してください。'); fAmt.focus(); return; }
    if (!d.c) { err('カテゴリを選んでください。'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fDate.value)) { err('日付を入力してください。'); fDate.focus(); return; }
    const tx = {id: orig ? orig.id : uid(), d: fDate.value, t: d.t, c: d.c, a, p: d.p, n: fMemo.value.trim().slice(0,80), s: orig ? (orig.s || Date.now()) : Date.now()};
    if (orig && orig.mf) tx.mf = orig.mf;
    if (orig && orig.r) tx.r = orig.r;
    if (d.t === 'e' && (d.rec || (orig && orig.rid))) {                // 毎月の系列。チェックが無ければ停止（系列は覚えておく）
      tx.rid = (orig && orig.rid) || uid();
      tx.rd = (orig && orig.rd && orig.d === tx.d) ? orig.rd : Number(tx.d.slice(8));
      if (d.rec) tx.rec = 1;
    }
    saveTx(tx, orig);
    ui.lastPay = d.p; ui.lastType = d.t;
    ui.month = tx.d.slice(0,7);
    closeSheet();
    const gen = tx.rec ? materializeRecurring(true) : null;            // 過去の日付で「毎月」にした場合は、今月までの分を追加
    if (gen && gen.n) toast(`${orig ? '更新しました' : '記録しました'}。毎月の分${gen.n}件も追加しました`, {action: '取り消す', fn: () => undoBatch(gen.batch), ms: 9000});
    else toast(orig ? '更新しました' : '記録しました');
    render();
  };
  const fmtAmt = () => {
    const neg = /^\s*-/.test(fAmt.value);
    const pos = fAmt.selectionStart == null ? fAmt.value.length : fAmt.selectionStart;
    const digitsBefore = normDigits(fAmt.value.slice(0, pos)).replace(/\D/g, '').length;
    const digits = normDigits(fAmt.value).replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 9);
    const out = digits ? (neg ? '-' : '') + Number(digits).toLocaleString('ja-JP') : '';
    fAmt.value = out;
    let count = 0, p = neg ? 1 : 0;
    while (p < out.length && count < digitsBefore) { if (/\d/.test(out[p])) count++; p++; }
    try { fAmt.setSelectionRange(p, p); } catch (e) {}
  };
  let composing = false;
  fAmt.addEventListener('compositionstart', () => { composing = true; });
  fAmt.addEventListener('compositionend', () => { composing = false; fmtAmt(); });
  fAmt.addEventListener('input', () => { if (!composing) { fmtAmt(); err(''); } });
  fAmt.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); fAmt.blur(); } });
  sheet.querySelector('#fClose').onclick = closeSheet;
  sheet.querySelector('#fType').onclick = e => { const b = e.target.closest('button[data-t]'); if (!b) return; d.t = b.dataset.t; d.c = null; paintHead(); paintCats(); paintRec(); err(''); };
  sheet.querySelector('#fRecBox').onchange = e => { if (e.target.id === 'fRec') d.rec = e.target.checked; };
  sheet.querySelector('#fCats').onclick = e => { const b = e.target.closest('button[data-c]'); if (!b) return; d.c = b.dataset.c; paintCats(); err(''); };
  sheet.querySelector('#fPays').onclick = e => { const b = e.target.closest('button[data-p]'); if (!b) return; d.p = b.dataset.p; paintPays(); };
  paintHead(); paintCats(); paintPays(); paintRec(); paintActions();
  if (!orig) setTimeout(() => { try { fAmt.focus(); } catch (e) {} }, 60);
}

/* ===== カテゴリ・支払方法の編集シート ===== */
function swatchesHtml(sel) {
  return PAL.map((c,i) => `<button type="button" class="sw" data-c="${c}" style="background:${c}" aria-label="色${i+1}" aria-pressed="${c === sel}"></button>`).join('');
}
function openNameSheet(kind, item, type) {
  const isCat = kind === 'cat';
  const word = isCat ? 'カテゴリ' : '支払方法';
  const list = isCat ? S.cats : S.pays;
  const isNew = !item;
  const d = item ? {...item} : (isCat ? {id:'c' + uid(), name:'', type, color:PAL[S.cats.length % PAL.length]} : {id:'p' + uid(), name:'', color:PAL[(S.pays.length + 3) % PAL.length]});
  const used = isNew ? 0 : usageCount(d.id, isCat ? 'c' : 'p');
  let confirming = false;
  const sheet = openSheet(`
    <div class="sheet-head"><h2>${word}を${isNew ? '追加' : '編集'}</h2>${closeBtn('nClose')}</div>
    ${isCat ? `<p class="muted" style="margin:0">${d.type === 'e' ? '支出' : '収入'}のカテゴリ</p>` : ''}
    <label class="field"><span class="flabel">名前</span><input id="nName" type="text" maxlength="16" autocomplete="off" placeholder="${isCat ? '例：ペット' : '例：PayPay、楽天カード'}"></label>
    <div class="field"><span class="flabel">色</span><div class="swatches" id="nSw"></div></div>
    ${isNew ? '' : `<p class="note" style="margin-left:0">${used ? `${used}件の記録で使われているため、削除できません。名前と色は変更できます。` : `この${word}を使った記録はありません。`}</p>`}
    <p class="err" id="nErr" role="alert"></p>
    <div class="sheet-foot" id="nActions"></div>`, `${word}を${isNew ? '追加' : '編集'}`);
  const nName = sheet.querySelector('#nName'), nErr = sheet.querySelector('#nErr');
  nName.value = d.name;
  const paintSw = () => { sheet.querySelector('#nSw').innerHTML = swatchesHtml(d.color); };
  const canDelete = !isNew && !used && (isCat || list.length > 1);
  const paintActions = () => {
    const box = sheet.querySelector('#nActions');
    if (confirming) {
      box.innerHTML = `<div class="confirm"><p><b>「${esc(d.name)}」を削除しますか？</b></p><div class="actions"><button type="button" class="btn" id="nNo">やめる</button><button type="button" class="btn danger solid primary" id="nYes">削除する</button></div></div>`;
      box.querySelector('#nNo').onclick = () => { confirming = false; paintActions(); };
      box.querySelector('#nYes').onclick = () => {
        if (isCat) S.cats = S.cats.filter(c => c.id !== d.id); else S.pays = S.pays.filter(p => p.id !== d.id);
        saveMeta(); closeSheet(); toast('削除しました'); render();
      };
    } else {
      box.innerHTML = `<div class="actions">${canDelete ? '<button type="button" class="btn danger" id="nDel">削除</button>' : ''}<button type="button" class="btn primary" id="nSave">保存</button></div>`;
      const del = box.querySelector('#nDel');
      if (del) del.onclick = () => { confirming = true; paintActions(); };
      box.querySelector('#nSave').onclick = () => {
        const name = nName.value.trim();
        if (!name) { nErr.textContent = '名前を入力してください。'; nName.focus(); return; }
        if (list.some(x => x.id !== d.id && x.name === name && (!isCat || x.type === d.type))) { nErr.textContent = `同じ名前の${word}があります。`; return; }
        d.name = name;
        if (isCat) S.cats = isNew ? [...S.cats, d] : S.cats.map(c => c.id === d.id ? d : c);
        else S.pays = isNew ? [...S.pays, d] : S.pays.map(p => p.id === d.id ? d : p);
        saveMeta(); closeSheet(); toast('保存しました'); render();
      };
    }
  };
  sheet.querySelector('#nClose').onclick = closeSheet;
  sheet.querySelector('#nSw').onclick = e => { const b = e.target.closest('button[data-c]'); if (!b) return; d.color = b.dataset.c; paintSw(); };
  nName.addEventListener('input', () => { nErr.textContent = ''; });
  paintSw(); paintActions();
  if (isNew) setTimeout(() => { try { nName.focus(); } catch (e) {} }, 60);
}

/* ===== ファイルの書き出し ===== */
async function shareOrDownload(text, filename, mime) {
  const blob = new Blob([text], {type: mime});
  try {
    const file = new File([blob], filename, {type: mime});
    if (navigator.canShare && navigator.canShare({files: [file]})) {
      try { await navigator.share({files: [file]}); return 'shared'; }
      catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
    }
  } catch (e) {}
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    return 'downloaded';
  } catch (e) { return 'failed'; }
}
function openCopySheet(text, fname) {
  const sheet = openSheet(`
    <div class="sheet-head"><h2>内容をコピー</h2>${closeBtn('vClose')}</div>
    <p class="muted" style="margin-top:0">この環境ではファイルを保存できませんでした。コピーして、メモアプリなどに貼り付けて保存してください（${esc(fname)}）。</p>
    <textarea id="vText" readonly></textarea>
    <div class="sheet-foot"><div class="actions"><button type="button" class="btn primary" id="vCopy">コピー</button></div></div>`, '内容をコピー');
  const ta = sheet.querySelector('#vText');
  ta.value = text.replace(/^﻿/, '');
  sheet.querySelector('#vClose').onclick = closeSheet;
  sheet.querySelector('#vCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(ta.value); toast('コピーしました'); }
    catch (e) { ta.focus(); ta.select(); toast('選択しました。コピーしてください'); }
  };
}
async function deliverFile(text, filename, mime) {
  const r = await shareOrDownload(text, filename, mime);
  if (r === 'failed') openCopySheet(text, filename);
  return r;
}
const csvCell = v => {
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
function csvFor(keys) {
  const rows = [['日付','種別','カテゴリ','金額','支払方法','メモ']];
  const all = keys.flatMap(k => S.months[k] || []).sort((a,b) => a.d < b.d ? -1 : a.d > b.d ? 1 : (a.s||0) - (b.s||0));
  for (const x of all) rows.push([x.d, x.t === 'i' ? '収入' : '支出', catById(x.c).name, x.a, payName(x.p), x.n || '']);
  return '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
}
async function exportCsv(scope) {
  const keys = scope === 'month' ? [ui.month] : Object.keys(S.months);
  if (keys.every(k => !(S.months[k] || []).length)) { toast('書き出す記録がありません'); return; }
  const r = await deliverFile(csvFor(keys), scope === 'month' ? `kakeibo-${ui.month}.csv` : 'kakeibo-all.csv', 'text/csv');
  if (r === 'shared' || r === 'downloaded') toast('書き出しました');
}

/* ===== バックアップ ===== */
async function exportBackup() {
  if (!realCount() && !Object.keys(S.learn).length && !S.accts.length && !S.entries.length) { toast('バックアップする記録がありません'); return; }
  const data = {app:'kakeibo', version:1, exportedAt:new Date().toISOString(), cats:S.cats, pays:S.pays, learn:S.learn, accts:S.accts, acctNames:S.acctNames, pointNames:S.pointNames, entries:S.entries, months:S.months};
  const d = todayStr().replace(/-/g, '');
  const r = await deliverFile(JSON.stringify(data), `kakeibo-backup-${d}.json`, 'application/json');
  if (r === 'shared' || r === 'downloaded') {
    S.lastBackup = Date.now(); saveMeta();
    toast('バックアップを書き出しました');
    render();
  }
}
async function handleBackupFile(file) {
  if (!file) return;
  let obj;
  try { obj = JSON.parse(await file.text()); } catch (e) { toast('バックアップファイルを読み込めません'); return; }
  if (!obj || obj.app !== 'kakeibo' || !obj.months || typeof obj.months !== 'object') { toast('このアプリのバックアップではありません'); return; }
  const months = {}; let n = 0, bad = 0;
  for (const k of Object.keys(obj.months)) {
    if (!/^\d{4}-\d{2}$/.test(k) || !Array.isArray(obj.months[k])) continue;
    const arr = [];
    for (const x of obj.months[k]) { const c = cleanTx(x); if (c && c.d.slice(0,7) === k) arr.push(c); else bad++; }
    if (arr.length) { months[k] = arr; n += arr.length; }
  }
  const ds = Object.values(months).flat().map(x => x.d).sort();
  const range = ds.length ? `${ds[0]} 〜 ${ds[ds.length-1]}` : '記録なし';
  const sheet = openSheet(`
    <div class="sheet-head"><h2>バックアップから復元</h2>${closeBtn('bClose')}</div>
    <div class="card"><dl class="kv"><dt>記録</dt><dd>${n.toLocaleString('ja-JP')}件</dd><dt>期間</dt><dd>${esc(range)}</dd>${Array.isArray(obj.accts) ? `<dt>現資産の項目</dt><dd>${obj.accts.length}件</dd>` : ''}${Array.isArray(obj.entries) ? `<dt>エントリー</dt><dd>${obj.entries.length}件</dd>` : ''}<dt>書き出した日時</dt><dd>${esc(obj.exportedAt ? new Date(obj.exportedAt).toLocaleString('ja-JP') : '不明')}</dd></dl></div>
    ${bad ? `<p class="note">読み取れない記録が${bad}件ありました。それらは復元されません。</p>` : ''}
    <p class="err" style="min-height:0;margin-top:14px"><b>いま入っている記録${realCount().toLocaleString('ja-JP')}件は、すべてこのバックアップの内容に置き換わります。</b></p>
    <div class="sheet-foot"><div class="actions"><button type="button" class="btn" id="bNo">やめる</button><button type="button" class="btn danger solid primary" id="bYes">置き換えて復元</button></div></div>`, 'バックアップから復元');
  sheet.querySelector('#bClose').onclick = sheet.querySelector('#bNo').onclick = closeSheet;
  sheet.querySelector('#bYes').onclick = () => {
    applyLoaded(months, {cats:obj.cats, pays:obj.pays, learn:obj.learn, accts:obj.accts, acctNames:obj.acctNames, pointNames:obj.pointNames, entries:obj.entries, lastBackup:S.lastBackup, dels:S.dels, sync:S.sync});
    saveAll();
    closeSheet(); toast(`${n.toLocaleString('ja-JP')}件を復元しました`); render();
  };
}

/* ===== MoneyForward などのCSV取り込み ===== */
async function handleCsvFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const good = []; const bad = [];
  for (const f of files) {
    try {
      const res = parseMoneyCsv(decodeText(await f.arrayBuffer()));
      if (res.ok) good.push({name:f.name, res}); else bad.push(`${f.name}：${res.error}`);
    } catch (e) { bad.push(`${f.name}：${e.message || '読み込めません'}`); }
  }
  if (!good.length) { openSheet(`<div class="sheet-head"><h2>取り込めませんでした</h2>${closeBtn('xClose')}</div>${bad.map(b => `<p class="err" style="min-height:0">${esc(b)}</p>`).join('')}<div class="sheet-foot"><div class="actions"><button type="button" class="btn primary" id="xOk">閉じる</button></div></div>`, '取り込みエラー'); $('#xClose').onclick = $('#xOk').onclick = closeSheet; return; }
  openImportSheet(good, bad);
}

function openImportSheet(good, bad) {
  const rows = good.flatMap(g => g.res.rows);
  const own = good.every(g => g.res.own);
  const imp = {rows, own, unit:'big', flip:false, exclCalc:true, exclXfer:true, catMap:{}, payMap:{},
    errors: good.reduce((n,g) => n + g.res.errors, 0), zero: good.reduce((n,g) => n + g.res.zero, 0)};
  const effT = r => (!own && imp.flip) ? (r.t === 'e' ? 'i' : 'e') : r.t;
  const srcCat = r => own ? r.big : imp.unit === 'mid' ? (r.mid || r.big) : (effT(r) === 'i' && r.big === '収入' && r.mid ? r.mid : r.big);
  const srcPay = r => r.pay || '';
  const active = () => rows.filter(r => !(!own && ((imp.exclCalc && r.excl) || (imp.exclXfer && r.xfer))));
  const catKey = (t, n) => `${t}|${n}`;

  function groups() {
    const cg = new Map(), pg = new Map();
    for (const r of active()) {
      const t = effT(r), k = catKey(t, srcCat(r));
      const g = cg.get(k) || {t, name:srcCat(r), n:0, sum:0}; g.n++; g.sum += r.a; cg.set(k, g);
      const pk = srcPay(r); const h = pg.get(pk) || {name:pk, n:0}; h.n++; pg.set(pk, h);
    }
    return {cg, pg};
  }
  function ensureMaps() {
    const {cg, pg} = groups();
    for (const [k, g] of cg) if (!(k in imp.catMap)) {
      const ex = S.cats.find(c => c.type === g.t && c.name === g.name);
      imp.catMap[k] = ex ? ex.id : 'new';
    }
    for (const [k, g] of pg) if (!(k in imp.payMap)) {
      const ex = S.pays.find(p => p.name === g.name) || (g.name === '' ? S.pays.find(p => p.id === 'cash') : null);
      imp.payMap[k] = ex ? ex.id : 'new';
    }
    return {cg, pg};
  }
  const catOptions = (t, name, sel) => {
    const exists = S.cats.some(c => c.type === t && c.name === name);
    return (exists ? '' : `<option value="new"${sel === 'new' ? ' selected' : ''}>新しく作る「${esc(name)}」</option>`)
      + S.cats.filter(c => c.type === t).map(c => `<option value="${esc(c.id)}"${sel === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')
      + `<option value="skip"${sel === 'skip' ? ' selected' : ''}>取り込まない</option>`;
  };
  const payOptions = (name, sel) => {
    const exists = S.pays.some(p => p.name === name);
    const label = name || '未設定';
    return (exists ? '' : `<option value="new"${sel === 'new' ? ' selected' : ''}>新しく作る「${esc(label)}」</option>`)
      + S.pays.map(p => `<option value="${esc(p.id)}"${sel === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  };
  const countToImport = () => {
    let n = 0;
    for (const r of active()) { if (imp.catMap[catKey(effT(r), srcCat(r))] !== 'skip') n++; }
    return n;
  };
  const sheet = openSheet('', 'CSVの取り込み');
  sheetLocked = true;
  function paint() {
    const {cg, pg} = ensureMaps();
    const act = active();
    const inc = act.filter(r => effT(r) === 'i'), exp = act.filter(r => effT(r) === 'e');
    const ds = act.map(r => r.d).sort();
    const exclN = rows.length - act.length;
    const mapRows = t => [...cg.entries()].filter(([, g]) => g.t === t).sort((a, b) => b[1].sum - a[1].sum).map(([k, g]) => `
      <div class="map"><div class="src"><span>${esc(g.name)}</span><span>${g.n}件・${yen(g.sum)}</span></div>
      <select data-k="${esc(k)}" aria-label="${esc(g.name)}の分類先">${catOptions(g.t, g.name, imp.catMap[k])}</select></div>`).join('');
    const payRows = [...pg.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, g]) => `
      <div class="map"><div class="src"><span>${esc(g.name || '（未設定）')}</span><span>${g.n}件</span></div>
      <select data-pk="${esc(k)}" aria-label="${esc(g.name || '未設定')}の支払方法">${payOptions(g.name, imp.payMap[k])}</select></div>`).join('');
    const top = sheet.scrollTop;
    sheet.innerHTML = `
      <div class="sheet-head"><h2>CSVの取り込み</h2>${closeBtn('iClose')}</div>
      <div class="card">
        <div class="sumline"><span>${good.length}ファイル</span><span>期間 <b>${ds.length ? ds[0] + ' 〜 ' + ds[ds.length-1] : '-'}</b></span></div>
        <div class="sumline"><span class="inc">収入 <b>${inc.length}件</b></span><span class="exp">支出 <b>${exp.length}件</b></span>${exclN ? `<span>除外 <b>${exclN}件</b></span>` : ''}${imp.errors ? `<span>読めない行 <b>${imp.errors}件</b></span>` : ''}</div>
        ${bad.length ? bad.map(b => `<p class="note" style="margin-left:0;color:var(--expense)">${esc(b)}</p>`).join('') : ''}
      </div>
      ${own ? '<p class="note">このアプリで書き出したCSVです。同じ内容の記録は重複して取り込みません。</p>' : `
      <div class="group-title">取り込み設定</div>
      <label class="opt"><input type="checkbox" data-o="exclCalc" ${imp.exclCalc ? 'checked' : ''}>「計算対象」がオフの行を取り込まない</label>
      <label class="opt"><input type="checkbox" data-o="exclXfer" ${imp.exclXfer ? 'checked' : ''}>振替（口座間の移動）を取り込まない</label>
      <div class="field" style="margin-top:8px"><span class="flabel">分類の単位</span>
        <div class="seg" role="group" aria-label="分類の単位"><button type="button" data-unit="big" aria-pressed="${imp.unit === 'big'}">大項目</button><button type="button" data-unit="mid" aria-pressed="${imp.unit === 'mid'}">中項目</button></div></div>
      <label class="opt"><input type="checkbox" data-o="flip" ${imp.flip ? 'checked' : ''}>収入と支出が逆になっている（金額の符号を反転）</label>`}
      <div class="group-title">支出の分類先（内容を確認して選べます）</div>
      <div class="maps">${mapRows('e') || '<p class="note">支出はありません。</p>'}</div>
      <div class="group-title">収入の分類先</div>
      <div class="maps">${mapRows('i') || '<p class="note">収入はありません。</p>'}</div>
      <div class="group-title">支払方法の割り当て${own ? '' : '（保有金融機関）'}</div>
      <div class="maps">${payRows}</div>
      <p class="note">「取り込まない」を選んだ分類は、その記録を読み込みません。すでに取り込み済みの記録（同じID）は自動で除きます。</p>
      <div class="sheet-foot"><p class="err" id="iErr" style="min-height:0;margin:0 0 6px"></p><div class="actions"><button type="button" class="btn" id="iNo">やめる</button><button type="button" class="btn primary" id="iGo">取り込む（<span id="iCnt">${countToImport()}</span>件）</button></div></div>`;
    sheet.scrollTop = top;
  }
  paint();
  sheet.onclick = e => {
    if (e.target.closest('#iClose, #iNo')) { closeSheet(); return; }
    if (e.target.closest('#iGo')) { commitImport(); return; }
    const u = e.target.closest('button[data-unit]');
    if (u) { imp.unit = u.dataset.unit; imp.catMap = {}; paint(); }
  };
  sheet.onchange = e => {
    const t = e.target;
    if (t.dataset.o) { imp[t.dataset.o] = t.checked; if (t.dataset.o === 'flip') imp.catMap = {}; paint(); return; }
    if (t.dataset.k) { imp.catMap[t.dataset.k] = t.value; const c = $('#iCnt'); if (c) c.textContent = countToImport(); return; }
    if (t.dataset.pk !== undefined) { imp.payMap[t.dataset.pk] = t.value; }
  };
  function commitImport() {
    const {cg, pg} = ensureMaps();
    const created = {cats:[], pays:[]};
    const catId = new Map(), payId = new Map();
    for (const [k, g] of cg) {
      const v = imp.catMap[k];
      if (v === 'skip') { catId.set(k, null); continue; }
      if (v === 'new') {
        const c = {id:'c' + uid(), name:g.name, type:g.t, color:PAL[S.cats.length % PAL.length]};
        S.cats.push(c); created.cats.push(c.id); catId.set(k, c.id);
      } else catId.set(k, v);
    }
    for (const [k, g] of pg) {
      const v = imp.payMap[k];
      if (v === 'new') {
        const p = {id:'p' + uid(), name:g.name || '未設定', color:PAL[(S.pays.length + 3) % PAL.length]};
        S.pays.push(p); created.pays.push(p.id); payId.set(k, p.id);
      } else payId.set(k, v);
    }
    const mfIds = new Set(), sigs = new Set();
    for (const x of allTx()) { if (x.mf) mfIds.add(x.mf); sigs.add(`${x.d}|${x.t}|${x.a}|${x.n}`); }
    const base = Date.now(); const txs = []; let dup = 0, skipped = 0;
    for (const r of active()) {
      const t = effT(r), cid = catId.get(catKey(t, srcCat(r)));
      if (!cid) { skipped++; continue; }
      if (r.id ? mfIds.has(r.id) : sigs.has(`${r.d}|${t}|${r.a}|${r.n}`)) { dup++; continue; }
      const tx = {id:uid(), d:r.d, t, c:cid, a:r.a, p:payId.get(srcPay(r)) || '', n:r.n, s:base + txs.length};
      if (r.id) tx.mf = r.id;
      txs.push(tx);
    }
    if (!txs.length && !created.cats.length && !created.pays.length) { $('#iErr').textContent = dup ? `新しく取り込める記録はありません（重複${dup}件）。` : '取り込める記録がありません。'; return; }
    const batch = addBatch(txs, created);
    if (txs.length) {
      const ms = [...new Set(txs.map(x => x.d.slice(0,7)))].sort();
      const cm = curMonth();
      ui.month = ms.filter(m => m <= cm).pop() || ms[ms.length - 1];
    }
    ui.tab = 'home'; ui.filter = 'all'; ui.q = ''; $('#q').value = '';
    closeSheet();
    render();
    toast(`${txs.length.toLocaleString('ja-JP')}件を取り込みました${dup ? `（重複${dup}件は除外）` : ''}`, {action:'取り消す', fn:() => undoBatch(batch), ms:10000});
  }
}
/* ===== レシート読み取り（この端末の中で文字認識） ===== */
function simdSupported() {
  try { return WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11])); }
  catch (e) { return false; }
}
function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('画像を開けません。JPEGやPNGの画像を選んでください')); };
    img.src = url;
  });
}
/* 写真の中からレシート（明るい紙の部分）を探す。背景の模様を文字として読まないための切り出し。
   見つかれば、傾きと切り出し範囲を返す。見つからない・全面が紙のときは null */
function segmentReceipt(img) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const k = 360 / Math.max(W, H);
  const sw = Math.max(8, Math.round(W * k)), sh = Math.max(8, Math.round(H * k));
  const cv = document.createElement('canvas'); cv.width = sw; cv.height = sh;
  const cx = cv.getContext('2d', {willReadFrequently: true});
  cx.imageSmoothingQuality = 'high'; cx.drawImage(img, 0, 0, sw, sh);
  const px = cx.getImageData(0, 0, sw, sh).data, n = sw * sh;
  const lum = new Float32Array(n), hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) { const v = 0.299 * px[i*4] + 0.587 * px[i*4+1] + 0.114 * px[i*4+2]; lum[i] = v; hist[v | 0]++; }
  // 大津の方法で、明るい紙と暗い背景の境目を決める
  let sum = 0; for (let v = 0; v < 256; v++) sum += v * hist[v];
  let wB = 0, sB = 0, best = -1, t = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v]; if (!wB) continue; const wF = n - wB; if (!wF) break;
    sB += v * hist[v];
    const mB = sB / wB, mF = (sum - sB) / wF, bv = wB * wF * (mB - mF) * (mB - mF);
    if (bv > best) { best = bv; t = v; }
  }
  let mB = 0, nB = 0, mF = 0, nF = 0;
  for (let i = 0; i < n; i++) { if (lum[i] > t) { mF += lum[i]; nF++; } else { mB += lum[i]; nB++; } }
  if (!nF || !nB) return null;
  mF /= nF; mB /= nB;
  if (mF < 110 || mF - mB < 45) return null;                 // 紙と背景の差がはっきりしない
  // 明るい領域のうち一番大きいものを紙とみなす（細い連結を切るため1回縮める）
  const m0 = new Uint8Array(n);
  for (let i = 0; i < n; i++) m0[i] = lum[i] > t ? 1 : 0;
  const m1 = new Uint8Array(n);
  for (let y = 1; y < sh - 1; y++) for (let x = 1; x < sw - 1; x++) {
    const i = y * sw + x;
    if (m0[i] && m0[i-1] && m0[i+1] && m0[i-sw] && m0[i+sw]) m1[i] = 1;
  }
  const lab = new Int32Array(n); let bestLab = 0, bestSize = 0, L = 0;
  const stack = new Int32Array(n);
  for (let i0 = 0; i0 < n; i0++) {
    if (!m1[i0] || lab[i0]) continue;
    L++; let sp = 0, size = 0; stack[sp++] = i0; lab[i0] = L;
    while (sp) {
      const i = stack[--sp]; size++;
      const x = i % sw, y = (i / sw) | 0;
      if (x > 0 && m1[i-1] && !lab[i-1]) { lab[i-1] = L; stack[sp++] = i-1; }
      if (x < sw-1 && m1[i+1] && !lab[i+1]) { lab[i+1] = L; stack[sp++] = i+1; }
      if (y > 0 && m1[i-sw] && !lab[i-sw]) { lab[i-sw] = L; stack[sp++] = i-sw; }
      if (y < sh-1 && m1[i+sw] && !lab[i+sw]) { lab[i+sw] = L; stack[sp++] = i+sw; }
    }
    if (size > bestSize) { bestSize = size; bestLab = L; }
  }
  if (!bestLab || bestSize < n * 0.04) return null;
  // 紙は凸な形なので、領域の外周点から凸包を作り、中を塗る（右端の太い文字などで欠けても紙として扱える）
  const pts = [];
  for (let y = 0; y < sh; y++) {
    let a = -1, b = -1;
    for (let x = 0; x < sw; x++) if (lab[y * sw + x] === bestLab) { if (a < 0) a = x; b = x; }
    if (a >= 0) { pts.push([a, y], [b, y]); }
  }
  for (let x = 0; x < sw; x++) {
    let a = -1, b = -1;
    for (let y = 0; y < sh; y++) if (lab[y * sw + x] === bestLab) { if (a < 0) a = y; b = y; }
    if (a >= 0) { pts.push([x, a], [x, b]); }
  }
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of pts) { while (lo.length >= 2 && cross(lo[lo.length-2], lo[lo.length-1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = pts.length - 1; i >= 0; i--) { const q = pts[i]; while (up.length >= 2 && cross(up[up.length-2], up[up.length-1], q) <= 0) up.pop(); up.push(q); }
  const hull = lo.slice(0, -1).concat(up.slice(0, -1));
  const mask = document.createElement('canvas'); mask.width = sw; mask.height = sh;
  const mctx = mask.getContext('2d');
  mctx.fillStyle = mctx.strokeStyle = '#fff'; mctx.lineWidth = 4; mctx.lineJoin = 'round';
  mctx.beginPath(); hull.forEach((q, i) => i ? mctx.lineTo(q[0] + .5, q[1] + .5) : mctx.moveTo(q[0] + .5, q[1] + .5)); mctx.closePath();
  mctx.fill(); mctx.stroke();
  const mdat = mctx.getImageData(0, 0, sw, sh).data;
  const fill = new Uint8Array(n);
  for (let i = 0; i < n; i++) fill[i] = mdat[i*4+3] > 128 ? 1 : 0;
  let area = 0; for (let i = 0; i < n; i++) area += fill[i];
  if (area > n * 0.88) return null;                           // ほぼ全面が紙 → 切り出し不要
  // 向き：形の主軸（縦長のレシートを縦にそろえる）
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) if (fill[i]) { mx += i % sw; my += (i / sw) | 0; }
  mx /= area; my /= area;
  let u20 = 0, u02 = 0, u11 = 0;
  for (let i = 0; i < n; i++) if (fill[i]) { const dx = (i % sw) - mx, dy = ((i / sw) | 0) - my; u20 += dx * dx; u02 += dy * dy; u11 += dx * dy; }
  u20 /= area; u02 /= area; u11 /= area;
  const th = 0.5 * Math.atan2(2 * u11, u20 - u02);           // 主軸の向き（x軸から）
  const tr = u20 + u02, dt = Math.sqrt(Math.max(0, (u20 - u02) * (u20 - u02) + 4 * u11 * u11));
  const l1 = (tr + dt) / 2, l2 = Math.max(1e-6, (tr - dt) / 2);
  const elong = Math.sqrt(l1 / l2);
  let d = th > 0 ? th - Math.PI / 2 : th + Math.PI / 2;      // 縦からのずれ
  let alpha = 0;
  if (elong >= 1.5 && (Math.abs(d) < 0.6 || elong >= 2.5)) alpha = -d;
  // 文字の行の傾きで微調整（±7度を探す）
  const dark = [];
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const i = y * sw + x; if (fill[i] && lum[i] < mF * 0.62) dark.push(x - mx, y - my); }
  let ca = Math.cos(alpha), sa = Math.sin(alpha), rho = 0;
  if (dark.length > 400) {
    let bestScore = -1;
    for (let deg = -7; deg <= 7.01; deg += 0.5) {
      const r = deg * Math.PI / 180, c2 = Math.cos(alpha + r), s2 = Math.sin(alpha + r);
      const bins = new Float32Array(sh * 3 + 40);
      for (let j = 0; j < dark.length; j += 2) {
        const yy = Math.round(dark[j] * s2 + dark[j+1] * c2 + sh * 1.5);
        if (yy >= 0 && yy < bins.length) bins[yy]++;
      }
      let sc = 0; for (let j = 0; j < bins.length; j++) sc += bins[j] * bins[j];
      if (sc > bestScore) { bestScore = sc; rho = r; }
    }
  }
  alpha += rho; ca = Math.cos(alpha); sa = Math.sin(alpha);
  // 回転後の範囲
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (let i = 0; i < n; i++) if (fill[i]) {
    const dx = (i % sw) - mx, dy = ((i / sw) | 0) - my;
    const qx = ca * dx - sa * dy, qy = sa * dx + ca * dy;
    if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
  }
  return {k, alpha, mx, my, x0, x1, y0, y1, mask, area: area / n, elong};
}

/* 下処理：レシートの切り出し・傾き補正・拡大・コントラスト補正。文字認識の精度を上げるため
   mode: 'none'（何もしない）／'gray'（白黒にしてコントラストを伸ばす）／'bin'（影に強い白黒2値） */
async function preprocessImage(file, mode, opt) {
  mode = mode || 'gray'; opt = opt || {};
  const img = await loadImage(file);
  const w0 = img.naturalWidth, h0 = img.naturalHeight;
  if (!w0 || !h0) throw new Error('画像を開けません');
  let seg = null;
  if (opt.crop !== false) { try { seg = segmentReceipt(img); } catch (e) { seg = null; } }
  const cv = document.createElement('canvas');
  let ctx;
  if (seg) {
    const {k, alpha, mx, my, x0, x1, y0, y1} = seg;
    const mg = 0.03 * Math.max(x1 - x0, y1 - y0) / 1;
    const rw = (x1 - x0 + 2 * Math.min(mg, 6)) / k, rh = (y1 - y0 + 2 * Math.min(mg, 6)) / k;   // 元画像上のサイズ
    let s = (opt.width || 1100) / rw;
    s = Math.min(3, Math.max(0.5, s));
    if (rw * rh * s * s > 7e6) s = Math.sqrt(7e6 / (rw * rh));
    const w = Math.max(8, Math.round(rw * s)), h = Math.max(8, Math.round(rh * s));
    cv.width = w; cv.height = h;
    ctx = cv.getContext('2d', {willReadFrequently: true});
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    const ca = Math.cos(alpha), sa = Math.sin(alpha);
    const qcx = (x0 + x1) / 2, qcy = (y0 + y1) / 2;          // 回転後の中心（縮小画像・重心基準）
    // 元画像(px) → 出力: o = s*R*(p - c0/k) ... c0 は縮小画像上の重心
    const c0x = mx / k, c0y = my / k;
    const e = w / 2 - s * (ca * c0x - sa * c0y) - s * qcx / k * 1 + 0;
    const f = h / 2 - s * (sa * c0x + ca * c0y) - s * qcy / k * 1 + 0;
    const T = [s * ca, s * sa, -s * sa, s * ca, e, f];
    ctx.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
    ctx.drawImage(img, 0, 0);
    // 紙の外側を白くつぶす
    const mc = document.createElement('canvas'); mc.width = w; mc.height = h;
    const mx2 = mc.getContext('2d', {willReadFrequently: true});
    mx2.setTransform(T[0] / k, T[1] / k, T[2] / k, T[3] / k, T[4], T[5]);
    mx2.imageSmoothingEnabled = true;
    mx2.drawImage(seg.mask, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const im = ctx.getImageData(0, 0, w, h), md = mx2.getImageData(0, 0, w, h);
    for (let i = 0; i < im.data.length; i += 4) if (md.data[i+3] < 128) { im.data[i] = im.data[i+1] = im.data[i+2] = 255; }
    ctx.putImageData(im, 0, 0);
  } else {
    let scale = 1;
    const maxSide = Math.max(w0, h0), minSide = Math.min(w0, h0);
    if (maxSide > 3000) scale = 3000 / maxSide;
    if (w0 * h0 * scale * scale > 6e6) scale = Math.sqrt(6e6 / (w0 * h0));
    if (minSide * scale < 700) scale = Math.min(2, 700 / minSide);
    const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
    cv.width = w; cv.height = h;
    ctx = cv.getContext('2d', {willReadFrequently: true});
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
  }
  const w = cv.width, h = cv.height;
  if (mode !== 'none') {
    const src = ctx.getImageData(0, 0, w, h), a = src.data, n = w * h;
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = 0.299 * a[i*4] + 0.587 * a[i*4+1] + 0.114 * a[i*4+2];
    if (mode === 'bin') {
      // 影に強い2値化：まわりの平均より十分暗い所だけを文字にする
      const ii = new Float64Array((w + 1) * (h + 1));
      for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += g[y * w + x]; ii[(y+1) * (w+1) + x + 1] = ii[y * (w+1) + x + 1] + row; } }
      const r = Math.max(8, Math.round(w / 40));
      for (let y = 0; y < h; y++) {
        const ya = Math.max(0, y - r), yb = Math.min(h, y + r + 1);
        for (let x = 0; x < w; x++) {
          const xa = Math.max(0, x - r), xb = Math.min(w, x + r + 1);
          const mean = (ii[yb * (w+1) + xb] - ii[ya * (w+1) + xb] - ii[yb * (w+1) + xa] + ii[ya * (w+1) + xa]) / ((xb - xa) * (yb - ya));
          const v = g[y * w + x] < mean * 0.86 ? 0 : 255;
          const o = (y * w + x) * 4; a[o] = a[o+1] = a[o+2] = v; a[o+3] = 255;
        }
      }
    } else {
      const hist = new Uint32Array(256);
      for (let i = 0; i < n; i++) hist[Math.round(g[i])]++;
      let acc = 0, lo = 0, hi = 255;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.01) { lo = v; break; } }
      acc = 0;
      for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.3) { hi = v; break; } }
      const span = Math.max(30, hi - lo);
      for (let i = 0; i < n; i++) {
        let v = (g[i] - lo) / span * 255; v = v > 255 ? 255 : v < 0 ? 0 : v;
        a[i*4] = a[i*4+1] = a[i*4+2] = v; a[i*4+3] = 255;
      }
    }
    ctx.putImageData(src, 0, 0);
  }
  if (opt.canvas) return cv;
  const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
  if (!blob) throw new Error('画像を処理できません');
  return await blob.arrayBuffer();
}
async function startOcrWorker(state, setMsg, psm) {
  const corePath = new URL(`vendor/core/tesseract-core-${simdSupported() ? 'simd-' : ''}lstm.wasm.js`, location.href).href;
  setMsg('日本語データを読み込んでいます（初回のみ約14MB）…', null);
  const res = await fetch('vendor/lang/jpn.traineddata');
  if (!res.ok) throw new Error('日本語データを読み込めません');
  const lang = await res.arrayBuffer();
  if (state.cancelled) return null;
  setMsg('文字認識エンジンを起動しています…', null);
  const w = new Worker('ocr-worker.js');
  state.worker = w;
  await new Promise((ok, ng) => {
    w.onmessage = e => { if (e.data.type === 'ready') ok(); else if (e.data.type === 'error') ng(new Error(e.data.message)); };
    w.onerror = () => ng(new Error('文字認識を開始できません'));
    w.postMessage({type:'init', corePath, lang, psm:psm || 6}, [lang]);
  });
  return state.cancelled ? null : w;
}
function ocrCall(w, buf, psm, onProgress, extra) {
  return new Promise((ok, ng) => {
    w.onmessage = e => {
      const m = e.data;
      if (m.type === 'progress') { if (onProgress) onProgress(m.value); }
      else if (m.type === 'result') ok(m.text);
      else if (m.type === 'error') ng(new Error(m.message));
    };
    w.onerror = () => ng(new Error('文字の読み取りに失敗しました'));
    w.postMessage(Object.assign({type:'recognize', image:buf, psm}, extra || {}), [buf]);
  });
}
async function runOcr(png, state, setMsg, psm) {
  const w = await startOcrWorker(state, setMsg, psm);
  if (!w) return null;
  setMsg('文字を読み取っています…', 0);
  const text = await ocrCall(w, png, psm || 6, v => setMsg('文字を読み取っています…', v));
  try { w.terminate(); } catch (e) {}
  state.worker = null;
  return text;
}

async function handleReceiptFile(file) {
  if (!file) return;
  const state = {cancelled:false, worker:null};
  const thumb = URL.createObjectURL(file);
  let handedOver = false;
  const sheet = openSheet(`
    <div class="sheet-head"><h2>レシートを読み取り中</h2>${closeBtn('rClose')}</div>
    <img class="thumb" src="${thumb}" alt="選んだレシート">
    <div class="progress indet" id="rProg"><i></i></div>
    <p class="muted" id="rMsg" style="margin:0 0 16px">画像を準備しています…</p>
    <div class="sheet-foot"><div class="actions"><button type="button" class="btn" id="rCancel">やめる</button></div></div>`,
    'レシートの読み取り', () => {
      state.cancelled = true;
      if (state.worker) { try { state.worker.terminate(); } catch (e) {} }
      if (!handedOver) URL.revokeObjectURL(thumb);
    });
  sheetLocked = true;
  sheet.querySelector('#rClose').onclick = sheet.querySelector('#rCancel').onclick = closeSheet;
  const setMsg = (t, p) => {
    const m = $('#rMsg'), pr = $('#rProg');
    if (!m || !pr) return;
    m.textContent = t;
    if (p == null) { pr.classList.add('indet'); pr.firstElementChild.style.width = ''; }
    else { pr.classList.remove('indet'); pr.firstElementChild.style.width = Math.round(p * 100) + '%'; }
  };
  try {
    const png = await preprocessImage(file);
    if (state.cancelled) return;
    const text = await runOcr(png, state, setMsg);
    if (state.cancelled || text === null) return;
    handedOver = true;
    openReceiptReview(parseReceipt(text), text, thumb);
  } catch (e) {
    if (state.cancelled) return;
    const s = $('#sheet');
    s.innerHTML = `
      <div class="sheet-head"><h2>読み取れませんでした</h2>${closeBtn('rClose')}</div>
      <p class="err" style="min-height:0">${esc(e.message || '読み取りに失敗しました')}</p>
      <p class="note" style="margin-left:0">明るい場所で、レシート全体が画面いっぱいに入るように撮り直すと読み取りやすくなります。</p>
      <div class="sheet-foot"><div class="actions"><button type="button" class="btn" id="rManual">手入力で続ける</button><button type="button" class="btn primary" id="rOk">閉じる</button></div></div>`;
    s.querySelector('#rClose').onclick = s.querySelector('#rOk').onclick = closeSheet;
    s.querySelector('#rManual').onclick = () => { handedOver = true; openReceiptReview({date:null, store:'', items:[], total:null, pay:null}, '', thumb); };
  }
}

/* ===== 反映前の確認画面（分類は自分で決める） ===== */
function openReceiptReview(info, rawText, thumb) {
  const expCats = S.cats.filter(c => c.type === 'e');
  const brandPay = payByBrand(info.brand);
  const R = {
    id: uid(), date: info.date || todayStr(), store: info.store || '', brand: info.brand || '', seq: info.seq || '',
    pay: brandPay || ((info.pay && S.pays.some(p => p.id === info.pay)) ? info.pay : (S.pays.some(p => p.id === ui.lastPay) ? ui.lastPay : (S.pays[0] ? S.pays[0].id : ''))),
    mode: info.items.length ? 'items' : 'single', learn: true, total: info.total, totalGuess: !!info.totalGuess, readN: info.items.length,
    items: info.items.map(it => { const s = suggestCat(it.label, info.store); return {label:it.label, amt:it.amount, neg:it.neg, cat:s ? s.c : '', sug:!!s, inc:true}; }),
    singleCat: '', singleSug: false, singleAmt: 0
  };
  const sum = () => R.items.reduce((s, it) => s + (it.inc ? (it.neg ? -it.amt : it.amt) : 0), 0);
  // 合計1件で登録するときの初期値
  const bySum = {};
  for (const it of R.items) if (it.cat) bySum[it.cat] = (bySum[it.cat] || 0) + it.amt;
  const top = Object.entries(bySum).sort((a, b) => b[1] - a[1])[0];
  R.singleCat = top ? top[0] : (storeHint(R.store) || '');
  R.singleSug = !!R.singleCat;
  R.singleAmt = R.total || Math.max(0, sum());

  const catOpts = sel => `<option value="">分類を選ぶ</option>` + expCats.map(c => `<option value="${esc(c.id)}"${c.id === sel ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  const itemHtml = (it, i) => `
    <div class="item${it.inc ? '' : ' off'}${it.inc && !it.cat ? ' need' : ''}" data-i="${i}">
      <div class="item-top">
        <input type="checkbox" data-f="inc" ${it.inc ? 'checked' : ''} aria-label="この行を登録する">
        <input type="text" data-f="label" value="${esc(it.label)}" maxlength="40" placeholder="品名" aria-label="品名">
        <button type="button" class="icon-btn sm" data-act="r-del" aria-label="この行を削除">${XICON}</button>
      </div>
      <div class="item-bot">
        <label class="amtbox"><span>${it.neg ? '−¥' : '¥'}</span><input type="text" inputmode="numeric" data-f="amt" value="${it.amt || ''}" placeholder="0" aria-label="金額"></label>
        <button type="button" class="chip small" data-act="r-sign" aria-pressed="${it.neg}">値引き</button>
        <select data-f="cat" aria-label="分類">${catOpts(it.cat)}</select>
      </div>
      <div class="item-note">${it.inc && it.sug && it.cat ? '<span class="tag">候補</span>自動で付けた分類です' : ''}</div>
    </div>`;

  const brandHint = () => !R.brand ? '' : `<p class="note" style="margin:8px 0 0">レシートの表記：<b>${esc(R.brand)}</b>${payByBrand(R.brand) === R.pay ? '' : ` <button type="button" class="chip small" data-act="r-addpay" style="margin-left:4px">「${esc(R.brand)}」を支払方法に追加して選ぶ</button>`}</p>`;
  const sheet = openSheet('', 'レシートの確認', () => { if (thumb) URL.revokeObjectURL(thumb); });
  sheetLocked = true;
  function paintAll() {
    sheet.innerHTML = `
      <div class="sheet-head"><h2>レシートの内容を確認${R.seq ? `（${esc(R.seq)}）` : ''}</h2>${closeBtn('vClose')}</div>
      ${R.readN ? '' : `<div class="banner warn"><div><b>明細を読み取れませんでした。</b>「行を追加」で明細を入力するか、「合計1件で登録」を使ってください。</div></div>`}
      ${thumb ? `<div><button type="button" class="chip small" data-act="r-img" aria-expanded="false">レシート画像を見る</button><img class="thumb" id="rImg" src="${thumb}" alt="レシート" hidden style="margin-top:10px"></div>` : ''}
      <label class="field"><span class="flabel">日付</span><input id="rDate" type="date" value="${esc(R.date)}"></label>
      <label class="field"><span class="flabel">店名</span><input id="rStore" type="text" maxlength="24" value="${esc(R.store)}" placeholder="例：スーパーみらい" autocomplete="off"></label>
      <div class="field"><span class="flabel">支払方法</span><div class="chips" id="rPays">${payChips(R.pay)}</div><div id="rBrand">${brandHint()}</div></div>
      <div class="field"><div class="seg" id="rMode" role="group" aria-label="登録のしかた">
        <button type="button" data-m="items" aria-pressed="${R.mode === 'items'}">明細ごとに登録</button>
        <button type="button" data-m="single" aria-pressed="${R.mode === 'single'}">合計1件で登録</button></div></div>
      <div id="rBody"></div>
      ${rawText ? `<details class="raw"><summary>読み取った文字を見る</summary><pre>${esc(rawText.replace(/\n{2,}/g, '\n'))}</pre></details>` : ''}
      <div class="sheet-foot"><p class="err" id="rErr" role="alert" style="min-height:0;margin:0 0 6px"></p>
        <div class="actions"><button type="button" class="btn" id="rNo">やめる</button><button type="button" class="btn primary" id="rGo">登録する</button></div></div>`;
    paintBody();
  }
  function paintBody() {
    const body = $('#rBody');
    if (R.mode === 'items') {
      const sugN = R.items.filter(it => it.inc && it.sug && it.cat).length;
      body.innerHTML = `
        <div class="group-title">明細（${R.items.length}行）</div>
        ${sugN ? `<div class="banner warn" style="margin-top:6px"><div>分類の候補を自動で付けています。<b>「候補」と出ている行は、内容を確認してから登録してください。</b>変更すると候補の表示は消えます。</div></div>` : ''}
        <div class="maps" id="rItems">${R.items.map(itemHtml).join('') || '<p class="note">明細がありません。</p>'}</div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button type="button" class="chip" data-act="r-add">＋ 行を追加</button>
          <select id="rBulk" aria-label="すべての行の分類をまとめて設定" style="flex:1 1 180px;min-height:40px;padding-top:6px;padding-bottom:6px">
            <option value="">すべての行の分類を一括設定…</option>${expCats.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select>
        </div>
        <div class="totals" id="rTotals"></div>
        <label class="opt" style="margin-top:6px"><input type="checkbox" id="rLearn" ${R.learn ? 'checked' : ''}>この分類を覚えて、次回から候補にする</label>`;
    } else {
      body.innerHTML = `
        <label class="field"><span class="flabel">金額</span><span class="amount"><b>¥</b><input id="rSAmt" type="text" inputmode="numeric" value="${R.singleAmt ? R.singleAmt.toLocaleString('ja-JP') : ''}" placeholder="0" aria-label="合計金額"></span></label>
        <div class="field"><span class="flabel">分類</span><select id="rSCat" aria-label="分類">${catOpts(R.singleCat)}</select>
          <div class="item-note" id="rSNote" style="margin-top:6px">${R.singleSug && R.singleCat ? '<span class="tag">候補</span>自動で付けた分類です' : ''}</div></div>
        ${R.total ? `<p class="note" style="margin-left:0">レシートから読み取った合計：${yen(R.total)}${R.totalGuess ? '（推定です。レシート画像と見比べてください）' : ''}</p>` : ''}`;
    }
    refresh();
  }
  function refresh() {
    const go = $('#rGo'); if (!go) return;
    const err = validate(true);
    if (R.mode === 'items') {
      const inc = R.items.filter(it => it.inc), s = sum();
      const t = $('#rTotals');
      if (t) {
        const diff = R.total != null ? R.total - s : null;
        t.innerHTML = `<div><span>登録する明細の合計（${inc.length}行）</span><b class="num">${s < 0 ? '−' : ''}${yen(s)}</b></div>`
          + (R.total != null ? `<div><span>レシートの合計</span><b class="num">${yen(R.total)}</b></div>` : '<div><span>レシートの合計</span><span class="muted">読み取れませんでした</span></div>')
          + (diff ? `<div class="diff"><span>差額</span><b class="num">${diff < 0 ? '−' : '+'}${yen(diff)}</b></div>` : '')
          + (diff ? `<div class="muted" style="display:block;font-size:12.5px">読み取り漏れ、外税の消費税、値引きなどが原因のことがあります。${diff > 0 && diff <= (R.total || 0) * 0.25 ? '<br><button type="button" class="chip small" data-act="r-adj" style="margin-top:6px">差額を「消費税・調整」の行として追加</button>' : ''}</div>` : '');
      }
      go.textContent = `登録する（${inc.length}件・${s < 0 ? '−' : ''}${yen(s)}）`;
    } else {
      go.textContent = `登録する（1件・${yen(R.singleAmt || 0)}）`;
    }
    go.disabled = !!err;
    const e = $('#rErr'); if (e) e.textContent = err ? err : '';
  }
  function validate() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(R.date)) return '日付を入力してください。';
    if (R.mode === 'single') {
      if (!(R.singleAmt > 0)) return '金額を入力してください。';
      if (!R.singleCat) return '分類を選んでください。';
      return '';
    }
    const inc = R.items.filter(it => it.inc);
    if (!inc.length) return '登録する行がありません。';
    if (inc.some(it => !(it.amt > 0))) return '金額が空の行があります。';
    const need = inc.filter(it => !it.cat).length;
    if (need) return `分類が未選択の行が${need}件あります。`;
    return '';
  }
  function repaintItem(i) {
    const el = sheet.querySelector(`.item[data-i="${i}"]`);
    if (el) el.outerHTML = itemHtml(R.items[i], i);
  }
  const fixSugBanner = () => {
    // 候補が残っていない場合は説明バナーを消す
    if (R.mode !== 'items') return;
    const left = R.items.filter(it => it.inc && it.sug && it.cat).length;
    const b = sheet.querySelector('#rBody .banner.warn');
    if (b && !left) b.remove();
  };
  function build() {
    const base = Date.now(), pay = R.pay, store = R.store.trim();
    if (R.mode === 'single') {
      return [{id:uid(), d:R.date, t:'e', c:R.singleCat, a:Math.round(R.singleAmt), p:pay, n:(store || 'レシート').slice(0,80), s:base, r:R.id}];
    }
    return R.items.filter(it => it.inc).map((it, i) => ({id:uid(), d:R.date, t:'e', c:it.cat, a:(it.neg ? -1 : 1) * Math.round(it.amt), p:pay,
      n:[store, it.label.trim()].filter(Boolean).join(' ').slice(0,80), s:base + i, r:R.id}));
  }
  paintAll();

  sheet.onclick = e => {
    const t = e.target;
    if (t.closest('#vClose, #rNo')) { receiptQueue.length = 0; closeSheet(); return; }
    if (t.closest('#rGo')) {
      const err = validate(); if (err) { $('#rErr').textContent = err; return; }
      const txs = build();
      if (R.mode === 'items' && R.learn) { for (const it of R.items) if (it.inc && it.cat) learnLabel(it.label, it.cat); saveMeta(); }
      const batch = addBatch(txs);
      ui.lastPay = R.pay;
      ui.month = R.date.slice(0,7); ui.tab = 'home'; ui.filter = 'all'; ui.q = ''; $('#q').value = '';
      closeSheet(); render();
      toast(`${txs.length}件を登録しました`, {action:'取り消す', fn:() => undoBatch(batch), ms:9000});
      if (receiptQueue.length) setTimeout(() => openReceiptReview(receiptQueue.shift(), '', ''), 350);
      return;
    }
    const pb = t.closest('#rPays button[data-p]');
    if (pb) { R.pay = pb.dataset.p; $('#rPays').innerHTML = payChips(R.pay); $('#rBrand').innerHTML = brandHint(); return; }
    const mb = t.closest('#rMode button[data-m]');
    if (mb) { R.mode = mb.dataset.m; sheet.querySelectorAll('#rMode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.m === R.mode))); paintBody(); return; }
    const act = t.closest('[data-act]');
    if (!act) return;
    const row = t.closest('.item'), i = row ? Number(row.dataset.i) : -1;
    switch (act.dataset.act) {
      case 'r-addpay': {
        const ex = payByBrand(R.brand);
        if (ex) R.pay = ex; else { const np = {id:'p' + uid(), name:R.brand, color:PAL[(S.pays.length + 3) % PAL.length]}; S.pays.push(np); saveMeta(); scheduleSync(); R.pay = np.id; }
        $('#rPays').innerHTML = payChips(R.pay); $('#rBrand').innerHTML = brandHint(); break;
      }
      case 'r-img': { const im = $('#rImg'); im.hidden = !im.hidden; act.setAttribute('aria-expanded', String(!im.hidden)); act.textContent = im.hidden ? 'レシート画像を見る' : 'レシート画像を隠す'; break; }
      case 'r-del': R.items.splice(i, 1); paintBody(); break;
      case 'r-sign': R.items[i].neg = !R.items[i].neg; repaintItem(i); refresh(); break;
      case 'r-add': { R.items.push({label:'', amt:0, neg:false, cat:'', sug:false, inc:true}); paintBody(); const l = sheet.querySelector(`.item[data-i="${R.items.length - 1}"] input[data-f="label"]`); if (l) l.focus(); break; }
      case 'r-adj': {
        const diff = R.total - sum();
        const cnt = {}; R.items.forEach(it => { if (it.inc && it.cat) cnt[it.cat] = (cnt[it.cat] || 0) + 1; });
        const common = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
        R.items.push({label:'消費税・調整', amt:diff, neg:false, cat:common ? common[0] : '', sug:false, inc:true});
        paintBody(); break;
      }
    }
  };
  sheet.oninput = e => {
    const t = e.target, row = t.closest('.item'), i = row ? Number(row.dataset.i) : -1;
    if (t.id === 'rStore') { R.store = t.value; return; }
    if (t.id === 'rSAmt') { const v = parseInt(normDigits(t.value).replace(/\D/g, '') || '0', 10); R.singleAmt = v; refresh(); return; }
    if (i < 0) return;
    if (t.dataset.f === 'label') R.items[i].label = t.value;
    else if (t.dataset.f === 'amt') {
      const digits = normDigits(t.value).replace(/\D/g, '').slice(0, 7);
      if (t.value !== digits) t.value = digits;
      R.items[i].amt = digits ? parseInt(digits, 10) : 0;
      refresh();
    }
  };
  sheet.onchange = e => {
    const t = e.target, row = t.closest('.item'), i = row ? Number(row.dataset.i) : -1;
    if (t.id === 'rDate') { R.date = t.value; refresh(); return; }
    if (t.id === 'rLearn') { R.learn = t.checked; return; }
    if (t.id === 'rSCat') { R.singleCat = t.value; R.singleSug = false; const n = $('#rSNote'); if (n) n.innerHTML = ''; refresh(); return; }
    if (t.id === 'rBulk') {
      if (!t.value) return;
      R.items.forEach(it => { if (it.inc) { it.cat = t.value; it.sug = false; } });
      paintBody(); return;
    }
    if (i < 0) return;
    const it = R.items[i];
    if (t.dataset.f === 'cat') { it.cat = t.value; it.sug = false; repaintItem(i); fixSugBanner(); refresh(); }
    else if (t.dataset.f === 'inc') { it.inc = t.checked; repaintItem(i); fixSugBanner(); refresh(); }
  };
}



/* ===== 「レシート」ボタンの入口：読み取り方を選ぶ ===== */
let receiptQueue = [];
const CLAUDE_PROMPT = `添付したレシート画像を、次の形式の文字だけで書き出してください（説明や装飾は不要です）。
店名：（店舗名。支店名があれば含める）
日付：YYYY-MM-DD
品名 ¥金額　（1品1行。数量が2以上なら「品名 ×2 ¥合計金額」。値引き・クーポンは「値引 ¥-金額」）
合計 ¥金額
支払方法：（クレジットカード／電子マネー／現金のいずれか）（カード名・ブランド名があれば続けて書く）
読めない文字は推測せず「?」にしてください。
レシートが複数枚あるときは、1枚ごとに「=====」だけの行で区切ってください。`;
function openReceiptChoice() {
  const sheet = openSheet(`
    <div class="sheet-head"><h2>レシートを取り込む</h2>${closeBtn('cClose')}</div>
    <div class="stack">
      <button type="button" class="btn primary" id="cPhoto">写真から読み取る（端末内）</button>
      <button type="button" class="btn" id="cPaste">文字を貼り付けて取り込む</button>
      <button type="button" class="btn" id="cManual">手入力で明細を作る</button>
    </div>
    <p class="note" style="margin-left:0">「文字を貼り付け」は、iPhoneの文字認識（Live Text）や、Claudeに読ませた結果をそのまま取り込めます。品名を正確に残したいときに向いています。</p>`, 'レシートを取り込む');
  sheet.querySelector('#cClose').onclick = closeSheet;
  sheet.querySelector('#cPhoto').onclick = () => { closeSheet(); $('#fileReceipt').click(); };
  sheet.querySelector('#cPaste').onclick = openReceiptPaste;
  sheet.querySelector('#cManual').onclick = () => openReceiptReview({date:null, store:'', items:[], total:null, pay:null}, '', '');
}
function openReceiptPaste() {
  const sheet = openSheet(`
    <div class="sheet-head"><h2>文字を貼り付けて取り込む</h2>${closeBtn('pClose')}</div>
    <textarea id="pText" rows="9" placeholder="ここにレシートの文字を貼り付け" style="width:100%"></textarea>
    <p class="err" id="pErr" style="min-height:20px"></p>
    <details class="raw"><summary>貼り付ける文字の作り方</summary>
      <p class="note" style="margin-left:0"><b>A. iPhoneの文字認識（無料・端末内）</b><br>
      ① 写真アプリでレシートを開く → 右下の文字認識のマークを押す<br>
      ② 文字を長押し →「すべてを選択」→「コピー」<br>
      ③ ここに貼り付ける<br>
      （この欄を長押し →「テキストを読み取り」を選ぶと、カメラの文字を直接入力できます。iOS 15以降のことが多い。確信度：中）</p>
      <p class="note" style="margin-left:0"><b>B. Claudeに読ませる（正確・複数枚OK）</b><br>
      ① 下のボタンで依頼文をコピー<br>
      ② Claudeアプリにレシートの写真を添付し、依頼文を貼り付けて送る<br>
      ③ 返ってきた文字をコピーして、ここに貼り付ける</p>
      <button type="button" class="chip" id="pCopy">Claude用の依頼文をコピー</button>
    </details>
    <div class="sheet-foot"><div class="actions"><button type="button" class="btn" id="pNo">やめる</button><button type="button" class="btn primary" id="pGo">内容を確認する</button></div></div>`, '文字を貼り付けて取り込む');
  sheet.querySelector('#pClose').onclick = sheet.querySelector('#pNo').onclick = closeSheet;
  sheet.querySelector('#pCopy').onclick = async e => {
    const b = e.currentTarget;
    try { await navigator.clipboard.writeText(CLAUDE_PROMPT); b.textContent = 'コピーしました'; }
    catch (err) { const ta = $('#pText'); ta.value = CLAUDE_PROMPT; ta.select(); b.textContent = '上の欄に出しました。コピーしてください'; }
  };
  sheet.querySelector('#pGo').onclick = () => {
    const text = $('#pText').value.trim();
    if (!text) { $('#pErr').textContent = '文字を貼り付けてください。'; return; }
    const parts = text.split(/^\s*={3,}\s*$/m).map(x => x.trim()).filter(Boolean);
    const infos = parts.map(p => parseReceipt(p));
    infos.forEach((inf, i) => { if (infos.length > 1) inf.seq = `${i + 1}/${infos.length}枚目`; });
    receiptQueue = infos.slice(1);
    openReceiptReview(infos[0], parts[0], '');
  };
}
/* ===== Googleスプレッドシートとの同期（任意機能） =====
   端末の記録が本体。シートは「自動の控え」で、シート側で直した内容も取り込める。
   同じ記録を両方で変えたときは、更新日時が新しい方を採用する。 */
const SYNC_URL_RE = /^https:\/\/script\.google\.com\/[^\s?#]+\/exec$/;
const SYNC_DELAY = 5000;
let syncBusy = false, syncDirty = false, syncTimer = null, syncErr = '', syncNote = '';

const syncOn = () => !!(S.sync && S.sync.url && S.sync.key);

function scheduleSync() {
  if (!syncOn() || !S.sync.auto) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { if (navigator.onLine !== false) syncNow({silent:true}); }, SYNC_DELAY);
}

async function gasCall(url, body, ms = 60000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  let res, text;
  try {
    // text/plain にすると事前確認(プリフライト)が不要になり、GASで受け取れる
    res = await fetch(url, {method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body:JSON.stringify(body), redirect:'follow', signal:ctl.signal});
    text = await res.text();
  } catch (e) {
    throw new Error(e && e.name === 'AbortError' ? '時間内に応答がありませんでした。電波の良い所でもう一度お試しください。' : '接続できませんでした。電波、URL、公開設定（アクセスできるユーザー：全員）を確認してください。');
  } finally { clearTimeout(timer); }
  let j;
  try { j = JSON.parse(text); } catch (e) {
    throw new Error('GASから想定外の応答でした。デプロイの「アクセスできるユーザー」が「全員」か、URLが「/exec」で終わるか確認してください。');
  }
  if (!j.ok) {
    const m = {auth:'合言葉が一致しません。アプリとGASのKEYを同じにしてください。', 'key-not-set':'GASのKEYがまだ初期値のままです。書き換えて、デプロイし直してください。', 'bad-request':'要求を読み取れませんでした。', server:'GAS側でエラーが出ました。' + (j.detail ? '（' + j.detail + '）' : '')};
    throw new Error(m[j.error] || ('GASがエラーを返しました：' + j.error));
  }
  return j;
}

const txToWire = x => ({id:x.id, d:x.d, t:x.t, c:x.c, cn:catById(x.c).name, a:x.a, p:x.p, pn:x.p ? payName(x.p) : '', n:x.n || '', u:x.u || 0, x:0});

/* シートの分類名・支払方法名 → このアプリのID（なければ新しく作る） */
function resolveCat(name, id, type, created) {
  let c = S.cats.find(c => c.name === name && c.type === type);
  if (c) return c.id;
  if (!name) { const f = S.cats.find(c => c.id === id); return f ? f.id : (type === 'i' ? 'other_i' : 'other_e'); }
  c = {id:'c' + uid(), name, type, color:PAL[S.cats.length % PAL.length]};
  S.cats.push(c); created.cats++;
  return c.id;
}
function resolvePay(name, id, created) {
  if (!name) return '';
  let p = S.pays.find(p => p.name === name);
  if (p) return p.id;
  p = {id:'p' + uid(), name, color:PAL[(S.pays.length + 3) % PAL.length]};
  S.pays.push(p); created.pays++;
  return p.id;
}

function putTx(tx) {
  const k = tx.d.slice(0,7);
  (S.months[k] = S.months[k] || []).push(tx);
}
function dropTx(id) {
  for (const k of Object.keys(S.months)) {
    const i = S.months[k].findIndex(x => x.id === id);
    if (i >= 0) { const [x] = S.months[k].splice(i, 1); if (!S.months[k].length) delete S.months[k]; return x; }
  }
  return null;
}

/* 現資産・エントリーの同期（1件ずつ、更新が新しい方を採用。削除は印で伝える） */
const itemStamp = (k, o) => k === 'acct' ? (o.m || o.u || 0) : (o.u || 0);
function itemsToWire() {
  const items = [];
  for (const a of S.accts) items.push({k:'acct', id:a.id, m:itemStamp('acct', a), x:0, d:a});
  for (const e of S.entries) items.push({k:'entry', id:e.id, m:itemStamp('entry', e), x:0, d:e});
  for (const id of Object.keys(S.idels)) items.push({k:S.idels[id].k, id, m:S.idels[id].t, x:1});
  return items;
}
function mergeItems(res) {
  let ch = 0;
  if (!Array.isArray(res.items)) return -1;               // GAS が古い（現資産・エントリーに未対応）
  for (const r of res.items) {
    if (!r || !r.id || (r.k !== 'acct' && r.k !== 'entry')) continue;
    const list = r.k === 'acct' ? S.accts : S.entries;
    const local = list.find(x => x.id === r.id);
    const lm = local ? itemStamp(r.k, local) : 0;
    const m = Number(r.m) || 0;
    if (r.x) {
      if (local && m > lm) { if (r.k === 'acct') S.accts = S.accts.filter(x => x.id !== r.id); else S.entries = S.entries.filter(x => x.id !== r.id); ch++; }
      continue;
    }
    const tomb = S.idels[r.id];
    if (tomb && tomb.t >= m) continue;                    // 端末で消した後に、古い内容が残っていた場合
    if (local && lm >= m) continue;                       // 端末の方が新しい（または同じ）
    const clean = r.k === 'acct' ? cleanAcct({...r.d, id:r.id, m}) : cleanEntry({...r.d, id:r.id, u:m});
    if (!clean) continue;
    if (r.k === 'acct') S.accts = local ? S.accts.map(x => x.id === r.id ? clean : x) : [...S.accts, clean];
    else S.entries = local ? S.entries.map(x => x.id === r.id ? clean : x) : [...S.entries, clean];
    delete S.idels[r.id];
    ch++;
  }
  const names = (cur, add) => [...new Set([...cur, ...(Array.isArray(add) ? add.map(x => String(x).trim().slice(0, 20)).filter(Boolean) : [])])].slice(-40);
  if (res.lists) { S.acctNames = names(S.acctNames, res.lists.acctNames); S.pointNames = names(S.pointNames, res.lists.pointNames); }
  return ch;
}

function mergeFromSheet(res, wasEmpty) {
  const st = {add:0, upd:0, del:0, cats:0, pays:0};
  const created = {cats:0, pays:0};
  // 新しい端末（記録なし）は、シートの分類・支払方法をそのまま使う
  if (wasEmpty && res.settings && res.settings.cats.length) {
    S.cats = res.settings.cats.map(c => ({id:c.id || ('c' + uid()), name:c.name, type:c.type, color:c.color || '#8A8F98'}));
    if (res.settings.pays.length) S.pays = res.settings.pays.map(p => ({id:p.id || ('p' + uid()), name:p.name, color:p.color || '#8A8F98'}));
  }
  const touched = new Set();
  for (const r of res.rows) {
    const tomb = S.dels[r.id] || 0;
    const local = findTx(r.id);
    if (r.x) {
      if (local && r.u > (local.u || 0)) { dropTx(r.id); touched.add(local.d.slice(0,7)); st.del++; }
      continue;
    }
    if (tomb && tomb >= r.u) continue;                    // 端末で消した後に、古い内容が残っていた場合
    if (local && (local.u || 0) >= r.u) continue;          // 端末の方が新しい（または同じ）
    const t = r.t === 'i' ? 'i' : 'e';
    const tx = cleanTx({id:r.id, d:r.d, t, c:resolveCat(r.cn, r.c, t, created), a:r.a, p:resolvePay(r.pn, r.p, created), n:r.n, s:local ? local.s : Date.now(), u:r.u});
    if (!tx) continue;
    if (local) { dropTx(r.id); touched.add(local.d.slice(0,7)); st.upd++; if (local.mf) tx.mf = local.mf; if (local.r) tx.r = local.r; if (local.rid) { tx.rid = local.rid; tx.rd = local.rd; if (local.rec) tx.rec = 1; } } else st.add++;
    putTx(tx); touched.add(tx.d.slice(0,7));
    delete S.dels[r.id];
  }
  st.cats = created.cats; st.pays = created.pays;
  return {st, touched};
}

async function syncNow(opt = {}) {
  if (!syncOn()) return false;
  if (syncBusy) { syncDirty = true; return false; }
  syncBusy = true; syncDirty = false;
  clearTimeout(syncTimer);
  if (!opt.silent) { syncNote = '同期中…'; if (ui.tab === 'set') renderSettings(); }
  const sent = Object.assign({}, S.dels);
  const sentI = Object.assign({}, S.idels);
  try {
    const wasEmpty = realCount() === 0 && !S.sync.last;
    const tx = allTx().map(txToWire);
    for (const id of Object.keys(sent)) tx.push({id, d:'2000-01-01', t:'e', c:'', cn:'', a:1, p:'', pn:'', n:'', u:sent[id], x:1});
    const res = await gasCall(S.sync.url, {key:S.sync.key, op:'sync', tx, settings: wasEmpty ? null : {cats:S.cats, pays:S.pays}, items:itemsToWire(), lists:{acctNames:S.acctNames, pointNames:S.pointNames}});
    const {st, touched} = mergeFromSheet(res, wasEmpty);
    const ich = mergeItems(res);
    for (const id of Object.keys(sentI)) if (S.idels[id] && S.idels[id].t === sentI[id].t) delete S.idels[id];
    for (const id of Object.keys(sent)) if (S.dels[id] === sent[id]) delete S.dels[id];
    S.sync.last = Date.now();
    syncErr = '';
    const changed = st.add + st.upd + st.del + st.cats + st.pays;
    syncNote = changed ? `シートから 追加${st.add}・更新${st.upd}・削除${st.del} を反映しました` : '';
    if (ich > 0) syncNote += `${syncNote ? '／' : ''}現資産・エントリー ${ich}件を反映しました`;
    if (ich < 0 && (S.accts.length || S.entries.length)) syncNote = '現資産・エントリーを他の端末と同期するには、スプレッドシート側のスクリプトを最新の Code.gs に入れ替えて、デプロイし直してください。';
    if (changed) { await saveAll(); } else { await saveMeta(); }
    syncBusy = false;
    render();
    if (!opt.silent) toast(changed || ich > 0 ? syncNote : '同期しました（変更なし）');
    return true;
  } catch (e) {
    syncErr = e.message || '同期できませんでした';
    syncNote = '';
    syncBusy = false;
    if (!opt.silent) toast('同期できませんでした');
    if (ui.tab === 'set') renderSettings();
    return false;
  } finally {
    syncBusy = false;
    if (syncDirty) scheduleSync();
  }
}

/* ===== 設定画面の部品 ===== */
function syncCardHtml() {
  if (!syncOn()) {
    return `<div class="card"><p class="sub-title">Googleスプレッドシート</p>
      <p class="note" style="margin:0 0 12px">記録の控えを自分のスプレッドシートに自動で残せます。シート側で直した内容も取り込めます。</p>
      <button type="button" class="btn" data-act="sync-setup" style="width:100%">連携を設定する</button></div>`;
  }
  const last = S.sync.last ? new Date(S.sync.last).toLocaleString('ja-JP') : 'まだありません';
  return `<div class="card"><p class="sub-title">Googleスプレッドシート</p>
    <dl class="kv"><dt>状態</dt><dd>${syncBusy ? '同期中…' : syncErr ? '失敗' : '連携中'}</dd><dt>最後の同期</dt><dd>${esc(last)}</dd><dt>自動同期</dt><dd>${S.sync.auto ? 'オン' : 'オフ'}</dd></dl>
    ${syncErr ? `<p class="err" style="min-height:0;margin:10px 0 0">${esc(syncErr)}</p>` : ''}
    ${syncNote && !syncErr ? `<p class="note" style="margin-left:0">${esc(syncNote)}</p>` : ''}
    <div class="stack" style="margin-top:12px"><button type="button" class="btn primary" data-act="sync-now">今すぐ同期</button><button type="button" class="btn" data-act="sync-setup">設定を変える</button></div></div>`;
}

function openSyncSheet() {
  const cur = S.sync || {};
  const sheet = openSheet(`
    <div class="sheet-head"><h2>スプレッドシート連携</h2>${closeBtn('yClose')}</div>
    <label class="field"><span class="flabel">ウェブアプリのURL</span><input type="text" id="yUrl" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(cur.url || '')}"></label>
    <label class="field"><span class="flabel">合言葉（GASのKEYと同じもの）</span><input type="text" id="yKey" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off" value="${esc(cur.key || '')}"></label>
    <label class="opt"><input type="checkbox" id="yAuto" ${cur.auto === false ? '' : 'checked'}><span>記録を変えたら自動で同期する</span></label>
    <p class="note" style="margin-left:0">URLと合言葉はこの端末の中だけに保存され、バックアップファイルには含まれません。</p>
    <p class="err" id="yErr" style="min-height:20px"></p>
    <div class="sheet-foot"><div class="actions">${syncOn() ? '<button type="button" class="btn danger" id="yOff">連携を解除</button>' : '<button type="button" class="btn" id="yNo">やめる</button>'}<button type="button" class="btn primary" id="yOk">接続を確かめて保存</button></div></div>`, 'スプレッドシート連携');
  const err = m => { sheet.querySelector('#yErr').textContent = m; };
  sheet.querySelector('#yClose').onclick = closeSheet;
  const no = sheet.querySelector('#yNo'); if (no) no.onclick = closeSheet;
  const off = sheet.querySelector('#yOff');
  if (off) off.onclick = () => {
    S.sync = {url:'', key:'', auto:true, last:null}; S.dels = {}; S.idels = {}; syncErr = ''; syncNote = '';
    saveMeta(); closeSheet(); toast('連携を解除しました（シートのデータは残ります）'); render();
  };
  sheet.querySelector('#yOk').onclick = async () => {
    const url = sheet.querySelector('#yUrl').value.trim().replace(/\s+/g, '');
    const key = sheet.querySelector('#yKey').value.trim();
    if (!SYNC_URL_RE.test(url)) { err(/\/dev$/.test(url) ? 'URLが「/dev」で終わっています。デプロイ後の「/exec」で終わるURLを入れてください。' : 'URLは「https://script.google.com/…/exec」の形です。'); return; }
    if (key.length < 8) { err('合言葉は8文字以上にしてください。'); return; }
    const btn = sheet.querySelector('#yOk'); btn.disabled = true; btn.textContent = '確認中…'; err('');
    try {
      await gasCall(url, {key, op:'ping'}, 30000);
    } catch (e) { err(e.message); btn.disabled = false; btn.textContent = '接続を確かめて保存'; return; }
    const changedTarget = url !== cur.url;
    S.sync = {url, key, auto:sheet.querySelector('#yAuto').checked, last: changedTarget ? null : cur.last || null};
    await saveMeta();
    closeSheet(); render();
    await syncNow();
  };
}
/* ===== イベント ===== */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const v = el.dataset.v;
  switch (el.dataset.act) {
    case 'prev': ui.month = shiftMonth(ui.month, -1); render(); break;
    case 'next': ui.month = shiftMonth(ui.month, 1); render(); break;
    case 'today': ui.month = curMonth(); render(); break;
    case 'goto': ui.month = el.dataset.m; render(); break;
    case 'tab': ui.tab = el.dataset.tab; render(); window.scrollTo(0, 0); break;
    case 'add': openTxSheet(null); break;
    case 'edit': { const tx = findTx(el.dataset.id); if (tx) openTxSheet(tx); break; }
    case 'filter': ui.filter = v; renderFilter(); renderList(); break;
    case 'atype': ui.aType = v; renderStats(); break;
    case 'aby': ui.aBy = v; renderStats(); break;
    case 'settype': ui.setType = v; renderSettings(); break;
    case 'editcat': { const c = S.cats.find(x => x.id === el.dataset.id); if (c) openNameSheet('cat', c); break; }
    case 'addcat': openNameSheet('cat', null, ui.setType); break;
    case 'editpay': { const p = S.pays.find(x => x.id === el.dataset.id); if (p) openNameSheet('pay', p); break; }
    case 'addpay': openNameSheet('pay', null); break;
    case 'addacct': openAcctSheet(null); break;
    case 'addentry': openEntrySheet(null); break;
    case 'editentry': { const e = S.entries.find(x => x.id === el.dataset.id); if (e) openEntrySheet(e); break; }
    case 'toggleentry': toggleEntry(el.dataset.id); break;
    case 'acctowner': ui.acctOwner = v; renderAcct(); break;
    case 'acct-refresh': refreshPrices(true); break;
    case 'acctpreset': openAcctSheet(null, el.dataset.name); break;
    case 'editacct': { const a = S.accts.find(x => x.id === el.dataset.id); if (a) openAcctSheet(a); break; }
    case 'receipt': openReceiptChoice(); break;
    case 'import-csv': $('#fileCsv').click(); break;
    case 'backup': exportBackup(); break;
    case 'restore': $('#fileBackup').click(); break;
    case 'export-month': exportCsv('month'); break;
    case 'export-all': exportCsv('all'); break;
    case 'update-app': updateApp(); break;
    case 'sync-setup': openSyncSheet(); break;
    case 'sync-now': syncNow(); break;
    case 'dismiss-install': lsSet(LS_FLAG_INSTALL, '1'); render(); break;
  }
});
$('#q').addEventListener('input', e => { ui.q = e.target.value; renderList(); });
$('#fileReceipt').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; handleReceiptFile(f); });
$('#fileCsv').addEventListener('change', e => { const fs = Array.from(e.target.files || []); e.target.value = ''; handleCsvFiles(fs); });
$('#fileBackup').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; handleBackupFile(f); });
$('#overlay').addEventListener('click', e => { if (e.target === $('#overlay') && !sheetLocked) closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#overlay').hidden) closeSheet(); });

/* 新しい版が反映されないとき：保存済みのアプリ本体だけを捨てて取り直す（記録は消えない） */
async function updateApp() {
  toast('最新版を確認しています…');
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) await reg.update();
    const files = ['./', 'index.html', 'style.css', 'app.js', 'sw.js', 'ocr-worker.js', 'manifest.webmanifest'];
    await Promise.all(files.map(f => fetch(f, {cache: 'reload'}).catch(() => null)));
    if (window.caches) { const keys = await caches.keys(); await Promise.all(keys.filter(k => k.startsWith('kakeibo-app-')).map(k => caches.delete(k))); }
  } catch (e) {}
  location.reload();
}

/* ===== ホーム画面アプリとして使えるようにする ===== */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}

/* 動作確認用（画面には影響しません） */
window.__kk = {get S() { return S; }, ui, store, syncNow, parseReceipt, parseMoneyCsv, render, preprocessImage, runOcr};

render();
initStore().then(() => { materializeRecurring(); render(); if (syncOn() && S.sync.auto) setTimeout(() => syncNow({silent:true}), 1500); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && store.loaded) { materializeRecurring(); updateEntryBadge(); if (ui.tab === 'entry') renderEntries(); } });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && store.loaded && syncOn() && S.sync.auto && (!S.sync.last || Date.now() - S.sync.last > 5 * 60 * 1000)) syncNow({silent:true});
});
})();
