
// ============ 配置 ============ 
const API = 'http://localhost:7373/api'

// const API = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
//   ? 'http://localhost:7373/api'
//   : 'https://{domain.name}/api'

let watchlist = []
let trades = []
let expandedTradeCodes = []
let lastQuoteMap = {}
let showCleared = false
let lastAnalyzedCode = null

// 初始化时转换旧的字符串格式为对象格式
function initWatchlist() {
  const stored = localStorage.getItem('watchlist')
  if (stored) {
    try {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed)) {
        // 如果是字符串数组，转换为对象数组
        if (parsed.length > 0 && typeof parsed[0] === 'string') {
          watchlist = parsed.map(code => ({
            code: code,
            name: code,
            addedAt: new Date().toISOString()
          }))
          localStorage.setItem('watchlist', JSON.stringify(watchlist))
        } else {
          watchlist = parsed
        }
      }
    } catch (e) {
      console.error('初始化自选列表失败:', e)
      watchlist = []
    }
  }
}
initWatchlist()

// 交易明细初始化（读取 trades，无则尝试迁移旧版 holdings → 一条买入流水）
function initTrades() {
  let stored = null
  try { stored = localStorage.getItem('trades') } catch (e) { stored = null }
  if (stored) {
    try {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed)) { trades = parsed; return }
    } catch (e) { /* 继续迁移 */ }
  }
  migrateOldHoldings()
}

function migrateOldHoldings() {
  let old = null
  try { old = localStorage.getItem('holdings') } catch (e) { old = null }
  if (!old) return
  try {
    const oldArr = JSON.parse(old)
    if (Array.isArray(oldArr)) {
      trades = oldArr.map(h => ({
        id: genTradeId(),
        code: normalizeCode(h.code),
        name: h.name || '',
        type: 'buy',
        price: h.cost || 0,
        qty: h.qty || 0,
        time: h.addedAt || new Date().toISOString()
      })).filter(t => t.price > 0 && t.qty > 0)
      saveTrades()
    }
  } catch (e) { /* 忽略旧数据 */ }
}
initTrades()

// ============ 工具函数 ============
function showLoading(el) { el.innerHTML = '<span class="loading"></span>分析中...' }
function showMsg(el, msg, type) {
  el.innerHTML = `<div class="${type === 'error' ? 'error-msg' : 'success-msg'}">${msg}</div>`
}
function normalizeCode(code) {
  code = code.trim().toLowerCase()
  if (/^\d{6}$/.test(code)) {
    return code.startsWith('6') ? 'sh' + code : 'sz' + code
  }
  return code
}

// 去掉市场前缀，只保留6位数字代码（市场已在说明中体现）
function bareCode(code) {
  return String(code || '').replace(/^(sh|sz|bj)/i, '')
}

// 获取市场归属（含板块：主板 / 创业板 / 科创板）
function getMarketFromCode(code) {
  code = String(code || '').trim().toLowerCase()
  const num = code.replace(/^(sh|sz|bj)/, '')
  if (!/^\d{6}$/.test(num)) return '未知市场'
  if (num.startsWith('688') || num.startsWith('689')) return '沪市(科创板)'
  if (num.startsWith('3')) return '深市(创业板)'
  if (num.startsWith('6')) return '沪市(主板)'
  if (num.startsWith('0')) return '深市(主板)'
  if (num.startsWith('4') || num.startsWith('8') || num.startsWith('9')) return '北交所'
  return '未知市场'
}

// 读取返回条数限制（默认 10，范围 1-100）
function getLimit(id) {
  const el = document.getElementById(id)
  const v = el ? parseInt(el.value) : 10
  return Math.max(1, Math.min(100, isNaN(v) ? 10 : v))
}

// 获取股票信息显示格式
function getStockDisplay(code, name) {
  const market = getMarketFromCode(code)
  return `${market} | ${bareCode(code)} | ${name}`
}

// 格式化数字
function formatNumber(num, decimals = 2) {
  if (num === null || num === undefined || isNaN(num)) return 'N/A'
  return num.toFixed(decimals)
}

// 隐藏结果面板（无有效结果时保持不展示）
function hideResult(el) {
  el = el || document.getElementById('analyzeResult')
  if (!el) return
  el.style.display = 'none'
  el.innerHTML = ''
  const cc = document.getElementById('chartCard')
  if (cc) cc.style.display = 'none'
  if (chartTimer) { clearInterval(chartTimer); chartTimer = null }
}

// 清空输入框及其结果
function clearStockInput() {
  const input = document.getElementById('stockCode')
  input.value = ''
  lastAnalyzedCode = null
  const msgEl = document.getElementById('analyzeMsg')
  if (msgEl) msgEl.innerHTML = ''
  hideResult()
  updateFavButton()
  input.focus()
}

