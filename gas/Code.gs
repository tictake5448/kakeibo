/**
 * 月次家計簿 ⇔ Googleスプレッドシート 同期用スクリプト
 *
 * 使い方（スプレッドシートの「拡張機能 → Apps Script」に貼り付けて使う）
 *  1. 下の KEY を、自分だけの合言葉（英数字12文字以上）に書き換える
 *  2. 「デプロイ → 新しいデプロイ → ウェブアプリ」で公開し、URL（…/exec）をアプリに入れる
 *
 * シートの列（「記録」シート）
 *  A:ID  B:日付  C:種別(支出/収入)  D:分類  E:金額  F:支払方法  G:メモ
 *  H:更新(自動)  I:削除(1で削除)  J:分類ID  K:支払ID
 * シートで直接直したとき、H列は自動で更新されます（onEdit）。
 */

// ★ここを書き換える（アプリの設定画面にも同じものを入れる）
const KEY = 'ここを自分だけの合言葉に書き換える';

const TX_SHEET = '記録';
const SET_SHEET = '設定';
const TX_HEAD = ['ID', '日付', '種別', '分類', '金額', '支払方法', 'メモ', '更新(自動)', '削除', '分類ID', '支払ID'];
const SET_HEAD = ['区分', 'ID', '種別', '名前', '色'];
const NCOL = TX_HEAD.length;

function doGet() {
  return out_({ok: true, app: 'kakeibo-sync', version: 1});
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
    let req;
    try { req = JSON.parse(e.postData.contents); } catch (err) { return out_({ok: false, error: 'bad-request'}); }
    if (KEY.indexOf('ここを') === 0) return out_({ok: false, error: 'key-not-set'});
    if (!req || req.key !== KEY) return out_({ok: false, error: 'auth'});
    if (req.op === 'ping') { ensureSheets_(); return out_({ok: true, pong: true}); }
    if (req.op === 'sync') return out_(sync_(req));
    return out_({ok: false, error: 'unknown-op'});
  } catch (err) {
    return out_({ok: false, error: 'server', detail: String(err && err.message || err)});
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- シートの準備 ---------- */
function ensureSheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let tx = ss.getSheetByName(TX_SHEET);
  if (!tx) {
    tx = ss.insertSheet(TX_SHEET);
    tx.getRange(1, 1, 1, NCOL).setValues([TX_HEAD]).setFontWeight('bold');
    // 日付・文字は「書式なしテキスト」にして、勝手に日付や数式へ変換されないようにする
    ['A:D', 'F:G', 'I:K'].forEach(function (a) { tx.getRange(a).setNumberFormat('@'); });
    tx.getRange('E:E').setNumberFormat('#,##0');
    tx.getRange('H:H').setNumberFormat('0');
    tx.setFrozenRows(1);
    tx.setColumnWidth(1, 90); tx.setColumnWidth(2, 90); tx.setColumnWidth(7, 220);
  }
  let st = ss.getSheetByName(SET_SHEET);
  if (!st) {
    st = ss.insertSheet(SET_SHEET);
    st.getRange(1, 1, 1, SET_HEAD.length).setValues([SET_HEAD]).setFontWeight('bold');
    st.getRange('A:E').setNumberFormat('@');
    st.setFrozenRows(1);
  }
  return {tx: tx, st: st, tz: ss.getSpreadsheetTimeZone()};
}

/* ---------- 値の整形 ---------- */
function pad2_(n) { return (n < 10 ? '0' : '') + n; }
function normDate_(v, tz) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  const m = String(v == null ? '' : v).trim().replace(/[\/.]/g, '-').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? m[1] + '-' + pad2_(+m[2]) + '-' + pad2_(+m[3]) : '';
}
function normAmount_(v) {
  if (typeof v === 'number') return Math.round(v);
  const n = Number(String(v == null ? '' : v).replace(/[,円¥\s]/g, ''));
  return isFinite(n) ? Math.round(n) : NaN;
}
function str_(v) { return v == null ? '' : String(v); }
function newId_() { return 's' + Utilities.getUuid().replace(/-/g, '').slice(0, 10); }

function toObj_(r, tz) {
  const d = normDate_(r[1], tz);
  const a = normAmount_(r[4]);
  if (!d || !isFinite(a) || a === 0) return null;
  const x = str_(r[8]).trim();
  return {
    id: str_(r[0]).trim(), d: d, t: str_(r[2]).trim() === '収入' ? 'i' : 'e',
    cn: str_(r[3]).trim(), a: a, pn: str_(r[5]).trim(), n: str_(r[6]),
    u: Number(r[7]) || 0, x: x !== '' && x !== '0' ? 1 : 0,
    c: str_(r[9]).trim(), p: str_(r[10]).trim()
  };
}
function toRow_(o) {
  return [o.id, o.d, o.t === 'i' ? '収入' : '支出', o.cn, o.a, o.pn, o.n, o.u, o.x ? '1' : '', o.c, o.p];
}

