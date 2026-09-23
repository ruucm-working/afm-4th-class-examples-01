#!/usr/bin/env node
// 회차 스냅샷 — 지갑 · 시세/지표 · 시장 맥락 · 뉴스 · 내 최근 기록을 한 파일로 모은다.
// 사용:  node common/snapshot.mjs --agent <에이전트 폴더> [--cycle <id>] [--quiet] [--no-context] [--stdout]
// 출력:  <에이전트>/runs/<cycleId>/snapshot.json · snapshot.md   (--quiet 면 cycleId 만 출력)

import fs from 'node:fs';
import path from 'node:path';
import {
  resolveAgentDir, loadPolicy, cycleIdFrom, kst, nowIso, asOf, openVenue, marketSnapshot, contextSnapshot,
  readJournal, readEquity, renderSnapshotMd, DEFAULT_NEWS_SOURCES,
} from './lib.mjs';

const argv = process.argv;
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const agentDir = resolveAgentDir(argv);
const policy = loadPolicy(agentDir);
const cycleId = opt('--cycle') || cycleIdFrom();
const runDir = path.join(agentDir, 'runs', cycleId);
fs.mkdirSync(runDir, { recursive: true });

const venue = openVenue(policy, { dryRun: policy.dryRun });   // 재현 모드(LEAGUE_ASOF)면 db.json 직접 · 시세/맥락도 그 시각 기준

let wallet;
try {
  wallet = await venue.wallet();
} catch (e) {
  console.error(`장부(${policy.venueUrl})를 읽지 못했습니다: ${e.message}\n→ 장부를 못 읽는 회차는 주문하지 않는다 (리그 규칙). 회차를 중단합니다.`);
  process.exit(2);
}

const market = await marketSnapshot(policy.markets);
const byMarket = Object.fromEntries(market.map((m) => [m.market, m]));
const context = flag('--no-context')
  ? { fearGreed: { ok: false, error: 'skipped' }, usdkrw: { ok: false, error: 'skipped' }, binance: { ok: false, error: 'skipped' }, kimchiPremium: null, news: [] }
  : await contextSnapshot({ upbitBtc: byMarket['KRW-BTC']?.price, upbitEth: byMarket['KRW-ETH']?.price, newsSources: policy.newsSources || DEFAULT_NEWS_SOURCES });

const snapshot = {
  cycleId, agent: policy.id, ts: nowIso(), kst: kst(), venueUrl: policy.venueUrl, dryRun: policy.dryRun,
  replay: asOf() ? { asOf: asOf().toISOString(), venueDb: process.env.LEAGUE_VENUE_DB, note: '재현 회차 — 시세·지표·맥락·뉴스·장부를 이 시각 기준으로 되돌려 만든 스냅샷' } : null,
  wallet, market, context,
  recentJournal: readJournal(agentDir, 5),
  equity: readEquity(agentDir, 8),
  policy: {
    maxWeightPerMarket: policy.maxWeightPerMarket, maxGrossExposure: policy.maxGrossExposure, cashFloor: policy.cashFloor,
    maxOrdersPerCycle: policy.maxOrdersPerCycle, maxTurnoverPerDay: policy.maxTurnoverPerDay, minTradeKRW: policy.minTradeKRW,
    rebalanceBand: policy.rebalanceBand, drawdownHaltPct: policy.drawdownHaltPct, dailyLossHaltPct: policy.dailyLossHaltPct,
  },
};

fs.writeFileSync(path.join(runDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
const md = renderSnapshotMd(snapshot);
fs.writeFileSync(path.join(runDir, 'snapshot.md'), md);

if (flag('--stdout')) process.stdout.write(md);
else if (flag('--quiet')) process.stdout.write(cycleId + '\n');
else {
  console.log(`스냅샷 저장: ${path.relative(process.cwd(), path.join(runDir, 'snapshot.md'))}${snapshot.replay ? ` (재현 · 기준 ${snapshot.kst} KST)` : ''}`);
  console.log(`- 회차 ${cycleId} · 총자산 ${Math.round(wallet.total).toLocaleString('ko-KR')}원 · 현금 ${Math.round(wallet.cash).toLocaleString('ko-KR')}원 · 보유 ${wallet.positions.length}종목`);
  console.log(`- 시세 ${market.length}종목 · 뉴스 ${context.news.reduce((a, n) => a + n.items.length, 0)}건 · 공포탐욕 ${context.fearGreed.ok ? context.fearGreed.data[0].value : '실패'} · 바이낸스 ${context.binance.ok ? 'ok' : '실패'}`);
}
