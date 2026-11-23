// 입주물량(공급) vs 적정수요 → data/supply.json
//  공급: 한국부동산원 청약홈 분양정보(공공데이터포털, MOLIT_KEY 와 같은 키 · 활용신청 필요) 의 입주예정월·공급세대수
//  수요: 행정안전부 주민등록 인구통계(키 불필요) × 0.5%  (부동산지인과 같은 적정수요 계산)
// 사용(bash): MOLIT_KEY=발급키 CACHE_DIR=../cache node tools/supply_sync.js
//  - 키가 없거나 활용신청 승인 전이면 인구(수요)만 저장하고 공급은 비워 둠
//  - 주소 → 구 매칭은 실거래 캐시(trade_<코드>_*.json)의 법정동 이름으로 함 (2026 행정구역 개편 지역도 자동 처리)
const fs = require('fs');
const path = require('path');

const KEY = process.env.MOLIT_KEY || '';
const REGIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'regions.json'), 'utf8'));
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const CACHE = process.env.CACHE_DIR || path.join(__dirname, 'cache');
fs.mkdirSync(DATA, { recursive: true });
const DEMAND_RATE = 0.005;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = s => { const v = parseFloat(String(s ?? '').replace(/[,\s"]/g, '')); return isFinite(v) ? v : 0; };

/* ---------- 수요: 주민등록 인구 ---------- */
const MOIS = 'https://jumin.mois.go.kr/downloadCsv.do';
async function moisCsv(kind, y0, m0, y1, m1) {
  const body = new URLSearchParams({ sltOrgType: '1', sltOrgLvl1: 'A', sltOrgLvl2: '', gender: 'gender', genderPer: 'genderPer', generation: 'generation',
    sltUndefType: '', searchYearStart: y0, searchMonthStart: m0, searchYearEnd: y1, searchMonthEnd: m1, sltOrderType: '1', sltOrderValue: 'ASC', category: kind, state: '2' });
  for (let t = 0; t < 4; t++) {
    try {
      const r = await fetch(`${MOIS}?searchYearMonth=${kind}&xlsStats=2`, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      const txt = new TextDecoder('euc-kr').decode(await r.arrayBuffer());
      if (txt.startsWith('"행정구역"')) return txt.trim().split(/\r?\n/).map(l => l.slice(1, -1).split('","'));
    } catch (e) { /* 재시도 */ }
    await sleep(3000 * (t + 1));
  }
  return null;
}
// 행정기관코드 10자리 앞 5자리 = 대시보드 지역코드 (80개 모두 1:1 확인)
function popByRegion(rows, col) {
  const out = {};
  for (const c of rows.slice(1)) {
    const m = c[0].match(/\((\d{10})\)/); if (!m) continue;
    const k = m[1].slice(0, 5); if (REGIONS[k] && num(c[col])) out[k] = num(c[col]);
  }
  return out;
}
async function population() {
  const now = new Date(Date.now() + 9 * 3600e3);
  const lastY = now.getUTCFullYear() - 1;
  const yr = await moisCsv('year', '2016', '12', String(lastY), '12');
  const hist = {};
  if (yr) {
    const head = yr[0];
    head.forEach((h, i) => { const m = h.match(/^(\d{4})년_총인구수$/); if (m) for (const [k, v] of Object.entries(popByRegion(yr, i))) (hist[k] = hist[k] || {})[m[1]] = v; });
  }
  // 최신 월: 매월 1일 공표라 지난달부터 시도, 없으면 그 전달
  let latest = null, latestYm = null;
  for (let back = 1; back <= 3 && !latest; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const y = String(d.getUTCFullYear()), m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const rows = await moisCsv('month', y, m, y, m);
    if (rows) { const p = popByRegion(rows, 1); if (Object.keys(p).length > 70) { latest = p; latestYm = y + m; } }
  }
  if (!latest) console.warn('! 주민등록 인구 최신월을 받지 못함');
  return { hist, latest: latest || {}, latestYm };
}

/* ---------- 법정동 → 지역코드 (실거래 캐시에서) ---------- */
function dongIndex() {
  const idx = {}; // '봉담읍' → Set(코드)
  if (!fs.existsSync(CACHE)) return idx;
  for (const f of fs.readdirSync(CACHE)) {
    const m = f.match(/^trade_(\d{5})_\d{6}\.json$/); if (!m || !REGIONS[m[1]]) continue;
    let rows; try { rows = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8')); } catch (e) { continue; }
    for (const r of rows || []) for (const t of String(r.d || '').split(/\s+/)) if (t) (idx[t] = idx[t] || new Set()).add(m[1]);
  }
  return idx;
}
const SIDO = { 서울: '서울', 인천: '인천', 경기: '경기' };
function sidoOf(addr) { const a = addr.trim(); for (const k in SIDO) if (a.startsWith(k)) return SIDO[k]; return null; }
// 주소 문자열 → 지역코드 (못 찾으면 null)
function matchRegion(addr, idx) {
  const sd = sidoOf(addr); if (!sd) return null;
  const toks = addr.replace(/[(),]/g, ' ').split(/\s+/).filter(Boolean);
  const inSido = Object.keys(REGIONS).filter(k => REGIONS[k].startsWith(sd + ' '));
  // 경기는 시 이름으로 먼저 좁힘 (예: '수원시' → '경기 수원 ...', '광명시' → '경기 광명시')
  let cand = inSido;
  if (sd === '경기') {
    const city = toks.find(t => /시$/.test(t) && t !== '경기도');
    if (city) { const c = city.replace(/시$/, ''); const f = inSido.filter(k => REGIONS[k] === '경기 ' + city || REGIONS[k].startsWith('경기 ' + c + ' ')); if (f.length) cand = f; }
    else { const gun = toks.find(t => /군$/.test(t)); if (gun) { const f = inSido.filter(k => REGIONS[k] === '경기 ' + gun); if (f.length) cand = f; } }
  }
  if (cand.length === 1) return cand[0];
  // 구 이름이 그대로 있으면 사용 (개편 전 이름과 겹치는 인천 중구·서구·동구는 동으로 판단)
  for (const t of toks) if (/구$/.test(t) && !(sd === '인천' && /^(중구|서구|동구|남구)$/.test(t))) {
    const f = cand.filter(k => REGIONS[k].endsWith(' ' + t)); if (f.length === 1) return f[0];
  }
  // 옛 화성시 동탄면 주소 → 동탄구
  if (toks.some(t => t.startsWith('동탄'))) { const f = cand.filter(k => REGIONS[k].endsWith(' 동탄구')); if (f.length === 1) return f[0]; }
  // 법정동(읍·면·동·리) 이름으로
  const votes = {};
  for (const t of toks) {
    const s = idx[t] || idx[t.replace(/\d+가$/, '')]; if (!s) continue;
    for (const k of s) if (cand.includes(k)) votes[k] = (votes[k] || 0) + 1;
  }
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  if (best.length && (best.length === 1 || best[0][1] > best[1][1])) return best[0][0];
  return null;
}

/* ---------- 공급: 청약홈 분양정보 ---------- */
const APPLY = 'https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail';
async function applyhome() {
  if (!KEY) return { err: '키 없음' };
  const keyParam = KEY.includes('%') ? KEY : encodeURIComponent(KEY);
  const all = [];
  for (const area of ['서울', '경기', '인천']) {
    for (let page = 1; page < 200; page++) {
      const url = `${APPLY}?page=${page}&perPage=500&serviceKey=${keyParam}&cond%5BSUBSCRPT_AREA_CODE_NM%3A%3AEQ%5D=${encodeURIComponent(area)}`;
      let j = null, raw = '';
      for (let t = 0; t < 4; t++) {
        try { const r = await fetch(url); raw = await r.text(); j = JSON.parse(raw); } catch (e) { j = null; }
        if (j && Array.isArray(j.data)) break;
        if (j && (j.code === -401 || j.code === -4)) break;
        await sleep(2000 * (t + 1));
      }
      if (!j || !Array.isArray(j.data)) return { err: (j && (j.msg || j.message)) || raw.slice(0, 200) || '응답 없음' };
      all.push(...j.data);
      if (page * 500 >= (j.matchCount ?? j.totalCount ?? 0) || !j.data.length) break;
    }
  }
  return { rows: all };
}

(async () => {
  const pop = await population();
  console.log(`인구: 연말 ${Object.keys(pop.hist).length}개 지역, 최신(${pop.latestYm}) ${Object.keys(pop.latest).length}개 지역`);
  const idx = dongIndex();
  const ah = await applyhome();
  const sup = {}, apts = {}, unmatched = [];
  let n = 0, from = null;
  if (ah.rows) {
    if (ah.rows[0]) console.log('샘플 필드: ' + Object.entries(ah.rows[0]).filter(([k]) => /SUPLY|HSHLD|CO$|MVN/.test(k)).map(([k, v]) => k + '=' + v).join(', '));
    const seen = new Set();
    for (const r of ah.rows) {
      const id = r.HOUSE_MANAGE_NO; if (seen.has(id)) continue; seen.add(id);
      if (r.HOUSE_SECD && r.HOUSE_SECD !== '01') continue; // APT만
      const ym = String(r.MVN_PREARNGE_YM || '').replace(/\D/g, '').slice(0, 6), hh = num(r.TOT_SUPLY_HSHLDRCO);
      if (ym.length !== 6 || !hh) continue;
      const k = matchRegion(String(r.HSSPLY_ADRES || ''), idx);
      if (!k) { unmatched.push(`${r.HOUSE_NM} · ${r.HSSPLY_ADRES}`); continue; }
      const y = ym.slice(0, 4);
      (sup[k] = sup[k] || {})[y] = (sup[k][y] || 0) + hh;
      (apts[k] = apts[k] || []).push([r.HOUSE_NM, ym, hh, String(r.RCRIT_PBLANC_DE || '').slice(0, 7)]);
      const pd = String(r.RCRIT_PBLANC_DE || '').slice(0, 7); if (pd && (!from || pd < from)) from = pd;
      n++;
    }
    for (const k in apts) apts[k].sort((a, b) => a[1].localeCompare(b[1]));
    console.log(`청약홈: ${ah.rows.length}건 중 ${n}개 단지 반영, 주소 매칭 실패 ${unmatched.length}건 (공고 ${from}~)`);
    if (unmatched.length) console.log('  매칭 실패 예: ' + unmatched.slice(0, 15).join(' / '));
  } else console.warn(`! 청약홈 분양정보 못 받음: ${ah.err} — 수요만 저장`);

  const regions = {};
  for (const k of Object.keys(REGIONS)) {
    const p = pop.latest[k] || (pop.hist[k] && pop.hist[k][Object.keys(pop.hist[k]).sort().pop()]) || null;
    regions[k] = { pop: p, demand: p ? Math.round(p * DEMAND_RATE) : null, popHist: pop.hist[k] || {}, sup: sup[k] || {}, apts: apts[k] || [] };
  }
  fs.writeFileSync(path.join(DATA, 'supply.json'), JSON.stringify({
    updated: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' KST',
    popYm: pop.latestYm, demandRate: DEMAND_RATE, supplyOk: !!ah.rows, supplyErr: ah.rows ? null : ah.err, supplyFrom: from, unmatched: unmatched.length, regions,
  }));
  console.log('저장: ' + path.join(DATA, 'supply.json'));
})();