// ============ 单股分析（支持代码或名称搜索） ============
// 从列表快速分析：填充输入框→分析→滚动到单股分析区域
function quickAnalyze(code) {
  const full = normalizeCode(code)
  document.getElementById('stockCode').value = String(full).replace(/^(sh|sz|bj)/, '')
  switchMainTab('analyze')
  analyzeStock()
  const card = document.getElementById('analyzeCard')
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function analyzeStock() {
  const raw = document.getElementById('stockCode').value.trim()
  const msgEl = document.getElementById('analyzeMsg')
  const resultEl = document.getElementById('analyzeResult')
  if (!raw) { hideResult(resultEl); showMsg(msgEl, '请输入股票代码或名称', 'error'); return }

  // 纯代码（可带 sh/sz/bj 前缀）→ 直接分析
  if (/^(sh|sz|bj)?\d{6}$/i.test(raw.replace(/\s/g, ''))) {
    return runAnalyze(normalizeCode(raw))
  }

  // 名称 / 关键词 → 搜索
  showLoading(msgEl)
  resultEl.style.display = 'block'
  resultEl.innerHTML = '<span class="loading"></span>正在搜索…'
  try {
    const res = await fetch(`${API}/search?q=${encodeURIComponent(raw)}`)
    const data = await res.json()
    if (data.error) throw new Error(data.error)
    const list = Array.isArray(data) ? data : (data.results || [])
    if (!list.length) {
      hideResult(resultEl)
      showMsg(msgEl, '⚠️ 未找到匹配的股票，请检查名称或改用代码', 'error')
      return
    }
    if (list.length === 1) return runAnalyze(list[0].code)
    resultEl.innerHTML = `
      <div style="margin-bottom:10px;color:#6a7a9e;">匹配到 ${list.length} 只，请选择要分析的股票：</div>
      ${list.map(s => `<div class="stock-item">
        <div><b>${s.name}</b> <span style="color:#6a7a9e;">${bareCode(s.code)} · ${getMarketFromCode(s.code)}</span></div>
        <button class="secondary" style="padding:4px 12px;font-size:12px;" onclick="document.getElementById('stockCode').value='${bareCode(s.code)}';analyzeStock()">分析</button>
      </div>`).join('')}
    `
    showMsg(msgEl, `✅ 匹配到 ${list.length} 只，请选择`, 'success')
  } catch (e) {
    hideResult(resultEl)
    showMsg(msgEl, `❌ 搜索失败（${e.message}）`, 'error')
  }
}

// 按标准代码拉取行情并渲染
async function runAnalyze(code) {
  const msgEl = document.getElementById('analyzeMsg')
  const resultEl = document.getElementById('analyzeResult')
  lastAnalyzedCode = normalizeCode(code)
  showLoading(msgEl)
  resultEl.style.display = 'block'
  resultEl.innerHTML = '<span class="loading"></span>正在获取行情数据...'
  try {
    const res = await fetch(`${API}/quote/${code}`)
    const data = await res.json()
    if (data.error) throw new Error(data.error)
    
    // 计算评分
    let score = 0
    const peScore = data.pe > 0 && data.pe < 15 ? 25 : (data.pe < 30 ? 15 : 5)
    const changeScore = data.changePercent > 0 ? 20 : 5
    const volScore = data.volume > 0 ? 15 : 5
    score = peScore + changeScore + volScore + 20 // 基础分
    score = Math.min(100, score)
    
    let verdict = score >= 70 ? '<span class="tag tag-buy">✅ 建议买入</span>' : score >= 50 ? '<span class="tag tag-wait">⏳ 观望为主</span>' : '<span class="tag tag-sell">❌ 不建议</span>'
    
    resultEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <h3 style="color:#00d4ff;margin:0;">${getStockDisplay(data.code, data.name)}</h3>
        <div style="display:flex;gap:8px;">
          <button class="secondary" onclick="fillHoldingFromWatchlist('${data.code}','${(data.name||'').replace(/'/g,'')}','${data.price || ''}')">交易</button>
          <button class="secondary" id="favBtn" onclick="toggleFavorite()">☆ 加入自选</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:15px;">
        <div><span style="color:#6a7a9e;">最新价</span><br><span style="font-size:20px;font-weight:600;">${formatNumber(data.price, 2)}</span></div>
        <div><span style="color:#6a7a9e;">涨跌幅</span><br><span style="font-size:20px;font-weight:600;color:${data.changePercent>=0?'#ff4646':'#00c864'}">${data.changePercent>=0?'+':''}${formatNumber(data.changePercent, 2)}%</span></div>
        <div><span style="color:#6a7a9e;">开盘价</span><br><span style="font-size:18px;font-weight:600;">${data.open ? formatNumber(data.open, 2) : 'N/A'}</span></div>
        <div><span style="color:#6a7a9e;">最高价</span><br><span style="font-size:18px;font-weight:600;">${data.high ? formatNumber(data.high, 2) : 'N/A'}</span></div>
        <div><span style="color:#6a7a9e;">最低价</span><br><span style="font-size:18px;font-weight:600;">${data.low ? formatNumber(data.low, 2) : 'N/A'}</span></div>
        <div><span style="color:#6a7a9e;">涨停价</span><br><span style="font-size:18px;font-weight:600;color:#ff4646;">${data.limitUp ? formatNumber(data.limitUp, 2) : 'N/A'}</span></div>
        <div><span style="color:#6a7a9e;">跌停价</span><br><span style="font-size:18px;font-weight:600;color:#00c864;">${data.limitDown ? formatNumber(data.limitDown, 2) : 'N/A'}</span></div>
        <div><span style="color:#6a7a9e;">成交量</span><br><span style="font-size:18px;font-weight:600;">${fmtVolumeHands(data.volume)}</span></div>
        <div><span style="color:#6a7a9e;">PE</span><br><span style="font-size:20px;font-weight:600;">${data.pe ? formatNumber(data.pe, 2) : 'N/A'}</span></div>
        <div><span style="color:#6a7a9e;">PB</span><br><span style="font-size:20px;font-weight:600;">${data.pb ? formatNumber(data.pb, 2) : 'N/A'}</span></div>
        <div><span style="color:#6a7a9e;">换手率</span><br><span style="font-size:20px;font-weight:600;">${data.turnover ? formatNumber(data.turnover, 2)+'%' : 'N/A'}</span></div>
        <div><span style="color:#6a7a9e;">成交额</span><br><span style="font-size:20px;font-weight:600;">${fmtMoneyWan(data.amount)}</span></div>
      </div>
      <div style="margin:15px 0;">
        <span style="color:#6a7a9e;">综合评分：</span>
        <strong style="font-size:24px;color:${score>=70?'#00c864':score>=50?'#ffb400':'#ff4646'}">${score}</strong> / 100
        <div class="score-bar" style="width:300px;display:inline-block;vertical-align:middle;margin-left:10px;">
          <div class="score-fill" style="width:${score}%;background:${score>=70?'#00c864':score>=50?'#ffb400':'#ff4646'}"></div>
        </div>
      </div>
      <div style="margin:10px 0;">${verdict}</div>
      <div style="margin-top:15px;padding:12px;background:#111836;border-radius:8px;border:1px solid #1e2d5a;">
        <div style="color:#6a7a9e;margin-bottom:8px;">💡 操作建议</div>
        ${score >= 70 ? '当前估值合理且走势偏强，可逢低分批建仓，建议仓位 20%-30%，止损设在前低下方 5%。' : score >= 50 ? '基本面尚可但趋势未明，建议观望为主，等待放量突破关键阻力位后再介入。' : '当前估值偏高或走势偏弱，不建议追高，可关注其他标的。'}
      </div>
    `
    updateFavButton()
    showStockChart(data.code, data.name)
    showMsg(msgEl, `✅ ${data.name} 分析完成`, 'success')
  } catch (e) {
    hideResult(resultEl)
    showMsg(msgEl, `❌ 分析失败（${e.message}）`, 'error')
  }
}

// ============ 股票走势图 ============
let currentChartCode = null
let chartTimer = null

function showStockChart(code, name) {
  currentChartCode = normalizeCode(code)
  const card = document.getElementById('chartCard')
  card.style.display = 'block'
  document.getElementById('chartName').textContent = `${name || ''} ${bareCode(currentChartCode)}`
  loadChart('minute')
}

async function loadChart(period) {
  if (!currentChartCode) return
  // 切换视图时停止分时轮询
  if (chartTimer) { clearInterval(chartTimer); chartTimer = null }
  document.querySelectorAll('#chartCard .chart-tab').forEach(b => b.classList.toggle('active', b.dataset.period === period))
  const msgEl = document.getElementById('chartMsg')
  const container = document.getElementById('chartContainer')
  msgEl.innerHTML = '<span class="loading"></span>加载走势图...'
  container.innerHTML = ''
  try {
    const apiPeriod = period === 'day5' ? 'day' : period
    const count = period === 'day5' ? 5 : (period === 'minute' ? 1 : 320)
    const apiUrl = `${API}/kline/${currentChartCode}?period=${apiPeriod}&count=${count}`
    console.log('API请求:', apiUrl) // 调试日志
    const res = await fetch(apiUrl)
    console.log('API响应状态:', res.status, res.statusText) // 调试日志
    let data
    try {
      data = await res.json()
    } catch (e) {
      const text = await res.text()
      console.log('API响应文本:', text) // 调试日志
      throw new Error(`响应不是JSON格式: ${text}`)
    }
    console.log('API响应数据:', data) // 调试日志
    if (data.error) throw new Error(data.error)
    msgEl.innerHTML = ''
    if (data.period === 'minute' && data.points) {
      renderLineChart(container, data.points.map(p => ({ x: p.time, y: p.price })), { prevClose: data.prevClose, timeLabel: true })
      // 分时视图每 30 秒自动拉取最新分时，实现实时跟进
      chartTimer = setInterval(() => {
        const active = document.querySelector('#chartCard .chart-tab.active')
        if (active && active.dataset.period === 'minute' && currentChartCode) loadChart('minute')
      }, 30000)
    } else if (data.klines) {
      renderLineChart(container, data.klines.map(k => ({ x: k.date, y: k.close, close: k.close, open: k.open, high: k.high, low: k.low })), { period: apiPeriod })
    } else {
      msgEl.innerHTML = '<div class="error-msg">未获取到走势数据</div>'
    }
  } catch (e) {
    console.error('加载走势图错误详情:', e) // 调试日志
    msgEl.innerHTML = `<div class="error-msg">走势图加载失败（${e.message}）</div>`
  }
}

function fmtTimeLabel(t) {
  const s = String(t || '').replace(/[^0-9]/g, '').slice(-4)
  return s.length === 4 ? s.slice(0, 2) + ':' + s.slice(2) : String(t || '')
}

// 成交额（万元）→ 展示文本
function fmtMoneyWan(wan) {
  if (!wan || isNaN(wan)) return 'N/A'
  return Math.abs(wan) >= 10000 ? formatNumber(wan / 10000, 2) + ' 亿' : formatNumber(wan, 2) + ' 万'
}

// 成交量（手）→ 展示文本
function fmtVolumeHands(hands) {
  if (!hands || isNaN(hands)) return 'N/A'
  return Math.abs(hands) >= 10000 ? formatNumber(hands / 10000, 2) + ' 万手' : formatNumber(hands, 0) + ' 手'
}

function renderLineChart(container, pts, opts) {
  opts = opts || {}
  if (!pts || !pts.length) { container.innerHTML = '<div style="color:#6a7a9e;">暂无数据</div>'; return }
  const values = pts.map(p => p.y).filter(v => typeof v === 'number' && isFinite(v) && v > 0)
  if (!values.length) { container.innerHTML = '<div style="color:#6a7a9e;">暂无有效数据</div>'; return }
  // 移动端自适应宽度
  const isMobile = window.innerWidth <= 768
  const W = isMobile ? window.innerWidth - 24 : 800
  const H = isMobile ? 200 : 240
  const pl = isMobile ? 48 : 56
  const pr = isMobile ? 12 : 16
  const pt = isMobile ? 14 : 18
  const pb = isMobile ? 28 : 30
  let lo = Math.min.apply(null, values), hi = Math.max.apply(null, values)
  pts.forEach(p => {
    if (typeof p.high === 'number' && isFinite(p.high) && p.high > 0) hi = Math.max(hi, p.high)
    if (typeof p.low === 'number' && isFinite(p.low) && p.low > 0) lo = Math.min(lo, p.low)
  })
  const span = (hi - lo) || Math.abs(hi) * 0.02 || 1
  lo -= span * 0.08; hi += span * 0.08
  const iw = W - pl - pr, ih = H - pt - pb
  const n = pts.length

  // 分时：固定交易日时间轴 09:30–11:30 / 13:00–15:00，午休间隙压缩
  const timeAxis = !!opts.timeLabel
  const TS_BASE = 9 * 60 + 30
  const TS_NOON = 11 * 60 + 30
  const timeToIdx = t => {
    const s = String(t || '').replace(/[^0-9]/g, '').slice(-4)
    const m = s.match(/^(\d{2})(\d{2})$/)
    if (!m) return 0
    const hh = parseInt(m[1], 10)
    const mm = parseInt(m[2], 10)
    if (hh > 23 || mm > 59) return 0
    let v = (hh * 60 + mm) - TS_BASE
    if (v > TS_NOON - TS_BASE) v -= 85
    return Math.max(0, Math.min(T_MAX, v))
  }
  const T_MAX = timeAxis ? 246 : (n - 1)
  const xs = timeAxis ? pts.map(p => timeToIdx(p.x)) : pts.map((p, i) => i)
  const x = i => (T_MAX <= 0 ? pl + iw / 2 : pl + (xs[i] / T_MAX) * iw)
  const y = v => pt + ih - ((v - lo) / (hi - lo)) * ih
  const firstVal = values[0], lastVal = values[values.length - 1], prevClose = opts.prevClose
  const lineColor = '#ff4646'
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(f => pt + ih * f)
  const yText = yy => (hi - ((yy - pt) / ih) * (hi - lo)).toFixed(2)
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join('')
  const xLabel = i => {
    const raw = String(pts[i].x)
    if (timeAxis) {
      // 分时：格式化时间为 HH:MM
      const s = raw.replace(/[^0-9]/g, '').slice(-4)
      return s.length === 4 ? s.slice(0, 2) + ':' + s.slice(2) : raw
    } else {
      // 非分时：显示完整日期 YYYY-MM-DD
      return raw
    }
  }

  // X 轴刻度：分时固定为交易日时段标签
  let tickDefs
  if (timeAxis) {
    tickDefs = [
      { idx: timeToIdx('0930'), label: '09:30' },
      { idx: timeToIdx('1030'), label: '10:30' },
      { idx: (timeToIdx('1130') + timeToIdx('1300')) / 2, label: '11:30/13:00' },
      { idx: timeToIdx('1400'), label: '14:00' },
      { idx: timeToIdx('1500'), label: '15:00' }
    ].map(t => ({ px: pl + (t.idx / T_MAX) * iw, label: t.label, anchor: 'middle' }))
  } else {
    const idxs = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1]
    tickDefs = idxs.map(i => ({ px: x(i), label: xLabel(i), anchor: (i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle')) }))
  }

  // 鼠标位置 → 最近数据点
  const nearestIndex = px => {
    if (!timeAxis) return Math.max(0, Math.min(n - 1, Math.round(((px - pl) / iw) * (n - 1))))
    const target = Math.max(0, Math.min(T_MAX, ((px - pl) / iw) * T_MAX))
    let best = 0, dist = Infinity
    for (let k = 0; k < n; k++) {
      const d = Math.abs(xs[k] - target)
      if (d < dist) { dist = d; best = k }
    }
    return best
  }

  // 当前股票在持仓列表中的交易记录 → 标注到对应图点位
  const chartTrades = currentChartCode ? trades.filter(t => bareCode(t.code) === bareCode(currentChartCode)) : []
  const tradeAtPoint = {}
  if (chartTrades.length) {
    chartTrades.forEach(t => {
      const dt = new Date(t.time)
      if (isNaN(dt.getTime())) return
      let idx = -1
      if (timeAxis) {
        // 分时图仅展示当日交易，历史交易不应标注到今日分时坐标
        if (!isToday(t.time)) return
        const hhmm = String(dt.getHours()).padStart(2, '0') + String(dt.getMinutes()).padStart(2, '0')
        const ti = timeToIdx(hhmm)
        let best = -1, dist = Infinity
        for (let k = 0; k < n; k++) {
          const d2 = Math.abs(xs[k] - ti)
          if (d2 < dist) { dist = d2; best = k }
        }
        if (dist <= 3) idx = best
      } else {
        const dateStr = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`
        // 找到第一个点位日期不早于交易日期：日K精确匹配，周/月K落入对应周期点位
        let target = -1
        for (let k = 0; k < n; k++) {
          if (String(pts[k].x) >= dateStr) { target = k; break }
        }
        if (target >= 0) {
          const pDate = String(pts[target].x)
          const prevDate = target > 0 ? String(pts[target - 1].x) : ''
          // 交易日期必须落在该点位覆盖周期 (prevDate, pDate] 内；首点位无法确定下界时仅接受等日期
          if (dateStr <= pDate && (!prevDate ? dateStr === pDate : dateStr > prevDate)) idx = target
        }
      }
      if (idx >= 0) {
        if (!tradeAtPoint[idx]) tradeAtPoint[idx] = []
        tradeAtPoint[idx].push(t)
      }
    })
  }
  const tradeMarkers = Object.keys(tradeAtPoint).map(idxStr => {
    const idx = +idxStr
    const tList = tradeAtPoint[idx]
    const hasBuy = tList.some(t => t.type !== 'sell')
    const hasSell = tList.some(t => t.type === 'sell')
    const tag = hasBuy && hasSell ? 'T' : (hasBuy ? 'B' : 'S')
    const mColor = hasBuy && hasSell ? '#facc15' : (hasBuy ? '#ff4646' : '#1e90ff')
    const px = x(idx)
    const p = pts[idx]
    const my = y(p.y)
    // 采样圆点附近折线，字母优先放在无趋势线遮挡的上方或下方（允许间隙、距离不固定）
    const lys = []
    const nbr = []
    if (idx > 0) nbr.push(idx - 1)
    nbr.push(idx)
    if (idx < n - 1) nbr.push(idx + 1)
    for (let k = 0; k < nbr.length - 1; k++) {
      const a = nbr[k], b = nbr[k + 1]
      const ax = x(a), bx = x(b)
      const ay = y(pts[a].y), by = y(pts[b].y)
      for (let s = 0; s <= 4; s++) {
        const fx = ax + (bx - ax) * s / 4
        if (fx >= px - 6 && fx <= px + 6) lys.push(ay + (by - ay) * s / 4)
      }
    }
    const gap = 10
    const hit = (lo2, hi2) => lys.some(v => v >= lo2 && v <= hi2)
    const upBlocked = hit(my - gap - 8, my - gap)
    const downBlocked = hit(my + gap - 2, my + gap + 6)
    const up = !(upBlocked && !downBlocked)
    const ty = up ? (my - gap) : (my + gap + 6)
    return `<circle cx="${px.toFixed(1)}" cy="${my.toFixed(1)}" r="3" fill="${mColor}" stroke="#0a0e27" stroke-width="1"/>
      <text x="${px.toFixed(1)}" y="${ty.toFixed(1)}" fill="${mColor}" font-size="${isMobile ? 7 : 8}" font-weight="700" text-anchor="middle">${tag}</text>`
  }).join('')

  let prevLine = ''
  if (timeAxis && prevClose != null && prevClose >= lo && prevClose <= hi) {
    prevLine = `<line x1="${pl}" y1="${y(prevClose).toFixed(1)}" x2="${W - pr}" y2="${y(prevClose).toFixed(1)}" stroke="#8ea0c8" stroke-width="1" stroke-dasharray="4 3"/>`
  }
  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;cursor:crosshair;">
      ${gridLines.map(yy => `<line x1="${pl}" y1="${yy}" x2="${W - pr}" y2="${yy}" stroke="#1e2d5a" stroke-width="1"/><text x="${pl - 6}" y="${yy + 4}" fill="#6a7a9e" font-size="${isMobile ? '10' : '11'}" text-anchor="end">${yText(yy)}</text>`).join('')}
      ${prevLine}
      <path d="${path}" fill="none" stroke="${lineColor}" stroke-width="${isMobile ? '1.5' : '1.8'}" stroke-linejoin="round" stroke-linecap="round"/>
      ${n > 1 ? `<circle cx="${x(n - 1).toFixed(1)}" cy="${y(lastVal).toFixed(1)}" r="3" fill="${lineColor}"/>` : ''}
      ${tradeMarkers}
      ${tickDefs.map(t => `<text x="${t.px.toFixed(1)}" y="${H - 6}" fill="#6a7a9e" font-size="${isMobile ? '10' : '11'}" text-anchor="${t.anchor}">${t.label}</text>`).join('')}
      <g data-tip></g>
    </svg>`

  // 鼠标悬浮：显示对应时刻的时间与价格
  const svg = container.querySelector('svg')
  const tip = svg.querySelector('[data-tip]')
  const toViewBox = (e) => {
    const rect = svg.getBoundingClientRect()
    return { x: (e.clientX - rect.left) * (W / rect.width), y: (e.clientY - rect.top) * (H / rect.height) }
  }
  svg.addEventListener('mousemove', (e) => {
    const p = toViewBox(e)
    if (p.x < pl || p.x > W - pr || p.y < pt || p.y > H - pb) { tip.innerHTML = ''; return }
    const i = nearestIndex(p.x)
    const px = x(i), py = y(pts[i].y)
    const nowDto = new Date()
    const pd = n => String(n).padStart(2, '0')
    const todayStr = `${nowDto.getFullYear()}-${pd(nowDto.getMonth()+1)}-${pd(nowDto.getDate())}`
    const isDayK = timeAxis ? false : (!opts.period || opts.period === 'day')
    const fontSize = isMobile ? 10 : 12
    const strokeWidth = isMobile ? 2 : 3
    tip.innerHTML = `
      <line x1="${px.toFixed(1)}" y1="${pt}" x2="${px.toFixed(1)}" y2="${pt + ih}" stroke="#8ea0c8" stroke-width="1" stroke-dasharray="3 3"/>
      <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4.5" fill="${lineColor}" stroke="#0a0e27" stroke-width="1.5"/>
      <g>
        <text x="${pl + 4}" y="${pt - 4}" fill="#6a7a9e" font-size="${isMobile ? 10 : 11}" text-anchor="start">${timeAxis ? todayStr + ' ' : ''}${xLabel(i)}${timeAxis ? ` ${formatNumber(pts[i].y, 2)} 元` : `（${isDayK ? `收:${formatNumber(pts[i].y, 2)} 开:${(typeof pts[i].open === 'number' && pts[i].open > 0) ? formatNumber(pts[i].open, 2) : 'N/A'} ` : ''}高:${(typeof pts[i].high === 'number' && pts[i].high > 0) ? formatNumber(pts[i].high, 2) : 'N/A'} 低:${(typeof pts[i].low === 'number' && pts[i].low > 0) ? formatNumber(pts[i].low, 2) : 'N/A'}）`}</text>
        ${(function() {
          const tArr = tradeAtPoint[i] || []
          if (!tArr.length) return ''
          const buys = tArr.filter(t => t.type !== 'sell')
          const sells = tArr.filter(t => t.type === 'sell')
          const mk = (list, tag) => {
            if (!list.length) return ''
            const totQty = list.reduce((s, t) => s + t.qty, 0)
            const totAmt = list.reduce((s, t) => s + t.qty * t.price, 0)
            return `${tag} 均价${formatNumber(totQty > 0 ? totAmt / totQty : 0, 2)}*${totQty}股`
          }
          const fsz = isMobile ? 8 : 9
          const bStr = mk(buys, 'B')
          const sStr = mk(sells, 'S')
          const parts = []
          if (bStr) parts.push({ txt: bStr, color: '#ff4646' })
          if (sStr) parts.push({ txt: sStr, color: '#1e90ff' })
          if (!parts.length) return ''
          let cxp = pl + 4
          let html = ''
          parts.forEach((part, k) => {
            const sep = k < parts.length - 1 ? '; ' : ''
            html += `<text x="${cxp.toFixed(1)}" y="${pt + 26}" fill="${part.color}" font-size="${fsz}" text-anchor="start">${part.txt}${sep}</text>`
            cxp += part.txt.length * fsz * 0.85 + (sep ? 8 : 0)
          })
          return html
        })()}
      </g>`
  })
  svg.addEventListener('mouseleave', () => { tip.innerHTML = '' })
}

// ============ 自选股 增删与按钮状态 ============
function isInWatchlist(code) {
  if (!code) return false
  const bare = String(code).replace(/^(sh|sz|bj)/, '')
  return watchlist.some(i => String(i.code).replace(/^(sh|sz|bj)/, '') === bare)
}

// 单股分析区按钮：在自选中→填充图标+取消自选；否则→空心图标+加入自选
function updateFavButton() {
  const btn = document.getElementById('favBtn')
  if (!btn) return
  const inList = isInWatchlist(lastAnalyzedCode)
  btn.innerHTML = inList ? '⭐ 取消自选' : '☆ 加入自选'
  btn.classList.toggle('fav-active', inList)
}

// 按标准代码加入自选
async function addCodeToWatchlist(code, opts) {
  opts = opts || {}
  code = normalizeCode(code)
  if (!/^(sh|sz|bj)?\d{6}$/i.test(code)) { if (!opts.silent) alert('无效的股票代码'); return false }
  if (isInWatchlist(code)) { if (!opts.silent) alert('已在自选列表中'); return false }
  try {
    const res = await fetch(`${API}/quote/${code}`)
    const data = await res.json()
    if (data.error) throw new Error(data.error)
    watchlist.push({
      code,
      name: data.name || code,
      price: data.price,
      changePercent: data.changePercent,
      market: getMarketFromCode(code),
      addedAt: new Date().toISOString()
    })
    localStorage.setItem('watchlist', JSON.stringify(watchlist))
    loadWatchlist()
    updateFavButton()
    if (!opts.silent) showMsg(document.getElementById('analyzeMsg'), `✅ 已加入自选: ${data.name || code} (${code})`, 'success')
    return true
  } catch (e) {
    if (!opts.silent) alert('加入自选失败: ' + e.message)
    return false
  }
}

// 扫描/筛选列表中的快捷加入
function quickAddWatchlist(code) {
  return addCodeToWatchlist(code)
}

// 单股分析区的"加入/取消自选"切换
async function toggleFavorite() {
  const code = lastAnalyzedCode
  if (!code) { alert('请先分析一只股票'); return }
  if (isInWatchlist(code)) {
    removeFromWatchlist(code)
    showMsg(document.getElementById('analyzeMsg'), `已取消自选: ${code}`, 'success')
  } else {
    await addCodeToWatchlist(code)
  }
  updateFavButton()
}

// ============ 市场TAB + 分页表格（通用） ============
const MARKET_TABS = ['主板', '创业板', '科创板', '北交所']
const PAGERS = {}

function marketGroupOf(code) {
  const m = getMarketFromCode(code)
  if (m.indexOf('科创') >= 0) return '科创板'
  if (m.indexOf('创业') >= 0) return '创业板'
  if (m.indexOf('主板') >= 0) return '主板'
  if (m.indexOf('北交所') >= 0) return '北交所'
  return '其它'
}

function createPagedMarketTable(id, rows, opts) {
  const ctrl = {
    rows: rows || [],
    pageSize: 10,
    groups: { 全部: [], 主板: [], 创业板: [], 科创板: [], 北交所: [], 其它: [] },
    state: { market: '全部', page: 1 },
    opts: opts || {}
  }
  ctrl.rows.forEach(r => {
    const g = marketGroupOf(r.code)
    if (!ctrl.groups[g]) ctrl.groups[g] = []
    ctrl.groups[g].push(r)
    ctrl.groups['全部'].push(r)
  })
  ctrl.render = function() {
    const list = ctrl.groups[ctrl.state.market] || []
    const totalPages = Math.max(1, Math.ceil(list.length / ctrl.pageSize))
    if (ctrl.state.page > totalPages) ctrl.state.page = totalPages
    const start = (ctrl.state.page - 1) * ctrl.pageSize
    const pageRows = list.slice(start, start + ctrl.pageSize)
    const tabKeys = ['全部'].concat(MARKET_TABS).concat(['其它'])
    const tabHtml = tabKeys.map(k => {
      const cnt = ctrl.groups[k] ? ctrl.groups[k].length : 0
      return `<button class="market-tab ${ctrl.state.market===k?'active':''}" onclick="setPagedMarket('${id}','${k}')">${k}<span class="tab-count">${cnt}</span></button>`
    }).join('')
    const rowHtml = pageRows.length
      ? pageRows.map((s, i) => ctrl.opts.row(s, start + i + 1)).join('')
      : `<tr><td colspan="${ctrl.opts.cols || 8}" style="text-align:center;color:#6a7a9e;">该分类下暂无数据</td></tr>`
    const pagerHtml = list.length > ctrl.pageSize ? `
      <div class="pager">
        <button class="pager-btn" ${ctrl.state.page<=1?'disabled':''} onclick="setPagedMarket('${id}', null, ${ctrl.state.page-1})">◀ 上一页</button>
        <span style="color:#6a7a9e;font-size:13px;">第 ${ctrl.state.page} / ${totalPages} 页 · 共 ${list.length} 条</span>
        <button class="pager-btn" ${ctrl.state.page>=totalPages?'disabled':''} onclick="setPagedMarket('${id}', null, ${ctrl.state.page+1})">下一页 ▶</button>
      </div>` : ''
    ctrl.el.innerHTML = `
      ${ctrl.opts.topHtml || ''}
      <div class="market-tabs">${tabHtml}</div>
      <div style="overflow-x:auto;">
        <table>
          ${ctrl.opts.head || ''}
          <tbody>${rowHtml}</tbody>
        </table>
      </div>
      ${pagerHtml}
    `
  }
  ctrl.el = document.getElementById(id)
  if (ctrl.el) {
    ctrl.el.style.display = 'block'
    ctrl.render()
  }
  PAGERS[id] = ctrl
  return ctrl
}

function setPagedMarket(id, market, page) {
  const c = PAGERS[id]
  if (!c) return
  if (market) c.state.market = market
  if (page !== undefined && page >= 1) c.state.page = page
  c.render()
}

// ============ 全市场扫描 ============
async function scanMarket() {
  const msgEl = document.getElementById('scanMsg')
  const resultEl = document.getElementById('scanResult')
  const limit = getLimit('scanLimit')
  showLoading(msgEl)
  resultEl.style.display = 'block'
  resultEl.innerHTML = '<span class="loading"></span>正在获取全市场真实行情...'
  try {
    const res = await fetch(`${API}/rank?type=changePercent&order=desc&limit=${limit}`)
    const data = await res.json()
    if (data.error) throw new Error(data.error)
    const stocks = Array.isArray(data) ? data : (data.results || [])

    if (stocks.length === 0) {
      resultEl.innerHTML = '<div class="error-msg">未获取到行情数据，请确认数据服务可访问外网。</div>'
      showMsg(msgEl, '⚠️ 未获取到数据', 'error')
      return
    }

    createPagedMarketTable('scanResult', stocks, {
      topHtml: `<div style="margin-bottom:10px;"><span class="tag tag-info">涨幅前${stocks.length}</span></div>`,
      head: `<tr><th>排名</th><th>市场</th><th>代码</th><th>名称</th><th>最新价</th><th>涨跌幅</th><th>PE</th><th>操作</th></tr>`,
      cols: 8,
      row: (s, rank) => {
        const market = getMarketFromCode(s.code || '')
        const code = s.code || 'N/A'
        const name = s.name || '未知'
        const price = s.price
        const changePercent = s.changePercent
        const pe = s.pe
        return `
        <tr>
          <td>${rank}</td>
          <td><span style="color:#6a7a9e;">${market}</span></td>
          <td><span style="color:var(--cyan);font-weight:600;">${bareCode(code)}</span></td>
          <td>${name}</td>
          <td>${formatNumber(price, 2)}</td>
          <td style="color:${changePercent>=0?'#ff4646':'#00c864'}">${changePercent>=0?'+':''}${formatNumber(changePercent, 2)}%</td>
          <td>${formatNumber(pe, 2)}</td>
          <td><button class="secondary" style="padding:4px 10px;font-size:12px;" onclick="quickAnalyze('${code}')">行情</button> <button class="secondary" style="padding:4px 10px;font-size:12px;" onclick="quickAddWatchlist('${code}')">加入自选</button></td>
        </tr>`
      }
    })
    showMsg(msgEl, `✅ 扫描完成（${stocks.length} 条）`, 'success')
  } catch (e) {
    resultEl.innerHTML = `<div class="error-msg">行情获取失败，请检查网络后重试（${e.message}）</div>`
    showMsg(msgEl, `❌ 行情获取失败（${e.message}）`, 'error')
  }
}

// ============ 排行 ============
async function loadRank(type, order) {
  const msgEl = document.getElementById('scanMsg')
  const resultEl = document.getElementById('scanResult')
  const limit = getLimit('scanLimit')
  showLoading(msgEl)
  resultEl.style.display = 'block'
  resultEl.innerHTML = '<span class="loading"></span>正在获取真实行情...'
  try {
    const res = await fetch(`${API}/rank?type=${type}&order=${order}&limit=${limit}`)
    const data = await res.json()
    if (data.error) throw new Error(data.error)
    const label = type === 'changePercent' ? (order==='desc'?'涨幅':'跌幅') : type==='turnover'?'换手率':'排行'
    const stocks = Array.isArray(data) ? data : (data.results || [])

    if (stocks.length === 0) {
      resultEl.innerHTML = '<div class="error-msg">未获取到行情数据，请确认数据服务可访问外网。</div>'
      showMsg(msgEl, `⚠️ ${label}排行无数据`, 'error')
      return
    }

    const isPct = type === 'changePercent'
    createPagedMarketTable('scanResult', stocks, {
      topHtml: `<div style="margin-bottom:10px;"><span class="tag tag-info">${label}排行 TOP${stocks.length}</span></div>`,
      head: `<tr><th>排名</th><th>市场</th><th>代码</th><th>名称</th><th>最新价</th><th>${label}</th><th>操作</th></tr>`,
      cols: 7,
      row: (s, rank) => {
        const market = getMarketFromCode(s.code || '')
        const code = s.code || 'N/A'
        const name = s.name || '未知'
        const price = s.price
        const displayValue = isPct ? s.changePercent : s.turnover
        const color = isPct ? (displayValue>=0?'#ff4646':'#00c864') : '#00d4ff'
        return `
        <tr>
          <td>${rank}</td>
          <td><span style="color:#6a7a9e;">${market}</span></td>
          <td><span style="color:var(--cyan);font-weight:600;">${bareCode(code)}</span></td>
          <td>${name}</td>
          <td>${formatNumber(price, 2)}</td>
          <td style="color:${color}">${displayValue>=0?'+':''}${formatNumber(displayValue, 2)}%</td>
          <td><button class="secondary" style="padding:4px 10px;font-size:12px;" onclick="quickAnalyze('${code}')">行情</button> <button class="secondary" style="padding:4px 10px;font-size:12px;" onclick="quickAddWatchlist('${code}')">加入自选</button></td>
        </tr>`
      }
    })
    showMsg(msgEl, `✅ ${label}排行加载完成`, 'success')
  } catch (e) {
    resultEl.innerHTML = `<div class="error-msg">行情获取失败，请检查网络后重试（${e.message}）</div>`
    showMsg(msgEl, `❌ 行情获取失败（${e.message}）`, 'error')
  }
}

// ============ 条件筛选 ============
function addScreenerRow(btn) {
  const container = document.getElementById('screenerConditions')
  const row = btn.parentElement.cloneNode(true)
  row.querySelector('button').textContent = '−'
  row.querySelector('button').onclick = function() { this.parentElement.remove() }
  container.appendChild(row)
}

function updateScreenerField(select) {
  // 字段变化时可动态调整后续选项
}

function presetScreener(type) {
  const container = document.getElementById('screenerConditions')
  container.innerHTML = ''
  const presets = {
    dividend: [{f:'pe',o:'lt',v:'15'},{f:'changePercent',o:'gt',v:'0'}],
    growth: [{f:'changePercent',o:'gt',v:'2'},{f:'turnover',o:'gt',v:'1'}],
    cashflow: [{f:'pe',o:'lt',v:'25'},{f:'pb',o:'lt',v:'3'}]
  }
  const items = presets[type] || []
  const fieldNames = {pe:'市盈率(PE)',pb:'市净率(PB)',changePercent:'涨跌幅',turnover:'换手率',price:'股价'}
  items.forEach(item => {
    const div = document.createElement('div')
    div.className = 'screener-row'
    div.innerHTML = `
      <select><option value="${item.f}">${fieldNames[item.f]||item.f}</option><option value="pe">市盈率(PE)</option><option value="pb">市净率(PB)</option><option value="changePercent">涨跌幅</option><option value="turnover">换手率</option></select>
      <select><option value="${item.o}">${item.o==='lt'?'<':item.o==='gt'?'>':'='}</option><option value="lt">&lt;</option><option value="gt">&gt;</option><option value="eq">=</option></select>
      <input type="text" placeholder="数值" value="${item.v}">
      <button class="secondary" onclick="this.parentElement.remove()">−</button>
    `
    container.appendChild(div)
  })
}

async function runScreener() {
  const msgEl = document.getElementById('screenerMsg')
  const resultEl = document.getElementById('screenerResult')
  const limit = getLimit('screenerLimit')
  showLoading(msgEl)
  resultEl.style.display = 'block'
  resultEl.innerHTML = '<span class="loading"></span>正在筛选全市场真实数据...'

  try {
    // 收集筛选条件
    const conditions = []
    const rows = document.querySelectorAll('#screenerConditions .screener-row')
    rows.forEach(row => {
      const selects = row.querySelectorAll('select')
      const input = row.querySelector('input')
      if (selects.length >= 2 && input) {
        const field = selects[0].value
        const operator = selects[1].value
        const value = parseFloat(input.value)
        if (!isNaN(value)) {
          conditions.push({ field, operator, value })
        }
      }
    })

    if (conditions.length === 0) {
      resultEl.innerHTML = '<div style="color:var(--sub);">请输入筛选条件</div>'
      showMsg(msgEl, '请输入筛选条件', 'error')
      return
    }

    // 调用筛选API
    const res = await fetch(`${API}/screener`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conditions, limit })
    })
    const data = await res.json()
    if (data.error) throw new Error(data.error)

    const stocks = Array.isArray(data) ? data : (data.results || [])
    const total = (data && data.total != null) ? data.total : stocks.length

    if (stocks.length === 0) {
      resultEl.innerHTML = '<div style="color:#6a7a9e;">当前条件下无匹配标的。</div>'
      showMsg(msgEl, '✅ 筛选完成，无匹配标的', 'success')
      return
    }

    createPagedMarketTable('screenerResult', stocks, {
      topHtml: `
        <div style="margin-bottom:10px;">
          <span class="tag tag-info">筛选结果 (共 ${total} 只，显示前 ${stocks.length} 只)</span>
          <span style="margin-left:10px;color:#6a7a9e;font-size:12px;">筛选条件: ${conditions.map(c => `${c.field} ${c.operator} ${c.value}`).join('; ')}</span>
        </div>`,
      head: `<tr><th>市场</th><th>代码</th><th>名称</th><th>最新价</th><th>涨跌幅</th><th>PE</th><th>PB</th><th>操作</th></tr>`,
      cols: 8,
      row: (s) => {
        const market = getMarketFromCode(s.code || '')
        const code = s.code || 'N/A'
        const name = s.name || '未知'
        const price = s.price
        const changePercent = s.changePercent
        const pe = s.pe
        const pb = s.pb
        return `
        <tr>
          <td><span style="color:#6a7a9e;">${market}</span></td>
          <td><span style="color:var(--cyan);font-weight:600;">${bareCode(code)}</span></td>
          <td>${name}</td>
          <td>${formatNumber(price, 2)}</td>
          <td style="color:${changePercent>=0?'#ff4646':'#00c864'}">${changePercent>=0?'+':''}${formatNumber(changePercent, 2)}%</td>
          <td>${formatNumber(pe, 2)}</td>
          <td>${formatNumber(pb, 2)}</td>
          <td><button class="secondary" style="padding:4px 10px;font-size:12px;" onclick="quickAnalyze('${code}')">行情</button> <button class="secondary" style="padding:4px 10px;font-size:12px;" onclick="quickAddWatchlist('${code}')">加入自选</button></td>
        </tr>`
      }
    })
    showMsg(msgEl, `✅ 筛选完成，找到 ${total} 只股票`, 'success')
  } catch (e) {
    resultEl.innerHTML = `<div class="error-msg">筛选失败，请检查网络后重试（${e.message}）</div>`
    showMsg(msgEl, `❌ 筛选失败（${e.message}）`, 'error')
  }
}

// ============ 自选股 ============
function renderWatchlist(list) {
  const resultEl = document.getElementById('watchlistResult')
  resultEl.style.display = 'block'
  // 按添加时间倒序（新添加的排在最前）
  list = [].concat(list).sort((a, b) => {
    const ta = a.addedAt ? new Date(a.addedAt).getTime() : 0
    const tb = b.addedAt ? new Date(b.addedAt).getTime() : 0
    return tb - ta
  })
  if (!list.length) {
    resultEl.innerHTML = '<div style="color:#6a7a9e;">自选列表为空，请先添加股票</div>'
    return
  }
  resultEl.innerHTML = `
    <div class="stock-grid">
      ${list.map(item => `
        <div class="stock-item" style="margin-bottom:0;">
          <div style="min-width:0;flex:1;">
            <div style="margin-bottom:3px;font-size:12px;color:#6a7a9e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${getStockDisplay(item.code, item.name)}</div>
            <div style="display:flex;align-items:center;">
              <span style="font-size:17px;font-weight:600;">${item.price != null ? formatNumber(item.price, 2) : 'N/A'}</span>
              ${item.changePercent !== undefined && item.changePercent !== null ? `<span style="margin-left:8px;color:${item.changePercent>=0?'#ff4646':'#00c864'}">${item.changePercent>=0?'+':''}${formatNumber(item.changePercent, 2)}%</span>` : ''}
            </div>
            ${item.addedAt ? `<div style="font-size:10px;color:#6a7a9e;">添加于: ${new Date(item.addedAt).toLocaleString('zh-CN')}</div>` : ''}
          </div>
          <div style="display:flex;gap:4px;">
            <button class="secondary" style="padding:3px 8px;font-size:11px;" onclick="quickAnalyze('${String(item.code).replace(/^(sh|sz|bj)/, '')}')">行情</button>
            <button class="secondary" style="padding:3px 8px;font-size:11px;" onclick="fillHoldingFromWatchlist('${item.code}','${(item.name||'').replace(/'/g,'')}','${item.price || ''}')">买入</button>
            <button class="danger" style="padding:3px 8px;font-size:11px;" onclick="removeFromWatchlist('${item.code}')">删</button>
          </div>
        </div>
      `).join('')}
    </div>
  `
}

async function loadWatchlist() {
  if (!watchlist.length) { renderWatchlist([]); updateFavButton(); return }
  const resultEl = document.getElementById('watchlistResult')
  resultEl.style.display = 'block'
  resultEl.innerHTML = '<span class="loading"></span>加载自选股...'
  try {
    const codes = watchlist.map(item => item.code).filter(Boolean)
    if (codes.length > 0) {
      const res = await fetch(`${API}/quote/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes })
      })
      const data = await res.json()
      const arr = Array.isArray(data) ? data : (data.results || [])
      const updated = watchlist.map(item => {
        const realtime = arr.find(s => s.code === item.code || s.code === String(item.code).replace(/^(sh|sz|bj)/, ''))
        if (realtime) {
          return {
            ...item,
            price: realtime.price,
            changePercent: realtime.changePercent,
            name: realtime.name || item.name,
            updatedAt: new Date().toISOString()
          }
        }
        return item
      })
      localStorage.setItem('watchlist', JSON.stringify(updated))
      watchlist = updated
      renderWatchlist(updated)
    } else {
      renderWatchlist(watchlist)
    }
  } catch (e) {
    renderWatchlist(watchlist)
  }
  updateFavButton()
}

