#!/usr/bin/env node
// 결정 실행 — decision.json → 주문 변환 → 정책 검사 → 장부에 주문 → journal/equity/daily 기록.
// 사용:  node common/execute.mjs --agent <에이전트 폴더> --cycle <cycleId> [--decision <path>] [--dry-run]
// 같은 cycleId 가 journal 에 이미 있으면 아무것도 하지 않는다 (중복 실행 방지).

import fs from 'node:fs';
import path from 'node:path';
import {
  resolveAgentDir, loadPolicy, asOf, openVenue, fetchTicker, decisionToOrders, riskCheck,
  readJournal, appendJournal, appendEquity, appendDailyNote, memoryPaths, kst, nowIso, krw, pct,
} from './lib.mjs';

const argv = process.argv;
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const agentDir = resolveAgentDir(argv);
const policy = loadPolicy(agentDir);
const cycleId = opt('--cycle');
if (!cycleId) { console.error('--cycle <cycleId> 가 필요합니다'); process.exit(2); }
const dryRun = policy.dryRun || flag('--dry-run');
const runDir = path.join(agentDir, 'runs', cycleId);
const decisionPath = path.resolve(agentDir, opt('--decision') || path.join('runs', cycleId, 'decision.json'));

const STANCES = new Set(['risk-on', 'neutral', 'risk-off', 'hold']);

function finish(entry) {
  if (asOf()) entry.replay = true;   // 재현 회차 표시 — 현황판·대시보드가 실시간 회차와 구분한다
  appendJournal(agentDir, entry);
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(entry, null, 2));
  console.log(JSON.stringify(entry, null, 2));
}

const already = readJournal(agentDir, 500).find((j) => j.cycleId === cycleId);
if (already) {
  console.log(JSON.stringify({ cycleId, status: 'already-executed', at: already.kst }, null, 2));
  process.exit(0);
}
fs.mkdirSync(runDir, { recursive: true });

// 결정 파일이 없으면 "결정 없음" 으로 기록하고 끝낸다 — 관망(hold)과는 다른 상태다.
if (!fs.existsSync(decisionPath)) {
  const venue = openVenue(policy, { dryRun: true });
  let wallet = null;
  try { wallet = await venue.wallet(); } catch {}
  finish({
    ts: nowIso(), kst: kst(), cycleId, agent: policy.id, stance: 'no-decision', status: 'no-decision',
    equityBefore: wallet?.total ?? null, equityAfter: wallet?.total ?? null, proposed: [], results: [], flags: ['decision.json 없음 — 에이전트가 결정을 내지 못했다'],
    rationale: '', dryRun,
  });
  if (wallet) appendEquity(agentDir, wallet, cycleId);
  appendDailyNote(agentDir, `- ${kst().slice(11, 16)} [${cycleId}] ⚠ 결정 파일 없음 (실행 실패로 기록)`);
  process.exit(0);
}

let decision;
try { decision = JSON.parse(fs.readFileSync(decisionPath, 'utf8')); }
catch (e) { console.error(`decision.json 파싱 실패: ${e.message}`); process.exit(2); }
if (decision.cycleId && decision.cycleId !== cycleId) {
  console.error(`decision.cycleId(${decision.cycleId}) 가 --cycle(${cycleId}) 과 다릅니다`); process.exit(2);
}
const stance = STANCES.has(decision.stance) ? decision.stance : 'neutral';

const venue = openVenue(policy, { dryRun });   // 재현 모드(LEAGUE_ASOF)면 db.json 에 그 시각 가격으로 직접 체결
const walletBefore = await venue.wallet();
const prices = await fetchTicker(policy.markets);

let converted;
try { converted = decisionToOrders(decision, walletBefore, prices, policy); }
catch (e) {
  finish({
    ts: nowIso(), kst: kst(), cycleId, agent: policy.id, stance, status: 'invalid-decision',
    equityBefore: walletBefore.total, equityAfter: walletBefore.total, proposed: [], results: [], flags: [String(e.message)],
    rationale: decision.rationale || '', dryRun,
  });
  process.exit(0);
}

