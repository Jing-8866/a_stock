# -*- coding: utf-8 -*-
import re, json

API = "http://localhost:7373"
OUT = "A股分析工具_实时版.html"

APP_JS = r"""
/* ================= 实时数据层 ================= */
const API = window.__API__ || 'http://localhost:7373';
const Q = (url, opt) => fetch(API + url, opt || undefined).then(r => r.json().then(j => r.ok ? j : Promise.reject(new Error(j.error || '请求失败'))));
const jget = url => fetch(url).then(r => r.json());
const num = (v, d = 2) => {
  if (v === null || v === undefined || v === '' || v === '—') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? null : n;
};
const fmt = (v, d = 2) => { const n = num(v, d); return n === null ? '—' : (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(d)); };
const cls = v => (num(v) === null) ? 'muted' : (v > 0 ? 'up' : (v < 0 ? 'down' : 'muted'));
const sign = v => (num(v) || 0) > 0 ? '+' : '';
const today = () => new Date().toLocaleString('zh-CN', { hour12: false });

/* 代码标准化 */
const norm = s => {
  s = String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/^\d{6}$/.test(s)) {
    const n = s[0]; s = (n === '6' || n === '5' || n === '9') ? 'sh' + s : 'sz' + s;
  } return s;
};
const mktOf = code => (String(code).startsWith('sh') ? '沪' : (String(code).startsWith('sz') ? '深' : '—'));

/* 综合评分引擎 */
function score(d) {
  const S = { val: 0, fin: 0, tech: 0, fund: 0, total: 0, checks: [] };
  // 估值
  let sv = 50;
  if (d.pe !== null) { if (d.pe < 10) sv += 30; else if (d.pe < 18) sv += 22; else if (d.pe < 30) sv += 10; else if (d.pe < 50) sv += 0; else sv -= 20; }
  if (d.pb !== null) { if (d.pb < 1) sv += 15; else if (d.pb < 2) sv += 8; else if (d.pb > 8) sv -= 10; }
  if (d.dy !== null) { if (d.dy > 5) sv += 15; else if (d.dy > 3) sv += 10; else if (d.dy < 1) sv -= 5; }
  S.val = Math.max(0, Math.min(100, sv));
  if (sv >= 75) S.checks.push(['ok', '估值极具吸引力', `PE ${fmt(d.pe)} / PB ${fmt(d.pb)} / 股息 ${fmt(d.dy)}%，低估与高股息叠加`, 1]);
  else if (sv >= 55) S.checks.push(['ok', '估值合理', `PE ${fmt(d.pe)}，未明显泡沫化`, 1]);
  else if (sv < 35) S.checks.push(['bad', '估值偏贵', `PE ${fmt(d.pe)} 偏高，安全边际不足`, 1]);
  else S.checks.push(['warn', '估值中性', `PE ${fmt(d.pe)}，处于中等水平`, 1]);
  // 财务
  let sf = 50;
  if (d.roe !== null) { if (d.roe > 20) sf += 25; else if (d.roe > 15) sf += 18; else if (d.roe > 10) sf += 10; else if (d.roe < 0) sf -= 40; }
  if (d.npYoY !== null) { if (d.npYoY > 30) sf += 20; else if (d.npYoY > 0) sf += 10; else if (d.npYoY < -20) sf -= 25; else if (d.npYoY < 0) sf -= 12; }
  if (d.revYoY !== null && d.npYoY !== null && d.revYoY < 0 && d.npYoY > 0) sf += 5;
  if (d.debt !== null) { if (d.debt > 85) sf -= 20; else if (d.debt < 30) sf += 10; }
  if (d.cf !== null && d.cf > 0) sf += 10; else if (d.cf !== null && d.cf < 0) sf -= 15;
  S.fin = Math.max(0, Math.min(100, sf));
  if (d.roe !== null && d.roe > 20) S.checks.push(['ok', '盈利能力优秀', `ROE ${fmt(d.roe)}%，长期股东回报高`, 2]);
  if (d.npYoY !== null && d.npYoY > 30) S.checks.push(['ok', '业绩高增', `净利同比 +${fmt(d.npYoY)}%`, 2]);
  if (d.npYoY !== null && d.npYoY < 0) S.checks.push(['warn', '业绩承压', `净利同比 ${sign(d.npYoY)}${fmt(d.npYoY)}%，关注拐点`, 2]);
  if (d.cf !== null && d.cf < 0) S.checks.push(['bad', '现金流为负', `经营性现金流 ${sign(d.cf)}${fmt(d.cf)}亿`, 2]);
  if (d.debt !== null && d.debt > 85) S.checks.push(['warn', '高杠杆', `资产负债率 ${fmt(d.debt)}%`, 2]);
  // 技术
  let st = 50;
  if (d.price && d.ma20) { if (d.price > d.ma20) st += 12; else st -= 10; if (d.price > d.ma60) st += 10; else st -= 8; if (d.price > d.ma250) st += 8; else st -= 12; }
  if (d.rsi !== null) { if (d.rsi < 30) st += 12; else if (d.rsi < 45) st += 6; else if (d.rsi > 80) st -= 18; else if (d.rsi > 70) st -= 8; }
  if (d.macd !== null) { if (d.macd > 0) st += 8; else st -= 6; }
  if (d.kdjJ !== null && d.kdjJ < 20) st += 8; else if (d.kdjJ !== null && d.kdjJ > 90) st -= 10;
  S.tech = Math.max(0, Math.min(100, st));
  if (d.price && d.ma250 && d.price > d.ma250 && d.price > d.ma60) S.checks.push(['ok', '多头排列', '股价站上60/250日均线，中长期趋势向上', 3]);
  else if (d.price && d.ma250 && d.price < d.ma250) S.checks.push(['warn', '趋势偏弱', '股价低于250日均线（年线），中长期下行趋势', 3]);
  if (d.rsi !== null && d.rsi > 75) S.checks.push(['warn', '短线超买', `RSI ${fmt(d.rsi)}，追高风险较大`, 3]);
  else if (d.rsi !== null && d.rsi < 35) S.checks.push(['ok', '超跌区域', `RSI ${fmt(d.rsi)}，处于相对低位`, 3]);
  // 资金
  let sf2 = 50;
  if (d.main20 !== null) { if (d.main20 > 0) sf2 += 20; else sf2 -= 15; }
  if (d.main5 !== null) { if (d.main5 > 0) sf2 += 15; else sf2 -= 10; }
  S.fund = Math.max(0, Math.min(100, sf2));
  if (d.main20 !== null && d.main20 > 0 && d.main5 > 0) S.checks.push(['ok', '主力持续流入', '5日/20日主力资金均净流入', 4]);
  else if (d.main20 !== null && d.main20 < 0) S.checks.push(['bad', '主力持续流出', `20日主力净流出 ${fmt(Math.abs(d.main20))}亿`, 4]);
  // 综合（加权）
  S.total = Math.round(S.val * 0.28 + S.fin * 0.32 + S.tech * 0.22 + S.fund * 0.18);
  if (S.total >= 70 && S.tech >= 55) { S.rec = 'buy'; S.label = '值得考虑买入'; S.desc = '四维整体偏正面：基本面扎实、估值合理、趋势与资金同步配合，是可重点关注的标的。'; }
  else if (S.total >= 60) { S.rec = 'watch'; S.label = '观望为主，等信号'; S.desc = '有亮点但存在短板（多为趋势未修复或估值偏高），建议列入观察池，等待右侧信号或回调到更优价位再介入。'; }
  else if (S.total >= 45) { S.rec = 'watch'; S.label = '谨慎观望'; S.desc = '基本面与估值尚可，但技术面或资金面偏弱，短期缺乏上涨催化，不宜急于建仓。'; }
  else { S.rec = 'avoid'; S.label = '当前不建议买入'; S.desc = '基本面恶化、趋势向下或估值过高，多项指标发出警示，当前位置风险大于机会。'; }
  return S;
}
const meter = (v, label) => {
  const c = v >= 65 ? 'var(--buy)' : (v >= 50 ? 'var(--gold)' : 'var(--avoid)');
  return `<div class="bar"><i style="width:${Math.max(2, v)}%;background:${c}"></i></div><div class="barlabel">${label} ${v}</div>`;
};
const round1 = (a, b) => Math.round((a + Number.EPSILON) * b) / b;

/* 把实时接口返回的原始数据标准化为评分所需字段 */
function normalize(raw) {
  const q = raw.quote || {};
  const t = raw.tech || {};
  const f = raw.fin || {};
  const fl = raw.flow || {};
  const out = {
    name: q.name || '—', code: raw.code, mkt: mktOf(raw.code),
    price: num(q.price), chg: num(q.change_percent),
    pe: num(q.pe_ratio), pb: num(q.pb_ratio), dy: num(q.dividend_ratio_ttm),
    mktcap: num(q.total_market_cap), ytd: num(q.chg_ytd), chg5: num(q.chg_5d),
    chg20: num(q.chg_20d), chg60: num(q.chg_60d),
    roe: num(f.ROETTM), gp: num(f.GrossIncomeRatio), npm: num(f.NetProfitRatio),
    revYoY: num(f.TORGrowRate), npYoY: num(f.NPParentCompanyYOY),
    debt: num(f.DebtAssetsRatio), cf: num(f.NetOperateCashFlow),
    ma5: num(t.ma && t.ma.MA_5), ma10: num(t.ma && t.ma.MA_10), ma20: num(t.ma && t.ma.MA_20),
    ma60: num(t.ma && t.ma.MA_60), ma250: num(t.ma && t.ma.MA_250),
    rsi: num(t.rsi && t.rsi.RSI_12), macd: num(t.macd && t.macd.MACD),
    kdjK: num(t.kdj && t.kdj.KDJ_K), kdjJ: num(t.kdj && t.kdj.KDJ_J),
    bbMid: num(t.boll && t.boll.BOLL_MID), bbUp: num(t.boll && t.boll.BOLL_UPPER), bbLow: num(t.boll && t.boll.BOLL_LOWER),
    mainNet: num(fl.MainNetFlow), main5: num(fl.MainNetFlow5D), main20: num(fl.MainNetFlow20D),
    high52: num(q.high_52week), low52: num(q.low_52week), time: q.time || ''
  };
  out.cf = out.cf === null ? null : out.cf / 1e8;
  out.mktcap = out.mktcap === null ? null : out.mktcap;
  out.mainNet = out.mainNet === null ? null : out.mainNet / 1e8;
  out.main5 = out.main5 === null ? null : out.main5 / 1e8;
  out.main20 = out.main20 === null ? null : out.main20 / 1e8;
  return out;
}

/* ================= 渲染 ================= */
const $ = id => document.getElementById(id);
const loading = (on, msg) => {
  const el = $('loading');
  if (!el) return;
  el.style.display = on ? 'flex' : 'none';
  if (msg) el.querySelector('span').textContent = msg;
};

async function analyze() {
  const code = norm($('code').value);
  $('out').innerHTML = '';
  if (!code) { renderMarket(); return; }
  loading(true, '正在拉取 ' + code + ' 实时数据…');
  try {
    const raw = await Q('/api/stock/' + encodeURIComponent(code));
    if (!raw.quote || !raw.quote.name) throw new Error('未找到该代码，请确认股票代码是否正确（如 600519 / sh600519 / 000651）');
    renderSingle(raw);
    window.__lastSingle = raw;
  } catch (e) {
    $('out').innerHTML = `<div class="card empty">⚠️ ${e.message}<br><br><span style="font-size:12.5px;color:var(--sub)">提示：服务需在本地运行（node api-server.js）。也可直接点击下方按钮查看全市场扫描结果。</span></div>`;
  } finally { loading(false); }
}
function renderSingle(raw) {
  const d = normalize(raw);
  const S = score(d);
  const recCls = S.rec === 'buy' ? 'v-buy' : (S.rec === 'watch' ? 'v-watch' : 'v-avoid');
  const connState = $('conn') ? `<span style="color:var(--buy)">● 实时</span> 数据时间 ${d.time || raw.fetchedAt.slice(0, 10)} · 获取于 ${today()}` : '';
  let h = `<div class="verdict ${recCls}">
    <div class="v-score">${S.total}<small> / 100</small></div>
    <div class="v-text">
      <span class="tag">${S.label}</span>
      <h2>${d.name} <span style="font-size:13px;color:var(--sub);font-weight:400">${(raw.code || '').toUpperCase()} · ${d.mkt}市</span></h2>
      <p>${S.desc}</p>
      <div style="font-size:11.5px;color:var(--sub);margin-top:7px">${connState}</div>
    </div>
  </div>`;
  h += `<div class="grid">
    <div class="metric"><div class="k">最新价</div><div class="v ${cls(d.chg)}">${fmt(d.price)} <span style="font-size:13px">${sign(d.chg)}${fmt(d.chg)}%</span></div>
      <div class="n">年内 ${sign(d.ytd)}<span class="${cls(d.ytd)}">${fmt(d.ytd)}%</span> ｜ 20日 ${fmt(d.chg20)}% ｜ 60日 ${fmt(d.chg60)}% ｜ 52周 ${fmt(d.low52)}~${fmt(d.high52)}</div></div>
    <div class="metric"><div class="k">估值</div><div class="v">${fmt(d.pe)}<span style="font-size:13px;color:var(--sub)"> 倍 PE</span></div>
      <div class="n">PB ${fmt(d.pb)} ｜ 股息 <b style="color:var(--gold)">${fmt(d.dy)}%</b> ｜ 市值 ${d.mktcap ? fmt(d.mktcap) : '—'}亿</div>
      ${meter(S.val, '估值')}</div>
    <div class="metric"><div class="k">财务质量</div><div class="v">${fmt(d.roe)}<span style="font-size:13px;color:var(--sub)">% ROE</span></div>
      <div class="n">净利率 ${fmt(d.npm)}% ｜ 毛利率 ${fmt(d.gp)}% ｜ 负债率 ${fmt(d.debt)}% ｜ 净利同比 ${sign(d.npYoY)}${fmt(d.npYoY)}%</div>
      ${meter(S.fin, '财务')}</div>
    <div class="metric"><div class="k">技术面</div><div class="v ${cls(d.chg)}">${fmt(d.rsi)}<span style="font-size:13px;color:var(--sub)"> RSI</span></div>
      <div class="n">MACD ${sign(d.macd)}${fmt(d.macd)} ｜ KDJ_J ${fmt(d.kdjJ)} ｜ ${d.price > d.ma20 ? '站上' : '跌破'}MA20(${fmt(d.ma20)})</div>
      ${meter(S.tech, '技术')}</div>
    <div class="metric"><div class="k">主力资金（亿元）</div><div class="v ${d.main20 > 0 ? 'down' : 'up'}">${fmt(d.main20)}<span style="font-size:13px;color:var(--sub)"> 20日</span></div>
      <div class="n">5日 ${sign(d.main5)}${fmt(d.main5)} ｜ 今日 ${sign(d.mainNet)}${fmt(d.mainNet)} ｜ ${d.main20 > 0 ? '资金持续流入' : '资金持续流出'}</div>
      ${meter(S.fund, '资金')}</div>
    <div class="metric"><div class="k">四维评分</div>
      <div style="font-size:12.5px;line-height:1.9;margin-top:4px">
        <div>估值 <b style="color:var(--${S.val >= 65 ? 'buy' : 'gold'})">${S.val}</b> · 财务 <b style="color:var(--${S.fin >= 65 ? 'buy' : 'gold'})">${S.fin}</b> · 技术 <b style="color:var(--${S.tech >= 65 ? 'buy' : 'gold'})">${S.tech}</b> · 资金 <b style="color:var(--${S.fund >= 65 ? 'buy' : 'gold'})">${S.fund}</b></div>
      </div>
      <div class="n" style="margin-top:6px">权重：估值28% 财务32% 技术22% 资金18%</div>
    </div>
  </div>`;
  const dims = [
    ['估值与分红', `PE ${fmt(d.pe)}倍 / PB ${fmt(d.pb)} / 股息 ${fmt(d.dy)}%，市值 ${d.mktcap ? fmt(d.mktcap) + '亿' : '—'}，年内 ${sign(d.ytd)}${fmt(d.ytd)}%。`, S.val >= 70 ? 'ok' : (S.val >= 50 ? 'warn' : 'bad')],
    ['财务与成长性', `ROE ${fmt(d.roe)}%，毛利率 ${fmt(d.gp)}%，净利同比 ${sign(d.npYoY)}${fmt(d.npYoY)}%，经营现金流 ${d.cf === null ? '—' : sign(d.cf) + fmt(d.cf) + '亿'}。`, S.fin >= 70 ? 'ok' : (S.fin >= 50 ? 'warn' : 'bad')],
    ['趋势与位置', `股价 ${fmt(d.price)}，MA20 ${fmt(d.ma20)} / MA60 ${fmt(d.ma60)} / MA250 ${fmt(d.ma250)}；RSI ${fmt(d.rsi)}，MACD ${sign(d.macd)}${fmt(d.macd)}。`, S.tech >= 60 ? 'ok' : (S.tech >= 45 ? 'warn' : 'bad')],
    ['资金动向', `主力5日 ${d.main5 === null ? '—' : sign(d.main5) + fmt(d.main5) + '亿'}，20日 ${d.main20 === null ? '—' : sign(d.main20) + fmt(d.main20) + '亿'}。`, S.fund >= 65 ? 'ok' : (S.fund >= 50 ? 'warn' : 'bad')]
  ];
  h += `<div class="section-title"><i></i>四大维度体检</div><div class="checks">`;
  dims.forEach(([t, b, c]) => {
    h += `<div class="check ${c}"><div class="ct"><b>${t}</b><span class="badge ${c}">${c === 'ok' ? '良好' : (c === 'warn' ? '关注' : '警示')}</span></div><div style="color:var(--sub);font-size:13px;margin-top:6px;line-height:1.6">${b}</div></div>`;
  });
  h += `</div>`;
  h += `<div class="section-title"><i></i>买卖操作建议</div>`;
  if (S.rec === 'buy') {
    h += `<div class="plan"><h4>✅ ${d.name} —— 可重点考虑，建议分批建仓</h4><ul>
      <li><b>仓位：</b>首次建仓不超过目标仓位的 1/3，确认站稳关键均线后再加仓。</li>
      <li><b>参考价位：</b>现价 ${fmt(d.price)}；回调至 MA20（${fmt(d.ma20)}）附近是较优买点，跌破布林下轨（${fmt(d.bbLow)}）可视为超跌机会。</li>
      <li><b>止盈：</b>上行目标参考布林上轨（${fmt(d.bbUp)}）或前高，分两档兑现。</li>
      <li><b>止损：</b>跌破年线（MA250 ${fmt(d.ma250)}）或基本面数据（如净利增速）转负，应减仓离场。</li></ul></div>`;
  } else if (S.rec === 'watch') {
    h += `<div class="plan"><h4>⏳ ${d.name} —— 列入观察池，等待右侧信号</h4><ul>
      <li><b>策略：</b>不建议一次性买入，采用"等信号再动手"。</li>
      <li><b>买入信号：</b>① 股价重新站上 MA20（${fmt(d.ma20)}）且 MA5 上穿 MA10；② MACD 由绿转红形成金叉；③ 主力资金连续 5 日净流入。</li>
      <li><b>可介入价位：</b>优先等回踩 MA60（${fmt(d.ma60)}）不破，或突破前高后回踩确认。</li>
      <li><b>规避情形：</b>若放量跌破 MA250（${fmt(d.ma250)}）或主力资金加速流出，放弃该标的。</li></ul></div>`;
  } else {
    h += `<div class="plan"><h4>🛑 ${d.name} —— 当前不建议买入</h4><ul>
      <li><b>结论：</b>综合评分偏低，基本面/趋势/资金中多项发出警示信号，当前位置风险大于机会。</li>
      <li><b>若已持有：</b>反弹至 MA20（${fmt(d.ma20)}）附近建议减仓；若跌破 MA250（${fmt(d.ma250)}）且无基本面改善，应止损。</li>
      <li><b>若想参与：</b>仅可作为超跌反弹短线博弈，严控仓位（≤5%），快进快出，不恋战。</li>
      <li><b>转多条件：</b>① 净利同比由负转正；② 股价站上 MA60 且均线拐头向上；③ 主力资金转为持续净流入。</li></ul></div>`;
  }
  h += `<div class="grid" style="grid-template-columns:1fr 1fr">
    <div class="card" style="margin:0"><div class="section-title"><i></i>潜在催化剂</div><div style="font-size:13.5px;line-height:1.9;color:#cdd8e6">
      ${d.main20 > 0 && d.main5 > 0 ? '<div>▹ 主力资金 5日/20日持续净流入，资金面认可度高</div>' : ''}
      ${d.npYoY > 20 ? '<div>▹ 业绩高增（+' + fmt(d.npYoY) + '%），基本面兑现</div>' : ''}
      ${d.dy > 5 ? '<div>▹ 股息率 ' + fmt(d.dy) + '%，具备高分红防守属性</div>' : ''}
      ${d.rsi !== null && d.rsi < 40 ? '<div>▹ RSI ' + fmt(d.rsi) + '，处于超跌区域，存在反弹需求</div>' : ''}
      ${d.pe !== null && d.pe < 15 ? '<div>▹ 估值处于历史低位（PE ' + fmt(d.pe) + '），安全边际较高</div>' : ''}
      ${d.cf !== null && d.cf > 0 ? '<div>▹ 经营现金流健康（+' + fmt(d.cf) + '亿），造血能力强</div>' : ''}
      ${(!d.npYoY || d.npYoY <= 0) ? '<div>▹ 关注后续业绩拐点能否出现</div>' : ''}
      ${(!d.dy || d.dy < 1) ? '<div>▹ 股息率偏低，收益主要依赖价差</div>' : ''}
    </div></div>
    <div class="card" style="margin:0"><div class="section-title"><i></i>主要风险</div><div style="font-size:13.5px;line-height:1.9;color:#cdd8e6">
      ${d.price && d.ma250 && d.price < d.ma250 ? '<div>▹ 股价跌破年线，中长期趋势向下</div>' : ''}
      ${d.main20 < 0 ? '<div>▹ 主力资金持续流出，抛压未释放</div>' : ''}
      ${d.npYoY < 0 ? '<div>▹ 净利同比负增长（' + sign(d.npYoY) + fmt(d.npYoY) + '%），基本面承压</div>' : ''}
      ${d.rsi > 75 ? '<div>▹ RSI 超买（' + fmt(d.rsi) + '），短期追高风险大</div>' : ''}
      ${d.pe !== null && d.pe > 50 ? '<div>▹ 估值偏高（PE ' + fmt(d.pe) + '），已充分反映乐观预期</div>' : ''}
      ${d.debt > 70 ? '<div>▹ 资产负债率偏高（' + fmt(d.debt) + '%），财务杠杆较重</div>' : ''}
      ${d.cf < 0 ? '<div>▹ 经营现金流为负，需警惕资金链压力</div>' : ''}
      ${(d.pe === null && d.npYoY < 0) ? '<div>▹ 处于亏损状态（PE为负），估值无法用市盈率衡量</div>' : ''}
    </div></div></div>`;
  // 最新动态
  const news = (raw.news || []).filter(n => n.title).slice(0, 5);
  const reps = (raw.reports || []).filter(r => r.title).slice(0, 4);
  if (news.length || reps.length) {
    h += `<div class="section-title"><i></i>最新动态（${d.time || ''}）</div><div class="card" style="margin-bottom:18px">`;
    if (reps.length) {
      h += `<div style="font-size:12.5px;color:var(--sub);margin-bottom:8px;font-weight:600">机构研报（最新评级）</div><div style="font-size:13px;line-height:2">`;
      reps.forEach(r => { h += `<div>· <span style="color:var(--gold)">${r.tzpj || '—'}</span> ${r.title}</div>`; });
      h += `</div>`;
    }
    if (news.length) {
      h += `<div style="font-size:12.5px;color:var(--sub);margin:${reps.length ? 14 : 0}px 0 8px;font-weight:600">相关新闻</div><div style="font-size:13px;line-height:2">`;
      news.forEach(n => { h += `<div>· ${n.title}</div>`; });
      h += `</div>`;
    }
    h += `</div>`;
  }
  h += `<div id="tip" style="display:none;margin-bottom:14px;padding:12px 16px;border-radius:10px;background:rgba(0,200,150,.1);border:1px solid rgba(0,200,150,.35);color:#a8f0d8;font-size:13.5px"></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px">
    <button class="btn-go" onclick="exportReport('pdf', event)">📄 导出 PDF 报告</button>
    <button class="btn-ghost" onclick="exportReport('docx', event)">📝 导出 Word 报告</button>
    <button class="btn-ghost" onclick="addWatch('${raw.code}','${d.name.replace(/'/g, '')}',${S.total})">⭐ 加入自选</button>
    <button class="btn-ghost" onclick="analyze()">🔄 刷新实时数据</button>
  </div>`;
  $('out').innerHTML = h;
  window.scrollTo({ top: $('out').offsetTop - 20, behavior: 'smooth' });
}

/* 全市场扫描 */
const TPL = {
  val: { name: '高股息低估值（收息防守型）', expr: "intersect([PE_TTM > 0, PE_TTM < 20, ROETTM > 12, DividendRatioTTM > 4])", cols: ['PE_TTM:PE', 'ROETTM:ROE', 'DividendRatioTTM:股息%'], hint: 'PE<20 且 ROE>12% 且股息率>4%，兼顾估值安全与现金回报' },
  growth: { name: '白马成长（业绩高增）', expr: "intersect([ROETTM > 15, NPParentCompanyYOY > 20, TORGrowRate > 10, PE_TTM > 0, PE_TTM < 60])", cols: ['ROETTM:ROE', 'NPParentCompanyYOY:净利同比%', 'TORGrowRate:营收同比%', 'PE_TTM:PE'], hint: 'ROE>15% 且净利增速>20%，成长弹性大但估值通常偏高' },
  cash: { name: '现金流健康（经营现金流转正）', expr: "intersect([NetOperateCashFlow > 0, ROETTM > 10, PE_TTM > 0])", cols: ['ROETTM:ROE', 'DividendRatioTTM:股息%', 'PE_TTM:PE'], hint: '经营现金流为正且ROE达标，注重真实赚钱能力而非账面利润' },
  cheap: { name: '低估值价值股（PE<15）', expr: "intersect([PE_TTM > 0, PE_TTM < 15, ROETTM > 10, DebtAssetsRatio < 70])", cols: ['PE_TTM:PE', 'ROETTM:ROE', 'DebtAssetsRatio:负债率%'], hint: 'PE<15 且 ROE>10% 且负债率<70%，典型价值型标的' }
};
async function renderMarket() {
  loading(true, '正在扫描全市场…');
  $('out').innerHTML = '';
  try {
    const [rankRaw, presets] = await Promise.all([
      Q('/api/ranking/CompScore?limit=12').catch(() => []),
      Q('/api/presets').catch(() => [])
    ]);
    let h = `<div class="verdict v-none"><div class="v-score" style="font-size:32px">5571<small style="font-size:13px"> 只A股</small></div>
      <div class="v-text"><span class="tag" style="background:var(--cyan);color:#04231c">全市场实时扫描</span>
      <h2>按多因子综合评分与条件筛选收敛候选池</h2>
      <p>没有输入代码时，工具会按「综合评分榜 → 高股息低估值 → 白马成长 → 现金流健康 → 低估值价值股」五个角度，把全市场 5571 只 A 股收敛成几张小清单。点击下方任一股票代码即可进入该股的实时四维体检与买卖建议。</p></div></div>`;
    if (Array.isArray(rankRaw) && rankRaw.length) {
      h += `<div class="card"><div class="section-title"><i></i>综合评分榜（实时）</div>
        <div style="font-size:13px;color:var(--sub);margin-bottom:14px">多因子综合打分最高的股票，基本面+资金+技术+风险的均衡最优解</div>
        <div style="overflow-x:auto"><table><thead><tr><th>#</th><th>代码</th><th>名称</th><th>综合分</th><th>资金</th><th>基本面</th><th>风险</th><th>技术</th><th>操作</th></tr></thead><tbody>`;
      rankRaw.forEach(r => {
        const c = r['代码'] || r.code;
        h += `<tr><td>${r['#'] || ''}</td><td style="color:var(--cyan)">${c}</td><td><b>${r['名称'] || r.name}</b></td>
          <td><b>${fmt(r['综合评分'] || r.综合评分)}</b></td><td>${fmt(r['资金评分'] || r.资金评分)}</td>
          <td>${fmt(r['基本面评分'] || r.基本面评分)}</td><td>${fmt(r['风险评分'] || r.风险评分)}</td>
          <td>${fmt(r['技术评分'] || r.技术评分)}</td>
          <td><button class="btn-ghost" style="padding:3px 10px;font-size:12px" onclick="doQuick('${c}')">分析 →</button></td></tr>`;
      });
      h += `</tbody></table></div></div>`;
    }
    $('out').innerHTML = h;
    for (const key of ['val', 'growth', 'cash', 'cheap']) {
      const t = TPL[key];
      const box = document.createElement('div');
      box.className = 'card';
      box.innerHTML = `<div class="section-title"><i></i>${t.name} <span style="font-size:12px;color:var(--sub);font-weight:400">（筛选中…）</span></div>`;
      $('out').appendChild(box);
      try {
        const rows = await Q('/api/screen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expression: t.expr, limit: 10 }) });
        const codes = (rows || []).slice(0, 10).map(r => r.code).filter(Boolean);
        let quotes = [];
        if (codes.length) {
          try { quotes = await Q('/api/quote/' + codes.join(',')); } catch (e) { quotes = []; }
        }
        let bh = `<div class="section-title"><i></i>${t.name}</div><div style="font-size:13px;color:var(--sub);margin-bottom:14px">${t.hint}</div>`;
        if (!rows || !rows.length) { bh += `<div style="color:var(--sub);font-size:13px">当前条件下无匹配标的。</div>`; }
        else {
          bh += `<div style="overflow-x:auto"><table><thead><tr><th>代码</th><th>名称</th>${t.cols.map(c => `<th>${c.split(':')[1]}</th>`).join('')}<th>最新价</th><th>涨跌幅</th><th>操作</th></tr></thead><tbody>`;
          rows.slice(0, 10).forEach(r => {
            const c = r.code; const q = (quotes || []).find(q => q.code === c) || {};
            bh += `<tr><td style="color:var(--cyan)">${c}</td><td><b>${r.name}</b></td>`;
            t.cols.forEach(col => { const f = col.split(':')[0]; bh += `<td>${fmt(r[f])}</td>`; });
            bh += `<td>${fmt(q.price)}</td><td class="${cls(q.change_percent)}">${sign(q.change_percent)}${fmt(q.change_percent)}%</td>
              <td><button class="btn-ghost" style="padding:3px 10px;font-size:12px" onclick="doQuick('${c}')">分析 →</button></td></tr>`;
          });
          bh += `</tbody></table></div>`;
        }
        box.innerHTML = bh;
      } catch (e) {
        box.innerHTML = `<div class="section-title"><i></i>${t.name}</div><div style="color:var(--avoid);font-size:13px">筛选失败：${e.message}</div>`;
      }
    }
    h = `<div class="section-title"><i></i>怎么用这份名单</div><div class="grid" style="grid-template-columns:1fr 1fr 1fr">
      <div class="card" style="margin:0"><div style="font-size:20px;margin-bottom:8px">🛡️ 稳健收息</div>
        <div style="font-size:13.5px;color:var(--sub);line-height:1.8">从「高股息低估值」里挑 <b style="color:var(--txt)">PE&lt;10 + 股息>5%</b> 的。不求大涨，赚分红+估值修复，适合大资金、低风险偏好。</div></div>
      <div class="card" style="margin:0"><div style="font-size:20px;margin-bottom:8px">🚀 成长弹性</div>
        <div style="font-size:13.5px;color:var(--sub);line-height:1.8">从「白马成长」里挑 <b style="color:var(--txt)">ROE>20 + 净利增速>30%</b> 的。弹性大但估值高，单只仓位≤10%，等回调介入。</div></div>
      <div class="card" style="margin:0"><div style="font-size:20px;margin-bottom:8px">📈 趋势跟随</div>
        <div style="font-size:13.5px;color:var(--sub);line-height:1.8">从「综合评分榜」里挑评分≥80且技术评分≥85的。顺势而为、右侧介入，跌破 MA20 就走，纪律优先。</div></div>
    </div>`;
    const box2 = document.createElement('div'); box2.innerHTML = h; $('out').appendChild(box2);
  } catch (e) {
    $('out').innerHTML = `<div class="card empty">⚠️ 无法连接数据服务：${e.message}<br><br><span style="font-size:12.5px">请先启动本地桥接服务：<code style="color:var(--gold)">node api-server.js</code></span></div>`;
  } finally { loading(false); }
}

/* 自定义筛选面板 */
async function runCustom() {
  const expr = $('expr').value.trim();
  const limit = Math.max(5, Math.min(50, parseInt($('lim').value) || 15));
  if (!expr) return alert('请输入筛选表达式');
  const box = $('customOut');
  box.innerHTML = '<div style="color:var(--sub);font-size:13px">筛选中…</div>';
  try {
    const rows = await Q('/api/screen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expression: expr, limit }) });
    if (!rows || !rows.length) { box.innerHTML = '<div style="color:var(--sub)">当前条件下无匹配标的。</div>'; return; }
    const codes = rows.slice(0, limit).map(r => r.code).filter(Boolean);
    let quotes = [];
    if (codes.length) { try { quotes = await Q('/api/quote/' + codes.join(',')); } catch (e) { quotes = []; } }
    const fields = Object.keys(rows[0]).filter(k => !['code', 'name'].includes(k));
    let h = `<div style="font-size:13px;color:var(--sub);margin-bottom:12px">共 ${rows.length} 只匹配（显示前 ${Math.min(rows.length, limit)} 只）</div>`;
    h += `<div style="overflow-x:auto"><table><thead><tr><th>代码</th><th>名称</th>${fields.map(f => `<th>${f}</th>`).join('')}<th>最新价</th><th>涨跌幅</th><th>操作</th></tr></thead><tbody>`;
    rows.slice(0, limit).forEach(r => {
      const c = r.code; const q = (quotes || []).find(q => q.code === c) || {};
      h += `<tr><td style="color:var(--cyan)">${c}</td><td><b>${r.name}</b></td>`;
      fields.forEach(f => { h += `<td>${fmt(r[f])}</td>`; });
      h += `<td>${fmt(q.price)}</td><td class="${cls(q.change_percent)}">${sign(q.change_percent)}${fmt(q.change_percent)}%</td>
        <td><button class="btn-ghost" style="padding:3px 10px;font-size:12px" onclick="doQuick('${c}')">分析 →</button></td></tr>`;
    });
    h += `</tbody></table></div>`;
    box.innerHTML = h;
  } catch (e) { box.innerHTML = `<div style="color:var(--avoid);font-size:13px">筛选失败：${e.message}</div>`; }
}

/* 多股对比 */
async function compare() {
  const raw = $('cmpCode').value.split(/[\s,，、;；]+/).map(norm).filter(Boolean);
  const box = $('cmpOut');
  if (!raw.length) return alert('请输入至少两个股票代码，用空格或逗号分隔');
  box.innerHTML = '<div style="color:var(--sub);font-size:13px">加载中…</div>';
  try {
    const qs = raw.join(',');
    const [q, t, f] = await Promise.all([
      Q('/api/quote/' + qs).catch(() => []),
      Q('/api/quote/' + qs).then(() => null),
      Promise.resolve(null)
    ]);
    let h = `<div class="card"><div class="section-title"><i></i>多股横向对比（实时）</div><div style="overflow-x:auto"><table><thead><tr>
      <th>代码</th><th>名称</th><th>最新价</th><th>涨跌幅</th><th>PE</th><th>PB</th><th>股息%</th><th>市值(亿)</th><th>年内%</th><th>20日%</th><th>操作</th></tr></thead><tbody>`;
    (q || []).forEach(item => {
      h += `<tr><td style="color:var(--cyan)">${item.code}</td><td><b>${item.name}</b></td>
        <td>${fmt(item.price)}</td><td class="${cls(item.change_percent)}">${sign(item.change_percent)}${fmt(item.change_percent)}%</td>
        <td>${fmt(item.pe_ratio)}</td><td>${fmt(item.pb_ratio)}</td>
        <td>${fmt(item.dividend_ratio_ttm)}</td>
        <td>${fmt(item.total_market_cap)}</td>
        <td class="${cls(item.chg_ytd)}">${sign(item.chg_ytd)}${fmt(item.chg_ytd)}%</td>
        <td class="${cls(item.chg_20d)}">${fmt(item.chg_20d)}%</td>
        <td><button class="btn-ghost" style="padding:3px 10px;font-size:12px" onclick="doQuick('${item.code}')">分析 →</button></td></tr>`;
    });
    h += `</tbody></table></div>
      <div style="margin-top:12px;display:flex;gap:10px">
        <button class="btn-go" style="padding:0 16px;font-size:14px" onclick="exportCompare(${JSON.stringify(raw)})">📄 导出对比报告(Word)</button>
      </div></div>`;
    box.innerHTML = h;
  } catch (e) { box.innerHTML = `<div style="color:var(--avoid);font-size:13px">对比失败：${e.message}</div>`; }
}

async function exportCompare(codes) {
  const box = $('cmpOut');
  box.insertAdjacentHTML('beforeend', '<div style="color:var(--sub);font-size:13px;margin-top:8px">正在生成 Word 报告…</div>');
  const list = await Promise.all(codes.map(c => Q('/api/stock/' + c).then(normalize).catch(() => null)));
  const valid = list.filter(Boolean);
  const rows = valid.map(d => {
    const S = score(d);
    return { 名称: d.name, 代码: d.code, 最新价: fmt(d.price), 涨跌幅: sign(d.chg) + fmt(d.chg) + '%', PE: fmt(d.pe), PB: fmt(d.pb), '股息%': fmt(d.dy), ROE: fmt(d.roe), '净利同比%': (d.npYoY===null?'—':sign(d.npYoY)+fmt(d.npYoY)), '综合评分': S.total, 建议: S.rec==='buy'?'值得买入':(S.rec==='watch'?'观望':'不建议') };
  });
  const payload = {
    title: '多股横向对比分析报告',
    meta: [['对比标的', valid.map(d => d.name).join(' / ') || '—'], ['数据来源', '腾讯自选股接口（实时）'], ['生成时间', today()]],
    tables: [{ title: '一、行情与估值对比', rows }],
    sections: [{ title: '二、对比结论', para: [
      '以上 ' + valid.length + ' 只股票按四维评分模型（估值28%·财务32%·技术22%·资金18%）排序。',
      '综合评分最高的标的，是当前基本面、估值、趋势与资金配合最优的选择。',
      '建议将仓位优先分配给评分≥70且趋势（技术维度）同步向上的标的，评分<50的标的即使估值便宜也应谨慎。',
      '具体每只在工具内点击"分析"可查看该股的详细四维体检与买卖操作建议。'
    ]}],
    notes: ['本报告由 A股选股分析工具 自动生成，为客观数据分析，不构成投资建议。股市有风险，入市需谨慎。']
  };
  try {
    const res = await fetch('/api/export/docx', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error((await res.json()).error || '导出失败');
    const blob = await res.blob();
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = '多股对比报告.docx'; a.click(); URL.revokeObjectURL(a.href);
    box.insertAdjacentHTML('beforeend', '<div style="color:var(--buy);font-size:13px;margin-top:8px">✅ Word 报告已生成并下载</div>');
  } catch (e) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    a.download = '多股对比报告.json'; a.click(); URL.revokeObjectURL(a.href);
    box.insertAdjacentHTML('beforeend', '<div style="color:var(--watch);font-size:13px;margin-top:8px">⚠️ 服务端导出不可用，已下载可导入的 JSON 数据</div>');
  }
}

/* 导出报告 */
function exportReport(fmt) {
  const raw = window.__lastSingle;
  if (!raw) return alert('请先分析一只股票，再导出报告');
  const d = normalize(raw);
  const S = score(d);
  const verdict = S.rec === 'buy' ? '值得考虑买入' : (S.rec === 'watch' ? '观望为主，等信号' : '当前不建议买入');
  const news = (raw.news || []).filter(n => n.title).slice(0, 8).map(n => n.title).join('\n');
  const reps = (raw.reports || []).filter(r => r.title).slice(0, 6).map(r => (r.tzpj || '') + ' ' + r.title).join('\n');
  const payload = {
    title: d.name + '（' + (raw.code || '') + '）股票分析报告',
    meta: [
      ['股票名称', d.name], ['股票代码', raw.code || ''], ['所属市场', d.mkt + '市'],
      ['数据日期', d.time || ''], ['生成时间', today()], ['数据来源', '腾讯自选股接口（实时）'],
      ['综合评分', S.total + ' / 100'], ['投资建议', verdict]
    ],
    sections: [
      { title: '一、行情快照', rows: [
        ['最新价', fmt(d.price) + ' 元'], ['涨跌幅', sign(d.chg) + fmt(d.chg) + '%'],
        ['今开', fmt(d.price) || '—'], ['最高/最低', fmt(d.price) + ' / ' + fmt(d.price)],
        ['总市值', (d.mktcap ? fmt(d.mktcap) : '—') + ' 亿元'], ['换手率', '—'],
        ['52周最高', fmt(d.high52) + ' 元'], ['52周最低', fmt(d.low52) + ' 元'],
        ['年内涨跌', sign(d.ytd) + fmt(d.ytd) + '%'], ['20日涨跌', fmt(d.chg20) + '%']
      ]},
      { title: '二、估值分析', rows: [
        ['市盈率 PE(TTM)', fmt(d.pe) + ' 倍'], ['市净率 PB', fmt(d.pb) + ' 倍'],
        ['股息率(TTM)', fmt(d.dy) + '%'], ['估值维度评分', S.val + ' / 100'],
        ['估值判断', S.val >= 70 ? '低估，安全边际高' : (S.val >= 50 ? '估值合理' : '估值偏高')]
      ]},
      { title: '三、财务质量', rows: [
        ['ROE(TTM)', fmt(d.roe) + '%'], ['毛利率', fmt(d.gp) + '%'], ['净利率', fmt(d.npm) + '%'],
        ['资产负债率', fmt(d.debt) + '%'], ['营收同比', sign(d.revYoY) + fmt(d.revYoY) + '%'],
        ['净利同比', sign(d.npYoY) + fmt(d.npYoY) + '%'], ['经营现金流', (d.cf === null ? '—' : sign(d.cf) + fmt(d.cf) + ' 亿元')],
        ['财务维度评分', S.fin + ' / 100']
      ]},
      { title: '四、技术面', rows: [
        ['RSI(12)', fmt(d.rsi)], ['MACD', sign(d.macd) + fmt(d.macd)], ['KDJ_J', fmt(d.kdjJ)],
        ['MA5 / MA10', fmt(d.ma5) + ' / ' + fmt(d.ma10)], ['MA20 / MA60', fmt(d.ma20) + ' / ' + fmt(d.ma60)],
        ['MA250(年线)', fmt(d.ma250)], ['布林上/中/下轨', fmt(d.bbUp) + ' / ' + fmt(d.bbMid) + ' / ' + fmt(d.bbLow)],
        ['技术维度评分', S.tech + ' / 100']
      ]},
      { title: '五、资金动向', rows: [
        ['主力净流入(今日)', (d.mainNet === null ? '—' : sign(d.mainNet) + fmt(d.mainNet) + ' 亿元')],
        ['主力净流入(5日)', (d.main5 === null ? '—' : sign(d.main5) + fmt(d.main5) + ' 亿元')],
        ['主力净流入(20日)', (d.main20 === null ? '—' : sign(d.main20) + fmt(d.main20) + ' 亿元')],
        ['资金维度评分', S.fund + ' / 100']
      ]},
      { title: '六、四维综合评分', rows: [
        ['估值维度', S.val + '（权重28%）'], ['财务维度', S.fin + '（权重32%）'],
        ['技术维度', S.tech + '（权重22%）'], ['资金维度', S.fund + '（权重18%）'],
        ['综合评分', S.total + ' / 100'], ['投资建议', verdict]
      ]},
      { title: '七、买卖操作建议', para: S.rec === 'buy'
        ? ['结论：可重点考虑，建议分批建仓。', '仓位：首次建仓不超过目标仓位的 1/3，确认站稳关键均线后再加仓。', '参考价位：现价 ' + fmt(d.price) + '；回调至 MA20（' + fmt(d.ma20) + '）附近是较优买点，跌破布林下轨（' + fmt(d.bbLow) + '）可视为超跌机会。', '止盈：上行目标参考布林上轨（' + fmt(d.bbUp) + '）或前高，分两档兑现。', '止损：跌破年线（MA250 ' + fmt(d.ma250) + '）或净利增速转负，应减仓离场。']
        : (S.rec === 'watch'
          ? ['结论：列入观察池，等右侧信号再动手。', '买入信号：① 股价重新站上 MA20（' + fmt(d.ma20) + '）且 MA5 上穿 MA10；② MACD 由绿转红形成金叉；③ 主力资金连续 5 日净流入。', '可介入价位：优先等回踩 MA60（' + fmt(d.ma60) + '）不破，或突破前高后回踩确认。', '规避情形：若放量跌破 MA250（' + fmt(d.ma250) + '）或主力资金加速流出，放弃该标的。']
          : ['结论：当前不建议买入，风险大于机会。', '若已持有：反弹至 MA20（' + fmt(d.ma20) + '）附近建议减仓；若跌破 MA250（' + fmt(d.ma250) + '）且无基本面改善，应止损。', '若想参与：仅可作为超跌反弹短线博弈，严控仓位≤5%，快进快出。', '转多条件：① 净利同比由负转正；② 股价站上 MA60 且均线拐头向上；③ 主力资金转为持续净流入。']) },
      { title: '八、潜在催化剂', rows: [
        ['主力资金', (d.main20 > 0 && d.main5 > 0) ? '5日/20日持续净流入' : '—'],
        ['业绩', d.npYoY > 20 ? '净利高增（+' + fmt(d.npYoY) + '%）' : '—'],
        ['分红', d.dy > 5 ? '股息率 ' + fmt(d.dy) + '%，高分红防守' : '—'],
        ['位置', (d.rsi !== null && d.rsi < 40) ? 'RSI ' + fmt(d.rsi) + ' 超跌' : '—'],
        ['估值', (d.pe !== null && d.pe < 15) ? 'PE ' + fmt(d.pe) + ' 历史低位' : '—'],
        ['现金流', (d.cf !== null && d.cf > 0) ? '+' + fmt(d.cf) + '亿 健康' : '—']
      ]},
      { title: '九、主要风险', rows: [
        ['趋势', (d.price && d.ma250 && d.price < d.ma250) ? '跌破年线' : '—'],
        ['资金', d.main20 < 0 ? '主力持续流出' : '—'],
        ['业绩', d.npYoY < 0 ? '净利同比负增长' : '—'],
        ['超买', d.rsi > 75 ? 'RSI 超买' : '—'],
        ['估值', (d.pe !== null && d.pe > 50) ? 'PE 偏高' : '—'],
        ['杠杆', d.debt > 70 ? '负债率偏高' : '—']
      ]}
    ],
    notes: ['本报告由 A股选股分析工具 基于腾讯自选股接口实时数据自动生成，为客观数据分析与多因子模型打分结果，不构成任何投资建议。', '评分模型权重：估值28%、财务32%、技术22%、资金18%。', '股市有风险，入市需谨慎；实盘决策请结合自身风险承受能力与资金规划，必要时咨询持牌投资顾问。'],
    lists: []
  };
  if (reps) payload.lists.push({ title: '机构研报（最新评级）', content: reps });
  if (news) payload.lists.push({ title: '相关新闻', content: news });
  const route = fmt === 'pdf' ? '/api/export/pdf' : '/api/export/docx';
  const btn = event && event.target;
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error((await res.json()).error || '导出失败');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = d.name + '_' + (raw.code || '') + '_分析报告' + (fmt === 'pdf' ? '.pdf' : '.docx');
    a.click(); URL.revokeObjectURL(a.href);
    flash('✅ ' + (fmt === 'pdf' ? 'PDF' : 'Word') + ' 报告已生成并下载');
  } catch (e) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    a.download = d.name + '_分析报告.json'; a.click(); URL.revokeObjectURL(a.href);
    flash('⚠️ 服务端导出不可用（' + e.message + '），已下载可导入的 JSON 数据');
  } finally { if (btn) btn.disabled = false; }
}

function flash(msg) {
  let el = $('tip');
  if (!el) { el = document.createElement('div'); el.id = 'tip'; el.style.cssText = 'margin-bottom:14px;padding:12px 16px;border-radius:10px;background:rgba(0,200,150,.1);border:1px solid rgba(0,200,150,.35);color:#a8f0d8;font-size:13.5px'; $('out').prepend(el); }
  el.style.display = 'block'; el.textContent = msg;
  clearTimeout(el._t); el._t = setTimeout(() => el.style.display = 'none', 4500);
}
function loadWatch() {
  try { return JSON.parse(localStorage.getItem('watchlist') || '[]'); } catch (e) { return []; }
}
function saveWatch(list) { localStorage.setItem('watchlist', JSON.stringify(list)); renderWatch(); }
function addWatch(code, name, score) {
  const list = loadWatch();
  if (list.find(x => x.code === code)) return flash('该股票已在自选中');
  list.push({ code, name, score, t: Date.now() });
  saveWatch(list); flash('✅ 已加入自选（共 ' + list.length + ' 只）');
}
function removeWatch(code) { saveWatch(loadWatch().filter(x => x.code !== code)); flash('已移除'); }
function renderWatch() {
  const box = $('watch');
  if (!box) return;
  const list = loadWatch();
  if (!list.length) { box.innerHTML = '<div style="font-size:13px;color:var(--sub)">暂无自选股票。在分析某只股票后点击"加入自选"即可在此追踪评分变化。</div>'; return; }
  let h = '<div style="overflow-x:auto"><table><thead><tr><th>代码</th><th>名称</th><th>综合评分</th><th>操作</th></tr></thead><tbody>';
  list.forEach(x => {
    h += `<tr><td style="color:var(--cyan)">${x.code}</td><td><b>${x.name}</b></td>
      <td><b style="color:${x.score>=70?'var(--buy)':(x.score>=50?'var(--gold)':'var(--avoid)')}">${x.score}</b></td>
      <td><button class="btn-ghost" style="padding:3px 9px;font-size:12px" onclick="doQuick('${x.code}')">分析</button>
      <button class="btn-ghost" style="padding:3px 9px;font-size:12px" onclick="removeWatch('${x.code}')">移除</button></td></tr>`;
  });
  h += '</tbody></table></div>';
  box.innerHTML = h;
}
function doQuick(c) { $('code').value = c.replace(/^(sh|sz)/, ''); analyze(); }

/* 初始化 */
const QUICK = ['600519 贵州茅台', '601318 中国平安', '601398 工商银行', '600276 恒瑞医药', '300308 中际旭创'];
renderWatch();
$('quick').innerHTML = QUICK.map(q => `<span class="chip" onclick="doQuick('${q.split(' ')[0]}')">⚡ ${q}</span>`).join('')
  + `<span class="chip" onclick="document.getElementById('code').value='';renderMarket()">📊 全市场扫描</span>`;
document.getElementById('code').addEventListener('keydown', e => { if (e.key === 'Enter') analyze(); });
renderMarket();
"""