function removeFromWatchlist(code) {
  const bare = String(code).replace(/^(sh|sz|bj)/, '')
  watchlist = watchlist.filter(item => String(item.code).replace(/^(sh|sz|bj)/, '') !== bare)
  localStorage.setItem('watchlist', JSON.stringify(watchlist))
  loadWatchlist()
  updateFavButton()
}

function clearWatchlist() {
  if (!watchlist.length) { showMsg(document.getElementById('scanMsg'), '自选列表为空', 'info'); return }
  if (confirm(`确定清空自选列表（共 ${watchlist.length} 只股票）？`)) {
    watchlist = []
    localStorage.removeItem('watchlist')
    document.getElementById('watchlistResult').style.display = 'none'
    showMsg(document.getElementById('scanMsg'), '自选列表已清空', 'success')
  }
}

// ============ 持仓管理（基于交易明细汇总） ============
// 交易流水：{ id, code, name, type:'buy'|'sell', price, qty, time }
function genTradeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// datetime-local 输入框默认值：当前系统时间
function holdTimeNow() {
  const now = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth()+1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`
}

function saveTrades() {
  localStorage.setItem('trades', JSON.stringify(trades))
}

function fmtTradeTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 添加交易流水（永远新增，不修改历史流水）
async function addTrade() {
  const raw = document.getElementById('holdStockInput').value.trim()
  const type = document.getElementById('holdTypeInput').value
  const price = parseFloat(document.getElementById('holdCostInput').value)
  const qty = parseInt(document.getElementById('holdQtyInput').value)

  if (!raw) { alert('请输入股票代码或名称'); return }
  if (isNaN(price) || price <= 0) { alert('请输入有效的交易股价'); return }
  if (isNaN(qty) || qty <= 0) { alert('请输入有效的交易数量'); return }

  let code
  if (/^(sh|sz|bj)?\d{6}$/i.test(raw.replace(/\s/g, ''))) {
    code = normalizeCode(raw)
  } else {
    try {
      const res = await fetch(`${API}/search?q=${encodeURIComponent(raw)}`)
      const data = await res.json()
      const list = Array.isArray(data) ? data : (data.results || [])
      if (!list.length) { alert('未找到匹配的股票，请改用代码'); return }
      if (list.length === 1) code = list[0].code
      else {
        const resultEl = document.getElementById('holdingsResult')
        resultEl.style.display = 'block'
        resultEl.innerHTML = `
          <div style="margin-bottom:10px;color:#6a7a9e;">匹配到 ${list.length} 只，请选择：</div>
          ${list.map(s => `<div class="stock-item">
            <div><b>${s.name}</b> <span style="color:#6a7a9e;">${bareCode(s.code)} · ${getMarketFromCode(s.code)}</span></div>
            <button class="secondary" style="padding:4px 12px;font-size:12px;" onclick="pickHoldingStock('${bareCode(s.code)}','${(s.name||'').replace(/'/g,'')}')">选择</button>
          </div>`).join('')}`
        return
      }
    } catch (e) { alert(`搜索失败（${e.message}）`); return }
  }

  // 卖出校验：卖出数量不能超过当前持仓
  if (type === 'sell') {
    const b = bareCode(code)
    let holding = 0
    trades.forEach(t => {
      if (bareCode(t.code) !== b) return
      holding += t.type === 'sell' ? -t.qty : t.qty
    })
    if (qty > holding) { alert(`卖出数量(${qty})超过当前持仓(${holding} 股)`); return }
  }

  try {
    const res = await fetch(`${API}/quote/${code}`)
    const data = await res.json()
    if (data.error) throw new Error(data.error)
    const timeInput = document.getElementById('holdTimeInput').value
    const tradeTime = timeInput ? new Date(timeInput).toISOString() : new Date().toISOString()
    trades.push({
      id: genTradeId(),
      code: normalizeCode(data.code),
      name: data.name || '',
      type: type,
      price: price,
      qty: qty,
      time: tradeTime
    })
    saveTrades()
    addCodeToWatchlist(normalizeCode(data.code), { silent: true })
    document.getElementById('holdStockInput').value = ''
    document.getElementById('holdCostInput').value = ''
    document.getElementById('holdQtyInput').value = ''
    document.getElementById('holdTimeInput').value = holdTimeNow()
    document.getElementById('holdStockHint').textContent = ''
    loadHoldings()
  } catch (e) {
    alert(`添加失败（${e.message}）`)
  }
}

// 搜索多匹配时选择某只股票后回填代码
function pickHoldingStock(code, name) {
  document.getElementById('holdStockInput').value = code
  document.getElementById('holdStockHint').textContent = name ? `${name}(${code})` : ''
  document.getElementById('holdCostInput').focus()
}

// 是否为今天（自然日）
function isToday(iso) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return false
  const now = new Date()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

// 按交易时间先进先出（FIFO）计算持仓成本
// 每笔买入作为一个批次记录，卖出时优先扣减最早买入的批次
// 成本价 = 剩余（未卖出的最早批次）批次的加权平均价
function calcCost(trades) {
  const lots = []
  trades.slice().sort((a, b) => new Date(a.time) - new Date(b.time)).forEach(t => {
    if (t.type === 'sell') {
      let remain = t.qty
      while (remain > 0 && lots.length) {
        const head = lots[0]
        if (head.qty <= remain) {
          remain -= head.qty
          lots.shift()
        } else {
          head.qty -= remain
          remain = 0
        }
      }
    } else {
      lots.push({ qty: t.qty, price: t.price })
    }
  })
  const totalQty = lots.reduce((s, l) => s + l.qty, 0)
  if (!totalQty) return 0
  return lots.reduce((s, l) => s + l.qty * l.price, 0) / totalQty
}

// 渲染持仓汇总表（由交易明细动态汇总）及可展开的明细表
function renderHoldings(quoteMap = {}) {
  const resultEl = document.getElementById('holdingsResult')
  resultEl.style.display = 'block'

  const groups = {}
  trades.forEach(t => {
    const bare = bareCode(t.code)
    if (!groups[bare]) groups[bare] = { code: t.code, name: t.name, buyQty: 0, buyAmt: 0, sellQty: 0, sellAmt: 0, todayBuyQty: 0, todayBuyAmt: 0, todaySellQty: 0, todaySellAmt: 0, trades: [], latestTime: '' }
    const g = groups[bare]
    if (!g.latestTime || new Date(t.time) > new Date(g.latestTime)) g.latestTime = t.time
    if (t.type === 'sell') { g.sellQty += t.qty; g.sellAmt += t.qty * t.price }
    else { g.buyQty += t.qty; g.buyAmt += t.qty * t.price }
    if (isToday(t.time)) {
      if (t.type === 'sell') { g.todaySellQty += t.qty; g.todaySellAmt += t.qty * t.price }
      else { g.todayBuyQty += t.qty; g.todayBuyAmt += t.qty * t.price }
    }
    g.trades.push(t)
  })

  const list = Object.values(groups)
    .map(g => {
      const q = quoteMap[bareCode(g.code)] || {}
      const price = q.price || 0
      const yClose = q.yesterdayClose || 0
      const cost = calcCost(g.trades)
      const qty = g.buyQty - g.sellQty
      // 持仓市值 = 现价 × 持仓数量
      const floating = price * qty
      // 买卖差额 = Σ卖出金额 - Σ买入金额
      const realized = g.sellAmt - g.buyAmt
      // 总持仓收益 = 现价×持仓数量 + Σ卖出金额 - Σ买入金额
      const totalProfit = floating + realized
      // 当日盈亏 = 持仓相对昨收变化 + 当日卖出收益 - 当日买入消耗（相对昨收）
      const dayProfit = (price - yClose) * qty
        + (g.todaySellAmt - yClose * g.todaySellQty)
        - (g.todayBuyAmt - yClose * g.todayBuyQty)
      return {
        code: g.code,
        name: q.name || g.name || '',
        cost: cost,
        qty: qty,
        price: price,
        buyAmt: g.buyAmt,
        sellAmt: g.sellAmt,
        realized: realized,
        floating: floating,
        totalProfit: totalProfit,
        dayProfit: dayProfit,
        trades: g.trades,
        latestTime: g.latestTime || ''
      }
    })
    .sort((a, b) => new Date(b.latestTime) - new Date(a.latestTime))
    .filter(s => showCleared || s.qty > 0)

  // 总是显示复选框：展示已清仓
  const hasData = list.length > 0 || trades.length > 0

  if (!hasData) {
    resultEl.innerHTML = `
      <div style="margin-bottom:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
        <label style="font-size:13px;color:#6a7a9e;display:flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" id="showClearedChk" ${showCleared?'checked':''} onchange="showCleared=this.checked;renderHoldings(lastQuoteMap)">展示已清仓</label>
      </div>
      <div style="color:#6a7a9e;">暂无持仓，请先添加交易明细</div>
    `
    return
  }

  let totalCost = 0, totalValue = 0, totalProfit = 0, totalDayProfit = 0, totalSellAmt = 0
  list.forEach(s => {
    totalCost += s.buyAmt
    totalValue += s.price * s.qty
    totalProfit += s.totalProfit
    totalDayProfit += s.dayProfit
    totalSellAmt += s.sellAmt
  })
  const holdPct = totalCost > 0 ? totalProfit / totalCost * 100 : 0
  const dayPct = totalCost > 0 ? totalDayProfit / totalCost * 100 : 0

  resultEl.innerHTML = `
    <div style="margin-bottom:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
      <span class="tag tag-info">总市值 ${formatNumber(totalValue, 2)}</span>
      <span class="tag tag-info">总投入 ${formatNumber(totalCost, 2)}</span>
      <span class="tag tag-info">总卖出 ${formatNumber(totalSellAmt, 2)}</span>
      <span class="tag ${totalProfit>=0?'tag-sell':'tag-buy'}">持仓收益 ${totalProfit>=0?'+':''}${formatNumber(totalProfit, 2)} (${holdPct>=0?'+':''}${formatNumber(holdPct, 2)}%)</span>
      <span class="tag ${totalDayProfit>=0?'tag-sell':'tag-buy'}">当日盈亏 ${totalDayProfit>=0?'+':''}${formatNumber(totalDayProfit, 2)} (${dayPct>=0?'+':''}${formatNumber(dayPct, 2)}%)</span>
      <label style="font-size:13px;color:#6a7a9e;display:flex;align-items:center;gap:4px;margin-left:auto;cursor:pointer;"><input type="checkbox" id="showClearedChk" ${showCleared?'checked':''} onchange="showCleared=this.checked;renderHoldings(lastQuoteMap)">展示已清仓</label>
    </div>
    <div style="overflow-x:auto;">
      <table>
        <thead><tr><th>股票</th><th>成本价</th><th>数量</th><th>现价</th><th>市值</th><th>持仓收益</th><th>当日盈亏</th><th>操作</th></tr></thead>
        <tbody>
        ${list.map(s => {
          const bare = bareCode(s.code)
          const price = s.price || 0
          const yClose = s.yesterdayClose || 0
          const hasQuote = price > 0
          const holdColor = s.totalProfit >= 0 ? '#ff4646' : '#00c864'
          const dayColor = s.dayProfit >= 0 ? '#ff4646' : '#00c864'
          const expanded = expandedTradeCodes.indexOf(bare) >= 0
          const detailRow = expanded ? `
          <tr>
            <td colspan="8" style="padding:10px 12px;background:#0a0e27;">
              <div style="font-size:12px;color:#6a7a9e;margin-bottom:6px;">📋 ${s.name || ''} (${bare}) 交易明细（${s.trades.length} 条）</div>
              <div style="overflow-x:auto;">
              <table style="font-size:12px;border:1px solid #1e2d5a;">
                <thead><tr><th>时间</th><th>交易方式</th><th>交易股价</th><th>交易数量</th><th>交易金额</th><th>操作</th></tr></thead>
                <tbody>
                  ${s.trades.slice().sort((a,b)=>new Date(b.time)-new Date(a.time)).map(t => `
                  <tr>
                    <td><span style="color:#6a7a9e;">${fmtTradeTime(t.time)}</span></td>
                    <td style="color:${t.type==='buy'?'#ff4646':'#00c864'};">${t.type==='buy'?'买入':'卖出'}</td>
                    <td>${formatNumber(t.price, 3)}</td>
                    <td>${t.qty}</td>
                    <td>${formatNumber(t.price * t.qty, 2)}</td>
                    <td><button class="danger" style="padding:2px 8px;font-size:11px;" onclick="removeTrade('${t.id}')">删</button></td>
                  </tr>`).join('')}
                </tbody>
              </table>
              </div>
            </td>
          </tr>` : ''
          const holdPct = s.buyAmt > 0 ? s.totalProfit / s.buyAmt * 100 : 0
          const dayPct = s.buyAmt > 0 ? s.dayProfit / s.buyAmt * 100 : 0
          const holdCell = hasQuote
            ? `${s.totalProfit>=0?'+':''}${formatNumber(s.totalProfit, 2)}<br><span style="font-size:11px;">${holdPct>=0?'+':''}${formatNumber(holdPct, 2)}%</span>`
            : 'N/A'
          const dayCell = hasQuote
            ? `${s.dayProfit>=0?'+':''}${formatNumber(s.dayProfit, 2)}<br><span style="font-size:11px;">${dayPct>=0?'+':''}${formatNumber(dayPct, 2)}%</span>`
            : 'N/A'
          return `
          <tr>
            <td><b>${s.name || ''}</b><br><span style="color:#6a7a9e;font-size:11px;">${bare}</span></td>
            <td>${formatNumber(s.cost, 3)}</td>
            <td>${s.qty}</td>
            <td>${hasQuote ? formatNumber(price, 2) : 'N/A'}</td>
            <td>${hasQuote ? formatNumber(s.floating, 2) : 'N/A'}</td>
            <td style="color:${holdColor};">${holdCell}</td>
            <td style="color:${dayColor};">${dayCell}</td>
            <td>
              <button class="secondary" style="padding:3px 8px;font-size:11px;" onclick="quickAnalyze('${bare}')">行情</button>
              <button class="secondary" style="padding:3px 8px;font-size:11px;" onclick="fillTradeFromHolding('${bare}')">交易</button>
              <button class="secondary" style="padding:3px 8px;font-size:11px;" onclick="toggleTrades('${bare}')">${expanded?'收起':'明细'}</button>
              <button class="danger" style="padding:3px 8px;font-size:11px;" onclick="removeHolding('${bare}')">删</button>
            </td>
          </tr>${detailRow}`
        }).join('')}
        </tbody>
      </table>
    </div>
  `
}

function switchMainTab(tab) {
  const tabs = ['analyze', 'watchlist', 'holdings', 'scan', 'screener', 'asset']
  const cardIds = { analyze: 'analyzeCard', watchlist: 'watchlistCard', holdings: 'holdingsCard', scan: 'scanCard', screener: 'screenerCard', asset: 'assetCard' }
  tabs.forEach(t => {
    const card = document.getElementById(cardIds[t])
    if (card) card.style.display = (t === tab) ? '' : 'none'
    const btn = document.getElementById('tabBtn' + t.charAt(0).toUpperCase() + t.slice(1))
    if (btn) btn.classList.toggle('active', t === tab)
  })
  const chartCard = document.getElementById('chartCard')
  if (chartCard) {
    if (tab === 'analyze' && lastAnalyzedCode) chartCard.style.display = 'block'
    else chartCard.style.display = 'none'
  }
  if (tab === 'watchlist') loadWatchlist()
  if (tab === 'holdings') loadHoldings()
  if (tab === 'asset') {
    // 如果assetType不是day，则切换为day类型
    if (assetType !== 'day') switchAssetType('day')
    // 确保日期输入框有值
    const dateInput = document.getElementById('assetDateInput')
    if (dateInput && assetType === 'day' && !dateInput.value) {
      dateInput.value = dateStr(new Date())
    }
    loadAssetAnalysis()
  }
}

function toggleTrades(code) {
  const bare = bareCode(code)
  const idx = expandedTradeCodes.indexOf(bare)
  if (idx >= 0) expandedTradeCodes = []
  else expandedTradeCodes = [bare]
  renderHoldings(lastQuoteMap)
}

// 汇总表"交易"按钮：填入代码，股价默认现价，数量置空，交易方式默认卖出
function fillTradeFromHolding(code) {
  const bare = bareCode(code)
  const q = lastQuoteMap[bare] || {}
  document.getElementById('holdStockInput').value = bare
  document.getElementById('holdTypeInput').value = 'sell'
  document.getElementById('holdCostInput').value = q.price > 0 ? q.price : ''
  document.getElementById('holdQtyInput').value = ''
  document.getElementById('holdTimeInput').value = holdTimeNow()
  const t = trades.find(t => bareCode(t.code) === bare)
  document.getElementById('holdStockHint').textContent = (t && t.name) ? `${t.name}(${bare})` : ''
  switchMainTab('holdings')
  const card = document.getElementById('holdingsCard')
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' })
  document.getElementById('holdQtyInput').focus()
}

// 刷新行情（从交易明细提取股票，批量获取现价与昨收）
async function loadHoldings() {
  const resultEl = document.getElementById('holdingsResult')
  if (!trades.length) { renderHoldings(); return }
  resultEl.style.display = 'block'
  resultEl.innerHTML = '<span class="loading"></span>加载行情...'
  const codes = [...new Set(trades.map(t => normalizeCode(t.code)))].filter(Boolean)
  let quoteMap = {}
  if (codes.length > 0) {
    try {
      const res = await fetch(`${API}/quote/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes })
      })
      const data = await res.json()
      const arr = Array.isArray(data) ? data : (data.results || [])
      arr.forEach(rt => {
        const a = rt.price || 0
        const yc = rt.yesterdayClose > 0 ? rt.yesterdayClose : ((a > 0 && rt.change) ? a - rt.change : 0)
        quoteMap[bareCode(rt.code)] = { price: a, yesterdayClose: yc, name: rt.name }
      })
    } catch (e) { /* 无行情时按 N/A 展示 */ }
  }
  lastQuoteMap = quoteMap
  renderHoldings(quoteMap)
}

