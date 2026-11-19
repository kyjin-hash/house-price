// 과거 실거래 원자료(cache/*.json)를 지역별 압축 파일(history/<코드>.json.gz)로 묶거나 푸는 도구
// 묶기: node tools/history.js pack <cache폴더> <history폴더>
// 풀기: node tools/history.js unpack <history폴더> <cache폴더>   (GitHub Actions에서 사용)
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const [mode, src, dst] = process.argv.slice(2);
const CT = { '': 0, '신규': 1, '갱신': 2 }, CTR = ['', '신규', '갱신'];
fs.mkdirSync(dst, { recursive: true });
if (mode === 'pack') {
  const byL = {};
  for (const f of fs.readdirSync(src)) { const m = f.match(/^(trade|rent2?|rent)_(\d+)_(\d{6})\.json$/); if (m) (byL[m[2]] = byL[m[2]] || []).push([m[1], m[3], f]); }
  for (const [l, files] of Object.entries(byL)) {
    const apts = [], idx = new Map(), out = {};
    const k = r => { const key = r.n + '|' + r.d + '|' + (r.y || 0); if (!idx.has(key)) { idx.set(key, apts.length); apts.push([r.n, r.d, r.y || 0]); } return idx.get(key); };
    for (const [kind, ym, f] of files) {
      const rows = JSON.parse(fs.readFileSync(path.join(src, f), 'utf8'));
      out[kind + '_' + ym] = rows.map(r => kind === 'trade' ? [k(r), r.a, r.dd, r.p, r.f] : [k(r), r.a, r.dd, r.dep, r.mr, CT[r.ct || ''] || 0]);
    }
    fs.writeFileSync(path.join(dst, l + '.json.gz'), zlib.gzipSync(JSON.stringify({ apts, files: out }), { level: 9 }));
  }
} else if (mode === 'unpack') {
  for (const f of fs.readdirSync(src).filter(f => f.endsWith('.json.gz'))) {
    const l = f.replace('.json.gz', ''); const { apts, files } = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(src, f))));
    for (const [key, rows] of Object.entries(files)) {
      const [kind, ym] = key.split('_'); const cf = path.join(dst, `${kind}_${l}_${ym}.json`);
      if (fs.existsSync(cf)) continue; // 이미 받은 최신 자료가 있으면 유지
      const objs = rows.map(x => { const [n, d, y] = apts[x[0]]; return kind === 'trade' ? { n, d, a: x[1], y, ym, dd: x[2], p: x[3], f: x[4] } : { n, d, a: x[1], y, ym, dd: x[2], dep: x[3], mr: x[4], ct: CTR[x[5]] }; });
      fs.writeFileSync(cf, JSON.stringify(objs));
    }
  }
}
console.log(mode, 'done');
