#!/usr/bin/env node
// decision.json 검사 — common/decision.schema.json 의 규칙을 손으로 옮긴 검사기 (의존성 없음).
// 사용:  node common/validate.mjs <decision.json 경로> [--cycle <cycleId>] [--policy <policy.json>]
// 종료:  0 = 유효 · 1 = 무효 (stderr 에 사유를 한 줄씩) · 2 = 파일 없음/파싱 실패
// Claude Code 의 Stop 훅과 각 에이전트 run.sh 가 같은 검사를 쓴다.

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const file = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--cycle' && argv[argv.indexOf(a) - 1] !== '--policy');
if (!file) { console.error('사용: node common/validate.mjs <decision.json> [--cycle <id>] [--policy <policy.json>]'); process.exit(2); }
if (!fs.existsSync(file)) { console.error(`파일 없음: ${file}`); process.exit(2); }

let d;
try { d = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { console.error(`JSON 파싱 실패: ${e.message}`); process.exit(2); }

const errors = [];
const err = (m) => errors.push(m);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const MARKET = /^KRW-[A-Z0-9]{2,20}$/;
const ALLOWED_TOP = new Set(['cycleId', 'stance', 'orders', 'targetWeights', 'rationale', 'evidence', 'confidence', 'horizonHours', 'invalidation', 'memoryNote', 'lessonCandidate']);
const ALLOWED_ORDER = new Set(['market', 'side', 'krw', 'amount', 'fraction', 'reason']);

if (!d || typeof d !== 'object' || Array.isArray(d)) { console.error('최상위가 객체가 아닙니다'); process.exit(1); }
for (const k of Object.keys(d)) if (!ALLOWED_TOP.has(k)) err(`허용되지 않은 키: ${k}`);
for (const k of ['cycleId', 'stance', 'rationale', 'evidence', 'confidence']) if (!(k in d)) err(`필수 키 없음: ${k}`);

if (typeof d.cycleId !== 'string' || !/^\d{8}-\d{4}$/.test(d.cycleId)) err('cycleId 는 "YYYYMMDD-HHmm" 문자열이어야 합니다');
const wantCycle = opt('--cycle');
if (wantCycle && d.cycleId !== wantCycle) err(`cycleId(${d.cycleId}) 가 이번 회차(${wantCycle}) 와 다릅니다`);
if (!['risk-on', 'neutral', 'risk-off', 'hold'].includes(d.stance)) err('stance 는 risk-on | neutral | risk-off | hold 중 하나');
if (typeof d.rationale !== 'string' || d.rationale.length < 20 || d.rationale.length > 1000) err('rationale 은 20~1000자 문자열');
if (!Array.isArray(d.evidence) || d.evidence.length < 1 || d.evidence.length > 12 || d.evidence.some((e) => typeof e !== 'string' || e.length > 300)) err('evidence 는 1~12개의 300자 이하 문자열 배열');
if (!isNum(d.confidence) || d.confidence < 0 || d.confidence > 1) err('confidence 는 0~1 숫자');
if ('horizonHours' in d && (!isNum(d.horizonHours) || d.horizonHours < 1 || d.horizonHours > 168)) err('horizonHours 는 1~168');
if ('invalidation' in d && (typeof d.invalidation !== 'string' || d.invalidation.length > 300)) err('invalidation 은 300자 이하 문자열');
if ('memoryNote' in d && (typeof d.memoryNote !== 'string' || d.memoryNote.length > 400)) err('memoryNote 는 400자 이하 문자열');
if ('lessonCandidate' in d && d.lessonCandidate !== null && (typeof d.lessonCandidate !== 'string' || d.lessonCandidate.length > 400)) err('lessonCandidate 는 400자 이하 문자열 또는 null');

const hasOrders = Array.isArray(d.orders) && d.orders.length > 0;
const hasWeights = d.targetWeights && typeof d.targetWeights === 'object' && Object.keys(d.targetWeights).length > 0;
if (hasOrders && hasWeights) err('orders 와 targetWeights 를 동시에 쓸 수 없습니다 (하나만)');

if ('orders' in d) {
  if (!Array.isArray(d.orders)) err('orders 는 배열');
  else {
    if (d.orders.length > 5) err('orders 는 최대 5개');
    d.orders.forEach((o, i) => {
      if (!o || typeof o !== 'object') return err(`orders[${i}] 는 객체`);
      for (const k of Object.keys(o)) if (!ALLOWED_ORDER.has(k)) err(`orders[${i}] 허용되지 않은 키: ${k}`);
      if (typeof o.market !== 'string' || !MARKET.test(o.market)) err(`orders[${i}].market 형식 오류 (예: KRW-BTC)`);
      if (!['buy', 'sell'].includes(o.side)) err(`orders[${i}].side 는 buy|sell`);
      if (typeof o.reason !== 'string' || !o.reason || o.reason.length > 200) err(`orders[${i}].reason 은 1~200자`);
      if ('krw' in o && (!isNum(o.krw) || o.krw <= 0)) err(`orders[${i}].krw 는 양수`);
      if ('amount' in o && (!isNum(o.amount) || o.amount <= 0)) err(`orders[${i}].amount 는 양수`);
      if ('fraction' in o && (!isNum(o.fraction) || o.fraction <= 0 || o.fraction > 1)) err(`orders[${i}].fraction 은 0 초과 1 이하`);
      if (o.side === 'buy' && !('krw' in o) && !('amount' in o)) err(`orders[${i}] 매수는 krw 또는 amount 필요`);
      if (o.side === 'sell' && !('amount' in o) && !('fraction' in o) && !('krw' in o)) err(`orders[${i}] 매도는 amount·fraction·krw 중 하나 필요`);
    });
  }
}

if ('targetWeights' in d) {
  const tw = d.targetWeights;
  if (!tw || typeof tw !== 'object' || Array.isArray(tw)) err('targetWeights 는 객체');
  else {
    let sum = 0;
    for (const [m, w] of Object.entries(tw)) {
      if (!MARKET.test(m)) err(`targetWeights 키 형식 오류: ${m}`);
      if (!isNum(w) || w < 0 || w > 1) err(`targetWeights[${m}] 는 0~1`);
      else sum += w;
    }
    if (sum > 1.0001) err(`targetWeights 합계 ${sum.toFixed(3)} > 1`);
  }
}

// 정책 파일이 있으면 허용 종목·비중 상한도 미리 본다 (실행 단계에서 어차피 축소·거절되지만, 여기서 알려 주면 에이전트가 고칠 수 있다)
const policyPath = opt('--policy') || path.join(path.dirname(path.resolve(file)), '..', '..', 'policy.json');
if (fs.existsSync(policyPath)) {
  try {
    const p = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    const markets = p.markets || [];
    const maxW = p.maxWeightPerMarket ?? 1;
    const maxG = p.maxGrossExposure ?? 1;
    if (hasOrders) for (const o of d.orders) if (markets.length && !markets.includes(String(o.market).toUpperCase())) err(`허용 종목 아님: ${o.market} (허용: ${markets.join(',')})`);
    if (hasWeights) {
      let g = 0;
      for (const [m, w] of Object.entries(d.targetWeights)) {
        if (markets.length && !markets.includes(m)) err(`허용 종목 아님: ${m}`);
        if (isNum(w) && w > maxW + 1e-9) err(`targetWeights[${m}]=${w} > 종목당 상한 ${maxW}`);
        g += isNum(w) ? w : 0;
      }
      if (g > maxG + 1e-9) err(`targetWeights 합계 ${g.toFixed(3)} > 총노출 상한 ${maxG}`);
    }
  } catch { /* 정책 파일이 깨졌으면 여기서는 무시 (loadPolicy 가 따로 실패한다) */ }
}

if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  process.exit(1);
}
const mode = hasOrders ? `orders ${d.orders.length}건` : hasWeights ? `targetWeights ${Object.keys(d.targetWeights).length}종목` : '관망(hold)';
console.log(`✓ decision.json 유효 — ${d.cycleId} · ${d.stance} · ${mode} · 확신 ${d.confidence}`);
