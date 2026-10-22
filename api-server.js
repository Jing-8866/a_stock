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
  res.sendFile(path.join(__dirname, 'index.html'))
})

// ============ 工具函数 ============

/**
 * 股票基础信息判断（公共函数）
 */

// 去掉市场前缀，只保留6位数字代码
function bareCode(code) {
  return String(code || '').replace(/^(sh|sz|bj)/i, '')
}

/**
 * 判断股票市场（公共函数）
 * @param {string} code - 股票代码
 * @returns {string} 市场名称：沪市/深市/京市
 */
function getMarket(code) {
  const num = bareCode(code)
  if (!/^\d{6}$/.test(num)) return '未知'
  // 优先判断可转债：11xxxx（深市）、12xxxx（沪市）、13xxxx（沪市）
  if (num.startsWith('11')) return '深市'
  if (num.startsWith('12') || num.startsWith('13')) return '沪市'
  // 股票市场判断
  // 注意：92xxxx 既可能是北交所也可能是科创板CDR，纯代码无法区分
  // 实际使用时会优先用API真实数据（SECUCODE后缀），这里暂定为北交所（北交所92xxxx更多）
  if (num.startsWith('92')) return '京市'
  if (num.startsWith('6')) return '沪市'
  if (num.startsWith('0') || num.startsWith('3')) return '深市'
  if (num.startsWith('4') || num.startsWith('8')) return '京市'
  return '未知'
}

/**
 * 判断股票板块（公共函数）
 * @param {string} code - 股票代码
 * @returns {string} 板块名称：主板/创业板/科创板/北交所/未知
 */
function getBoard(code) {
  const num = bareCode(code)
  if (!/^\d{6}$/.test(num)) return '未知'
  // 注意：92xxxx代码比较特殊
  // - 北交所：SECUCODE以.BJ结尾（API真实数据优先）
  // - 科创板CDR：SECUCODE以.SH结尾（API真实数据优先）
  // - 纯代码推断时，无法区分，暂定为北交所（北交所92xxxx更多）
  // 但由于优先使用API真实数据，实际会由extractStockInfoFromApi正确判断
  if (num.startsWith('688') || num.startsWith('689')) return '科创板'
  if (num.startsWith('92')) return '北交所'
  if (num.startsWith('30')) return '创业板'
  if (num.startsWith('60') || num.startsWith('0')) return '主板'
  if (num.startsWith('4') || num.startsWith('8')) return '北交所'
  return '未知'
}

/**
 * 判断股票类型（公共函数）
 * @param {string} code - 股票代码
 * @returns {string} 类型：股/债
 */
function getStockType(code) {
  const num = bareCode(code)
  if (!/^\d{6}$/.test(num)) return null
  // 可转债：11xxxx（深市）、12xxxx（沪市）、13xxxx
  if (num.startsWith('11') || num.startsWith('12') || num.startsWith('13')) return '债'
  return '股'
}

/**
 * 从API返回的原始数据中提取股票信息（优先级最高）
 * 统一处理所有数据源返回的市场/板块/类型信息，避免各处重复逻辑
 * 
 * @param {object} rawData - API返回的原始数据对象
 * @param {string} code - 股票代码（6位数字）
 * @returns {object} { market, board, type } 提取的市场、板块、类型信息
 * 
 * 支持的数据源格式：
 * - 东方财富新股：MARKET字段（如"上交所科创板"），SECUCODE字段（如"688827.SH"）
 * - 东方财富可转债：SECUCODE字段（如"127119.SZ"），MARKET字段通常为空
 * - 其他数据源：可扩展支持更多字段
 */
function extractStockInfoFromApi(rawData, code) {
  const result = { market: '', board: '', type: '' }
  if (!rawData || !code) return result
  
  const secucode = String(rawData.SECUCODE || rawData.secucode || '')
  const marketField = String(rawData.MARKET || rawData.market || '')
  
  // 1. 尝试从SECUCODE后缀提取市场和板块（适用于新股和可转债）
  if (secucode) {
    if (secucode.endsWith('.SH')) {
      result.market = '沪市'
      // 沪市92xxxx可能是科创板CDR，但需要MARKET字段确认
    }
    else if (secucode.endsWith('.SZ')) {
      result.market = '深市'
    }
    else if (secucode.endsWith('.BJ')) {
      result.market = '京市'
      result.board = '北交所'  // 北交所股票代码多样（4/8/92开头），SECUCODE后缀.BJ即可确定是北交所
    }
  }
  
  // 2. 尝试从MARKET字段提取市场和板块（优先级更高，可能覆盖SECUCODE推断）
  if (marketField) {
    // 提取板块信息
    if (marketField.includes('科创板')) result.board = '科创板'
    else if (marketField.includes('创业板')) result.board = '创业板'
    else if (marketField.includes('北交所')) result.board = '北交所'
    else if (marketField.includes('上交所') || marketField.includes('深交所')) result.board = '主板'
    
    // 提取市场信息（可能比SECUCODE更准确）
    if (marketField.includes('上交所')) result.market = '沪市'
    else if (marketField.includes('深交所')) result.market = '深市'
    else if (marketField.includes('北交所')) result.market = '京市'
  }
  
  // 3. 判断类型：优先使用显式字段，否则从代码推断
  if (rawData.type) {
    result.type = rawData.type
  } else {
    result.type = getStockType(code) || '股'
  }
  
  return result
}

