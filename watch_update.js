#!/usr/bin/env node
/**
 * watch_update.js
 * 收盤後持續輪詢所有持股，直到當日籌碼全數更新，或超過安全終止時間
 *
 * 終止條件（優先順序）：
 * 1. 所有個股都有當日籌碼 → commit+push 後退出（成功）
 * 2. 現在時間 >= 20:00 → 有更新就 commit，退出（超時）
 * 3. 所有股票無當日 price（未開盤）且已跑 3 輪 → 退出（今日休市）
 *    ＊ 有任何一支有 price，代表今天有開盤，第 3 條不觸發
 *
 * 每輪結束後休息 5 分鐘再重試
 */

const fs   = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const DATA_DIR          = path.join(__dirname, 'data');
const SLEEP_MS          = 5 * 60 * 1000;  // 5 分鐘
const MAX_NO_MARKET_ITER = 3;
const CUTOFF_HOUR       = 20;              // 20:00 強制結束

function now()     { return new Date(); }
function timeStr() { return now().toLocaleTimeString('zh-TW', { hour12: false }); }
function todayISO() { return now().toISOString().slice(0, 10); }
function isPastCutoff() { return now().getHours() >= CUTOFF_HOUR; }
function log(msg)  { console.log(`[${timeStr()}] ${msg}`); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function stockStatus(id, todayDate) {
  const f = path.join(DATA_DIR, `${id}.json`);
  if (!fs.existsSync(f)) return { hasChip: false, hasPrice: false };
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  return {
    hasChip:  d.chips.some(c  => c.date  === todayDate),
    hasPrice: d.prices.some(p => p.date  === todayDate),
  };
}

function gitCommit(todayDate, partial = false) {
  const label = partial ? 'partial-update' : 'auto-update';
  try {
    execSync('git add data/', { cwd: __dirname, stdio: 'pipe' });
    execSync('git pull --rebase', { cwd: __dirname, stdio: 'inherit' });
    execSync(`git commit -m "data: ${label} ${todayDate}"`, { cwd: __dirname, stdio: 'pipe' });
    execSync('git push', { cwd: __dirname, stdio: 'inherit' });
    log(`✓ git push 完成`);
  } catch(e) {
    if (!e.stdout?.toString().includes('nothing to commit')) {
      log(`git 操作失敗: ${e.message}`);
    }
  }
}

async function main() {
  const index  = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'index.json'), 'utf8'));
  const stocks = index.stocks;

  log(`watch_update 啟動，監控 ${stocks.length} 支：${stocks.map(s => s.name).join('、')}`);
  log(`終止條件：全數更新 / 20:00 超時 / 休市 ${MAX_NO_MARKET_ITER} 輪`);

  let iter = 0;
  let noMarketIter = 0;

  while (true) {
    iter++;
    const todayDate = todayISO();
    log(`\n─── 第 ${iter} 輪更新 ───`);

    // 執行增量抓取（--dry = 只寫 JSON，不 commit）
    spawnSync('node', ['update_all.js', '--dry'], { cwd: __dirname, stdio: 'inherit' });

    // 檢查各股狀態
    const statuses = stocks.map(s => ({ ...s, ...stockStatus(s.id, todayDate) }));
    const anyHasPrice = statuses.some(s => s.hasPrice);
    const allHaveChip = statuses.every(s => s.hasChip);

    log('狀態：');
    for (const s of statuses) {
      const mark = s.hasChip ? '✓ 有籌碼' : (s.hasPrice ? '⏳ 有開盤，等籌碼' : '— 無資料');
      log(`  ${s.name} ${s.id}: ${mark}`);
    }

    // ── 終止條件 1：全部有籌碼 ──
    if (allHaveChip) {
      log('\n✓ 所有個股籌碼已是最新');
      gitCommit(todayDate);
      break;
    }

    // ── 終止條件 2：超過 20:00 ──
    if (isPastCutoff()) {
      log(`\n⚠ 已超過 ${CUTOFF_HOUR}:00，強制停止`);
      gitCommit(todayDate, true);
      break;
    }

    // ── 終止條件 3：無開盤且達上限輪次 ──
    if (!anyHasPrice) {
      noMarketIter++;
      log(`今日無 price 資料（${noMarketIter}/${MAX_NO_MARKET_ITER} 輪）`);
      if (noMarketIter >= MAX_NO_MARKET_ITER) {
        log('⚠ 今日應為休市，停止更新');
        break;
      }
    } else {
      noMarketIter = 0; // 有開盤就重置無市場計數
    }

    log(`等待 5 分鐘後重試...`);
    await sleep(SLEEP_MS);
  }

  log('watch_update 結束');
}

main().catch(e => { console.error(e); process.exit(1); });
