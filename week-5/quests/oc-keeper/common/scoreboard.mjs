#!/usr/bin/env node
// 리그 현황판 — 각 에이전트의 장부를 읽어 표(markdown)와 대시보드 JSON 을 만든다.
// 사용:  node common/scoreboard.mjs [--venues league/venues.json] [--write] [--board [경로]]
//   --write  league/scoreboard.md 갱신 + league/equity-history.jsonl 에 자산 표시 한 줄 추가
//   --board  moa 대시보드용 JSON 을 venues.json 의 board.path(또는 준 경로)에 쓴다
//            — 페이지 afm4-league-agents 맨 위의 <LeagueBoard>(moa-docs/src/league-board.jsx) 가 60초마다 읽는다.
//            --write 와 같이 주면 방금 추가한 표시까지 history 에 들어간다. league/board.sh 가 5분 타이머로 둘 다 준다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Venue, krw, pct, kst, nowIso, readJournal } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const argv = process.argv;
const has = (f) => argv.includes(f);
const optVal = (f) => { const i = argv.indexOf(f); const v = i >= 0 ? argv[i + 1] : null; return v && !v.startsWith('--') ? v : null; };
const venuesPath = path.resolve(optVal('--venues') || path.join(root, 'league', 'venues.json'));
const cfg = JSON.parse(fs.readFileSync(venuesPath, 'utf8'));
const outDir = path.dirname(venuesPath);
const historyPath = path.join(outDir, 'equity-history.jsonl');

const cidOf = (memo) => (typeof memo === 'string' && /\[cid:([^\]]+)\]/.exec(memo)?.[1]) || null;

// 에이전트 폴더의 회차 수와 마지막 회차 (runs/latest → result.json · decision.json · journal) — 없으면 null
function runsOf(agent) {
  try {
    const runs = path.join(root, agent, 'runs');
    const ids = fs.readdirSync(runs).filter((d) => /^\d{8}-\d{4}$/.test(d)).sort();
    let latest = null;
    try { latest = path.basename(fs.readlinkSync(path.join(runs, 'latest'))); } catch { latest = ids.at(-1) || null; }
    if (!latest) return { runs: ids.length, lastRun: null };
    const rd = (f) => { try { return JSON.parse(fs.readFileSync(path.join(runs, latest, f), 'utf8')); } catch { return null; } };
    const res = rd('result.json'), dec = rd('decision.json');
    const j = readJournal(path.join(root, agent), 10).find((x) => x.cycleId === latest) || null;
    return {
      runs: ids.length,
      lastRun: {
        cycleId: latest, status: res?.status ?? null, stance: dec?.stance ?? null, confidence: dec?.confidence ?? null,
        filled: j ? (j.results || []).filter((r) => r.status === 'filled').length : null,
        kst: j?.kst ?? null,
      },
    };
  } catch { return { runs: 0, lastRun: null }; }
}

const rows = [];
for (const v of cfg.venues) {
  const url = v.url || `http://127.0.0.1:${v.port}`;
  const base = { agent: v.agent, runtime: v.runtime || '', url, ...runsOf(v.agent) };
  try {
    const venue = new Venue(url);
    const w = await venue.wallet();
    let orders = [];   // 최신순 (서버가 뒤집어 준다)
    try { orders = await venue.orders(500); } catch {}
    // 무단 주문 검출 — execute.mjs 가 낸 주문은 메모에 반드시 [cid:<회차>/<n>] 이 있다. 없는 주문은 에이전트(또는 사람)가 장부를 직접 건드린 것이다.
    const rogue = orders.filter((o) => !cidOf(o.memo)).length;
    rows.push({
      ...base, ok: true,
      total: w.total, cash: w.cash, holdingValue: w.holdingValue, startCash: w.startCash, profitRate: w.profitRate,
      orders: w.orderCount, rogue, priceError: w.priceError ?? null,
      positions: (w.positions || []).map((p) => ({ ...p, weight: w.total ? p.value / w.total : 0 })),
      recentOrders: orders.slice(0, 20).map((o) => ({ id: o.id, at: o.created_at, market: o.market, side: o.side, amount: o.amount, price: o.price, krw: Math.round(o.amount * o.price), cid: cidOf(o.memo) })),
    });
  } catch (e) {
    rows.push({ ...base, ok: false, error: String(e.message).slice(0, 80) });
  }
}
const posStr = (r) => r.positions.map((p) => `${p.market.replace('KRW-', '')} ${pct(p.weight, 0)}`).join(' · ') || '현금 100%';
const ranked = [...rows].sort((a, b) => (b.total ?? -Infinity) - (a.total ?? -Infinity));

