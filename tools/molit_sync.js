// 국토부 아파트 매매·전월세 실거래가(공공데이터포털) → 대시보드용 JSON
// 사용(bash): MOLIT_KEY=발급키 node molit_sync.js [시작월=202001]
// 결과: data/index.json (검색용 목록) + data/r/<지역코드>.json (단지·평형별 상세)
// 지난달 이전 자료는 cache/ 에 저장해 다시 받지 않음. 호출 한도 초과 시 받은 데까지만 만들고 다음 실행에서 이어 받음.
const fs = require('fs');
const path = require('path');

const KEY = process.env.MOLIT_KEY;
if (!KEY) { console.error('환경변수 MOLIT_KEY 가 없습니다.'); process.exit(1); }
const START = process.argv[2] || '202001';
const REGIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'regions.json'), 'utf8'));
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const CACHE = process.env.CACHE_DIR || path.join(__dirname, 'cache');
fs.mkdirSync(path.join(DATA, 'r'), { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });
const CONC = 4;

const EP = {
  trade: 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade',
  rent: 'https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent',
};
function ymRange(start) {
  const out = []; let y = +start.slice(0, 4), m = +start.slice(4);
  const now = new Date(); const end = now.getFullYear() * 100 + now.getMonth() + 1;
  while (y * 100 + m <= end) { out.push(y + String(m).padStart(2, '0')); m++; if (m > 12) { m = 1; y++; } }
  return out;
}
const YMS = ymRange(START);
const FRESH = new Set(YMS.slice(-2)); // 최근 2개월은 신고 지연 때문에 항상 새로 받음
const tag = (x, t) => { const m = x.match(new RegExp('<' + t + '>([\\s\\S]*?)</' + t + '>')); return m ? m[1].trim() : ''; };
const num = s => { const v = parseFloat(String(s).replace(/,/g, '')); return isFinite(v) ? v : 0; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const keyParam = KEY.includes('%') ? KEY : encodeURIComponent(KEY);
const quota = { trade: false, rent: false }; let calls = 0;

// 전월세는 2021-06부터 신규/갱신 구분이 있어 그 이후는 계약유형 포함 캐시(rent2)를 씀
const cacheFile = (kind, lawd, ym) => path.join(CACHE, `${kind === "rent" && ym >= "202106" ? "rent2" : kind}_${lawd}_${ym}.json`);
async function fetchMonth(kind, lawd, ym) {
  const cf = cacheFile(kind, lawd, ym);
  if (fs.existsSync(cf) && !FRESH.has(ym)) return JSON.parse(fs.readFileSync(cf, 'utf8'));
  if (quota[kind] || process.env.OFFLINE) return fs.existsSync(cf) ? JSON.parse(fs.readFileSync(cf, 'utf8')) : null;
  const rows = []; let page = 1;
  for (;;) {
    const url = `${EP[kind]}?serviceKey=${keyParam}&LAWD_CD=${lawd}&DEAL_YMD=${ym}&numOfRows=1000&pageNo=${page}`;
    let xml = '';
    for (let t = 0; t < 6; t++) {
      try { xml = await (await fetch(url)).text(); calls++; } catch (e) { xml = ''; }
      if (xml.includes('<response>') || (xml.includes('<') && !/LIMITED_NUMBER|EXCEEDS/.test(xml))) break;
      await sleep(2000 * (t + 1)); // 초당 제한·일시 오류는 쉬었다가 재시도
    }
    if (/LIMITED_NUMBER|EXCEEDS/.test(xml) && !xml.includes('<response>')) {
      if (!quota[kind]) console.warn(`! ${kind} 호출 한도 초과(${tag(xml, 'errMsg') || tag(xml, 'returnAuthMsg')}) — 받은 데까지 저장`);
      quota[kind] = true; return null;
    }
    const err = tag(xml, 'returnAuthMsg') || (tag(xml, 'resultCode') && !/^0+$/.test(tag(xml, 'resultCode')) ? tag(xml, 'resultMsg') : '');
    if (err || !xml) { console.warn(`! ${kind} ${lawd} ${ym}: ${err || '응답 없음'}`); return null; }
    for (const it of xml.match(/<item>[\s\S]*?<\/item>/g) || []) {
      const base = { n: tag(it, 'aptNm'), d: tag(it, 'umdNm'), a: num(tag(it, 'excluUseAr')), y: num(tag(it, 'buildYear')), ym, dd: num(tag(it, 'dealDay')) };
      if (kind === 'trade') { if (tag(it, 'cdealType')) continue; rows.push({ ...base, p: num(tag(it, 'dealAmount')), f: num(tag(it, 'floor')) }); }
      else rows.push({ ...base, dep: num(tag(it, 'deposit')), mr: num(tag(it, 'monthlyRent')), ct: tag(it, 'contractType') });
    }
    if (page * 1000 >= num(tag(xml, 'totalCount'))) break;
    page++;
  }
  fs.writeFileSync(cf, JSON.stringify(rows));
  return rows;
}

async function pool(tasks, n) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < tasks.length) { const k = i++; await tasks[k](); } })); }