CSS = r"""
:root{--bg:#0e1420;--panel:#161f30;--panel2:#1c2737;--line:#26313f;--txt:#e6edf5;--sub:#8b9bb1;--up:#ff4d4f;--down:#00c896;--gold:#ffb020;--cyan:#36d7e3;--vio:#8b7dff;--buy:#00c896;--watch:#ffb020;--avoid:#ff4d4f}
*{box-sizing:border-box;margin:0;padding:0}
body{background:linear-gradient(160deg,#0c1119,#131c2b 60%,#0d1a26);color:var(--txt);font-family:"PingFang SC","Microsoft YaHei","WenQuanYi Micro Hei",system-ui,sans-serif;min-height:100vh;padding:28px 20px 60px}
.wrap{max-width:1180px;margin:0 auto}
header{display:flex;align-items:center;gap:14px;margin-bottom:6px}
.logo{width:46px;height:46px;border-radius:13px;background:linear-gradient(135deg,#ff4d4f,#ffb020);display:grid;place-items:center;font-size:24px;box-shadow:0 8px 24px rgba(255,77,79,.25)}
h1{font-size:23px;letter-spacing:.5px}
.sub{color:var(--sub);font-size:13px;margin-bottom:22px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:18px}
.input-row{display:flex;gap:10px;align-items:stretch;flex-wrap:wrap}
input[type=text]{flex:1;min-width:240px;background:var(--panel2);border:1px solid var(--line);border-radius:11px;color:var(--txt);font-size:16px;padding:13px 15px;outline:none;letter-spacing:1px}
input[type=text]:focus{border-color:var(--gold)}
button{cursor:pointer;border:none;border-radius:11px;font-size:15px;font-weight:600;padding:0 22px;transition:.18s;white-space:nowrap}
.btn-go{background:linear-gradient(135deg,#ff4d4f,#ff8a3d);color:#fff}
.btn-go:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(255,77,79,.3)}
.btn-ghost{background:var(--panel2);color:var(--sub);border:1px solid var(--line)}
.btn-ghost:hover{color:var(--txt);border-color:var(--cyan)}
.hint{color:var(--sub);font-size:12.5px;margin-top:11px;line-height:1.7}
.hint code{background:var(--panel2);padding:1px 7px;border-radius:5px;color:var(--gold);font-size:12px}
.quick{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.chip{background:var(--panel2);border:1px solid var(--line);color:var(--sub);border-radius:20px;padding:5px 13px;font-size:12.5px;cursor:pointer}
.chip:hover{color:var(--txt);border-color:var(--cyan)}
.verdict{display:flex;align-items:center;gap:18px;padding:22px 24px;border-radius:14px;margin-bottom:18px;flex-wrap:wrap}
.v-buy{background:linear-gradient(100deg,rgba(0,200,150,.16),rgba(0,200,150,.04));border:1px solid rgba(0,200,150,.4)}
.v-watch{background:linear-gradient(100deg,rgba(255,176,32,.16),rgba(255,176,32,.04));border:1px solid rgba(255,176,32,.4)}
.v-avoid{background:linear-gradient(100deg,rgba(255,77,79,.16),rgba(255,77,79,.04));border:1px solid rgba(255,77,79,.4)}
.v-none{background:var(--panel);border:1px solid var(--line)}
.v-score{font-size:46px;font-weight:800;line-height:1}
.v-score small{font-size:15px;font-weight:500;opacity:.7}
.v-text .tag{display:inline-block;font-size:13px;font-weight:700;padding:4px 12px;border-radius:20px;margin-bottom:8px}
.v-buy .tag{background:var(--buy);color:#04231c}
.v-watch .tag{background:var(--watch);color:#2b1d00}
.v-avoid .tag{background:var(--avoid);color:#fff}
.v-text h2{font-size:19px;margin-bottom:5px}
.v-text p{color:var(--sub);font-size:13.5px;line-height:1.6}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;margin-bottom:18px}
.metric{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:15px 17px}
.metric .k{color:var(--sub);font-size:12.5px;margin-bottom:8px}
.metric .v{font-size:21px;font-weight:700}
.metric .n{font-size:12px;color:var(--sub);margin-top:5px;line-height:1.5}
.bar{height:5px;border-radius:4px;background:var(--panel2);overflow:hidden;margin-top:9px}
.bar i{display:block;height:100%;border-radius:4px}
.barlabel{font-size:11px;color:var(--sub);margin-top:4px}
.up{color:var(--up)}.down{color:var(--down)}.muted{color:var(--sub)}
.section-title{font-size:15px;font-weight:700;margin:6px 2px 12px;display:flex;align-items:center;gap:9px}
.section-title i{width:4px;height:15px;background:var(--gold);border-radius:3px;display:inline-block}
.checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:11px}
.check{background:var(--panel2);border-left:3px solid var(--line);border-radius:9px;padding:12px 15px;font-size:13.5px;line-height:1.6}
.check.ok{border-color:var(--buy)}.check.warn{border-color:var(--watch)}.check.bad{border-color:var(--avoid)}
.check .ct{display:flex;align-items:flex-start;gap:9px}
.check .ct b{flex:1}
.badge{flex:0 0 auto;font-size:11px;padding:2px 8px;border-radius:11px;margin-top:2px}
.badge.ok{background:rgba(0,200,150,.18);color:var(--buy)}
.badge.warn{background:rgba(255,176,32,.18);color:var(--watch)}
.badge.bad{background:rgba(255,77,79,.18);color:var(--avoid)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:var(--sub);font-weight:600;text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:11px 12px;border-bottom:1px solid rgba(38,49,63,.5)}
tr:hover td{background:rgba(255,255,255,.02)}
.plan{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:18px 20px;margin-bottom:18px;font-size:13.5px;line-height:1.85}
.plan h4{font-size:14px;margin-bottom:9px;color:var(--gold)}
.plan ul{list-style:none}
.plan li{padding-left:18px;position:relative;margin-bottom:5px;color:#cdd8e6}
.plan li:before{content:"▹";position:absolute;left:0;color:var(--cyan)}
.note{font-size:12px;color:var(--sub);line-height:1.75;background:rgba(139,125,255,.07);border:1px solid rgba(139,125,255,.22);border-radius:12px;padding:14px 18px}
.note b{color:var(--vio)}
.empty{text-align:center;color:var(--sub);padding:40px;font-size:14px}
#loading{position:fixed;inset:0;background:rgba(8,12,20,.72);z-index:99;display:none;place-items:center;flex-direction:column;gap:12px}
#loading .sp{width:34px;height:34px;border:3px solid rgba(255,255,255,.15);border-top-color:var(--gold);border-radius:50%;animation:spin 0.7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
#loading span{color:var(--sub);font-size:13px}
.screen-panel{background:var(--panel2);border:1px dashed var(--line);border-radius:11px;padding:14px 16px;margin-bottom:18px}
.screen-panel .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.screen-panel input[type=text]{background:var(--panel);flex:1;min-width:320px}
.screen-panel input[type=number]{width:70px;background:var(--panel);border:1px solid var(--line);border-radius:9px;color:var(--txt);padding:9px 10px;font-size:14px;outline:none}
@media(max-width:600px){.v-score{font-size:38px}h1{font-size:19px}}
"""

HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>A股选股分析工具 · 实时版</title>
<style>__CSS__</style>
</head>
<body>
<div id="loading"><div class="sp"></div><span>加载中…</span></div>
<div class="wrap">
  <header>
    <div class="logo">📈</div>
    <div><h1>A股选股分析工具 <span style="font-size:12px;color:var(--buy);background:rgba(0,200,150,.12);padding:2px 9px;border-radius:10px">实时版</span></h1>
    <div class="sub">接入腾讯自选股实时行情 · 输入股票代码 → 四维体检与买卖建议 ｜ 留空 → 全市场条件筛选与候选池</div></div>
  </header>

  <div class="card">
    <div class="input-row">
      <input type="text" id="code" placeholder="例如：600519 / sh600519 / 000651 / 300750（留空=全市场实时扫描）" autocomplete="off">
      <button class="btn-go" onclick="analyze()">分析</button>
      <button class="btn-ghost" onclick="document.getElementById('code').value='';analyze()">全市场扫描</button>
    </div>
    <div class="hint">
      支持 6 位代码或带市场前缀（sh / sz），如 <code>600519</code> <code>sh601318</code> <code>000651</code> <code>sz300750</code>。
      有代码 → 估值、财务、技术面、资金流、研报新闻五大维度实时打分 + <b>是否值得买</b>的明确结论；留空 → 按综合评分 + 4 组条件筛选收敛候选池。可自定义筛选表达式，结果可导出 PDF / Word。
    </div>
    <div class="quick" id="quick"></div>
  </div>

  <div class="card">
    <div style="font-size:13px;color:var(--sub);margin-bottom:10px">🔀 <b style="color:var(--txt)">多股横向对比</b>（输入多个代码，用空格或逗号分隔）</div>
    <div class="input-row">
      <input type="text" id="cmpCode" placeholder="例如：600519 601318 000651 300750" autocomplete="off">
      <button class="btn-ghost" onclick="compare()">生成对比表</button>
    </div>
    <div id="cmpOut" style="margin-top:14px"></div>
  </div>

  <div class="card screen-panel">
    <div style="font-size:13px;color:var(--sub);margin-bottom:10px">🔧 <b style="color:var(--txt)">自定义条件筛选</b>（实时执行，可调字段见下方提示）</div>
    <div class="row">
      <input type="text" id="expr" value="intersect([PE_TTM > 0, PE_TTM < 20, ROETTM > 15, DividendRatioTTM > 4, DebtAssetsRatio < 70])" placeholder="筛选表达式">
      <span style="color:var(--sub);font-size:12px">条数</span>
      <input type="number" id="lim" value="15" min="5" max="50">
      <button class="btn-go" style="padding:0 16px;font-size:14px" onclick="runCustom()">执行筛选</button>
    </div>
    <div style="font-size:11.5px;color:var(--sub);margin-top:9px;line-height:1.7">
      可用字段：<code style="color:var(--cyan)">PE_TTM</code> 市盈率 · <code style="color:var(--cyan)">PB</code> 市净率 · <code style="color:var(--cyan)">ROETTM</code> 净资产收益率 · <code style="color:var(--cyan)">TORGrowRate</code> 营收同比 · <code style="color:var(--cyan)">NPParentCompanyYOY</code> 净利同比 · <code style="color:var(--cyan)">DividendRatioTTM</code> 股息率 · <code style="color:var(--cyan)">NetOperateCashFlow</code> 经营现金流 · <code style="color:var(--cyan)">DebtAssetsRatio</code> 资产负债率 · <code style="color:var(--cyan)">GrossIncomeRatio</code> 毛利率 · <code style="color:var(--cyan)">MarketValue</code> 总市值。<br>
      语法：<code style="color:var(--gold)">intersect([条件1, 条件2])</code> 表示 AND（全部满足），<code style="color:var(--gold)">union([...])</code> 表示 OR；也可使用预设 <code style="color:var(--gold)">--preset WhiteHorseGrowth</code> 等。
    </div>
    <div id="customOut" style="margin-top:14px"></div>
  </div>

  <div class="card">
    <div class="section-title"><i></i>⭐ 我的自选（评分快照，本地保存）</div>
    <div id="watch"></div>
  </div>

  <div id="out"></div>
</div>
<script>__JS__</script>
</body>
</html>"""

html = HTML.replace('__CSS__', CSS).replace('__JS__', APP_JS)
open(OUT, 'w', encoding='utf-8').write(html)
print('生成:', OUT, '大小KB:', round(len(html.encode())/1024, 1))
