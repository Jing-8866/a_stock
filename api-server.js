/**
 * A股数据桥接服务 - 完整版
 * 启动: node api-server.js
 * 访问: http://localhost:7373
 */

const express = require('express')
const cors = require('cors')
const path = require('path')
const http = require('http')
const https = require('https')
const { URL } = require('url')

const app = express()
const PORT = 7373

// ============ 中间件 ============
app.use(cors()) // 允许跨域（file:// 打开 HTML 也能调接口）
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// 仅对 API 响应强制 UTF-8 JSON；静态资源（HTML/CSS/JS）必须保留自身 MIME，
// 否则浏览器会把 HTML 当成 JSON/纯文本，直接显示源码。
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
  }
  next()
})

// ============ 静态文件托管 ============
// 托管当前目录（HTML/JS/CSS/图片等）
app.use(express.static(path.join(__dirname)))

// 根路径自动跳转到主工具页面
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'A股分析工具.html'))
})

// ============ 工具函数 ============
/**
 * 修复中文编码问题
 */
function fixChineseEncoding(str) {
  if (!str || typeof str !== 'string') return str
  
  // 如果已经是正确的中文，直接返回
  if (/[\u4e00-\u9fa5]/.test(str)) return str
  
  // 尝试GBK -> UTF-8转换
  try {
    // 创建一个简单的GBK到UTF-8转换表（常见股票名称）
    const gbkToUtf8 = {
      '¹þÖÝÃ©Ì¨': '贵州茅台',
      'ÎåÁ¹Òº': '五粮液',
      'ÖÐ¹úÆ½°²': '中国平安',
      'Æ½°²ÒøÐÐ': '平安银行',
      'ÕÐÉÌÒøÐÐ': '招商银行',
      'ÒÁÀû¹É·Ý': '伊利股份',
      'ÃÀµÄ¼¯ÍÅ': '美的集团',
      'º£¿µÎÀÊÓ': '海康威视',
      'ºãÈðÒ½Ò©': '恒瑞医药',
      '¸ñÁ¦µçÆ÷': '格力电器',
      'ÐËÒµÒøÐÐ': '兴业银行',
      'ÄþµÂÊ±´ú': '宁德时代',
      '¶«·½²Æ¸»': '东方财富',
      'ÖÐÐÅÖ¤È¯': '中信证券',
      'ÖÐ¹ú¹úÂÃ': '中国国旅',
      '±ÏÑÇµÏ': '比亚迪',
      '³¤½®µçÁ¦': '长江电力',
      'ÖÐÔ¶º£¿Ø': '中远海控',
      'Ë³·á¿Ø¹É': '顺丰控股',
      'ÉÏÆë¼¯ÍÅ': '上汽集团'
    }
    
    // 检查是否在转换表中
    if (gbkToUtf8[str]) {
      return gbkToUtf8[str]
    }
    
    // 尝试Buffer转换
    const buf = Buffer.from(str, 'binary')
    // 尝试GBK解码
    try {
      return buf.toString('gbk')
    } catch (e) {
      // 尝试GB18030
      try {
        return buf.toString('gb18030')
      } catch (e2) {
        // 如果都不行，返回原始字符串
        return str
      }
    }
  } catch (e) {
    return str
  }
}

/**
 * 通用 HTTP 请求转发，返回原始 Buffer（用于抓取外部行情数据）
 */
function fetchBuffer(urlStr, extraHeaders) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const client = url.protocol === 'https:' ? https : http
    // 按目标站点设置合适的 Referer，避免因 Referer 不匹配被反爬重置连接
    const referer = /eastmoney\.com$/.test(url.hostname)
      ? 'https://quote.eastmoney.com/'
      : (/sina\.com\.cn$/.test(url.hostname) ? 'https://finance.sina.com.cn/' : 'https://finance.qq.com/')
    const headers = Object.assign({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'close',
      'Referer': referer
    }, extraHeaders || {})
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers,
      timeout: 15000
    }
    const req = client.request(options, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          return reject(new Error(`上游返回 HTTP ${res.statusCode}`))
        }
        resolve(Buffer.concat(chunks))
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('请求上游超时')) })
    req.end()
  })
}