// 删除单条交易明细
function removeTrade(id) {
  trades = trades.filter(t => t.id !== id)
  saveTrades()
  loadHoldings()
}

// 删除股票（连同其全部交易明细）
function removeHolding(code) {
  const bare = bareCode(code)
  const count = trades.filter(t => bareCode(t.code) === bare).length
  if (!confirm(`确定删除 ${bare} 的 ${count} 条交易明细？`)) return
  trades = trades.filter(t => bareCode(t.code) !== bare)
  saveTrades()
  loadHoldings()
}

function clearHoldInput() {
  document.getElementById('holdStockInput').value = ''
  document.getElementById('holdCostInput').value = ''
  document.getElementById('holdQtyInput').value = ''
  document.getElementById('holdTimeInput').value = holdTimeNow()
  document.getElementById('holdStockHint').textContent = ''
}

// 从自选股填入持仓输入框（股票代码 + 买入方式 + 现价），并滚动到持仓区域
function fillHoldingFromWatchlist(code, name, price) {
  document.getElementById('holdStockInput').value = bareCode(code)
  document.getElementById('holdTypeInput').value = 'buy'
  document.getElementById('holdCostInput').value = price > 0 ? price : ''
  document.getElementById('holdQtyInput').value = ''
  document.getElementById('holdTimeInput').value = holdTimeNow()
  document.getElementById('holdStockHint').textContent = name ? `${name}(${bareCode(code)})` : ''
  switchMainTab('holdings')
  const card = document.getElementById('holdingsCard')
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' })
  document.getElementById('holdCostInput').focus()
}