const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = v => v == null ? null : Math.round(v / 1000) / 10; // 만원 → 억
// 3개월 이동 평균 고점 (거래 2건 이상인 구간만)
function rollingPeak(byYm) {
  let best = null;
  for (let i = 2; i < YMS.length; i++) {
    const win = [YMS[i - 2], YMS[i - 1], YMS[i]].flatMap(m => byYm[m] || []);
    if (win.length < 2) continue;
    const v = avg(win);
    if (!best || v > best[1]) best = [YMS[i], v, win.length];
  }
  return best ? [best[0], r1(best[1]), best[2]] : null;
}

// ---- 시세 현실화 보정 ----
const CONV = 0.055; // 전월세 전환율 (반전세 → 전세 환산)
const band = a => a < 60 ? 'S' : a < 85 ? 'M' : 'L';
const floorAdj = f => f <= 1 ? 1.06 : f === 2 ? 1.04 : f === 3 ? 1.02 : 1; // 저층 → 중층 환산
// 구·면적대별 월간 ㎡당 가격 지수 (3개월 평균으로 평활)
function buildIndex(list, valueOf) {
  const by = {};
  for (const r of list) { const k = band(r.a); ((by[k] = by[k] || {})[r.ym] = by[k][r.ym] || []).push(valueOf(r) / r.a); }
  const idx = {};
  for (const k of Object.keys(by)) {
    const m = {}; for (const ym of YMS) { const v = by[k][ym]; if (v && v.length >= 3) m[ym] = median(v); }
    const sm = {}; YMS.forEach((ym, i) => { const w = [YMS[i - 1], ym, YMS[i + 1]].filter(x => x && m[x] != null).map(x => m[x]); if (w.length) sm[ym] = avg(w); });
    const have = YMS.filter(ym => sm[ym] != null);
    if (!have.length) continue;
    const now = avg(have.slice(-2).map(ym => sm[ym])); // 마지막 달은 신고가 덜 들어와서 최근 2개월 평균
    idx[k] = { sm, now };
  }
  return idx;
}
function adjEstimate(rows, idx, valueOf, useFloor) {
  const recent = new Set(YMS.slice(-12));
  const rs = rows.filter(r => recent.has(r.ym)).sort((x, y) => (y.ym + String(y.dd).padStart(2, '0')).localeCompare(x.ym + String(x.dd).padStart(2, '0'))).slice(0, 10);
  if (!rs.length) return null;
  const vals = rs.map(r => {
    const I = idx[band(r.a)]; let f = 1;
    if (I) { let k = YMS.indexOf(r.ym); while (k > 0 && I.sm[YMS[k]] == null) k--; const base = I.sm[YMS[k]]; if (base) f = I.now / base; }
    return valueOf(r) * f * (useFloor ? floorAdj(r.f) : 1);
  });
  return [r1(median(vals)), rs.length, rs[0].ym];
}
const convJeon = r => r.dep + r.mr * 12 / CONV;
// 가장 마지막 거래 1건을 지금 시점으로 환산 [보정값, 원래값, 거래일, 층, 시점보정%]
function lastAdj(rows, idx, valueOf, useFloor) {
  if (!rows.length) return null;
  const r = rows.reduce((b, x) => !b || (x.ym + String(x.dd).padStart(2, '0')) > (b.ym + String(b.dd).padStart(2, '0')) ? x : b, null);
  const I = idx[band(r.a)]; let f = 1;
  if (I) { let k = YMS.indexOf(r.ym); while (k > 0 && I.sm[YMS[k]] == null) k--; const base = I.sm[YMS[k]]; if (base) f = I.now / base; }
  const fl = useFloor ? floorAdj(r.f) : 1;
  return [r1(valueOf(r) * f * fl), r1(valueOf(r)), r.ym + String(r.dd).padStart(2, '0'), r.f ?? null, Math.round((f * fl - 1) * 1000) / 10];
}