/**
 * GBK 解码
 * 说明：腾讯行情接口（qt.gtimg.cn）返回 GBK 编码，而 Node 原生 Buffer.toString('gbk') 会抛
 * "Unknown encoding"，导致中文名称乱码。此处优先用 TextDecoder（完整 ICU 构建支持 gbk），
 * 其次回退 iconv-lite，最后回退 UTF-8。
 */
function decodeGBK(buffer) {
  if (!buffer || !buffer.length) return ''
  try {
    const text = new TextDecoder('gbk', { fatal: false }).decode(buffer)
    if (text && text.indexOf('\uFFFD') === -1) return text
  } catch (e) { /* 当前 Node 未内置该编码，继续回退 */ }
  try {
    const iconv = require('iconv-lite')
    return iconv.decode(buffer, 'gbk')
  } catch (e) { /* 未安装 iconv-lite */ }
  const utf8 = buffer.toString('utf8')
  return utf8.indexOf('\uFFFD') === -1 ? utf8 : buffer.toString('latin1')
}

/** 抓取 GBK 文本接口（腾讯行情），返回已正确解码的字符串 */
async function fetchUrl(urlStr) {
  return decodeGBK(await fetchBuffer(urlStr))
}

/* ============ 东方财富数据接口（UTF-8 JSON，无中文乱码，覆盖全市场） ============ */
// 沪深 A 股：深主板 / 创业板 / 沪主板 / 科创板
const EM_FS_HS_A = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23'
const EM_FIELDS = 'f12,f14,f2,f3,f8,f9,f23,f20,f5'

function emToNumber(v) {
  if (v === null || v === undefined || v === '' || v === '-') return null
  const n = typeof v === 'number' ? v : parseFloat(v)
  return isNaN(n) ? null : n
}

function emClistUrl(pn, pz, fid, po, fields) {
  return `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=${pz}&po=${po}&np=1&fltt=2&invt=2&fid=${fid}&fs=${EM_FS_HS_A}&fields=${fields || EM_FIELDS}`
}

function emMapStock(item) {
  return {
    code: item.f12 || '',
    name: item.f14 || '',
    price: emToNumber(item.f2),
    changePercent: emToNumber(item.f3),
    turnover: emToNumber(item.f8),
    pe: emToNumber(item.f9),
    pb: emToNumber(item.f23),
    marketCap: emToNumber(item.f20),
    volume: emToNumber(item.f5)
  }
}

function emExtractList(data) {
  const d = data && data.data
  if (!d) return []
  const diff = d.diff || d.list || []
  const arr = Array.isArray(diff) ? diff : Object.values(diff)
  return arr.filter(Boolean)
}

async function emFetchJson(urlStr) {
  const buffer = await fetchBuffer(urlStr)
  return JSON.parse(buffer.toString('utf8'))
}

/** 分页拉取沪深 A 股全市场行情（用于条件筛选） */
async function emFetchAllStocks(maxPages) {
  const pageSize = 100
  const pages = maxPages || 60
  const all = []
  for (let pn = 1; pn <= pages; pn++) {
    let data
    try {
      data = await emFetchJson(emClistUrl(pn, pageSize, 'f3', 1))
    } catch (e) {
      if (all.length) break
      throw e
    }
    const list = emExtractList(data)
    if (!list.length) break
    list.forEach(item => all.push(emMapStock(item)))
    const total = (data && data.data && data.data.total) || 0
    if (total && all.length >= total) break
  }
  return all
}

/* ============ 新浪财经备用数据源（东财不可达时降级） ============ */
const SINA_RANK_URL = (page, num, sort, asc) =>
  `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=${num}&sort=${sort}&asc=${asc}&node=hs_a&symbol=&_s_r_a=page`

function sinaToNumber(v) {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return isNaN(n) ? null : n
}

function sinaMapStock(item) {
  const mktcap = sinaToNumber(item.mktcap)
  return {
    code: item.code || String(item.symbol || '').replace(/^(sh|sz)/, ''),
    name: item.name || '',
    price: sinaToNumber(item.trade),
    changePercent: sinaToNumber(item.changepercent),
    turnover: sinaToNumber(item.turnoverratio),
    pe: sinaToNumber(item.per),
    pb: sinaToNumber(item.pb),
    marketCap: mktcap === null ? null : mktcap / 1e8,
    volume: sinaToNumber(item.volume)
  }
}

async function sinaFetchJson(urlStr) {
  const buffer = await fetchBuffer(urlStr)
  let text = buffer.toString('utf8')
  if (text.indexOf('\uFFFD') !== -1) text = decodeGBK(buffer)
  return JSON.parse(text)
}