// ============ 资产分析 ============
let assetType = 'day'
let assetSelDate = ''
let assetSelMonth = ''
let assetSelYear = 0
let assetAllData = null

function dateStr(d) {
  const pd = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pd(d.getMonth() + 1)}-${pd(d.getDate())}`
}
function addDays(s, n) {
  const d = new Date(s + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return dateStr(d)
}
function addMonths(s, n) {
  const d = new Date(s + 'T00:00:00')
  d.setMonth(d.getMonth() + n)
  return dateStr(d)
}
function prevDayIn(arr, day) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] < day) return arr[i]
  return null
}

function switchAssetType(type) {
  assetType = type
  document.querySelectorAll('#assetCard [data-type]').forEach(b => b.classList.toggle('active', b.dataset.type === type))
  const dateInput = document.getElementById('assetDateInput')
  const rangeLabel = document.getElementById('assetRangeLabel')
  if (type === 'all') {
    dateInput.style.display = 'none'
    rangeLabel.textContent = '全部交易汇总'
  } else {
    dateInput.style.display = ''
    if (type === 'month') {
      dateInput.type = 'month'
      dateInput.value = assetSelMonth || dateStr(new Date()).slice(0, 7)
    } else if (type === 'year') {
      dateInput.type = 'number'
      dateInput.min = '2000'
      dateInput.max = '2100'
      dateInput.value = assetSelYear || new Date().getFullYear()
      dateInput.style.width = '100px'
    } else {
      dateInput.type = 'date'
      dateInput.value = assetSelDate || dateStr(new Date())
      dateInput.style.width = '160px'
    }
    rangeLabel.textContent = ''
  }
  loadAssetAnalysis()
}

// 构建每只股票逐日盈亏（基于持仓管理的盈亏计算逻辑）
async function buildDailyData() {
  const codes = [...new Set(trades.map(t => normalizeCode(t.code)))].filter(Boolean)
  const stocks = []
  
  // 先收集所有交易日期
  const tradeDateSet = new Set()
  trades.forEach(t => {
    const d = String(t.time).slice(0, 10)
    tradeDateSet.add(d)
  })
  
  // 获取最早的交易日期（用于过滤K线数据）
  const firstTradeDate = tradeDateSet.size > 0 ? [...tradeDateSet].sort()[0] : null
  
  // 收集所有K线日期（只从最早交易日期开始）
  const allDateSet = new Set()
  
  // 存储每笔交易的明细（用于FIFO成本计算）
  const tradeDetails = {} // { code: [{date, type, price, qty}] }
  
  for (const c of codes) {
    const bare = bareCode(c)
    const st = { code: bare, name: (trades.find(t => bareCode(t.code) === bare) || {}).name || bare, closes: {}, orders: {}, dayPnl: {}, hold: {} }
    
    // 初始化交易明细
    tradeDetails[bare] = []
    
    // 先收集交易明细（用于后续计算）
    trades.filter(t => bareCode(t.code) === bare).forEach(t => {
      const d = String(t.time).slice(0, 10)
      // 只记录从最早交易日期开始的交易
      if (firstTradeDate && d < firstTradeDate) return
      if (!st.orders[d]) st.orders[d] = { buyQty: 0, sellQty: 0, buyAmt: 0, sellAmt: 0 }
      if (t.type === 'buy') { 
        st.orders[d].buyQty += t.qty; 
        st.orders[d].buyAmt += t.qty * t.price;
        tradeDetails[bare].push({ date: d, type: 'buy', price: t.price, qty: t.qty });
      } else { 
        st.orders[d].sellQty += t.qty; 
        st.orders[d].sellAmt += t.qty * t.price;
        tradeDetails[bare].push({ date: d, type: 'sell', price: t.price, qty: t.qty });
      }
    })
    
    try {
      const res = await fetch(`${API}/kline/${c}?period=day&count=1000`)
      const data = await res.json()
      ;(data.klines || []).forEach(k => { 
        if (k.date) {
          // 只保留从最早交易日期开始的K线数据
          if (!firstTradeDate || k.date >= firstTradeDate) {
            st.closes[k.date] = k.close
            allDateSet.add(k.date)
          }
        }
      })
    } catch (e) { /* 无K线时仅统计已实现交易差额 */ }
    
    stocks.push(st)
  }
  
  // days 从交易日期和K线日期中合并，确保包含持仓期间的所有交易日
  // 从最早的交易日期开始，过滤掉早于最早的交易日期的K线数据
  const filteredDateSet = new Set([...allDateSet].filter(d => !firstTradeDate || d >= firstTradeDate))
  const days = [...new Set([...tradeDateSet, ...filteredDateSet])].sort()
  console.log('最早交易日期:', firstTradeDate, '总天数:', days.length, '交易日期数:', tradeDateSet.size, 'K线日期数:', allDateSet.size) // 调试日志
  if (!days.length) return null
  
  // 使用持仓管理的逻辑计算盈亏：总盈亏 = 现价×持仓 + 卖出-买入
  // 对于每一天，计算该日的市值变化和已实现盈亏
  
  // 初始化每日盈亏
  const stockDayPnl = {} // { code: { date: pnl } }
  const stockBuyAmt = {} // { code: total buy amount }
  const stockSellAmt = {} // { code: total sell amount }
  const stockQty = {} // { code: current quantity }
  
  codes.forEach(c => {
    const bare = bareCode(c)
    stockDayPnl[bare] = {}
    stockBuyAmt[bare] = 0
    stockSellAmt[bare] = 0
    stockQty[bare] = 0
  })
  
  // 逐日计算盈亏
  days.forEach(d => {
    stocks.forEach(s => {
      const o = s.orders[d] || { buyQty: 0, sellQty: 0, buyAmt: 0, sellAmt: 0 }
      const close = s.closes[d]
      const bare = s.code
      
      // 更新持仓数量
      stockQty[bare] += o.buyQty - o.sellQty
      
      // 更新累计买入卖出金额
      stockBuyAmt[bare] += o.buyAmt
      stockSellAmt[bare] += o.sellAmt
      
      // 获取当前持仓市值和累计盈亏（持仓管理逻辑）
      const price = close || 0
      const currentHoldQty = stockQty[bare]
      const currentBuyAmt = stockBuyAmt[bare]
      const currentSellAmt = stockSellAmt[bare]
      
      // 记录每日持仓数量
      if (!s.hold) s.hold = {}
      s.hold[d] = currentHoldQty
      
      // 今日持仓市值 = 当前收盘价 × 当前持仓数量
      const todayMarketValue = price * currentHoldQty
      // 累计买卖差额 = 累计卖出金额 - 累计买入金额
      const totalRealized = currentSellAmt - currentBuyAmt
      // 累计总盈亏 = 今日持仓市值 + 累计买卖差额
      const totalProfit = todayMarketValue + totalRealized
      
      // 获取昨天的累计总盈亏
      const prevDay = d > days[0] ? days[days.indexOf(d) - 1] : null
      const prevTotalProfit = prevDay ? (stockDayPnl[bare][prevDay] || 0) : 0
      
      // 今日盈亏 = 今日累计总盈亏 - 昨日累计总盈亏
      const pnl = totalProfit - prevTotalProfit
      
      s.dayPnl[d] = pnl
      stockDayPnl[bare][d] = totalProfit
    })
  })
  
  return { stocks, days, latestDay: days[days.length - 1] }
}

// 计算当前口径周期（含上周期）的总盈亏、买卖笔数与重点股票
function calcAssetPeriod(all) {
  const days = all.days
  const latest = all.latestDay
  const now = dateStr(new Date())
  let start, end, prevStart, prevEnd, label
  if (assetType === 'all') {
    start = days[0]; end = days[days.length - 1]
    prevStart = prevEnd = null
    label = `${start} ~ ${end}`
  } else if (assetType === 'day') {
    end = assetSelDate || (days.includes(now) ? now : latest)
    start = end
    prevEnd = prevDayIn(days, end) || null
    prevStart = prevEnd
    label = end
  } else if (assetType === 'week') {
    const anchor = assetSelDate || latest
    const d = new Date(anchor + 'T00:00:00')
    const dow = d.getDay()
    const mondayOffset = dow === 0 ? -6 : 1 - dow
    start = addDays(anchor, mondayOffset)
    end = addDays(start, 4)
    const pOffset = mondayOffset - 7
    prevStart = addDays(anchor, pOffset)
    prevEnd = addDays(prevStart, 4)
    label = `${start} ~ ${end}`
  } else if (assetType === 'month') {
    const anchor = assetSelMonth ? assetSelMonth + '-15' : latest
    start = anchor.slice(0, 7) + '-01'
    const ly = parseInt(start.slice(0, 4)), lm = parseInt(start.slice(5, 7))
    end = new Date(ly, lm - 1, 0).getDate()
    end = `${start.slice(0, 7)}-${String(end).padStart(2, '0')}`
    prevStart = addMonths(start, -1)
    const py = parseInt(prevStart.slice(0, 4)), pm = parseInt(prevStart.slice(5, 7))
    prevEnd = `${prevStart.slice(0, 7)}-${String(new Date(py, pm - 1, 0).getDate()).padStart(2, '0')}`
    label = start.slice(0, 7)
  } else { // year
    const anchor = assetSelYear ? String(assetSelYear) : latest
    start = anchor.slice(0, 4) + '-01-01'
    end = anchor.slice(0, 4) + '-12-31'
    prevStart = (parseInt(anchor.slice(0, 4)) - 1) + '-01-01'
    prevEnd = (parseInt(anchor.slice(0, 4)) - 1) + '-12-31'
    label = anchor.slice(0, 4)
  }
  const sumRange = (s, e) => {
    let pnl = 0
    days.forEach(d => { if (d >= s && d <= e) pnl += all.stocks.reduce((x, st) => x + (st.dayPnl[d] || 0), 0) })
    return pnl
  }
  const cur = sumRange(start, end)
  const prev = (prevStart && prevEnd) ? sumRange(prevStart, prevEnd) : null
  const tradesIn = trades.filter(t => {
    const d = String(t.time).slice(0, 10)
    return d >= start && d <= end
  })
  const buys = tradesIn.filter(t => t.type === 'buy').length
  const sells = tradesIn.filter(t => t.type === 'sell').length
  // 计算期间内每只股票的盈亏
  const stockPnlRaw = all.stocks.map(st => {
    let p = 0
    days.forEach(d => { if (d >= start && d <= end) p += st.dayPnl[d] || 0 })
    return { code: st.code, name: st.name, pnl: p }
  })
  
  // 按日分析时，展示当日有交易或持仓的股票（包含当日已清仓）
  // 其他周期则只展示有盈亏的股票
  let stockPnl
  if (assetType === 'day') {
    // 获取当日有交易的股票代码
    const tradedCodes = new Set()
    trades.forEach(t => {
      const d = String(t.time).slice(0, 10)
      if (d === start) tradedCodes.add(bareCode(t.code))
    })
    // 获取当日持仓 > 0 的股票代码
    const heldCodes = new Set()
    all.stocks.forEach(st => {
      // 检查当日或之前一天是否有持仓（防止停牌等无交易日）
      const holdQty = st.hold && (st.hold[start] ?? st.hold[prevDayIn(days, start)] ?? 0)
      if (holdQty > 0) heldCodes.add(st.code)
    })
    // 合并有交易或有持仓的股票代码
    const includedCodes = new Set([...tradedCodes, ...heldCodes])
    // 筛选出当日有交易或有持仓的股票（无论盈亏）
    stockPnl = stockPnlRaw.filter(x => includedCodes.has(x.code)).sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
  } else {
    // 非按日分析，只展示有盈亏的股票
    stockPnl = stockPnlRaw.filter(x => x.pnl !== 0).sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
  }
  
  // 计算累计盈亏（从最早交易日期到当前统计期间的结束日期）
  const totalProfit = sumRange(days[0], end)
  
  // 各取最多5支正收益和5支负收益的股票
  const positiveStocks = stockPnl.filter(x => x.pnl > 0).slice(0, 5)
  const negativeStocks = stockPnl.filter(x => x.pnl < 0).slice(0, 5)
  return { start, end, prevStart, prevEnd, label, cur, prev, totalProfit, buys, sells, positiveStocks, negativeStocks }
}

// 悬浮提示：显示日期期间与收益金额
function showAssetTip(e, label, value) {
  const tip = document.getElementById('assetTip')
  if (!tip) return
  tip.innerHTML = `<b>${label}</b><br><span style="color:${value >= 0 ? '#ff4646' : '#00c864'};">${value >= 0 ? '+' : ''}${formatNumber(value, 2)}</span>`
  tip.style.display = 'block'
  const host = tip.parentElement || document.body
  const box = host.getBoundingClientRect()
  let x = e.clientX - box.left + 12, y = e.clientY - box.top + 12
  const tw = tip.offsetWidth || 110
  if (x + tw > box.width - 6) x = x - tw - 24
  if (y + 46 > box.height - 6) y = y - 56
  tip.style.left = x + 'px'
  tip.style.top = y + 'px'
}
function hideAssetTip() {
  const tip = document.getElementById('assetTip')
  if (tip) tip.style.display = 'none'
}

function renderAssetChart(container, pts, opts) {
  opts = opts || {}
  const isMobile = window.innerWidth <= 768
  const W = isMobile ? window.innerWidth - 34 : 780
  const H = 170
  const pl = 64, pr = 16, pt = 16, pb = 26
  const iw = W - pl - pr, ih = H - pt - pb
  const vals = pts.map(p => p.value).filter(v => typeof v === 'number' && isFinite(v))
  if (!vals.length) { container.innerHTML = '<div style="color:#6a7a9e;">暂无收益数据</div>'; return }
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals)
  if (lo === hi) { lo -= 1; hi += 1 }
  const span = hi - lo
  const y = v => pt + ih - ((v - lo) / span) * ih
  const xOf = i => pl + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw)
  const zeroY = y(0)
  const stroke = opts.type === 'bar' ? '' : (innerWidth <= 768 ? '1.5' : '2')
  let body = ''
  if (opts.type === 'bar') {
    const n = pts.length
    const bw = Math.min(46, (iw / n) * 0.62)
    // 先绘制所有透明交互区域（在底层）
    pts.forEach((p, i) => {
      const cx = xOf(i)
      // 透明交互区域：覆盖整个柱子宽度和图表高度
      body += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${pt.toFixed(1)}" width="${bw.toFixed(1)}" height="${ih.toFixed(1)}" fill="transparent" data-label="${p.label}" data-value="${p.value || 0}"/>`
    })
    // 再绘制所有有颜色的柱子（在上层）
    pts.forEach((p, i) => {
      const cx = xOf(i)
      const v = p.value || 0
      const c = v >= 0 ? '#ff4646' : '#00c864'
      const yTop = Math.min(y(v), zeroY)
      const h = Math.abs(y(v) - zeroY)
      body += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" fill="${c}" rx="2"/>`
      body += `<title>${p.label}: ${v >= 0 ? '+' : ''}${formatNumber(v, 2)}</title></rect>`
    })
  } else {
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${xOf(i).toFixed(1)},${y(p.value || 0).toFixed(1)}`).join('')
    const c = (pts[pts.length - 1].value || 0) >= 0 ? '#ff4646' : '#00c864'
    body += `<path d="${path}" fill="none" stroke="${c}" stroke-width="${stroke}" stroke-linejoin="round" stroke-linecap="round"/>`
    pts.forEach((p, i) => {
      body += `<circle cx="${xOf(i).toFixed(1)}" cy="${y(p.value || 0).toFixed(1)}" r="3" fill="${(p.value || 0) >= 0 ? '#ff4646' : '#00c864'}" onmousemove="showAssetTip(event,'${p.label}',${p.value || 0})" onmouseleave="hideAssetTip()"><title>${p.label}: ${(p.value || 0) >= 0 ? '+' : ''}${formatNumber(p.value || 0, 2)}</title></circle>`
    })
  }
  // 0轴基准线
  body += `<line x1="${pl}" y1="${zeroY.toFixed(1)}" x2="${W - pr}" y2="${zeroY.toFixed(1)}" stroke="#3a4a76" stroke-width="1" stroke-dasharray="3 3"/>`
  // x轴标签（间隔采样，最多8个）
  const step = Math.ceil(pts.length / 8)
  pts.forEach((p, i) => {
    if (i % step === 0 || i === pts.length - 1) {
      let t = p.label
      if (t.length > 5) t = t.slice(0, 5)
      body += `<text x="${xOf(i).toFixed(1)}" y="${(H - 8).toFixed(1)}" fill="#6a7a9e" font-size="10" text-anchor="middle">${t}</text>`
    }
  })
  container.style.position = 'relative'
  container.innerHTML = `<div id="assetTip" style="position:absolute;display:none;pointer-events:none;background:#16204a;border:1px solid #2a3a6e;border-radius:6px;padding:5px 9px;font-size:12px;color:#e0e6ff;z-index:30;white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,.45);"></div><svg width="100%" height="auto" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="display:block;background:#0a0e27;border:1px solid #1e2d5a;border-radius:8px;cursor:crosshair;">${body}</svg>`
  // 事件委托：使用 SVG 坐标系统计算位置（正确处理 PC 和移动端）
  const svg = container.querySelector('svg')
  const tip = document.getElementById('assetTip')
  const transparentRects = svg.querySelectorAll('rect[data-label]')
  
  function getSvgCoordinates(event, svgElement, w, h) {
    const rect = svgElement.getBoundingClientRect()
    const svgWidth = w
    const svgHeight = h
    const x = (event.clientX - rect.left) * (svgWidth / rect.width)
    const y = (event.clientY - rect.top) * (svgHeight / rect.height)
    return { x, y }
  }
  
  svg.addEventListener('mousemove', (e) => {
    if (opts.type !== 'bar') return
    const svgRect = svg.getBoundingClientRect()
    if (e.clientX < svgRect.left || e.clientX > svgRect.right || e.clientY < svgRect.top || e.clientY > svgRect.bottom) {
      tip.style.display = 'none'
      return
    }
    const svgCoords = getSvgCoordinates(e, svg, W, H)
    const mx = svgCoords.x
    const my = svgCoords.y
    let found = false
    transparentRects.forEach((el) => {
      if (found) return
      const x = parseFloat(el.getAttribute('x'))
      const width = parseFloat(el.getAttribute('width'))
      const y = parseFloat(el.getAttribute('y'))
      const height = parseFloat(el.getAttribute('height'))
      if (mx >= x && mx <= x + width && my >= y && my <= y + height) {
        const label = el.getAttribute('data-label')
        const value = parseFloat(el.getAttribute('data-value'))
        showAssetTip(e, label, value)
        found = true
      }
    })
    if (!found) tip.style.display = 'none'
  })
  
  svg.addEventListener('mouseleave', () => {
    tip.style.display = 'none'
  })
  
  svg.addEventListener('touchstart', (e) => {
    if (opts.type !== 'bar') return
    const touch = e.touches[0]
    const svgRect = svg.getBoundingClientRect()
    if (touch.clientX < svgRect.left || touch.clientX > svgRect.right || touch.clientY < svgRect.top || touch.clientY > svgRect.bottom) {
      e.preventDefault()
      return
    }
    const svgCoords = getSvgCoordinates(touch, svg, W, H)
    const mx = svgCoords.x
    const my = svgCoords.y
    let found = false
    transparentRects.forEach((el) => {
      if (found) return
      const x = parseFloat(el.getAttribute('x'))
      const width = parseFloat(el.getAttribute('width'))
      const y = parseFloat(el.getAttribute('y'))
      const height = parseFloat(el.getAttribute('height'))
      if (mx >= x && mx <= x + width && my >= y && my <= y + height) {
        const label = el.getAttribute('data-label')
        const value = parseFloat(el.getAttribute('data-value'))
        showAssetTip({ clientX: touch.clientX, clientY: touch.clientY }, label, value)
        found = true
        e.preventDefault()
      }
    })
  })
}

// 月度每日收益日历（仅周一~周五，首尾周空位占位，无收益显示0）
function renderDayCalendar(el, year, month, all) {
  const daysInMonth = new Date(year, month - 1, 0).getDate()
  const firstDOW = new Date(year, month - 1, 1).getDay()
  const startsMonday = firstDOW === 0 ? 2 : 2 - firstDOW
  const weeks = []
  for (let d = startsMonday; d <= daysInMonth; d += 7) {
    const cells = []
    for (let w = 0; w < 5; w++) {
      const dd = d + w
      if (dd >= 1 && dd <= daysInMonth) {
        const s = `${year}-${String(month).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
        let pnl = 0
        all.stocks.forEach(st => { pnl += st.dayPnl[s] || 0 })
        cells.push(`<td style="border:1px solid #24325f;padding:5px;text-align:center;background:#111836;">
          <div style="font-size:13px;color:#e0e6ff;">${dd}</div>
          <div style="font-size:10px;color:${pnl >= 0 ? '#ff4646' : '#00c864'};">${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}</div>
        </td>`)
      } else {
        cells.push('<td style="border:1px solid #24325f;padding:5px;background:#0a0e27;"></td>')
      }
    }
    weeks.push(`<tr>${cells.join('')}</tr>`)
  }
  el.innerHTML = `
    <div style="margin:10px 0 4px;font-size:13px;color:#8ea0c8;">📅 ${year}年${month}月 收益日历</div>
    <div style="overflow-x:auto;">
      <table style="width:100%;min-width:420px;border-collapse:collapse;font-size:12px;border:1px solid #1e2d5a;">
        <thead><tr>
          <th style="padding:4px;border:1px solid #24325f;background:#16204a;color:#8ea0c8;">一</th>
          <th style="padding:4px;border:1px solid #24325f;background:#16204a;color:#8ea0c8;">二</th>
          <th style="padding:4px;border:1px solid #24325f;background:#16204a;color:#8ea0c8;">三</th>
          <th style="padding:4px;border:1px solid #24325f;background:#16204a;color:#8ea0c8;">四</th>
          <th style="padding:4px;border:1px solid #24325f;background:#16204a;color:#8ea0c8;">五</th>
        </tr></thead>
        <tbody>${weeks.join('')}</tbody>
      </table>
    </div>`
}