/**
 * 获取股票完整信息（统一入口，优先API数据，降级代码推断）
 * 
 * @param {string} code - 股票代码（6位数字）
 * @param {object|null} rawData - API返回的原始数据（可选）
 * @returns {object} { market, board, type } 股票的市场、板块、类型
 * 
 * 调用示例：
 * - 有API数据：getStockInfo('688827', rawData) → 优先使用rawData中的真实数据
 * - 无API数据：getStockInfo('688827', null) → 降级使用代码规则推断
 */
function getStockInfo(code, rawData = null) {
  // 优先使用API真实数据
  if (rawData) {
    const extracted = extractStockInfoFromApi(rawData, code)
    // 如果API提供了完整信息，直接返回
    if (extracted.market && extracted.board) {
      return extracted
    }
    // 部分信息缺失，用代码规则补充
    const fallback = {
      market: getMarket(code),
      board: getBoard(code),
      type: getStockType(code) || '股'
    }
    return {
      market: extracted.market || fallback.market,
      board: extracted.board || fallback.board,
      type: extracted.type || fallback.type
    }
  }
  
  // 降级：纯代码规则推断
  return {
    market: getMarket(code),
    board: getBoard(code),
    type: getStockType(code) || '股'
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
      // 关闭 keep-alive 复用，避免东财等上游断开复用连接后出现 socket hang up / 首次成功后续失败
      'Connection': 'close',
      'Referer': referer
    }, extraHeaders || {})
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers,
      timeout: 30000
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
    const rawCode = req.params.code
    console.log(`[DEBUG] /api/quote/:code 原始代码: ${rawCode}`)
    // 转换为标准 secid 格式（处理不带前缀的代码）
    const code = toSecid(rawCode)
    console.log(`[DEBUG] /api/quote/:code 转换后代码: ${code}`)
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
    console.log(`[DEBUG] /api/quote/:code 返回的代码字段: ${code}`)
    console.log(`[DEBUG] /api/quote/:code 腾讯接口的代码字段: ${codeField}`)
    const result = {
      code: code, // 使用完整的代码（带前缀）
      name: name,
      price: parseFloat(fields[3]) || 0,
      yesterdayClose: parseFloat(fields[4]) || 0,
      open: parseFloat(fields[5]) || 0,
      volume: parseFloat(fields[36]) || 0,
      amount: parseFloat(fields[37]) || 0,
      bidPrice: parseFloat(fields[7]) || 0,
      askPrice: parseFloat(fields[8]) || 0,
      high: parseFloat(fields[33]) || 0,
      low: parseFloat(fields[34]) || 0,
      limitUp: parseFloat(fields[47]) || 0,
      limitDown: parseFloat(fields[48]) || 0,
      change: parseFloat(fields[31]) || 0,
      changePercent: parseFloat(fields[32]) || 0,
      turnover: parseFloat(fields[38]) || 0,
      pe: parseFloat(fields[39]) || 0,
      pb: parseFloat(fields[46]) || 0,
      marketCap: parseFloat(fields[44]) || 0,
      timestamp: new Date().toISOString(),
      // 使用统一函数获取市场、板块、类型（腾讯接口无市场字段，降级代码推断）
      ...getStockInfo(code, null)
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
      const rawCode = fields[2] || ''
      // 尝试从原始代码中提取不带前缀的代码
      const bare = String(rawCode).replace(/^(sh|sz|bj)/i, '')
      // 通过代码推断完整代码格式
      const fullCode = bare ? toSecid(bare) : ''
      return {
        code: fullCode || rawCode,
        name: fixChineseEncoding(fields[1] || ''),
        price: parseFloat(fields[3]) || 0,
        yesterdayClose: parseFloat(fields[4]) || 0,
        change: parseFloat(fields[31]) || 0,
        changePercent: parseFloat(fields[32]) || 0,
        pe: parseFloat(fields[39]) || 0,
        pb: parseFloat(fields[46]) || 0,
        high: parseFloat(fields[33]) || 0,
        low: parseFloat(fields[34]) || 0,
        volume: parseFloat(fields[36]) || 0,
        // 使用统一函数获取市场、板块、类型（腾讯接口无市场字段，降级代码推断）
        ...getStockInfo(bare, null)
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
  console.log(`[DEBUG] toSecid输入: "${code}"`)
  code = String(code || '').toLowerCase().trim()
  if (/^(sh|sz|bj)\d{6}$/.test(code)) {
    console.log(`[DEBUG] toSecid: 已经有前缀，返回: ${code}`)
    return code
  }
  if (/^\d{6}$/.test(code)) {
    console.log(`[DEBUG] toSecid: 6位数字代码: ${code}`)
    if (code.startsWith('6')) {
      const result = 'sh' + code
      console.log(`[DEBUG] toSecid: 沪市，返回: ${result}`)
      return result
    }
    // 北交所：4xxxxx, 8xxxxx, 92xxxx
    if (code.startsWith('4') || code.startsWith('8') || code.startsWith('92')) {
      const result = 'bj' + code
      console.log(`[DEBUG] toSecid: 北交所，返回: ${result}`)
      return result
    }
    const result = 'sz' + code
    console.log(`[DEBUG] toSecid: 深市，返回: ${result}`)
    return result
  }
  console.log(`[DEBUG] toSecid: 其他格式，返回: ${code}`)
  return code
}

/** 东财 K 线（腾讯 fqkline 不可用时的降级源）
 * secid: sh600519 / sz000001 / bj430047
 * period: day | week | month
 * 返回 [{ date, open, close, high, low, volume }]
 */
async function emFetchKline(secid, period, count) {
  try {
    const s = String(secid || '').toLowerCase().trim()
    let emSecid = ''
    if (s.startsWith('sh')) emSecid = '1.' + s.slice(2)
    else if (s.startsWith('sz') || s.startsWith('bj')) emSecid = '0.' + s.slice(2)
    else if (/^\d{6}$/.test(s)) emSecid = (s.startsWith('6') ? '1.' : '0.') + s
    if (!emSecid) {
      console.error(`[ERROR] 无效的secid: ${secid}`)
      return []
    }
    const klt = period === 'week' ? 102 : (period === 'month' ? 103 : 101)
    const lmt = Math.max(1, Math.min(1000, parseInt(count) || 320))
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${emSecid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=${klt}&fqt=1&end=20500101&lmt=${lmt}`
    console.log(`[DEBUG] 东财K线URL: ${url}`)
    const buffer = await fetchBuffer(url)
    const text = buffer.toString('utf8')
    console.log(`[DEBUG] 东财K线响应长度: ${text.length}`)
    const data = JSON.parse(text)
    const lines = (data && data.data && data.data.klines) || []
    console.log(`[DEBUG] 东财K线原始行数: ${lines.length}`)
    return lines.map(line => {
      const p = String(line).split(',')
      return {
        date: p[0] || '',
        open: parseFloat(p[1]) || null,
        close: parseFloat(p[2]) || null,
        high: parseFloat(p[3]) || null,
        low: parseFloat(p[4]) || null,
        volume: parseFloat(p[5]) || null
      }
    }).filter(k => {
      if (k.close === null) {
        console.log(`[WARN] 过滤掉close为null的记录: ${JSON.stringify(k)}`)
        return false
      }
      if (k.close <= 0) {
        console.log(`[WARN] 过滤掉close<=0的记录: ${JSON.stringify(k)}`)
        return false
      }
      return true
    })
  } catch (e) {
    // 降为 WARN 单行：东财失败后有新浪/昨收兜底，非致命，去掉堆栈避免日志噪音误导
    console.log(`[WARN] 东财K线获取失败: ${e.message}`)
    return []
  }
}

/** 新浪 K 线（降级源）
 * symbol: sz002342 或 002342
 * period: day | week | month
 * 返回 [{ date, open, close, high, low, volume }]
 */
async function sinaKline(symbol, period, count) {
  try {
    // 新浪 K 线接口参数
    // scale: 5=5分钟，15=15分钟，30=30分钟，60=60分钟，240=日，1200=周
    // 注意：新浪不支持月K，月K降级为日K
    const scale = period === 'week' ? 1200 : (period === 'month' ? 240 : 240)
    
    // 新浪接口需要完整的股票代码（带前缀）
    let sinaSymbol = symbol
    if (!/^(sh|sz|bj)\d{6}$/.test(sinaSymbol)) {
      if (sinaSymbol.startsWith('6')) sinaSymbol = 'sh' + sinaSymbol
      // 北交所：4xxxxx, 8xxxxx, 92xxxx
      else if (sinaSymbol.startsWith('4') || sinaSymbol.startsWith('8') || sinaSymbol.startsWith('92')) sinaSymbol = 'bj' + sinaSymbol
      else sinaSymbol = 'sz' + sinaSymbol
    }
    
    const url = `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_${sinaSymbol}_${scale}_1577432551767=/CN_MarketDataService.getKLineData?symbol=${sinaSymbol}&scale=${scale}&ma=no&datalen=${count}`
    console.log(`[DEBUG] 新浪K线URL: ${url}`)
    const buf = await fetchBuffer(url)
    let text = buf.toString('utf8')
    if (text.indexOf('\uFFFD') !== -1) text = decodeGBK(buf)
    
    console.log(`[DEBUG] 新浪K线响应前500字符: ${text.substring(0, 500)}`)
    
    // 提取 JSON 数据 - 新浪返回格式: /*<script>...</script>*/var _symbol_scale_ts=([...]);
    // 先剥离反爬注释 /*...*/，再优先匹配圆括号包裹 =([...])，兜底 =[...]
    text = text.replace(/\/\*[\s\S]*?\*\//g, '')
    const m = text.match(/=\s*\(\s*(\[[\s\S]*?\])\s*\)/) || text.match(/=\s*(\[[\s\S]*\])\s*;?/)
    if (!m) {
      console.error(`[ERROR] 新浪K线解析失败: 未找到 JSON 数据`)
      console.error(`[ERROR] 响应内容: ${text}`)
      return []
    }
    
    const arr = JSON.parse(m[1])
    if (!Array.isArray(arr) || !arr.length) {
      console.error(`[ERROR] 新浪K线无数据`)
      return []
    }
    
    const klines = arr.map(point => {
      return {
        date: point.day || '',
        open: parseFloat(point.open) || null,
        close: parseFloat(point.close) || null,
        high: parseFloat(point.high) || null,
        low: parseFloat(point.low) || null,
        volume: parseFloat(point.volume) || null
      }
    }).filter(k => {
      if (k.close === null) return false
      if (k.close <= 0) return false
      return true
    })
    
    console.log(`[DEBUG] 新浪K线解析成功，条数: ${klines.length}`)
    return klines
  } catch (e) {
    // 降为 WARN 单行：新浪失败属可兜底的非致命错误，去掉堆栈统一日志风格
    console.log(`[WARN] 新浪K线获取失败: ${e.message}`)
    return []
  }
}

/** 新浪分时（优先，时间字段明确）→ 返回 [{time:"09:30", price, volume}] */
async function sinaMinute(secid) {
  const url = `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_=/CN_MarketDataService.getMinLine2Data?symbol=${secid}`
  const buf = await fetchBuffer(url)
  let text = buf.toString('utf8')
  if (text.indexOf('\uFFFD') !== -1) text = decodeGBK(buf)
  // 剥离新浪反爬注释 /*...*/ 后再提取，优先圆括号包裹 (([...]))，兜底 =[...]
  text = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const m = text.match(/\(\s*(\[[\s\S]*?\])\s*\)/) || text.match(/=\s*(\[[\s\S]*\])\s*;?/)
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
  // 主源：腾讯 qt.gtimg.cn（fields[3]=昨收）
  try {
    const text = await fetchUrl(`https://qt.gtimg.cn/q=${secid}`)
    const m = text.match(/"([^"]*)"/)
    if (m) {
      const f = m[1].split('~')
      const v = parseFloat(f[3])
      if (isFinite(v) && v > 0) return v
    }
  } catch (e) { /* 忽略，尝试东财兜底 */ }
  // 兜底：东财日K取最近一根收盘价（腾讯 qt.gtimg.cn 对北交所 bj 前缀可能无数据）
  try {
    const dayKlines = await emFetchKline(secid, 'day', 2)
    if (dayKlines.length) {
      const v = dayKlines[dayKlines.length - 1].close
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
      let points = []
      console.log(`[DEBUG] 开始获取分时数据, secid: ${secid}`)
      // 优先东财 trends2 当日分时（ndays=1）——腾讯/新浪分时接口不支持北交所 bj 前缀，
      // 东财 trends2 对北交所 0. 前缀支持良好，故作为所有股票（含北交所）的首选分时源
      try {
        const s = String(secid || '').toLowerCase().trim()
        let emSecid = ''
        if (s.startsWith('sh')) emSecid = '1.' + s.slice(2)
        else if (s.startsWith('sz') || s.startsWith('bj')) emSecid = '0.' + s.slice(2)
        else if (/^\d{6}$/.test(s)) emSecid = (s.startsWith('6') ? '1.' : '0.') + s
        if (emSecid) {
          const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${emSecid}&ut=fa5fd1943c7b386f172d6893dbfba10b&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0&iscca=0`
          console.log(`[DEBUG] 东财trends2当日分时URL: ${url}`)
          const buffer = await fetchBuffer(url)
          const data = JSON.parse(buffer.toString('utf8'))
          const trends = (data && data.data && data.data.trends) || []
          // trends 每项: "2026-10-22 09:30,开,收,高,低,量,额,均价"；time 取时分 HH:MM
          points = trends.map(line => {
            const p = String(line).split(',')
            const price = parseFloat(p[2])
            const volume = parseFloat(p[5])
            return { time: String(p[0] || '').slice(-5), price: (isFinite(price) && price > 0) ? price : null, volume: isFinite(volume) ? volume : null }
          }).filter(pt => pt.time && pt.price !== null)
          console.log(`[DEBUG] 东财trends2当日分时条数: ${points.length}`)
        }
      } catch (e) {
        console.log(`[WARN] 东财trends2当日分时获取失败: ${e.message}`)
      }
      // 降级1：腾讯分时
      if (!points.length) {
        try { 
          points = await tencentMinute(secid)
          console.log(`[DEBUG] 腾讯分时获取结果: ${points.length} 条`)
        } catch (e) { 
          console.log(`[WARN] 腾讯分时获取失败: ${e.message}`)
        }
      }
      // 降级2：新浪分时
      if (!points.length) {
        try { 
          points = await sinaMinute(secid)
          console.log(`[DEBUG] 新浪分时获取结果: ${points.length} 条`)
        } catch (e2) { 
          console.log(`[WARN] 新浪分时获取失败: ${e2.message}`)
        }
      }
      const prevClose = await fetchPrevClose(secid)
      console.log(`[DEBUG] 昨收价: ${prevClose}`)
      return res.json({ code: secid, period: 'minute', prevClose, points })
    }

    if (period === 'day5') {
      // 近5个交易日的分时走势：用5分钟K线数据
      let minKlines = []
      console.log(`[DEBUG] 开始获取五日分时数据, secid: ${secid}`)
      // secid -> 东财 emSecid（北交所 bj 用 0. 前缀，与东财市场代码一致）
      const s = String(secid || '').toLowerCase().trim()
      let emSecid = ''
      if (s.startsWith('sh')) emSecid = '1.' + s.slice(2)
      else if (s.startsWith('sz') || s.startsWith('bj')) emSecid = '0.' + s.slice(2)
      else if (/^\d{6}$/.test(s)) emSecid = (s.startsWith('6') ? '1.' : '0.') + s

      // 优先东财 trends2 多日分时（ndays=5，近5个交易日逐分钟）——与「分时」同族接口，
      // 比 5 分钟K线更契合「五日=近5日分时」语义，且对北交所 0. 前缀支持良好
      try {
        if (emSecid) {
          const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${emSecid}&ut=fa5fd1943c7b386f172d6893dbfba10b&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=5&iscr=0&iscca=0`
          console.log(`[DEBUG] 东财trends2多日分时URL: ${url}`)
          const buffer = await fetchBuffer(url)
          const data = JSON.parse(buffer.toString('utf8'))
          // trends 每项: "2026-10-22 09:30,开,收,高,低,量,额,均价"；取 p[0]=时间 p[2]=最新价 p[5]=量
          const trends = (data && data.data && data.data.trends) || []
          minKlines = trends.map(line => {
            const p = String(line).split(',')
            return { date: p[0] || '', close: parseFloat(p[2]) || null, volume: parseFloat(p[5]) || null }
          }).filter(k => k.close !== null && k.close > 0)
          console.log(`[DEBUG] 东财trends2分时条数: ${minKlines.length}`)
        }
      } catch (e) { 
        console.log(`[WARN] 东财trends2多日分时获取失败: ${e.message}`)
      }

      // 降级1：东财5分钟K线（klt=5）
      if (!minKlines.length && emSecid) {
        try {
          const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${emSecid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=5&fqt=1&end=20500101&lmt=250`
          console.log(`[DEBUG] 东财5分钟K线URL: ${url}`)
          const buffer = await fetchBuffer(url)
          const data = JSON.parse(buffer.toString('utf8'))
          const lines = (data && data.data && data.data.klines) || []
          minKlines = lines.map(line => {
            const p = String(line).split(',')
            return { date: p[0] || '', close: parseFloat(p[2]) || null, volume: parseFloat(p[5]) || null }
          }).filter(k => k.close !== null && k.close > 0)
          console.log(`[DEBUG] 东财5分钟K线条数: ${minKlines.length}`)
        } catch (e) { 
          console.log(`[WARN] 东财5分钟K线获取失败: ${e.message}`)
        }
      }
      // 降级新浪5分钟K线（scale=5）
      if (!minKlines.length) {
        try {
          const symbol = secid.toLowerCase().replace(/^(sh|sz|bj)(\d{6})$/, '$2')
          let sinaSymbol = symbol
          if (!/^(sh|sz|bj)\d{6}$/.test(sinaSymbol)) {
            if (sinaSymbol.startsWith('6')) sinaSymbol = 'sh' + sinaSymbol
            // 北交所：4xxxxx, 8xxxxx, 92xxxx
            else if (sinaSymbol.startsWith('4') || sinaSymbol.startsWith('8') || sinaSymbol.startsWith('92')) sinaSymbol = 'bj' + sinaSymbol
            else sinaSymbol = 'sz' + sinaSymbol
          }
          // 修正 JSONP 回调变量名：与日K段保持一致的规范格式（var _symbol_scale_时间戳=），
          // 空占位 var _= 易被新浪返回空/异常格式，导致正则匹配失败而静默降级无效
          const url = `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_${sinaSymbol}_5_1577432551767=/CN_MarketDataService.getKLineData?symbol=${sinaSymbol}&scale=5&ma=no&datalen=250`
          console.log(`[DEBUG] 新浪5分钟K线URL: ${url}`)
          const buf = await fetchBuffer(url)
          let text = buf.toString('utf8')
          if (text.indexOf('\uFFFD') !== -1) text = decodeGBK(buf)
          // 新浪返回含反爬前缀 /*<script>...</script>*/，且 JSON 数组被包在 =([...]) 里。
          // 先剥离 /*...*/ 注释，再优先匹配 =([...])（圆括号包裹），兜底匹配 =[...]
          text = text.replace(/\/\*[\s\S]*?\*\//g, '')
          const m = text.match(/=\s*\(\s*(\[[\s\S]*?\])\s*\)/) || text.match(/=\s*(\[[\s\S]*\])\s*;?/)
          if (m) {
            const arr = JSON.parse(m[1])
            minKlines = arr.map(point => ({
              date: point.day || '',
              close: parseFloat(point.close) || null,
              volume: parseFloat(point.volume) || null
            })).filter(k => k.close !== null && k.close > 0)
            console.log(`[DEBUG] 新浪5分钟K线条数: ${minKlines.length}`)
          } else {
            console.log(`[WARN] 新浪5分钟K线解析失败/无数据，响应前200字符: ${text.substring(0, 200)}`)
          }
        } catch (e) { 
          console.log(`[WARN] 新浪5分钟K线获取失败: ${e.message}`)
        }
      }
      // 取最近5个交易日
      const daySet = [...new Set(minKlines.map(k => k.date.slice(0, 10)))].sort()
      const last5Days = daySet.slice(-5)
      console.log(`[DEBUG] 最近5个交易日: ${last5Days.join(', ')}`)
      const filtered = minKlines.filter(k => last5Days.includes(k.date.slice(0, 10)))
      const points = filtered.map(k => ({ time: k.date, price: k.close, volume: k.volume }))
      console.log(`[DEBUG] 过滤后的数据点数: ${points.length}`)
      // prevClose = 第一天的昨收（从日K线获取前一天收盘价）
      let prevClose = null
      if (last5Days.length > 0) {
        try {
          const dayKlines = await emFetchKline(secid, 'day', 10)
          const prevDayKlines = dayKlines.filter(k => k.date < last5Days[0])
          if (prevDayKlines.length) prevClose = prevDayKlines[prevDayKlines.length - 1].close
          console.log(`[DEBUG] 从日K线获取昨收: ${prevClose}`)
        } catch (e) { 
          console.log(`[WARN] 从日K线获取昨收失败: ${e.message}`)
        }
      }
      if (!prevClose) prevClose = await fetchPrevClose(secid)
      console.log(`[DEBUG] 最终昨收价: ${prevClose}`)
      return res.json({ code: secid, period: 'day5', prevClose, points, days: last5Days })
    }

    const pf = period === 'week' ? 'week' : period === 'month' ? 'month' : 'day'
    let klines = []
    // 北交所（bj 前缀）：腾讯 fqkline 不支持 bj 前缀 secid，会返回空数据白跑一次请求，
    // 故北交所直接跳过腾讯，走下方东财降级（东财对北交所 0. 前缀映射正确）
    const isBJ = String(secid || '').toLowerCase().startsWith('bj')
    // 优先腾讯 fqkline，失败（如 HTTP 501 接口废弃）降级东财；北交所跳过腾讯
    if (!isBJ) {
      try {
        const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${secid},${pf},,,${count},qfq`
        console.log(`[DEBUG] 腾讯K线URL: ${url}`)
        const text = await fetchUrl(url)
        console.log(`[DEBUG] 腾讯K线响应前200字符: ${text.substring(0, 200)}`)
        const json = JSON.parse(text)
        const d = json && json.data && json.data[secid]
        const rows = d ? (d['qfq' + pf] || d[pf] || []) : []
        klines = (rows || []).map(r => ({
          date: String(r[0] || ''),
          open: parseFloat(r[1]) || null,
          close: parseFloat(r[2]) || null,
          high: parseFloat(r[3]) || null,
          low: parseFloat(r[4]) || null,
          volume: parseFloat(r[5]) || null
        })).filter(k => k.close !== null && k.close > 0)
        console.log(`[DEBUG] 腾讯K线获取成功，条数: ${klines.length}`)
      } catch (e) {
        console.log(`[WARN] 腾讯K线获取失败: ${e.message}, 尝试降级到东财`)
      }
    } else {
      console.log(`[INFO] 北交所股票（${secid}），跳过腾讯 fqkline，直接走东财`)
    }
    if (!klines.length) {
      console.log(`[INFO] 腾讯K线无数据，尝试东财`)
      try {
        klines = await emFetchKline(secid, pf, count)
        console.log(`[DEBUG] 东财K线获取成功，条数: ${klines.length}`)
      } catch (e) {
        console.error(`[ERROR] 东财K线获取失败: ${e.message}`)
      }
    }
    if (!klines.length) {
      console.log(`[INFO] 东财K线无数据，尝试新浪`)
      try {
        const symbol = secid.toLowerCase().replace(/^(sh|sz|bj)(\d{6})$/, '$2')
        klines = await sinaKline(symbol, pf, count)
        console.log(`[DEBUG] 新浪K线获取成功，条数: ${klines.length}`)
      } catch (e) {
        console.error(`[ERROR] 新浪K线获取失败: ${e.message}`)
      }
    }
    // 所有数据源都尝试过后，返回结果（可能为空数组）
    if (!klines.length) {
      console.log(`[WARN] 所有K线数据源均失败，返回空数据`)
    }
    res.json({ code: secid, period: pf, klines })
  } catch (e) {
    console.error(`[ERROR] K线接口异常: ${e.message}`)
    res.status(500).json({ error: e.message, points: [], klines: [] })
  }
})

/**
 * 当日可申购新股/新债
 * GET /api/ipo
 */
app.get('/api/ipo', async (req, res) => {
  try {
    const now = new Date()
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const today = fmt(now)
    // 前10个交易日
    const minD = new Date(now)
    let cnt = 0
    while (cnt < 10) { minD.setDate(minD.getDate() - 1); if (minD.getDay() !== 0 && minD.getDay() !== 6) cnt++ }
    const minDate = fmt(minD)
    // 后10个交易日
    const maxD = new Date(now)
    cnt = 0
    while (cnt < 10) { maxD.setDate(maxD.getDate() + 1); if (maxD.getDay() !== 0 && maxD.getDay() !== 6) cnt++ }
    const maxDate = fmt(maxD)

    const result = []

    // 计算状态
    // 状态判断逻辑：
    // 1. 可申购：发行日期 = 今天
    // 2. 待发行：发行日期 > 今天
    // 3. 已上市：上市日期存在且 <= 今天
    // 4. 已发行待上市：发行日期 < 今天 且（无上市日期 或 上市日期 > 今天）
    const calcStatus = (applyDate, listingDate) => {
      if (!applyDate) return '未知'
      if (applyDate === today) return '可申购'
      if (applyDate > today) return '待发行'
      // 发行日期已过
      if (listingDate && listingDate <= today) return '已上市'
      return '已发行待上市'
    }

    // 提取有效的上市日期
    // 优先级：实际上市日期 > 预计上市日期 > 其他上市日期字段
    const extractListingDate = (r, debug = false) => {
      // 1. 优先：实际上市日期（已上市股票）
      const actualFields = [
        'LISTING_DATE',           // 实际上市日期（最权威）
      ]
      for (const field of actualFields) {
        if (r[field]) {
          const dateStr = String(r[field]).slice(0, 10)
          if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            const year = parseInt(dateStr.slice(0, 4))
            if (year >= 2020 && year <= 2100) {
              if (debug) console.log(`[DEBUG] 使用字段 ${field}: ${dateStr}`)
              return dateStr
            }
          }
        }
      }
      
      // 2. 预计上市日期（未上市股票）
      const expectedFields = [
        'SELECT_LISTING_DATE',    // 选择/确定上市日期
        'EXPECTED_LISTING_DATE',  // 预计上市日期
        'LISTING_DATE_NEW',       // 新上市日期字段
        'APPLY_LISTING_DATE',     // 申请上市日期
        'PLAN_LISTING_DATE',      // 计划上市日期
        'SCHEDULE_LISTING_DATE',  // 安排上市日期
      ]
      for (const field of expectedFields) {
        if (r[field]) {
          const dateStr = String(r[field]).slice(0, 10)
          if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            const year = parseInt(dateStr.slice(0, 4))
            if (year >= 2020 && year <= 2100) {
              if (debug) console.log(`[DEBUG] 使用字段 ${field}: ${dateStr}`)
              return dateStr
            }
          }
        }
      }
      
      return ''
    }

    // 1. 新股
    try {
      const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_APP_IPOAPPLY&columns=ALL&pageNumber=1&pageSize=200&sortColumns=APPLY_DATE&sortTypes=-1&source=WEB&client=WEB'
      const buffer = await fetchBuffer(url, { 'Referer': 'https://data.eastmoney.com/' })
      const data = JSON.parse(buffer.toString('utf8'))
      const rows = (data && data.result && data.result.data) || []
      console.log(`[DEBUG] 新股数据条数: ${rows.length}`)
      if (rows.length > 0) {
        const sample = rows[0]
        console.log(`[DEBUG] 新股样本数据日期字段: LISTING_DATE=${sample.LISTING_DATE}, SELECT_LISTING_DATE=${sample.SELECT_LISTING_DATE}, EXPECTED_LISTING_DATE=${sample.EXPECTED_LISTING_DATE}`)
      }
      rows.forEach(r => {
        const applyDate = String(r.APPLY_DATE || '').slice(0, 10)
        const listingDate = extractListingDate(r)
        if (!applyDate || applyDate < minDate || applyDate > maxDate) return
        const code = String(r.SECURITY_CODE || '')
        if (!code) return
        // 使用统一函数获取股票信息（优先API真实数据，降级代码推断）
        const info = getStockInfo(code, r)
        if (info.market === '未知') {
          console.log(`[DEBUG] 新股市场未知: code=${code}, name=${r.SECURITY_NAME_ABBR || r.SECURITY_NAME}, SECUCODE=${r.SECUCODE}`)
        }
        const status = calcStatus(applyDate, listingDate)
        result.push({ type: info.type, name: r.SECURITY_NAME_ABBR || r.SECURITY_NAME || '', code, price: parseFloat(r.ISSUE_PRICE) || 0, market: info.market, board: info.board, applyDate, listingDate, status })
      })
    } catch (e) { console.log(`[WARN] 新股获取失败: ${e.message}`) }

    // 2. 可转债
    try {
      const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_BOND_CB_LIST&columns=ALL&pageNumber=1&pageSize=200&sortColumns=PUBLIC_START_DATE&sortTypes=-1&source=WEB&client=WEB'
      const buffer = await fetchBuffer(url, { 'Referer': 'https://data.eastmoney.com/' })
      const data = JSON.parse(buffer.toString('utf8'))
      const rows = (data && data.result && data.result.data) || []
      console.log(`[DEBUG] 可转债数据条数: ${rows.length}`)
      if (rows.length > 0) {
        const sample = rows[0]
        console.log(`[DEBUG] 可转债样本数据日期字段: LISTING_DATE=${sample.LISTING_DATE}, SELECT_LISTING_DATE=${sample.SELECT_LISTING_DATE}`)
      }
      rows.forEach(r => {
        const applyDate = String(r.PUBLIC_START_DATE || '').slice(0, 10)
        const listingDate = extractListingDate(r)
        if (!applyDate || applyDate < minDate || applyDate > maxDate) return
        const code = String(r.SECURITY_CODE || '')
        if (!code) return
        // 使用统一函数获取股票信息（优先API真实数据，降级代码推断）
        const info = getStockInfo(code, r)
        // 可转债板块固定为"可转债"
        info.board = '可转债'
        info.type = '债'
        if (info.market === '未知') {
          console.log(`[DEBUG] 可转债市场未知: code=${code}, name=${r.SECURITY_NAME_ABBR}, SECUCODE=${r.SECUCODE}`)
        }
        const status = calcStatus(applyDate, listingDate)
        result.push({ type: info.type, name: r.SECURITY_NAME_ABBR || '', code, price: parseFloat(r.ISSUE_PRICE) || 0, market: info.market, board: info.board, applyDate, listingDate, status })
      })
    } catch (e) { console.log(`[WARN] 可转债获取失败: ${e.message}`) }

    res.json({ date: today, minDate, maxDate, items: result })
  } catch (e) {
    console.error(`[ERROR] 打新接口异常: ${e.message}`)
    res.status(500).json({ error: e.message, items: [] })
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
  console.log('║     A股数据桥接服务                        ║')
  console.log('╠═══════════════════════════════════════════╣')
  console.log(`║  服务地址: http://localhost:${PORT}              ║`)
  console.log('║  分析工具: http://localhost:' + PORT + '/index.html ║')
  console.log('║  数据备份、导入: http://localhost:' + PORT + '/localStorage.html ║')
  console.log('║  API文档:  http://localhost:' + PORT + '/api/health              ║')
  console.log('╚═══════════════════════════════════════════╝')
})