// 2021~22 고점 실거래 매매가 ÷ 같은 시기(±1개월, 없으면 ±2개월) 전세 실거래 중위값
function peakRatio(top, je) {
  if (!top) return null;
  const i = YMS.indexOf(top.ym);
  for (const w of [1, 2]) {
    const win = new Set(YMS.slice(Math.max(0, i - w), i + w + 1));
    const js = je.filter(r => win.has(r.ym)).map(r => r.dep);
    if (js.length) { const jm = median(js); return [Math.round(jm / top.p * 1000) / 10, r1(top.p), top.ym + String(top.dd).padStart(2, '0'), r1(jm), js.length, w]; }
  }
  return null;
}
function summarize(regionRows) {
  const allTr = [], allJe = [];
  for (const { kind, rows } of regionRows) for (const r of rows) {
    if (kind === 'trade') allTr.push(r);
    else if (r.ct !== '갱신' && (r.mr === 0 || r.dep >= convJeon(r) * 0.3)) allJe.push(r);
  }
  const tIdx = buildIndex(allTr, r => r.p), jIdx = buildIndex(allJe, convJeon);
  const apts = new Map();
  for (const { kind, rows } of regionRows) for (const r of rows) {
    const id = r.d + '|' + r.n;
    if (!apts.has(id)) apts.set(id, { n: r.n, d: r.d, y: r.y, t: new Map() });
    const A = apts.get(id); if (!A.y && r.y) A.y = r.y;
    const b = Math.floor(r.a);
    if (!A.t.has(b)) A.t.set(b, { tr: [], je: [], wo: 0 });
    const T = A.t.get(b);
    if (kind === 'trade') T.tr.push(r); else if (r.mr > 0) { T.wo++; if (r.ct !== '갱신' && r.dep >= convJeon(r) * 0.3) (T.jc = T.jc || []).push(r); } else if (r.ct === '갱신') T.renew = (T.renew || 0) + 1; else T.je.push(r); // 전세는 신규 계약만 (갱신은 5% 상한이라 시세보다 낮음)
  }
  const recent3 = new Set(YMS.slice(-3)), recent12 = new Set(YMS.slice(-12));
  const out = [];
  for (const A of apts.values()) {
    const types = [];
    for (const [a, T] of A.t) {
      if (!T.tr.length && !T.je.length) continue;
      const trBy = {}, jeBy = {};
      for (const r of T.tr) (trBy[r.ym] = trBy[r.ym] || []).push(r.p);
      for (const r of T.je) (jeBy[r.ym] = jeBy[r.ym] || []).push(r.dep);
      const top = T.tr.reduce((b, r) => !b || r.p > b.p ? r : b, null);
      const top21 = T.tr.filter(r => r.ym >= '202101' && r.ym <= '202212').reduce((b, r) => !b || r.p > b.p ? r : b, null); // 2021~22 상승장 고점
      const last = T.tr.reduce((b, r) => !b || (r.ym + String(r.dd).padStart(2, '0')) > (b.ym + String(b.dd).padStart(2, '0')) ? r : b, null);
      // 분기별 평균 [분기, 매매평균, 전세평균]
      const q = {};
      for (const r of T.tr) { const k = r.ym.slice(0, 4) + 'Q' + Math.ceil(+r.ym.slice(4) / 3); (q[k] = q[k] || [[], []])[0].push(r.p); }
      for (const r of T.je) { const k = r.ym.slice(0, 4) + 'Q' + Math.ceil(+r.ym.slice(4) / 3); (q[k] = q[k] || [[], []])[1].push(r.dep); }
      const qs = Object.keys(q).sort().map(k => [k, r1(avg(q[k][0])), r1(avg(q[k][1]))]);
      types.push({
        a,
        t3: r1(median(T.tr.filter(r => recent3.has(r.ym)).map(r => r.p))),
        j3: r1(median(T.je.filter(r => recent3.has(r.ym)).map(r => r.dep))),
        t12: r1(median(T.tr.filter(r => recent12.has(r.ym)).map(r => r.p))),
        j12: r1(median(T.je.filter(r => recent12.has(r.ym)).map(r => r.dep))),
        last: last ? [last.ym + String(last.dd).padStart(2, '0'), r1(last.p), last.f] : null,
        top: top ? [top.ym + String(top.dd).padStart(2, '0'), r1(top.p), top.f] : null,
        top21: top21 ? [top21.ym + String(top21.dd).padStart(2, '0'), r1(top21.p), top21.f] : null,
        pk21: peakRatio(top21, T.je),
        tPk: rollingPeak(trBy), jPk: rollingPeak(jeBy),
        nt: T.tr.filter(r => recent12.has(r.ym)).length, nj: T.je.filter(r => recent12.has(r.ym)).length, nw: T.wo,
        ntAll: T.tr.length, njAll: T.je.length,
        q: qs,
        tAdj: adjEstimate(T.tr, tIdx, r => r.p, true),
        jAdj: adjEstimate(T.je.concat(T.jc || []), jIdx, convJeon, false),
        tLast: lastAdj(T.tr, tIdx, r => r.p, true),
        jLast: lastAdj(T.je.concat(T.jc || []), jIdx, convJeon, false),
      });
    }
    if (!types.length) continue;
    types.sort((x, y) => x.a - y.a);
    out.push({ n: A.n, d: A.d, y: A.y, types });
  }
  return out.sort((x, y) => x.n.localeCompare(y.n, 'ko'));
}

