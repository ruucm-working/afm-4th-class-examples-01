#!/usr/bin/env node
// 회고 자료 — 자산 추이 · 최대낙폭 · 주문 통계 · 최근 판단 이유를 Markdown 으로 뽑는다 (LLM 의 /reflect 입력).
// 사용:  node common/review.mjs --agent <에이전트 폴더> [--days 7]

import { resolveAgentDir, loadPolicy, readJournal, readEquity, Venue, krw, pct, kst } from './lib.mjs';

const argv = process.argv;
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const agentDir = resolveAgentDir(argv);
const policy = loadPolicy(agentDir);
const days = Number(opt('--days') || 7);

const eq = readEquity(agentDir, 5000).filter((e) => Date.now() - new Date(e.ts).getTime() <= days * 86400000);
const journal = readJournal(agentDir, 5000).filter((j) => Date.now() - new Date(j.ts).getTime() <= days * 86400000);

let wallet = null;
try { wallet = await new Venue(policy.venueUrl).wallet(); } catch {}

const L = [];
L.push(`# 회고 자료 — ${policy.id} · 최근 ${days}일 · ${kst()}`);
L.push('');
if (wallet) {
  L.push(`## 지금 지갑`);
  L.push(`- 총자산 ${krw(wallet.total)} · 시작 ${krw(wallet.startCash)} · 수익률 ${pct(wallet.profitRate)} · 현금 ${pct(wallet.cash / wallet.total, 0)} · 보유 ${wallet.positions.map((p) => `${p.market.replace('KRW-', '')} ${pct(p.value / wallet.total, 0)}(${pct(p.pnlRate)})`).join(', ') || '없음'}`);
  L.push('');
}
if (eq.length) {
  let peak = -Infinity, mdd = 0;
  for (const e of eq) { peak = Math.max(peak, e.total); mdd = Math.min(mdd, e.total / peak - 1); }
  const first = eq[0], last = eq.at(-1);
  L.push('## 자산 추이');
  L.push(`- 기록 ${eq.length}개 · ${first.kst.slice(0, 16)} ${krw(first.total)} → ${last.kst.slice(0, 16)} ${krw(last.total)} (${pct(last.total / first.total - 1)}) · 최고 ${krw(Math.max(...eq.map((e) => e.total)))} · 최저 ${krw(Math.min(...eq.map((e) => e.total)))} · 최대낙폭 ${pct(mdd)}`);
  L.push('');
}
const byStatus = {};
const byMarket = {};
for (const j of journal) {
  byStatus[j.status] = (byStatus[j.status] || 0) + 1;
  for (const r of j.results || []) {
    const k = `${r.market} ${r.side}`;
    byMarket[k] ??= { filled: 0, rejected: 0, failed: 0, krw: 0 };
    if (r.status === 'filled') { byMarket[k].filled++; byMarket[k].krw += r.krw || 0; }
    else if (r.status === 'rejected') byMarket[k].rejected++;
    else if (r.status === 'failed') byMarket[k].failed++;
  }
}
L.push('## 회차 결과');
L.push(`- 회차 ${journal.length}개 · ${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(' · ') || '없음'}`);
if (Object.keys(byMarket).length) {
  L.push('');
  L.push('| 종목·방향 | 체결 | 거절 | 실패 | 체결 금액 |');
  L.push('|---|---:|---:|---:|---:|');
  for (const [k, v] of Object.entries(byMarket)) L.push(`| ${k} | ${v.filled} | ${v.rejected} | ${v.failed} | ${krw(v.krw)} |`);
}
L.push('');
L.push('## 거절·축소 사유 (정책이 막은 것 — 정책이 옳았는지, 결정이 무리였는지 구분해서 본다)');
const reasons = {};
for (const j of journal) {
  for (const r of j.results || []) if (r.status === 'rejected') reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  for (const f of j.flags || []) reasons[f] = (reasons[f] || 0) + 1;
}
for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 12)) L.push(`- ${v}회 · ${k}`);
if (!Object.keys(reasons).length) L.push('- 없음');
L.push('');
L.push('## 최근 판단 (결정 시점 문장 그대로)');
for (const j of journal.slice(-10)) {
  L.push(`- ${j.kst} [${j.cycleId}] ${j.stance} · ${j.status} · ${krw(j.equityBefore)} → ${krw(j.equityAfter)} · 확신 ${j.confidence ?? '—'}`);
  L.push(`  - 이유: ${String(j.rationale || '').slice(0, 300)}`);
  if (j.invalidation) L.push(`  - 무효화 조건: ${j.invalidation}`);
}
if (!journal.length) L.push('- 기록 없음');
process.stdout.write(L.join('\n') + '\n');