async function sinaFetchRank(type, order, n) {
  const sort = type === 'turnover' ? 'turnoverratio' : (type === 'pe' ? 'per' : 'changepercent')
  const asc = order === 'asc' ? 1 : 0
  const data = await sinaFetchJson(SINA_RANK_URL(1, n, sort, asc))
  const arr = Array.isArray(data) ? data : []
  return arr.map(sinaMapStock)
}

async function sinaFetchAllStocks(maxPages) {
  const num = 100
  const pages = maxPages || 60
  const all = []
  for (let pn = 1; pn <= pages; pn++) {
    let data
    try {
      data = await sinaFetchJson(SINA_RANK_URL(pn, num, 'changepercent', 0))
    } catch (e) {
      if (all.length) break
      throw e
    }
    if (!Array.isArray(data) || !data.length) break
    data.forEach(item => all.push(sinaMapStock(item)))
    if (data.length < num) break
  }
  return all
}

/** 统一排行获取：优先东财，失败降级新浪 */
async function fetchRankList(type, order, n) {
  try {
    const fid = type === 'turnover' ? 'f8' : (type === 'pe' ? 'f9' : 'f3')
    const po = order === 'asc' ? 0 : 1
    const data = await emFetchJson(emClistUrl(1, n, fid, po))
    const list = emExtractList(data).map(emMapStock)
    if (list.length) return list
  } catch (e) { /* 东财失败，降级新浪 */ }
  return sinaFetchRank(type, order, n)
}

/** 统一全市场获取：优先东财，失败降级新浪 */
async function fetchAllStocks() {
  try {
    const list = await emFetchAllStocks()
    if (list.length) return list
  } catch (e) { /* 东财失败，降级新浪 */ }
  return sinaFetchAllStocks()
}

// ============ 编码修复函数 ============
/**
 * 修复中文编码问题 - 针对腾讯接口的GBK乱码
 */
function fixChineseEncoding(text) {
  if (!text || typeof text !== 'string') return text || ''
  
  // 如果已经包含中文字符，直接返回
  if (/[\u4e00-\u9fa5]/.test(text)) {
    return text
  }
  
  // 常见的GBK乱码到正确中文的映射
  const gbkFixMap = {
    // 贵州茅台 -> ¹þÖÝÃ©Ì¨ (GBK乱码)
    '¹þÖÝÃ©Ì¨': '贵州茅台',
    '¹þÖÝÃ©Ì¨ (600519)': '贵州茅台',
    // 五粮液 -> ÎåÁ¹Òº
    'ÎåÁ¹Òº': '五粮液',
    'ÎåÁ¹Òº (000858)': '五粮液',
    // 中国平安 -> ÖÐ¹úÆ½°²
    'ÖÐ¹úÆ½°²': '中国平安',
    'ÖÐ¹úÆ½°² (601318)': '中国平安',
    // 平安银行 -> Æ½°²ÒøÐÐ
    'Æ½°²ÒøÐÐ': '平安银行',
    'Æ½°²ÒøÐÐ (000001)': '平安银行',
    // 招商银行 -> ÕÐÉÌÒøÐÐ
    'ÕÐÉÌÒøÐÐ': '招商银行',
    'ÕÐÉÌÒøÐÐ (600036)': '招商银行',
    // 伊利股份 -> ÒÁÀû¹É·Ý
    'ÒÁÀû¹É·Ý': '伊利股份',
    'ÒÁÀû¹É·Ý (600887)': '伊利股份',
    // 美的集团 -> ÃÀµÄ¼¯ÍÅ
    'ÃÀµÄ¼¯ÍÅ': '美的集团',
    'ÃÀµÄ¼¯ÍÅ (000333)': '美的集团',
    // 海康威视 -> º£¿µÎÀÊÓ
    'º£¿µÎÀÊÓ': '海康威视',
    'º£¿µÎÀÊÓ (002415)': '海康威视',
    // 恒瑞医药 -> ºãÈðÒ½Ò©
    'ºãÈðÒ½Ò©': '恒瑞医药',
    'ºãÈðÒ½Ò© (600276)': '恒瑞医药',
    // 格力电器 -> ¸ñÁ¦µçÆ÷
    '¸ñÁ¦µçÆ÷': '格力电器',
    '¸ñÁ¦µçÆ÷ (000651)': '格力电器',
    // 兴业银行 -> ÐËÒµÒøÐÐ
    'ÐËÒµÒøÐÐ': '兴业银行',
    'ÐËÒµÒøÐÐ (601166)': '兴业银行',
    // 宁德时代 -> ÄþµÂÊ±´ú
    'ÄþµÂÊ±´ú': '宁德时代',
    'ÄþµÂÊ±´ú (300750)': '宁德时代',
    // 东方财富 -> ¶«·½²Æ¸»
    '¶«·½²Æ¸»': '东方财富',
    '¶«·½²Æ¸» (300059)': '东方财富'
  }
  
  // 检查是否在映射表中
  if (gbkFixMap[text]) {
    return gbkFixMap[text]
  }
  
  // 尝试Buffer转换
  try {
    // 将字符串视为latin1编码的字节
    const buf = Buffer.from(text, 'latin1')
    
    // 尝试GBK解码
    try {
      const gbkStr = buf.toString('gbk')
      if (gbkStr && gbkStr !== text && !gbkStr.includes('�')) {
        return gbkStr
      }
    } catch (e) {
      // GBK解码失败，继续尝试
    }
    
    // 尝试GB18030解码
    try {
      const gb18030Str = buf.toString('gb18030')
      if (gb18030Str && gb18030Str !== text && !gb18030Str.includes('�')) {
        return gb18030Str
      }
    } catch (e) {
      // GB18030解码失败
    }
  } catch (e) {
    // Buffer转换失败
  }
  
  // 如果所有方法都失败，返回原始文本
  return text
}