(async () => {
  const index = [];
  const codes = Object.keys(REGIONS);
  // 받는 순서: 최근 13개월 → 2021~2022 고점 구간 → 나머지 (한도에 걸려도 중요한 구간부터 채워지게)
  const pri = ym => YMS.slice(-13).includes(ym) ? 0 : (ym >= '202101' && ym <= '202212') ? 1 : 2;
  const order = [...YMS].sort((x, y) => pri(x) - pri(y) || y.localeCompare(x));
  const jobs = [];
  for (const ym of order) for (const lawd of codes) for (const kind of ['trade', 'rent']) jobs.push(() => fetchMonth(kind, lawd, ym));
  let done = 0;
  await pool(jobs.map(j => async () => { await j(); if (++done % 1000 === 0) console.log(`진행 ${done}/${jobs.length} · 호출 ${calls}`); }), CONC);
  const coverage = {}, regionStats = {}; let oldRentTotal = 0;
  for (const lawd of codes) {
    const regionRows = []; let missing = 0, oldRent = 0; const have = [];
    for (const ym of YMS) for (const kind of ['trade', 'rent']) {
      let cf = cacheFile(kind, lawd, ym);
      // 신규/갱신 구분 자료를 아직 못 받은 달은 이전 자료(전체 계약)로 임시 대체
      if (!fs.existsSync(cf) && kind === 'rent') { cf = path.join(CACHE, `rent_${lawd}_${ym}.json`); if (fs.existsSync(cf)) oldRent++; }
      if (fs.existsSync(cf)) { regionRows.push({ kind, rows: JSON.parse(fs.readFileSync(cf, 'utf8')) }); if (kind === 'trade') have.push(ym); } else missing++;
    }
    coverage[lawd] = have.length; if (oldRent) oldRentTotal += oldRent;
    const apts = summarize(regionRows);
    // 지역 전세가율: 단지·평형별 (전세 ÷ 매매) 의 중위값. 지금(최근 3개월, 없으면 1년)과 분기별
    const nowR = [], qR = {};
    for (const a of apts) for (const t of a.types) {
      const p = t.t3 ?? t.t12, j = t.j3 ?? t.j12;
      if (p && j && j < p * 1.2) nowR.push(j / p * 100);
      for (const [k, tp, tj] of t.q) if (tp && tj && tj < tp * 1.2) (qR[k] = qR[k] || []).push(tj / tp * 100);
    }
    const rnd = v => v == null ? null : Math.round(v * 10) / 10;
    regionStats[lawd] = { now: rnd(median(nowR)), n: nowR.length, q: Object.fromEntries(Object.keys(qR).sort().filter(k => qR[k].length >= 5).map(k => [k, rnd(median(qR[k]))])) };
    fs.writeFileSync(path.join(DATA, 'r', lawd + '.json'), JSON.stringify({ l: lawd, g: REGIONS[lawd], have, apts }));
    for (const a of apts) {
      const main = a.types.reduce((b, t) => (t.nt + t.nj) > (b.nt + b.nj) ? t : b, a.types[0]);
      index.push([a.n, a.d, lawd, a.y, a.types.reduce((v, t) => v + t.ntAll + t.njAll, 0), main.t3 ?? main.t12 ?? (main.last && main.last[1]), a.types.map(t => t.a)]);
    }
    console.log(`${REGIONS[lawd]}(${lawd}) 단지 ${apts.length}개${missing ? ` · 빠진 달 ${missing}` : ''} · 누적 호출 ${calls}`);
  }
  fs.writeFileSync(path.join(DATA, 'index.json'), JSON.stringify({
    updated: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' KST', from: YMS[0], to: YMS[YMS.length - 1], months: YMS.length, coverage, regionStats, oldRentMonths: oldRentTotal, partial: quota.trade || quota.rent,
    regions: REGIONS, source: '국토교통부 실거래가 공개시스템 (공공데이터포털 API)', apts: index,
  }));
  const size = fs.readdirSync(path.join(DATA, 'r')).reduce((s, f) => s + fs.statSync(path.join(DATA, 'r', f)).size, 0);
  console.log(`완료: 단지 ${index.length}개 · API 호출 ${calls}회 · 상세 ${(size / 1e6).toFixed(1)}MB${quota.trade || quota.rent ? ' · 한도 초과로 일부 누락(다시 실행하면 이어 받음)' : ''}`);
})().catch(e => { console.error('실패:', e.message); process.exit(1); });
