#!/usr/bin/env node
// 규칙 엔진 — 스냅샷 숫자만으로 "규칙이 제안하는 목표 비중"을 계산한다 (LLM 은 이 제안을 검토하고 줄일 수만 있다).
// 사용:  node common/signals.mjs --agent <에이전트 폴더> --cycle <cycleId>
// 입력:  <에이전트>/strategy.json (전략 파라미터) · runs/<cycleId>/snapshot.json
// 출력:  runs/<cycleId>/signals.json · signals.md   (stdout 에도 Markdown)
//
// 전략 두 가지
//  trend  — 추세추종 + 변동성 역가중.  trend=up 이고 7일·30일 수익률이 양수인 종목만, 모멘텀 점수 순으로, 1/변동성 가중
//  keeper — 위험균형(리스크 패리티) 코어. trend=down 이 아닌 종목을 1/변동성 가중, 포트폴리오 일변동성 목표에 맞춰 총노출을 정한다
// 둘 다: 종목당·총노출 상한(policy.json) 안에서, 공포탐욕·손실 사다리로 노출을 줄인다. 숫자는 전부 스냅샷에서 온다.

import fs from 'node:fs';
import path from 'node:path';
import { resolveAgentDir, loadPolicy, pct, krw } from './lib.mjs';

const argv = process.argv;
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const agentDir = resolveAgentDir(argv);
const policy = loadPolicy(agentDir);
const cycleId = opt('--cycle');
if (!cycleId) { console.error('--cycle <cycleId> 가 필요합니다'); process.exit(2); }
const runDir = path.join(agentDir, 'runs', cycleId);
const snapPath = path.join(runDir, 'snapshot.json');
if (!fs.existsSync(snapPath)) { console.error(`스냅샷 없음: ${snapPath} (snapshot.mjs 를 먼저)`); process.exit(2); }
const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));

const stratPath = path.join(agentDir, 'strategy.json');
const S = fs.existsSync(stratPath) ? JSON.parse(fs.readFileSync(stratPath, 'utf8')) : {};
const strategy = S.strategy || 'trend';
const P = {
  // 공통
  targetDailyVol: S.targetDailyVol ?? 0.015,      // 포트폴리오 일변동성 목표 (상관 1 가정 → 보수적)
  minWeight: S.minWeight ?? 0.05,                  // 이보다 작은 비중은 0 으로 (먼지 방지)
  greedCut: S.greedCut ?? { 80: 0.7, 90: 0.5 },    // 공포탐욕 지수 ≥ 키 → 총노출 배율
  fearBoost: S.fearBoost ?? 1.0,                   // 극단적 공포 때 배율 (기본 1 = 추가 매수 없음)
  ddLadder: S.ddLadder ?? { '-0.03': 0.6, '-0.05': 0.3 },   // 시작 대비 손실 ≤ 키 → 총노출 배율 (손실 제동은 policy 가 따로)
  maxRsi: S.maxRsi ?? 80,                          // RSI14(1h) 이 이 이상이면 신규 편입 금지 (과열)
  minVolumeRatio: S.minVolumeRatio ?? 0.6,         // 24h 거래대금 ÷ 7일 평균 하한 (유동성 없는 급등 배제)
  // trend 전용
  momentumWeights: S.momentumWeights ?? { ret7d: 0.5, ret30d: 0.3, ret24h: 0.2 },
  maxPositions: S.maxPositions ?? 3,
  // keeper 전용
  allowMixed: S.allowMixed ?? true,                // trend=mixed 도 코어에 포함
};

const rows = [];
const notes = [];
const equity = snap.wallet.total;
const ddFromStart = equity / snap.wallet.startCash - 1;
const fng = snap.context?.fearGreed?.ok ? snap.context.fearGreed.data[0].value : null;

// ── 1. 종목별 적격성
for (const m of snap.market) {
  const r = { market: m.market, trend: m.trend, ret24h: m.ret24h, ret7d: m.ret7d, ret30d: m.ret30d, rsi: m.rsi14_1h, vol: m.dailyVol20, volumeRatio: m.volumeRatio24h, eligible: false, why: [] };
  if (!m.dailyVol20 || m.dailyVol20 <= 0) { r.why.push('변동성 계산 불가'); rows.push(r); continue; }
  if (strategy === 'trend') {
    if (m.trend !== 'up') r.why.push(`추세 ${m.trend} (up 아님)`);
    if (!(m.ret7d > 0)) r.why.push(`7d ${pct(m.ret7d)} ≤ 0`);
    if (!(m.ret30d > 0)) r.why.push(`30d ${pct(m.ret30d)} ≤ 0`);
  } else {
    if (m.trend === 'down') r.why.push('추세 down');
    if (!P.allowMixed && m.trend === 'mixed') r.why.push('추세 mixed 제외');
  }
  if (m.rsi14_1h !== null && m.rsi14_1h >= P.maxRsi) r.why.push(`RSI ${m.rsi14_1h.toFixed(0)} ≥ ${P.maxRsi} 과열`);
  if (m.volumeRatio24h !== null && m.volumeRatio24h < P.minVolumeRatio) r.why.push(`거래대금비 ${m.volumeRatio24h.toFixed(2)}x < ${P.minVolumeRatio}`);
  r.eligible = r.why.length === 0;
  if (r.eligible) r.why.push('적격');
  rows.push(r);
}