const check = riskCheck({ orders: converted.orders, wallet: walletBefore, prices, policy, agentDir });
const results = [];
let n = 0;
for (const o of check.approved) {
  n++;
  const cid = `${cycleId}/${n}`;
  const memo = `[${policy.id}] ${o.side === 'buy' ? '매수' : '매도'} · ${String(o.reason || decision.rationale || '').replace(/\s+/g, ' ').slice(0, 200)}`;
  try {
    const r = await venue.placeOrder({ market: o.market, side: o.side, amount: o.amount, memo, cid });
    results.push({
      market: o.market, side: o.side, amount: o.amount, krw: Math.round(o.krw), status: r.status,
      orderId: r.order?.id ?? null, price: r.order?.price ?? o.price, error: r.error ?? null, cid,
    });
  } catch (e) {
    results.push({ market: o.market, side: o.side, amount: o.amount, krw: Math.round(o.krw), status: 'failed', error: String(e.message), cid });
  }
}
for (const r of check.rejected) results.push({ market: r.market, side: r.side, amount: r.amount ?? null, krw: r.krw ? Math.round(r.krw) : null, status: 'rejected', reason: r.reason });

let walletAfter = walletBefore;
if (!dryRun && check.approved.length) {
  try { walletAfter = await venue.wallet(); } catch {}
}

const status = check.approved.length === 0 && check.rejected.length === 0 ? 'hold'
  : results.some((r) => r.status === 'filled') ? 'executed'
  : results.some((r) => r.status === 'dry-run') ? 'dry-run'
  : results.some((r) => r.status === 'failed') ? 'failed' : 'all-rejected';

const entry = {
  ts: nowIso(), kst: kst(), cycleId, agent: policy.id, stance, status, dryRun,
  equityBefore: walletBefore.total, equityAfter: walletAfter.total,
  cashRatioAfter: walletAfter.cash / walletAfter.total,
  proposed: converted.orders.map((o) => ({ market: o.market, side: o.side, krw: o.krw ? Math.round(o.krw) : null, amount: o.amount ?? null })),
  results, flags: [...check.flags, ...converted.notes],
  rationale: String(decision.rationale || '').slice(0, 1000),
  evidence: Array.isArray(decision.evidence) ? decision.evidence.slice(0, 12).map((e) => String(e).slice(0, 300)) : [],
  confidence: typeof decision.confidence === 'number' ? decision.confidence : null,
  horizonHours: decision.horizonHours ?? null,
  invalidation: decision.invalidation ? String(decision.invalidation).slice(0, 300) : null,
  risk: check.summary,
};
finish(entry);
appendEquity(agentDir, walletAfter, cycleId);

// 판단 일지 — 결과가 나온 뒤 이유를 바꿔 쓰지 못하도록 결정 시점의 문장을 그대로 남긴다
const acts = results.map((r) => `${r.market.replace('KRW-', '')} ${r.side} ${r.krw ? krw(r.krw) : ''} ${r.status}${r.reason ? `(${r.reason})` : ''}`).join(', ') || '주문 없음';
appendDailyNote(agentDir, [
  `- ${kst().slice(11, 16)} [${cycleId}] **${stance}** · ${status} · 자산 ${krw(walletBefore.total)} → ${krw(walletAfter.total)} · 현금 ${pct(entry.cashRatioAfter, 0)}`,
  `  - 실행: ${acts}`,
  decision.memoryNote ? `  - 메모: ${String(decision.memoryNote).replace(/\s+/g, ' ').slice(0, 400)}` : null,
  entry.invalidation ? `  - 무효화 조건: ${entry.invalidation}` : null,
].filter(Boolean).join('\n'));

// 교훈 후보 — 정책을 바꾸지 않는다. lessons.md 의 "후보" 절에만 쌓고 사람이 검토한다.
if (decision.lessonCandidate) {
  const lp = memoryPaths(agentDir).lessons;
  if (!fs.existsSync(lp)) fs.writeFileSync(lp, '# 교훈\n\n## 확정 (사람이 검토해 옮긴 것)\n\n## 후보 (에이전트가 제안 · 검증 전)\n\n');
  fs.appendFileSync(lp, `- ${kst().slice(0, 16)} [${cycleId}] ${String(decision.lessonCandidate).replace(/\s+/g, ' ').slice(0, 400)}\n`);
}