/* ---------- 同期本体 ---------- */
function sync_(req) {
  const sh = ensureSheets_();
  const now = Date.now();
  const n = sh.tx.getLastRow() - 1;
  const raw = n > 0 ? sh.tx.getRange(2, 1, n, NCOL).getValues() : [];

  // 既存の行（読めない行はそのまま残す）
  const rows = raw.map(function (r) { return {raw: r, o: toObj_(r, sh.tz)}; });
  const byId = {};
  rows.forEach(function (row) {
    const o = row.o;
    if (!o) return;
    if (!o.id) { o.id = newId_(); o.u = now; }          // シートに手で足した行にIDを付ける
    byId[o.id] = row;
  });

  // 端末から届いた記録を反映（更新日時が新しい方を採用。同じなら端末の表記で更新）
  (req.tx || []).forEach(function (c) {
    if (!c || !c.id || !/^\d{4}-\d{2}-\d{2}$/.test(String(c.d)) || !isFinite(Number(c.a)) || Number(c.a) === 0) return;
    const o = {
      id: String(c.id), d: String(c.d), t: c.t === 'i' ? 'i' : 'e',
      cn: str_(c.cn), a: Math.round(Number(c.a)), pn: str_(c.pn), n: str_(c.n).slice(0, 120),
      u: Number(c.u) || 0, x: c.x ? 1 : 0, c: str_(c.c), p: str_(c.p)
    };
    const cur = byId[o.id];
    if (!cur) {
      if (o.x) return;                                   // 知らない記録の削除は無視
      const row = {raw: null, o: o};
      rows.push(row); byId[o.id] = row;
    } else if (o.u >= cur.o.u) {
      if (o.x) { cur.o.x = 1; cur.o.u = o.u; }          // 削除は内容を残したまま「削除」印だけ付ける
      else cur.o = o;
    }
  });

  // シートへ書き戻す
  const all = rows.map(function (row) { return row.o ? toRow_(row.o) : row.raw; });
  if (all.length) sh.tx.getRange(2, 1, all.length, NCOL).setValues(all);

  // 設定（分類・支払方法）。端末が送ってきたときだけ上書きする
  const s = req.settings;
  if (s && Array.isArray(s.cats) && Array.isArray(s.pays)) {
    const lines = [];
    s.cats.forEach(function (c) { lines.push(['分類', str_(c.id), c.type === 'i' ? '収入' : '支出', str_(c.name), str_(c.color)]); });
    s.pays.forEach(function (p) { lines.push(['支払方法', str_(p.id), '', str_(p.name), str_(p.color)]); });
    const last = sh.st.getLastRow();
    if (last > 1) sh.st.getRange(2, 1, last - 1, SET_HEAD.length).clearContent();
    if (lines.length) sh.st.getRange(2, 1, lines.length, SET_HEAD.length).setValues(lines);
  }
  const sl = sh.st.getLastRow() - 1;
  const sv = sl > 0 ? sh.st.getRange(2, 1, sl, SET_HEAD.length).getValues() : [];
  const settings = {cats: [], pays: []};
  sv.forEach(function (r) {
    if (!str_(r[3]).trim()) return;
    if (r[0] === '分類') settings.cats.push({id: str_(r[1]), type: r[2] === '収入' ? 'i' : 'e', name: str_(r[3]), color: str_(r[4])});
    else if (r[0] === '支払方法') settings.pays.push({id: str_(r[1]), name: str_(r[3]), color: str_(r[4])});
  });

  return {
    ok: true, now: now,
    rows: rows.filter(function (row) { return row.o; }).map(function (row) { return row.o; }),
    settings: settings
  };
}

/* ---------- シートを直接編集したとき：更新日時とIDを自動で付ける ---------- */
function onEdit(e) {
  try {
    const rg = e.range, sheet = rg.getSheet();
    if (sheet.getName() !== TX_SHEET) return;
    const r0 = Math.max(rg.getRow(), 2), r1 = rg.getRow() + rg.getNumRows() - 1;
    if (r1 < 2) return;
    if (rg.getColumn() === 8 && rg.getNumColumns() === 1) return;   // 更新列そのものの編集は無視
    const cnt = r1 - r0 + 1, now = Date.now();
    sheet.getRange(r0, 8, cnt, 1).setValues(Array.from({length: cnt}, function () { return [now]; }));
    const ids = sheet.getRange(r0, 1, cnt, 2).getValues();           // A:ID, B:日付
    let changed = false;
    const out = ids.map(function (r) {
      if (!str_(r[0]).trim() && str_(r[1]).trim()) { changed = true; return [newId_()]; }
      return [r[0]];
    });
    if (changed) sheet.getRange(r0, 1, cnt, 1).setValues(out);
  } catch (err) {}
}