// ============ API 路由 ============

/**
 * 健康检查
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: '2.0' })
})

/**
 * 实时行情 - 单股
 * GET /api/quote/:code  (如 sh600519 或 600519)
 */
app.get('/api/quote/:code', async (req, res) => {
  try {
    const code = req.params.code
    // 腾讯行情接口
    const url = `https://qt.gtimg.cn/q=${code}`
    const rawData = await fetchUrl(url)
    
    // 调试：记录原始数据
    console.log(`[DEBUG] 原始响应前100字符: ${rawData.substring(0, 100)}`)
    
    // 解析腾讯行情数据
    const match = rawData.match(/="(.+)"/)
    if (!match) {
      console.log(`[DEBUG] 未找到股票数据，原始响应: ${rawData}`)
      return res.status(404).json({ error: '未找到该股票数据' })
    }
    
    const rawFields = match[1]
    const fields = rawFields.split('~')
    
    // 调试：查看字段
    console.log(`[DEBUG] 字段数量: ${fields.length}`)
    console.log(`[DEBUG] 名称字段 (字段1): "${fields[1]}"`)
    console.log(`[DEBUG] 代码字段 (字段2): "${fields[2]}"`)
    
    // 处理中文编码问题
    let name = fields[1] || ''
    const codeField = fields[2] || code
    
    // 尝试修复中文乱码
    name = fixChineseEncoding(name)
    
    // 创建响应对象
    const result = {
      code: codeField,
      name: name,
      price: parseFloat(fields[3]) || 0,
      yesterdayClose: parseFloat(fields[4]) || 0,
      open: parseFloat(fields[5]) || 0,
      volume: parseFloat(fields[6]) || 0,
      bidPrice: parseFloat(fields[7]) || 0,
      askPrice: parseFloat(fields[8]) || 0,
      high: parseFloat(fields[33]) || 0,
      low: parseFloat(fields[34]) || 0,
      change: parseFloat(fields[31]) || 0,
      changePercent: parseFloat(fields[32]) || 0,
      turnover: parseFloat(fields[37]) || 0,
      pe: parseFloat(fields[39]) || 0,
      pb: parseFloat(fields[46]) || 0,
      marketCap: parseFloat(fields[44]) || 0,
      timestamp: new Date().toISOString()
    }
    
    res.json(result)
  } catch (e) {
    console.error(`[ERROR] 获取股票数据失败: ${e.message}`)
    res.status(500).json({ error: e.message })
  }
})

/**
 * 实时行情 - 批量
 * POST /api/quote/batch  body: { codes: ["sh600519", "sz000001"] }
 */
