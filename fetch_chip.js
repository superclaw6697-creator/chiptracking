#!/usr/bin/env node
/**
 * fetch_chip.js
 * 抓取指定股票區間的外資籌碼 + 股價，輸出到 data/<stockId>.json
 *
 * 用法：
 *   node fetch_chip.js <股票代號> [startDate] [endDate]
 *
 * 範例：
 *   node fetch_chip.js 2312 2026-05-01 2026-06-09
 *   node fetch_chip.js 2312              ← 預設近20交易日
 */

const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');

const stockId = process.argv[2];
const argStart = process.argv[3];
const argEnd = process.argv[4];

if (!stockId) {
  console.error('用法: node fetch_chip.js <股票代號> [startDate YYYY-MM-DD] [endDate YYYY-MM-DD]');
  process.exit(1);
}

const TOKEN = fs.readFileSync(path.join(os.homedir(), 'secret/findmind_api.key'), 'utf8').trim();

const FOREIGN_KEYWORDS = ['摩根','高盛','美林','瑞銀','野村','花旗','德意志','匯豐','法興','麥格理','巴克萊','星展','渣打','怡富'];
const isForeign = name => FOREIGN_KEYWORDS.some(k => name.includes(k));

function dateRange(start, end) {
  const dates = [];
  const d = new Date(start);
  const endMs = new Date(end).getTime();
  while (d.getTime() <= endMs) {
    if (d.getDay() !== 0 && d.getDay() !== 6) dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function defaultDates(n = 20) {
  const dates = [];
  const d = new Date();
  if (d.getHours() < 15) d.setDate(d.getDate() - 1);
  while (dates.length < n) {
    if (d.getDay() !== 0 && d.getDay() !== 6) dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() - 1);
  }
  return dates.sort();
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function aggregateDay(rows) {
  const allBrokers = {};
  for (const r of rows) {
    const b = r.securities_trader;
    if (!allBrokers[b]) allBrokers[b] = { buy_amt: 0, buy_vol: 0, sell_amt: 0, sell_vol: 0 };
    allBrokers[b].buy_amt  += r.price * r.buy;
    allBrokers[b].buy_vol  += r.buy;
    allBrokers[b].sell_amt += r.price * r.sell;
    allBrokers[b].sell_vol += r.sell;
  }

  // 外資彙整
  let f_buy_amt = 0, f_buy_vol = 0, f_sell_amt = 0, f_sell_vol = 0;
  const topForeign = [];

  for (const [name, v] of Object.entries(allBrokers)) {
    if (!isForeign(name)) continue;
    f_buy_amt  += v.buy_amt;
    f_buy_vol  += v.buy_vol;
    f_sell_amt += v.sell_amt;
    f_sell_vol += v.sell_vol;
    const buy  = Math.round(v.buy_vol  / 1000);
    const sell = Math.round(v.sell_vol / 1000);
    const net  = buy - sell;
    if (buy > 0 || sell > 0) {
      topForeign.push({
        name,
        buy,
        buy_avg:  v.buy_vol  ? +(v.buy_amt  / v.buy_vol ).toFixed(2) : 0,
        sell,
        sell_avg: v.sell_vol ? +(v.sell_amt / v.sell_vol).toFixed(2) : 0,
        net,
      });
    }
  }

  topForeign.sort((a, b) => b.net - a.net);
  const topForeignSellers = [...topForeign].sort((a, b) => a.net - b.net).filter(f => f.net < 0);

  return {
    foreign_buy:           Math.round(f_buy_vol  / 1000),
    foreign_buy_avg:       f_buy_vol  ? +(f_buy_amt  / f_buy_vol ).toFixed(2) : 0,
    foreign_sell:          Math.round(f_sell_vol / 1000),
    foreign_sell_avg:      f_sell_vol ? +(f_sell_amt / f_sell_vol).toFixed(2) : 0,
    foreign_net:           Math.round((f_buy_vol - f_sell_vol) / 1000),
    top_foreign:           topForeign.filter(f => f.net > 0).slice(0, 10),
    top_foreign_sellers:   topForeignSellers.slice(0, 10),
  };
}

async function main() {
  const dates = (argStart && argEnd) ? dateRange(argStart, argEnd) : defaultDates(20);
  const startDate = dates[0];
  const endDate   = dates[dates.length - 1];

  console.log(`\n股票 ${stockId}  ${startDate} ～ ${endDate}（${dates.length}個交易日）`);

  // 同時抓股價（TaiwanStockPrice 支援區間，一次取完）
  const priceUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${stockId}&start_date=${startDate}&end_date=${endDate}&token=${TOKEN}`;
  console.log('抓取股價...');
  const priceRes = await fetchJSON(priceUrl);
  const priceMap = {};
  for (const p of (priceRes.data || [])) {
    priceMap[p.date] = { date: p.date, open: p.open, high: p.max, low: p.min, close: p.close, volume: p.Trading_Volume };
  }

  // 逐日抓券商分點
  const chips = [];
  for (const date of dates) {
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockTradingDailyReport&data_id=${stockId}&start_date=${date}&token=${TOKEN}`;
    const res = await fetchJSON(url);
    const rows = res.data || [];
    if (rows.length) {
      const dayChip = aggregateDay(rows);
      chips.push({ date, ...dayChip });
      process.stdout.write(`  ${date}: 分點${rows.length}筆  外資淨${dayChip.foreign_net >= 0 ? '+' : ''}${dayChip.foreign_net}張  均買${dayChip.foreign_buy_avg}\n`);
    } else {
      process.stdout.write(`  ${date}: 無資料\n`);
    }
    await sleep(600);
  }

  const prices = dates.map(d => priceMap[d]).filter(Boolean);

  const output = { stockId, startDate, endDate, prices, chips };
  const outDir  = path.join(__dirname, 'data');
  const outFile = path.join(outDir, `${stockId}.json`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\n✓ 已寫入 ${outFile}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
