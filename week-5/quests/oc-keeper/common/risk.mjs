#!/usr/bin/env node
// 결정 검사(주문은 내지 않음) — LLM 이 decision.json 을 쓴 뒤 정책에 걸리는지 미리 본다.
// 사용:  node common/risk.mjs --agent <에이전트 폴더> --decision runs/<cycleId>/decision.json
// 출력:  JSON { orders(변환 결과), approved, rejected, flags, summary }

import fs from 'node:fs';
import path from 'node:path';
import { resolveAgentDir, loadPolicy, openVenue, fetchTicker, decisionToOrders, riskCheck } from './lib.mjs';

const argv = process.argv;
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const agentDir = resolveAgentDir(argv);
const policy = loadPolicy(agentDir);
const decisionPath = path.resolve(agentDir, opt('--decision') || '');
if (!opt('--decision') || !fs.existsSync(decisionPath)) {
  console.error('사용: node common/risk.mjs --agent <폴더> --decision runs/<cycleId>/decision.json');
  process.exit(2);
}
const decision = JSON.parse(fs.readFileSync(decisionPath, 'utf8'));
const venue = openVenue(policy, { dryRun: true });
const wallet = await venue.wallet();
const prices = await fetchTicker(policy.markets);

const { orders, notes } = decisionToOrders(decision, wallet, prices, policy);
const check = riskCheck({ orders, wallet, prices, policy, agentDir });
console.log(JSON.stringify({ cycleId: decision.cycleId, converted: orders, notes, ...check }, null, 2));
