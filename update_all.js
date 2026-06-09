#!/usr/bin/env node
/**
 * update_all.js
 * 讀取 data/index.json，對每支股票增量更新籌碼資料，最後 git commit + push
 *
 * 用法：
 *   node update_all.js          ← 更新全部持股
 *   node update_all.js --dry    ← 只抓資料，不 commit/push
 */

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { execSync } = require('child_process');

const DRY = process.argv.includes('--dry');
const TOKEN = fs.readFileSync(path.join(os.homedir(), 'secret/findmind_api.key'), 'utf8').trim();
const DATA_DIR = path.join(__dirname, 'data');

const FOREIGN_KEYWORDS = ['摩根','高盛','美林','瑞銀','野村','花旗','德意志','匯豐','法興','麥格理','巴克萊','星展','渣打','怡富'];
const isForeign = name => FOREIGN_KEYWORDS.some(k => name.includes(k));

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

// 今天（如果已過 15:00 算今天，否則算昨天）
function today() {
  const d = new Date();
  if (d.getHours() < 15) d.setDate(d.getDate() - 1);
  // 跳過週末
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// 某日期加 N 天（跳過週末）
function nextTradingDay(dateStr) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// 預設起始：8 週前
function defaultStart() {
  const d = new Date();
  d.setDate(d.getDate() - 56);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

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
  let f_buy_amt = 0, f_buy_vol = 0, f_sell_amt = 0, f_sell_vol = 0;
  const topForeign = [];
  for (const [name, v] of Object.entries(allBrokers)) {
    if (!isForeign(name)) continue;
    f_buy_amt  += v.buy_amt;  f_buy_vol  += v.buy_vol;
    f_sell_amt += v.sell_amt; f_sell_vol += v.sell_vol;
    const buy = Math.round(v.buy_vol / 1000), sell = Math.round(v.sell_vol / 1000);
    if (buy > 0 || sell > 0) topForeign.push({
      name, buy,
      buy_avg:  v.buy_vol  ? +(v.buy_amt  / v.buy_vol ).toFixed(2) : 0,
      sell,
      sell_avg: v.sell_vol ? +(v.sell_amt / v.sell_vol).toFixed(2) : 0,
      net: buy - sell,
    });
  }
  topForeign.sort((a, b) => b.net - a.net);
  return {
    foreign_buy:      Math.round(f_buy_vol  / 1000),
    foreign_buy_avg:  f_buy_vol  ? +(f_buy_amt  / f_buy_vol ).toFixed(2) : 0,
    foreign_sell:     Math.round(f_sell_vol / 1000),
    foreign_sell_avg: f_sell_vol ? +(f_sell_amt / f_sell_vol).toFixed(2) : 0,
    foreign_net:      Math.round((f_buy_vol - f_sell_vol) / 1000),
    top_foreign:      topForeign.slice(0, 10),
  };
}

async function updateStock(stockId) {
  const outFile = path.join(DATA_DIR, `${stockId}.json`);

  // 讀取現有資料，決定從哪天開始補
  let existing = null;
  let startDate;
  if (fs.existsSync(outFile)) {
    existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const lastChipDate = existing.chips.at(-1)?.date;
    const lastPriceDate = existing.prices.at(-1)?.date;
    const lastDate = [lastChipDate, lastPriceDate].filter(Boolean).sort().at(-1);
    startDate = lastDate ? nextTradingDay(lastDate) : defaultStart();
  } else {
    startDate = defaultStart();
  }

  const endDate = today();
  if (startDate > endDate) {
    console.log(`  ${stockId}: 已是最新（${endDate}），略過`);
    return false; // 無更新
  }

  console.log(`  ${stockId}: 補抓 ${startDate} ～ ${endDate}`);

  // 抓股價（區間一次取）
  const priceUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${stockId}&start_date=${startDate}&end_date=${endDate}&token=${TOKEN}`;
  const priceRes = await fetchJSON(priceUrl);
  const newPriceMap = {};
  for (const p of (priceRes.data || [])) {
    newPriceMap[p.date] = { date: p.date, open: p.open, high: p.max, low: p.min, close: p.close, volume: p.Trading_Volume };
  }

  // 逐日抓分點
  const dates = dateRange(startDate, endDate);
  const newChips = [];
  for (const date of dates) {
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockTradingDailyReport&data_id=${stockId}&start_date=${date}&token=${TOKEN}`;
    const res = await fetchJSON(url);
    const rows = res.data || [];
    if (rows.length) {
      const dayChip = aggregateDay(rows);
      newChips.push({ date, ...dayChip });
      process.stdout.write(`    ${date}: 外資淨${dayChip.foreign_net >= 0 ? '+' : ''}${dayChip.foreign_net}張\n`);
    }
    await sleep(600);
  }

  if (!newChips.length && !Object.keys(newPriceMap).length) {
    console.log(`    無新資料`);
    return false;
  }

  // 合併現有 + 新資料（以 date 為 key，新資料覆蓋舊資料）
  const priceMap = {}, chipMap = {};
  if (existing) {
    existing.prices.forEach(p => priceMap[p.date] = p);
    existing.chips.forEach(c  => chipMap[c.date]  = c);
  }
  Object.assign(priceMap, newPriceMap);
  newChips.forEach(c => chipMap[c.date] = c);

  const prices = Object.values(priceMap).sort((a,b) => a.date.localeCompare(b.date));
  const chips  = Object.values(chipMap ).sort((a,b) => a.date.localeCompare(b.date));

  const output = {
    stockId,
    startDate: prices[0]?.date || chips[0]?.date,
    endDate:   prices.at(-1)?.date || chips.at(-1)?.date,
    prices, chips,
  };
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  return true; // 有更新
}

async function main() {
  const indexFile = path.join(DATA_DIR, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const stocks = index.stocks;

  console.log(`\n更新 ${stocks.length} 支股票...\n`);

  let updatedCount = 0;
  for (const { id, name } of stocks) {
    console.log(`[${name} ${id}]`);
    const updated = await updateStock(id);
    if (updated) updatedCount++;
    console.log();
  }

  if (updatedCount === 0) {
    console.log('所有持股已是最新，無需 commit。');
    return;
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  console.log(`\n更新 ${updatedCount} 支，執行 git commit...`);

  if (DRY) {
    console.log('（--dry 模式，略過 commit/push）');
    return;
  }

  try {
    execSync('git add data/', { cwd: __dirname, stdio: 'inherit' });
    execSync('git pull --rebase', { cwd: __dirname, stdio: 'inherit' });
    execSync(`git commit -m "data: auto-update ${dateStr}"`, { cwd: __dirname, stdio: 'inherit' });
    execSync('git push', { cwd: __dirname, stdio: 'inherit' });
    console.log('\n✓ 已 push 到 GitHub');
  } catch(e) {
    console.error('git 操作失敗:', e.message);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