// ── 2. 순위·가중
let picks = rows.filter((r) => r.eligible);
if (strategy === 'trend') {
  const w = P.momentumWeights;
  for (const r of picks) r.score = (w.ret7d * (r.ret7d ?? 0)) + (w.ret30d * (r.ret30d ?? 0)) + (w.ret24h * (r.ret24h ?? 0));
  picks.sort((a, b) => b.score - a.score);
  picks = picks.slice(0, P.maxPositions);
}
// 변동성 역가중 (1/vol), 정규화
const invSum = picks.reduce((a, r) => a + 1 / r.vol, 0);
for (const r of picks) r.rawWeight = invSum ? (1 / r.vol) / invSum : 0;

// ── 3. 총노출: 변동성 목표 → 상한 → 공포탐욕 → 손실 사다리
let gross = 0;
if (picks.length) {
  const portVolAtFull = picks.reduce((a, r) => a + r.rawWeight * r.vol, 0);   // 상관 1 가정
  gross = Math.min(policy.maxGrossExposure, P.targetDailyVol / portVolAtFull);
  notes.push(`변동성 목표 ${pct(P.targetDailyVol)} ÷ 가중평균 일변동성 ${pct(portVolAtFull)} → 총노출 ${pct(gross, 0)} (상한 ${pct(policy.maxGrossExposure, 0)})`);
  if (fng !== null) {
    for (const [k, mult] of Object.entries(P.greedCut).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      if (fng >= Number(k)) { gross *= mult; notes.push(`공포탐욕 ${fng} ≥ ${k} → 총노출 ×${mult}`); }
    }
    if (fng <= 20 && P.fearBoost !== 1) { gross *= P.fearBoost; notes.push(`공포탐욕 ${fng} ≤ 20 → 총노출 ×${P.fearBoost}`); }
  }
  for (const [k, mult] of Object.entries(P.ddLadder).sort((a, b) => Number(b[0]) - Number(a[0]))) {
    if (ddFromStart <= Number(k)) { gross *= mult; notes.push(`시작 대비 ${pct(ddFromStart)} ≤ ${pct(Number(k), 0)} → 총노출 ×${mult}`); }
  }
  gross = Math.min(gross, 1 - policy.cashFloor);
} else notes.push('적격 종목 없음 → 전액 현금');

// ── 4. 종목별 목표 비중 (종목당 상한·최소 비중)
const targetWeights = {};
let assigned = 0;
for (const r of picks) {
  let w = Math.min(r.rawWeight * gross, policy.maxWeightPerMarket);
  if (w < P.minWeight) w = 0;
  r.weight = Math.round(w * 1000) / 1000;
  if (r.weight > 0) { targetWeights[r.market] = r.weight; assigned += r.weight; }
}
// 상한에 걸려 남은 노출은 재분배하지 않는다 (단순·보수적)

const out = {
  cycleId, agent: policy.id, strategy, kst: snap.kst, params: P,
  equity, ddFromStart, fearGreed: fng,
  rows, notes, targetWeights, grossTarget: Math.round(assigned * 1000) / 1000, cashTarget: Math.round((1 - assigned) * 1000) / 1000,
};
fs.writeFileSync(path.join(runDir, 'signals.json'), JSON.stringify(out, null, 2));

const L = [];
L.push(`# 규칙 엔진 제안 — ${cycleId} · ${policy.id} · 전략 ${strategy}`);
L.push(`총자산 ${krw(equity)} · 시작 대비 ${pct(ddFromStart)} · 공포탐욕 ${fng ?? '—'}`);
L.push('');
L.push('| 종목 | 추세 | 24h | 7d | 30d | RSI | 일변동성 | 거래대금비 | 판정 | 목표 비중 |');
L.push('|---|---|---:|---:|---:|---:|---:|---:|---|---:|');
for (const r of rows) L.push(`| ${r.market.replace('KRW-', '')} | ${r.trend} | ${pct(r.ret24h)} | ${pct(r.ret7d)} | ${pct(r.ret30d)} | ${r.rsi?.toFixed(0) ?? '—'} | ${pct(r.vol)} | ${r.volumeRatio?.toFixed(2) ?? '—'}x | ${r.why.join(' · ')} | ${r.weight ? pct(r.weight, 1) : '0%'} |`);
L.push('');
L.push(`**제안 목표 비중:** ${Object.keys(targetWeights).length ? Object.entries(targetWeights).map(([m, w]) => `${m.replace('KRW-', '')} ${pct(w, 1)}`).join(' · ') : '없음'} → 코인 ${pct(assigned, 1)} · 현금 ${pct(1 - assigned, 1)}`);
L.push('');
L.push('계산 메모:');
for (const n of notes) L.push(`- ${n}`);
L.push('');
L.push('이 제안은 규칙(strategy.json · policy.json)만으로 나온 숫자다. 에이전트는 이 비중을 **줄이거나 관망으로 바꿀 수만** 있고, 늘리거나 목록에 없는 종목을 넣을 수 없다.');
const md = L.join('\n') + '\n';
fs.writeFileSync(path.join(runDir, 'signals.md'), md);
process.stdout.write(md);