const L = [];
L.push(`# 리그 현황판 — ${kst()} (KST)`);
L.push('');
L.push('| 순위 | 에이전트 | 런타임 | 총자산 | 수익률 | 현금 | 보유 | 주문 수 | 무단 주문 |');
L.push('|---:|---|---|---:|---:|---:|---|---:|---:|');
ranked.forEach((r, i) => {
  if (r.ok) L.push(`| ${i + 1} | ${r.agent} | ${r.runtime} | ${krw(r.total)} | ${pct(r.profitRate)} | ${pct(r.cash / r.total, 0)} | ${posStr(r)} | ${r.orders} | ${r.rogue ? `⚠ ${r.rogue}` : '0'} |`);
  else L.push(`| — | ${r.agent} | ${r.runtime} | 장부 응답 없음 | | | ${r.error} | | |`);
});
L.push('');
L.push('모의투자 연습용 · 시작 자본은 각 장부의 startCash · 수익률 = 총자산 ÷ 시작자본 − 1 · 무단 주문 = 메모에 [cid:…] 이 없는 주문 (운영 코드가 아닌 곳에서 낸 것 → 규칙 위반으로 본다)');
const md = L.join('\n') + '\n';
process.stdout.write(md);

if (has('--write')) {
  fs.writeFileSync(path.join(outDir, 'scoreboard.md'), md);
  fs.appendFileSync(historyPath, JSON.stringify({ ts: nowIso(), kst: kst(), rows: rows.map((r) => ({ agent: r.agent, ok: r.ok, total: r.total ?? null, profitRate: r.profitRate ?? null })) }) + '\n');
}

// ────────────────────────────── 대시보드 JSON (moa 페이지가 읽는다)

function readHistory(max) {
  if (!fs.existsSync(historyPath)) return [];
  const lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-max).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

if (has('--board')) {
  const b = cfg.board || {};
  const boardPath = path.resolve(optVal('--board') || b.path || path.join(outDir, 'board.json'));
  const hist = readHistory(b.historyMax || 4032);   // 5분 간격 2주
  const agents = rows.map((r) => r.agent);
  const series = Object.fromEntries(agents.map((a) => [a, []]));
  const t = [];
  for (const h of hist) {
    const ts = Math.round(new Date(h.ts).getTime() / 1000);
    if (!Number.isFinite(ts)) continue;
    if (t.length && ts <= t[t.length - 1]) continue;   // 같은 초의 중복 표시(회차 끝 + 타이머)는 하나만
    t.push(ts);
    const byAgent = Object.fromEntries((h.rows || []).map((r) => [r.agent, r]));
    for (const a of agents) {
      const r = byAgent[a];
      series[a].push(r && r.ok && r.profitRate != null ? Math.round(r.profitRate * 100000) / 1000 : null);   // 퍼센트 · 소수 3자리
    }
  }
  const feed = rows.flatMap((r) => (r.recentOrders || []).map((o) => ({ ...o, agent: r.agent })))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 20);
  // 회차별 판단 기록 — 각 에이전트 journal.jsonl 에서 (최신순 · 최대 b.cyclesMax) · 페이지의 「회차별 판단」 표
  const cycles = rows.flatMap((r) => readJournal(path.join(root, r.agent), 200).map((j) => ({
    agent: r.agent, cycleId: j.cycleId, ts: j.ts, kst: j.kst, stance: j.stance, status: j.status, replay: !!j.replay, dryRun: !!j.dryRun,
    confidence: j.confidence ?? null, equityBefore: j.equityBefore ?? null, equityAfter: j.equityAfter ?? null, cashRatioAfter: j.cashRatioAfter ?? null,
    results: (j.results || []).map((x) => ({ market: x.market, side: x.side, krw: x.krw ?? null, status: x.status, reason: x.reason ?? null })),
    flags: (j.flags || []).slice(0, 4).map((f) => String(f).slice(0, 160)),
    rationale: String(j.rationale || '').slice(0, 600), invalidation: j.invalidation ? String(j.invalidation).slice(0, 300) : null,
  }))).sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || ''))).slice(0, b.cyclesMax || 120);
  const board = {
    generatedAt: nowIso(), kst: kst(), startCash: cfg.startCash ?? null, everyMin: b.everyMin || 5,
    replay: b.replay || null,   // { from, until, note } — 되돌려 돌린 구간 (league/backfill.sh 가 venues.json 에 적는다 · reset.sh 가 지운다)
    agents: rows.map((r) => ({
      agent: r.agent, runtime: r.runtime, ok: r.ok, error: r.error ?? null,
      total: r.total ?? null, cash: r.cash ?? null, holdingValue: r.holdingValue ?? null, startCash: r.startCash ?? null, profitRate: r.profitRate ?? null,
      orders: r.orders ?? null, rogue: r.rogue ?? null, priceError: r.priceError ?? null,
      positions: r.positions || [], runs: r.runs ?? 0, lastRun: r.lastRun ?? null,
    })),
    history: { t, series },
    orders: feed,
    cycles,
  };
  fs.mkdirSync(path.dirname(boardPath), { recursive: true });
  const tmp = boardPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(board));
  fs.renameSync(tmp, boardPath);   // 통째로 바꿔치기 — 읽는 쪽이 반쯤 쓰인 파일을 보지 않는다
  process.stderr.write(`board → ${boardPath} (표시 ${t.length}개 · 주문 ${feed.length}건 · 회차 ${cycles.length}건)\n`);
}