// 周收益日历（仅该周周一~周五）
function renderWeekCalendar(el, monday, all) {
  const cells = []
  for (let w = 0; w < 5; w++) {
    const s = addDays(monday, w)
    const d = new Date(s + 'T00:00:00')
    let pnl = 0
    all.stocks.forEach(st => { pnl += st.dayPnl[s] || 0 })
    cells.push(`<td style="border:1px solid #24325f;padding:5px;text-align:center;background:#111836;width:20%;">
      <div style="font-size:13px;color:#e0e6ff;">${d.getDate()}</div>
      <div style="font-size:10px;color:${pnl >= 0 ? '#ff4646' : '#00c864'};">${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}</div>
    </td>`)
  }
  el.innerHTML = `
    <div style="margin:10px 0 4px;font-size:13px;color:#8ea0c8;">📅 ${monday.slice(0, 4)}年${parseInt(monday.slice(5, 7))}月${parseInt(monday.slice(8, 10))}日 起一周 收益日历</div>
    <div style="overflow-x:auto;">
      <table style="width:100%;min-width:420px;border-collapse:collapse;font-size:12px;border:1px solid #1e2d5a;">
        <thead><tr>
          <th style="padding:4px;border:1px solid #24325f;background:#16204a;color:#8ea0c8;">一</th>
          <th style="padding:4px;border:1px solid #24325f;background:#16204a;color:#8ea0c8;">二</th>
          <th style="padding:4px;border:1px solid #24325f;background:#16204a;color:#8ea0c8;">三</th>
          <th style="padding:4px;border:1px solid #24325f;background:#16204a;color:#8ea0c8;">四</th>
          <th style="padding:4px;border:1px solid #24325f;background:#16204a;color:#8ea0c8;">五</th>
        </tr></thead>
        <tbody><tr>${cells.join('')}</tr></tbody>
      </table>
    </div>`
}