app.post('/api/quote/batch', async (req, res) => {
  try {
    const { codes } = req.body
    if (!codes || !Array.isArray(codes)) return res.status(400).json({ error: 'codes 必须是数组' })
    const url = `https://qt.gtimg.cn/q=${codes.join(',')}`
    const data = await fetchUrl(url)
    const lines = data.split(';').filter(l => l.trim())
    const results = lines.map(line => {
      const match = line.match(/="(.+)"/)
      if (!match) return null
      const fields = match[1].split('~')
      return {
        code: fields[2] || '',
        name: fixChineseEncoding(fields[1] || ''),
        price: parseFloat(fields[3]) || 0,
        change: parseFloat(fields[31]) || 0,
        changePercent: parseFloat(fields[32]) || 0,
        pe: parseFloat(fields[39]) || 0,
        pb: parseFloat(fields[46]) || 0,
        high: parseFloat(fields[33]) || 0,
        low: parseFloat(fields[34]) || 0,
        volume: parseFloat(fields[6]) || 0
      }
    }).filter(Boolean)
    res.json(results)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * 技术指标
 * GET /api/technical/:code?period=day
 */
app.get('/api/technical/:code', async (req, res) => {
  try {
    const { code } = req.params
    const { period = 'day' } = req.query
    // 腾讯 K 线接口
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},${period},,,60,qfq`
    const data = await fetchUrl(url)
    res.json(data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * 财务数据
 * GET /api/finance/:code
 */
app.get('/api/finance/:code', async (req, res) => {
  try {
    const { code } = req.params
    // 腾讯财务接口
    const url = `https://web.ifzq.gtimg.cn/appstock/app/finance/get?code=${code}`
    const data = await fetchUrl(url)
    res.json(data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * 资金流向
 * GET /api/fundflow/:code
 */
app.get('/api/fundflow/:code', async (req, res) => {
  try {
    const { code } = req.params
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fundflow/get?code=${code}`
    const data = await fetchUrl(url)
    res.json(data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * 新闻/研报
 * GET /api/news/:code?count=10
 */
app.get('/api/news/:code', async (req, res) => {
  try {
    const { code } = req.params
    const { count = 10 } = req.query
    const url = `https://web.ifzq.gtimg.cn/appstock/app/news/get?code=${code}&count=${count}`
    const data = await fetchUrl(url)
    res.json(data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * 条件筛选（真实全市场数据）
 * POST /api/screener  body: { conditions: [{ field, operator, value }], limit: 10 }
 */
app.post('/api/screener', async (req, res) => {
  try {
    const { conditions, limit } = req.body
    if (!conditions || !Array.isArray(conditions)) {
      return res.status(400).json({ error: 'conditions 必须是数组' })
    }
    const n = Math.max(1, Math.min(100, parseInt(limit) || 10))

    const stocks = await fetchAllStocks()
    const filtered = stocks.filter(stock => conditions.every(cond => {
      const value = stock[cond.field]
      if (value === null || value === undefined) return false
      const target = parseFloat(cond.value)
      if (isNaN(target)) return false
      switch (cond.operator) {
        case 'gt': return value > target
        case 'lt': return value < target
        case 'eq': return Math.abs(value - target) < 0.01
        default: return true
      }
    }))

    res.json({
      total: filtered.length,
      results: filtered.slice(0, n),
      message: `筛选到 ${filtered.length} 只符合条件股票`,
      conditions
    })
  } catch (e) {
    res.status(500).json({ error: e.message, results: [] })
  }
})

/**
 * 全市场排行（真实数据）
 * GET /api/rank?type=changePercent&order=desc&limit=10
 * type: changePercent 涨跌幅 | turnover 换手率 | pe 市盈率
 */
app.get('/api/rank', async (req, res) => {
  try {
    const { type = 'changePercent', order = 'desc', limit } = req.query
    const n = Math.max(1, Math.min(100, parseInt(limit) || 10))
    const results = await fetchRankList(type, order, n)
    res.json({ results })
  } catch (e) {
    res.status(500).json({ error: e.message, results: [] })
  }
})

/* ============ 股票搜索（支持代码或名称） ============ */
async function emSearch(q) {
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&count=10&token=D43BF722C8E33BDC906FB84D85E326E8`
  const data = await emFetchJson(url)
  const rows = (data && data.QuotationCodeTable && data.QuotationCodeTable.Data) || []
  return rows.map(r => {
    const mk = String(r.MktNum)
    const prefix = mk === '1' ? 'sh' : (mk === '0' ? 'sz' : '')
    return { code: prefix + (r.Code || ''), name: r.Name || '' }
  }).filter(x => x.code && x.name)
}

async function sinaSearch(q) {
  const url = `https://suggest3.sinajs.cn/suggest/type=11,12,13,14,15&key=${encodeURIComponent(q)}`
  const text = await fetchUrl(url)
  const m = text.match(/="([\s\S]*)"/)
  if (!m) return []
  return m[1].split(';').map(seg => {
    const p = seg.split(',')
    if (p.length < 4) return null
    const code = (p[3] || p[2] || '').trim()
    const name = (p[0] || '').trim()
    return code && name ? { code, name } : null
  }).filter(Boolean)
}

async function txSearch(q) {
  const url = `https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(q)}&t=all&c=1`
  const text = await fetchUrl(url)
  const m = text.match(/="([\s\S]*)"/)
  if (!m) return []
  return m[1].split('^').map(seg => {
    const p = seg.split('~')
    if (p.length < 4) return null
    const code = ((p[1] || '') + (p[2] || '')).trim()
    const name = (p[3] || p[4] || '').trim()
    return code && name ? { code, name } : null
  }).filter(Boolean)
}

async function searchStocks(q) {
  for (const fn of [emSearch, sinaSearch, txSearch]) {
    try {
      const list = await fn(q)
      if (list && list.length) return list.slice(0, 10)
    } catch (e) { /* 换下一个数据源 */ }
  }
  return []
}

/**
 * 按代码或名称搜索股票
 * GET /api/search?q=茅台
 */
app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim()
    if (!q) return res.json({ results: [] })
    const results = await searchStocks(q)
    res.json({ results })
  } catch (e) {
    res.status(500).json({ error: e.message, results: [] })
  }
})

/** 股票代码 → 腾讯 secid（sh600519 / sz000001 / bj...） */
function toSecid(code) {
  code = String(code || '').toLowerCase().trim()
  if (/^(sh|sz|bj)\d{6}$/.test(code)) return code
  if (/^\d{6}$/.test(code)) {
    if (code.startsWith('6')) return 'sh' + code
    if (code.startsWith('4') || code.startsWith('8')) return 'bj' + code
    return 'sz' + code
  }
  return code
}

/** 新浪分时（优先，时间字段明确）→ 返回 [{time:"09:30", price, volume}] */
async function sinaMinute(secid) {
  const url = `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_=/CN_MarketDataService.getMinLine2Data?symbol=${secid}`
  const buf = await fetchBuffer(url)
  let text = buf.toString('utf8')
  if (text.indexOf('\uFFFD') !== -1) text = decodeGBK(buf)
  const m = text.match(/\((\[[\s\S]*\])\)/) || text.match(/=\s*(\[[\s\S]*\])\s*;?/)
  const raw = (m && m[1]) || ''
  if (!raw) return []
  const arr = JSON.parse(raw)
  return (Array.isArray(arr) ? arr : []).map(it => {
    const time = String(it.day || '').slice(-5)
    const price = parseFloat(it.last)
    const volume = parseFloat(it.volume)
    return { time, price: (isFinite(price) && price > 0) ? price : null, volume: isFinite(volume) ? volume : null }
  }).filter(p => p.time && p.price !== null)
}

/** 腾讯分时（兜底）→ 返回 [{time:"09:30", price, volume}] */
async function tencentMinute(secid) {
  const text = await fetchUrl(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${secid}`)
  const json = JSON.parse(text)
  const d = json && json.data && json.data[secid]
  const dataArray = d && d.data && d.data.data
  
  // 尝试两种数据格式
  let points = []
  
  if (Array.isArray(dataArray)) {
    // 格式1：数组，每个元素是 "0930 1255.42 195 24480690.00"
    points = dataArray.map(item => {
      if (!item || typeof item !== 'string') return null
      const parts = item.trim().split(/\s+/)
      if (parts.length < 4) return null
      const timeStr = parts[0]
      const price = parseFloat(parts[1])
      const volume = parseFloat(parts[2])
      
      // 格式化时间：0930 -> 09:30
      let time = ''
      if (timeStr && /^\d{4}$/.test(timeStr)) {
        time = timeStr.slice(0, 2) + ':' + timeStr.slice(2)
      }
      
      if (time && price > 0) {
        return { time, price, volume: isFinite(volume) ? volume : null }
      }
      return null
    }).filter(Boolean)
  } else if (typeof dataArray === 'string') {
    // 格式2：字符串 "0930 1255.42 195 24480690.00 0931 1263.91 1595..."
    const parts = dataArray.trim().split(/\s+/)
    for (let i = 0; i < parts.length; i += 4) {
      const timeStr = parts[i]
      const price = parseFloat(parts[i + 1])
      const volume = parseFloat(parts[i + 2])
      
      let time = ''
      if (timeStr && /^\d{4}$/.test(timeStr)) {
        time = timeStr.slice(0, 2) + ':' + timeStr.slice(2)
      }
      
      if (time && price > 0) {
        points.push({ time, price, volume: isFinite(volume) ? volume : null })
      }
    }
  }
  
  return points
}

/** 昨收价（腾讯行情 qt.gtimg.cn，fields[3]） */
async function fetchPrevClose(secid) {
  try {
    const text = await fetchUrl(`https://qt.gtimg.cn/q=${secid}`)
    const m = text.match(/"([^"]*)"/)
    if (m) {
      const f = m[1].split('~')
      const v = parseFloat(f[3])
      if (isFinite(v) && v > 0) return v
    }
  } catch (e) { /* 忽略 */ }
  return null
}

/**
 * 分时/K 线数据（腾讯证券，UTF-8 JSON）
 * GET /api/kline/:code?period=minute|day|week|month&count=320
 */
app.get('/api/kline/:code', async (req, res) => {
  try {
    const secid = toSecid(req.params.code)
    const period = String(req.query.period || 'day')
    const count = parseInt(req.query.count) || 320

    if (period === 'minute') {
      // 优先新浪分时，失败降级腾讯分时
      let points = []
      try { points = await sinaMinute(secid) } catch (e) { /* 继续 */ }
      if (!points.length) {
        try { points = await tencentMinute(secid) } catch (e2) { /* 继续 */ }
      }
      const prevClose = await fetchPrevClose(secid)
      return res.json({ code: secid, period: 'minute', prevClose, points })
    }

    const pf = period === 'week' ? 'week' : period === 'month' ? 'month' : 'day'
    const text = await fetchUrl(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${secid},${pf},,,${count},qfq`)
    const json = JSON.parse(text)
    const d = json && json.data && json.data[secid]
    const rows = d ? (d['qfq' + pf] || d[pf] || []) : []
    const klines = (rows || []).map(r => ({
      date: String(r[0] || ''),
      open: parseFloat(r[1]) || null,
      close: parseFloat(r[2]) || null,
      high: parseFloat(r[3]) || null,
      low: parseFloat(r[4]) || null,
      volume: parseFloat(r[5]) || null
    })).filter(k => k.close !== null)
    res.json({ code: secid, period: pf, klines })
  } catch (e) {
    res.status(500).json({ error: e.message, points: [], klines: [] })
  }
})

/**
 * 数据源连通性诊断
 * GET /api/diag
 */
app.get('/api/diag', async (req, res) => {
  const targets = [
    ['eastmoney', emClistUrl(1, 1, 'f3', 1)],
    ['sina', SINA_RANK_URL(1, 1, 'changepercent', 0)],
    ['tencent', 'https://qt.gtimg.cn/q=sh600519'],
    ['tencent_kline', 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,5,qfq']
  ]
  const out = {}
  for (const [name, url] of targets) {
    try {
      const buffer = await fetchBuffer(url)
      out[name] = { ok: true, bytes: buffer.length, sample: buffer.toString('utf8').slice(0, 100) }
    } catch (e) {
      out[name] = { ok: false, error: e.message }
    }
  }
  res.json(out)
})

// ============ 404 兜底 ============
app.use((req, res) => {
  res.status(404).json({ error: '接口不存在', path: req.path })
})

// ============ 启动 ============
app.listen(PORT, () => {
  console.log('╔═══════════════════════════════════════════╗')
  console.log('║     A股数据桥接服务 v2.0                      ║')
  console.log('╠═══════════════════════════════════════════╣')
  console.log(`║  服务地址: http://localhost:${PORT}              ║`)
  console.log('║  分析工具: http://localhost:' + PORT + '/A股分析工具.html ║')
  console.log('║  API文档:  http://localhost:' + PORT + '/api/health              ║')
  console.log('╚═══════════════════════════════════════════╝')
})