// 年收益日历（12个月格）
function renderYearCalendar(el, year, all, title) {
  const monthRows = []
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, '0')}`
    let v = 0
    all.stocks.forEach(st => { all.days.filter(d => d.slice(0, 7) === key).forEach(d => { v += st.dayPnl[d] || 0 }) })
    monthRows.push({ m, v })
  }
  el.innerHTML = `
    <div style="margin:10px 0 4px;font-size:13px;color:#8ea0c8;">📅 ${title || `${year} 年收益日历`}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;">
      ${monthRows.map(r => `
        <div style="background:#111836;border:1px solid #1e2d5a;border-radius:8px;padding:10px;text-align:center;">
          <div style="font-size:12px;color:#6a7a9e;">${r.m} 月</div>
          <div style="font-size:15px;color:${r.v >= 0 ? '#ff4646' : '#00c864'};">${r.v >= 0 ? '+' : ''}${formatNumber(r.v, 2)}</div>
        </div>`).join('')}
    </div>`
}

function renderAssetAnalysis() {
  const resultEl = document.getElementById('assetResult')
  const msgEl = document.getElementById('assetMsg')
  document.querySelectorAll('#assetCard [data-type]').forEach(b => b.classList.toggle('active', b.dataset.type === assetType))
  if (!trades.length) {
    msgEl.innerHTML = '<div class="success-msg">暂无交易明细，请先到「持仓管理」录入交易后再统计</div>'
    resultEl.style.display = 'none'
    return
  }
  resultEl.style.display = 'block'
  if (!assetAllData || !assetAllData.days.length) {
    resultEl.innerHTML = '<div class="error-msg">行情数据为空，无法统计</div>'
    return
  }
  if (assetType === 'day' && document.getElementById('assetDateInput').type !== 'date') { /* 已切换 */ }
  const p = calcAssetPeriod(assetAllData)
  const rangeLabel = document.getElementById('assetRangeLabel')
  rangeLabel.textContent = `${p.label}${p.start !== p.end ? '' : ''}`
  const fmt = n => `${n >= 0 ? '+' : ''}${formatNumber(n, 2)}`
  const diff = (p.prev != null) ? p.cur - p.prev : null
  const pct = (p.prev != null && p.prev !== 0) ? ((p.cur - p.prev) / Math.abs(p.prev)) * 100 : null
  let html = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px;">
      <div style="background:#111836;border:1px solid #1e2d5a;border-radius:8px;padding:10px;">
        <div style="font-size:12px;color:#6a7a9e;">期间盈亏</div>
        <div style="font-size:20px;color:${p.cur >= 0 ? '#ff4646' : '#00c864'};">${fmt(p.cur)}</div>
      </div>
      <div style="background:#111836;border:1px solid #1e2d5a;border-radius:8px;padding:10px;">
        <div style="font-size:12px;color:#6a7a9e;">累计盈亏（截止到当前期间）</div>
        <div style="font-size:20px;">${fmt(p.totalProfit)}</div>
      </div>
      <div style="background:#111836;border:1px solid #1e2d5a;border-radius:8px;padding:10px;">
        <div style="font-size:12px;color:#6a7a9e;">买卖笔数</div>
        <div style="font-size:18px;color:#e0e6ff;">买 ${p.buys}  · 卖 ${p.sells} </div>
      </div>
    </div>`
  // 上周期对比
  if (diff != null) {
    html += `
    <div style="background:#111836;border:1px solid #1e2d5a;border-radius:8px;padding:10px;margin-bottom:14px;">
      <div style="font-size:13px;color:#8ea0c8;margin-bottom:6px;">📈 对比上一周期（${p.prevStart} ~ ${p.prevEnd}）</div>
      <div style="display:flex;flex-wrap:wrap;gap:20px;font-size:13px;">
        <span>上期盈亏：<b style="color:${p.prev >= 0 ? '#ff4646' : '#00c864'};">${fmt(p.prev)}</b></span>
        <span>本期差额：<b style="color:${diff >= 0 ? '#ff4646' : '#00c864'};">${fmt(diff)}</b></span>
        <span>变化幅度：<b style="color:${diff >= 0 ? '#ff4646' : '#00c864'};">${pct != null ? `${pct >= 0 ? '+' : ''}${formatNumber(pct, 2)}%` : '--'}</b></span>
      </div>
    </div>`
  }
  // 重点股票（前5支收益最高和前5支亏损最大，分左右两栏）
  if (p.positiveStocks && p.positiveStocks.length > 0 || p.negativeStocks && p.negativeStocks.length > 0) {
    const stockRow = (tag, st, isPositive) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 2px;border-bottom:1px solid #1e2d5a;font-size:13px;">
        <span style="color:#8ea0c8;flex:0 0 92px;">${tag}</span>
        <span style="color:#e0e6ff;flex:1;">${st.name}(${st.code})</span>
        <b style="color:${isPositive ? '#ff4646' : '#00c864'};">${isPositive ? '+' : ''}${formatNumber(st.pnl, 2)}</b>
      </div>`
    
    html += `
    <div style="background:#111836;border:1px solid #1e2d5a;border-radius:8px;padding:10px;margin-bottom:12px;">
      <div style="font-size:13px;color:#8ea0c8;margin-bottom:4px;">⭐ 重点股票（期间盈亏贡献）</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;">
        ${p.positiveStocks && p.positiveStocks.length > 0 ? `
          <div style="border:1px solid #1e2d5a;border-radius:6px;overflow:hidden;">
            <div style="background:#16204a;padding:8px 10px;font-size:12px;color:#ff4646;border-bottom:1px solid #1e2d5a;">📈 收益最高（前${p.positiveStocks.length}）</div>
            <div style="padding:4px 0;">${p.positiveStocks.map((st, i) => stockRow(`${i + 1}.`, st, true)).join('')}</div>
          </div>` : ''}
        ${p.negativeStocks && p.negativeStocks.length > 0 ? `
          <div style="border:1px solid #1e2d5a;border-radius:6px;overflow:hidden;">
            <div style="background:#16204a;padding:8px 10px;font-size:12px;color:#00c864;border-bottom:1px solid #1e2d5a;">📉 亏损最大（前${p.negativeStocks.length}）</div>
            <div style="padding:4px 0;">${p.negativeStocks.map((st, i) => stockRow(`${i + 1}.`, st, false)).join('')}</div>
          </div>` : ''}
      </div>
    </div>`
  }
  // 周期内每日/每月盈亏走势 + 日历
  let subInfo = null
  let allYearFlag = false
  if (assetType === 'week') {
    const curWeek = dateStr(new Date()) >= p.start && dateStr(new Date()) <= p.end
    const daysOfWeek = assetAllData.days.filter(d => d >= p.start && d <= (curWeek ? addDays(assetAllData.latestDay, 0) : p.end))
    subInfo = {
      title: `📉 ${p.label} 每日收益走势${curWeek ? '（截至最新交易日）' : ''}`,
      pts: daysOfWeek.map(d => ({ label: d.slice(5), value: assetAllData.stocks.reduce((s, st) => s + (st.dayPnl[d] || 0), 0) })),
      cal: [p.start]
    }
    html += `<div id="assetSubInfo"></div>`
  } else if (assetType === 'month') {
    const year = parseInt(p.start.slice(0, 4)), month = parseInt(p.start.slice(5, 7))
    const curMonth = dateStr(new Date()).slice(0, 7) === p.start.slice(0, 7)
    const daysOfMonth = assetAllData.days.filter(d => d >= p.start && d <= (curMonth ? addDays(assetAllData.latestDay, 0) : p.end))
    subInfo = {
      title: `📉 ${p.label} 每日收益走势${curMonth ? '（截至最新交易日）' : ''}`,
      pts: daysOfMonth.map(d => ({ label: d.slice(5), value: assetAllData.stocks.reduce((s, st) => s + (st.dayPnl[d] || 0), 0) })),
      cal: { year, month }
    }
    html += `<div id="assetSubInfo"></div>`
  } else if (assetType === 'year') {
    const year = parseInt(p.start.slice(0, 4))
    const daysOfYear = assetAllData.days.filter(d => d >= p.start && d <= p.end)
    const monthMap = {}
    daysOfYear.forEach(d => {
      const mk = d.slice(5, 7)
      monthMap[mk] = (monthMap[mk] || 0) + assetAllData.stocks.reduce((s, st) => s + (st.dayPnl[d] || 0), 0)
    })
    subInfo = {
      title: `📉 ${p.label} 每月收益走势`,
      pts: Object.keys(monthMap).sort().map(mk => ({ label: mk + '月', value: monthMap[mk] })),
      cal: { year, month: null }
    }
    html += `<div id="assetSubInfo"></div>`
  } else if (assetType === 'all') {
    allYearFlag = true
    html += `<div id="assetSubInfo"></div>`
  }
  resultEl.innerHTML = html
  // 渲染图
  if ((assetType === 'week' || assetType === 'month' || assetType === 'year') && subInfo) {
    const wrap = document.getElementById('assetSubInfo')
    wrap.innerHTML = `<div style="font-size:13px;color:#8ea0c8;margin-bottom:4px;margin-top:6px;">${subInfo.title}</div>`
    renderAssetChart(wrap, subInfo.pts, { type: 'bar' })
    const calEl = document.createElement('div')
    wrap.appendChild(calEl)
    if (assetType === 'week') renderWeekCalendar(calEl, subInfo.cal[0], assetAllData)
    else if (assetType === 'month') renderDayCalendar(calEl, subInfo.cal.year, subInfo.cal.month, assetAllData)
    else renderYearCalendar(calEl, subInfo.cal.year, assetAllData)
  } else if (allYearFlag) {
    renderAllAnalysis(document.getElementById('assetSubInfo'))
  }
}

async function loadAssetAnalysis() {
  const dateInput = document.getElementById('assetDateInput')
  if (dateInput) {
    if (assetType === 'day' || assetType === 'week') assetSelDate = dateInput.value || assetSelDate
    else if (assetType === 'month') assetSelMonth = dateInput.value || assetSelMonth
    else if (assetType === 'year') assetSelYear = parseInt(dateInput.value) || assetSelYear
  }
  const msgEl = document.getElementById('assetMsg')
  msgEl.innerHTML = '<span class="loading"></span>统计中...'
  try {
    assetAllData = await buildDailyData()
    renderAssetAnalysis()
    msgEl.innerHTML = ''
  } catch (e) {
    msgEl.innerHTML = `<div class="error-msg">资产统计失败（${e.message}）</div>`
    document.getElementById('assetResult').style.display = 'none'
  }
}

// 历史至今视图：按年/按月切换，切换控件在走势上方，同时作用于走势与日历
let allCalView = 'month'
let allCalSelYear = ''

function assetYearlyMap() {
  if (!assetAllData || !assetAllData.days) return {}
  const yearly = {}
  assetAllData.days.forEach(d => {
    const y = d.slice(0, 4)
    const v = assetAllData.stocks.reduce((s, st) => s + (st.dayPnl[d] || 0), 0)
    yearly[y] = (yearly[y] || 0) + v
  })
  return yearly
}

function assetMonthlyMap(year) {
  if (!assetAllData || !assetAllData.days) return {}
  const months = {}
  for (let m = 1; m <= 12; m++) months[m] = 0
  assetAllData.days.filter(d => d.slice(0, 4) === String(year)).forEach(d => {
    const mk = parseInt(d.slice(5, 7))
    months[mk] = (months[mk] || 0) + assetAllData.stocks.reduce((s, st) => s + (st.dayPnl[d] || 0), 0)
  })
  return months
}

function allCalYears() {
  // 返回所有年份（从交易开始年份到最新年份）
  if (!assetAllData || !assetAllData.days || !assetAllData.days.length) return []
  const years = [...new Set(assetAllData.days.map(d => d.slice(0, 4)))].sort((a, b) => parseInt(a) - parseInt(b))
  return years
}

function renderAllAnalysis(el) {
  if (!el) return
  const years = allCalYears()
  if (!years.length) { el.innerHTML = '<div style="color:#6a7a9e;">暂无年度数据</div>'; return }
  if (!allCalSelYear) allCalSelYear = years[years.length - 1]
  const yearly = assetYearlyMap()
  el.innerHTML = `
    <div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;align-items:center;">
      <button class="market-tab ${allCalView === 'month' ? 'active' : ''}" id="allCalBtnMonth" onclick="assetCalSetView('month')">按月</button>
      <button class="market-tab ${allCalView === 'year' ? 'active' : ''}" id="allCalBtnYear" onclick="assetCalSetView('year')">按年</button>
      <span id="allCalYearSel" style="${allCalView === 'month' ? '' : 'display:none;'}margin-left:6px;">
        选择年份：
        <select class="asset-select" onchange="assetCalSetYear(this.value)">
          ${years.map(y => `<option value="${y}" ${y === allCalSelYear ? 'selected' : ''}>${y} 年</option>`).join('')}
        </select>
      </span>
    </div>
    <div id="assetAllViewBody"></div>`
  renderAllViewBody()
}

function renderAllViewBody() {
  const body = document.getElementById('assetAllViewBody')
  if (!body) return
  const yearly = assetYearlyMap()
  const years = allCalYears()
  
  // 构建完整的HTML
  const fullHtml = buildAllViewHtml(yearly, years, allCalView, allCalSelYear)
  body.innerHTML = fullHtml
  // 延迟执行，确保DOM已渲染
  setTimeout(() => {
    const chartHost = document.getElementById('allChartHost')
    if (chartHost) {
      if (allCalView === 'year') {
        const yearPts = years.map(y => ({ label: y, value: yearly[y] }))
        renderAssetChart(chartHost, yearPts, { type: 'bar' })
      } else {
        const year = allCalSelYear || years[years.length - 1]
        const monthlyData = {}
        years.forEach(y => {
          const months = assetMonthlyMap(y)
          monthlyData[y] = months
        })
        const currentMonths = monthlyData[year]
        const monthPts = Object.keys(currentMonths).map(m => ({ label: parseInt(m) + '月', value: currentMonths[m] }))
        renderAssetChart(chartHost, monthPts, { type: 'bar' })
      }
    }
  }, 0)
}

function buildAllViewHtml(yearly, years, view, selYear) {
  // 渲染走势
  let chartHtml = ''
  if (view === 'year') {
    chartHtml = `<div style="font-size:13px;color:#8ea0c8;margin-bottom:4px;">📉 年度收益走势</div><div id="allChartHost"></div>`
  } else {
    const year = selYear || years[years.length - 1]
    chartHtml = `<div style="font-size:13px;color:#8ea0c8;margin-bottom:4px;">📈 ${year} 年 每月收益走势</div><div id="allChartHost"></div>`
  }
  
  // 渲染收益日历（按年倒序，默认折叠）
  let calendarHtml = '<div style="font-size:13px;color:#8ea0c8;margin:12px 0 4px;">📅 收益日历（点击年份展开）</div>'
  years.slice().reverse().forEach(y => {
    const months = assetMonthlyMap(y)
    const yearTotal = Object.values(months).reduce((sum, v) => sum + v, 0)
    calendarHtml += `
      <div style="background:#111836;border:1px solid #1e2d5a;border-radius:8px;overflow:hidden;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid #1e2d5a;cursor:pointer;" onclick="toggleYearCalendar('${y}')">
          <div style="color:#e0e6ff;">${y} 年 ${y === years[years.length - 1] ? `<span style="color:#6a7a9e;font-size:11px;"></span>` : ''}</div>
          <div style="color:${yearTotal >= 0 ? '#ff4646' : '#00c864'};font-size:13px;">${yearTotal >= 0 ? '+' : ''}${formatNumber(yearTotal, 2)}</div>
          <span id="icon-${y}" style="color:#6a7a9e;">▼</span>
        </div>
        <div id="calendar-${y}" style="display:none;">
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;padding:8px;">
            ${Array.from({ length: 12 }, (_, i) => i + 1).map(m => `
              <div style="background:#16204a;border:1px solid #24325f;border-radius:6px;padding:8px;text-align:center;">
                <div style="font-size:12px;color:#6a7a9e;">${m}月</div>
                <div style="font-size:13px;color:${(months[m] || 0) >= 0 ? '#ff4646' : '#00c864'};">${(months[m] || 0) >= 0 ? '+' : ''}${formatNumber(months[m] || 0, 2)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `
  })
  
  return chartHtml + calendarHtml
}

function assetCalSetView(view) {
  allCalView = view
  const sel = document.getElementById('allCalYearSel')
  const btnY = document.getElementById('allCalBtnYear')
  const btnM = document.getElementById('allCalBtnMonth')
  if (btnY) btnY.classList.toggle('active', view === 'year')
  if (btnM) btnM.classList.toggle('active', view === 'month')
  if (sel) sel.style.display = view === 'month' ? '' : 'none'
  renderAllViewBody()
}

function assetCalSetYear(year) {
  allCalSelYear = String(year)
  renderAllViewBody()
}

// 切换年份日历的展开/折叠
function toggleYearCalendar(year) {
  const el = document.getElementById('calendar-' + year)
  const icon = document.getElementById('icon-' + year)
  if (el && icon) {
    const isHidden = el.style.display === 'none' || !el.style.display
    el.style.display = isHidden ? 'grid' : 'none'
    icon.textContent = isHidden ? '▲' : '▼'
  }
}
