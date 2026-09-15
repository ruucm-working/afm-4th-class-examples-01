// ============================================================
// 냉장고 파먹기 API 서버 (PostgreSQL / Supabase)
// DB 접속 주소는 .env 의 DATABASE_URL 에만 둔다. 브라우저는 절대 모른다.
// 로컬: node server.js  /  Vercel: module.exports 로 서버리스 동작
// ============================================================
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 6010;

// ── 환경변수 & DB 풀 ──────────────────────────
// Vercel 등에서 값 끝에 줄바꿈이 붙는 경우가 있어 .trim() 을 건다.
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
// OpenAI 키도 서버에만 둔다. 브라우저는 /api/recipes/generate 만 부른다.
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-5.4-mini').trim();
// JWT 서명 비밀키. 이 값이 새면 누구나 아무 사용자로 로그인한 척 토큰을 만들 수 있다.
const JWT_SECRET = (process.env.JWT_SECRET || '').trim();
const JWT_EXPIRES_IN = '7d';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5, // 서버리스에서 연결이 과하게 늘지 않도록 작게 둔다
});

// ── 허용 값 (index.html 의 선택지와 같아야 한다) ──
const CATEGORIES = ['채소', '과일', '육류', '해산물', '유제품', '달걀/두부', '양념', '기타'];
const STORAGES = ['냉장', '냉동', '실온'];
const DIFFICULTIES = ['쉬움', '보통', '어려움'];

// DB 컬럼(snake_case) → 화면에서 쓰는 모양(camelCase)
// DATE 를 그대로 받으면 JS Date 로 바뀌며 시간대 때문에 하루가 밀릴 수 있어 문자열로 뽑는다.
const INGREDIENT_COLUMNS = `
  id, name, category, quantity::float8 AS quantity, unit, storage,
  to_char(expires_at, 'YYYY-MM-DD') AS "expiresAt"`;

const RECIPE_COLUMNS = `
  id, name, emoji, minutes, difficulty, servings, description, favorite, ingredients, steps`;

// ── 회원가입 시 넣어줄 샘플 데이터 ─────────────
const daysFromNow = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

const SEED_INGREDIENTS = [
  ['달걀', '달걀/두부', 8, '개', '냉장', 9],
  ['두부', '달걀/두부', 1, '모', '냉장', 1],
  ['대파', '채소', 2, '대', '냉장', 4],
  ['양파', '채소', 3, '개', '실온', 14],
  ['김치', '기타', 500, 'g', '냉장', 30],
  ['돼지고기', '육류', 300, 'g', '냉장', 2],
  ['우유', '유제품', 1, '팩', '냉장', -1],
  ['감자', '채소', 4, '개', '실온', 20],
  ['새우', '해산물', 200, 'g', '냉동', 60],
  ['밥', '기타', 2, '공기', '냉동', 25],
  ['간장', '양념', 1, '병', '실온', 180],
  ['고추장', '양념', 1, '통', '냉장', 120],
  ['애호박', '채소', 1, '개', '냉장', 3],
  ['사과', '과일', 3, '개', '냉장', 12],
  ['치즈', '유제품', 5, '장', '냉장', 0],
];

const SEED_RECIPES = [
  {
    name: '김치찌개', emoji: '🍲', minutes: 25, difficulty: '쉬움', servings: 2, favorite: true,
    description: '묵은지와 돼지고기로 끓이는 한국인의 소울푸드.',
    ingredients: [
      { name: '김치', amount: '300g' }, { name: '돼지고기', amount: '150g' }, { name: '두부', amount: '1/2모' },
      { name: '대파', amount: '1/2대' }, { name: '양파', amount: '1/2개' }, { name: '고춧가루', amount: '1큰술' },
    ],
    steps: ['돼지고기와 김치를 냄비에 넣고 볶는다.', '물 500ml 를 붓고 끓인다.', '양파, 두부를 넣고 10분 더 끓인다.', '대파를 올리고 불을 끈다.'],
  },
  {
    name: '계란말이', emoji: '🍳', minutes: 10, difficulty: '쉬움', servings: 1, favorite: false,
    description: '도시락 반찬의 기본, 촉촉한 계란말이.',
    ingredients: [{ name: '달걀', amount: '3개' }, { name: '대파', amount: '약간' }, { name: '소금', amount: '약간' }],
    steps: ['달걀을 풀고 잘게 썬 대파와 소금을 넣는다.', '약불에 팬을 달구고 얇게 붓는다.', '반쯤 익으면 돌돌 말고, 남은 계란물을 부어 반복한다.'],
  },
  {
    name: '새우볶음밥', emoji: '🍛', minutes: 15, difficulty: '쉬움', servings: 1, favorite: true,
    description: '냉동밥과 냉동새우로 뚝딱 만드는 한 그릇.',
    ingredients: [
      { name: '밥', amount: '1공기' }, { name: '새우', amount: '100g' }, { name: '달걀', amount: '1개' },
      { name: '대파', amount: '1/3대' }, { name: '간장', amount: '1큰술' },
    ],
    steps: ['대파로 파기름을 낸다.', '새우를 넣고 볶는다.', '밥을 넣고 간장으로 간을 한다.', '한쪽에 달걀 스크램블을 만들어 섞는다.'],
  },
  {
    name: '감자조림', emoji: '🥔', minutes: 30, difficulty: '보통', servings: 3, favorite: false,
    description: '달짝지근 짭조름한 밥도둑 반찬.',
    ingredients: [
      { name: '감자', amount: '2개' }, { name: '양파', amount: '1/2개' }, { name: '간장', amount: '3큰술' },
      { name: '올리고당', amount: '2큰술' },
    ],
    steps: ['감자를 깍둑썰기해 물에 담가 전분을 뺀다.', '냄비에 감자, 간장, 물을 넣고 조린다.', '양파와 올리고당을 넣고 국물이 자작해질 때까지 졸인다.'],
  },
  {
    name: '애호박전', emoji: '🥒', minutes: 20, difficulty: '쉬움', servings: 2, favorite: false,
    description: '노릇노릇 부쳐낸 애호박전.',
    ingredients: [{ name: '애호박', amount: '1개' }, { name: '달걀', amount: '2개' }, { name: '부침가루', amount: '3큰술' }],
    steps: ['애호박을 0.5cm 두께로 썬다.', '부침가루를 입히고 달걀물에 담근다.', '기름 두른 팬에 앞뒤로 부친다.'],
  },
  {
    name: '제육볶음', emoji: '🌶️', minutes: 25, difficulty: '보통', servings: 2, favorite: false,
    description: '매콤달콤 고추장 양념 돼지고기 볶음.',
    ingredients: [
      { name: '돼지고기', amount: '300g' }, { name: '고추장', amount: '2큰술' }, { name: '양파', amount: '1개' },
      { name: '대파', amount: '1대' }, { name: '간장', amount: '1큰술' }, { name: '마늘', amount: '1큰술' },
    ],
    steps: ['고추장, 간장, 마늘로 양념장을 만든다.', '돼지고기를 양념에 30분 재운다.', '팬에 고기를 볶다가 양파, 대파를 넣고 마무리한다.'],
  },
  {
    name: '두부부침', emoji: '🧈', minutes: 15, difficulty: '쉬움', servings: 2, favorite: false,
    description: '겉바속촉 두부부침에 양념간장 곁들이기.',
    ingredients: [{ name: '두부', amount: '1모' }, { name: '간장', amount: '2큰술' }, { name: '대파', amount: '약간' }],
    steps: ['두부를 도톰하게 썰어 물기를 뺀다.', '팬에 노릇하게 굽는다.', '간장에 다진 대파를 섞어 곁들인다.'],
  },
];

// ── DB 초기화 (lazy init) ─────────────────────
// 서버리스는 cold start 마다 여기로 들어올 수 있어 flag 로 한 번만 실행한다.
let dbInitPromise = null;

async function initDB() {
  if (!DATABASE_URL) {
    const err = new Error('DATABASE_URL 이 없습니다. .env 파일을 확인해주세요.');
    err.status = 503;
    throw err;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id             SERIAL PRIMARY KEY,
      email          TEXT NOT NULL UNIQUE,
      password_hash  TEXT NOT NULL,
      nickname       TEXT NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ingredients (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT '기타',
      quantity    NUMERIC NOT NULL DEFAULT 1,
      unit        TEXT NOT NULL DEFAULT '개',
      storage     TEXT NOT NULL DEFAULT '냉장',
      expires_at  DATE NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS recipes (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL,
      emoji        TEXT NOT NULL DEFAULT '🍽️',
      minutes      INTEGER NOT NULL DEFAULT 0,
      difficulty   TEXT NOT NULL DEFAULT '쉬움',
      servings     INTEGER NOT NULL DEFAULT 1,
      description  TEXT NOT NULL DEFAULT '',
      favorite     BOOLEAN NOT NULL DEFAULT false,
      ingredients  JSONB NOT NULL DEFAULT '[]',
      steps        JSONB NOT NULL DEFAULT '[]',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- 로그인 기능 이전에 만든 테이블에도 "주인" 컬럼을 붙인다.
    -- 탈퇴(사용자 삭제) 시 그 사람의 재료·레시피도 함께 지워진다.
    ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE recipes     ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS ingredients_user_id_idx ON ingredients(user_id);
    CREATE INDEX IF NOT EXISTS recipes_user_id_idx     ON recipes(user_id);
  `);
}

// 새로 가입한 사용자의 냉장고에 샘플 재료·레시피를 채워준다 (가입과 같은 트랜잭션 안에서)
async function seedUserData(client, userId) {
  for (const [name, category, quantity, unit, storage, days] of SEED_INGREDIENTS) {
    await client.query(
      'INSERT INTO ingredients (user_id, name, category, quantity, unit, storage, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [userId, name, category, quantity, unit, storage, daysFromNow(days)]
    );
  }
  for (const r of SEED_RECIPES) {
    await client.query(
      `INSERT INTO recipes (user_id, name, emoji, minutes, difficulty, servings, description, favorite, ingredients, steps)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [userId, r.name, r.emoji, r.minutes, r.difficulty, r.servings, r.description, r.favorite,
        JSON.stringify(r.ingredients), JSON.stringify(r.steps)]
    );
  }
}

function ensureDB() {
  if (!dbInitPromise) {
    dbInitPromise = initDB().catch((err) => {
      dbInitPromise = null; // 실패하면 다음 요청에서 다시 시도한다
      throw err;
    });
  }
  return dbInitPromise;
}

// ── AI 레시피 생성 (OpenAI) ────────────────────
// 화면에 보여줄 수 있는 에러 (expose=true 면 에러 핸들러가 메시지를 그대로 내려준다)
const userError = (status, message) => Object.assign(new Error(message), { status, expose: true });

// 기본 양념은 냉장고에 없어도 쓸 수 있게 허용한다
const PANTRY = ['소금', '후추', '설탕', '식용유', '참기름', '물', '다진마늘', '깨'];

// OpenAI Structured Outputs 스키마 — recipes 테이블 모양과 똑같이 받는다
const RECIPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'emoji', 'minutes', 'difficulty', 'servings', 'description', 'ingredients', 'steps', 'tip'],
  properties: {
    name: { type: 'string', description: '요리 이름' },
    emoji: { type: 'string', description: '요리를 나타내는 이모지 1개' },
    minutes: { type: 'integer', description: '총 조리 시간(분)' },
    difficulty: { type: 'string', enum: DIFFICULTIES },
    servings: { type: 'integer' },
    description: { type: 'string', description: '한 줄 소개 (40자 이내)' },
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'amount'],
        properties: {
          name: { type: 'string', description: '재료명. 냉장고 재료는 목록에 적힌 이름과 글자 하나까지 똑같이' },
          amount: { type: 'string', description: '분량 (예: 1/2모, 2큰술)' },
        },
      },
    },
    steps: { type: 'array', items: { type: 'string' }, description: '조리 순서, 한 단계에 한 문장' },
    tip: { type: 'string', description: '맛있게 만드는 팁 한 문장' },
  },
};

async function generateRecipe({ available, mustUse, preference, maxMinutes, servings }) {
  const describe = (i) => `${i.name}(${i.quantity}${i.unit}, 유통기한 ${i.expiresAt})`;
  const system = [
    '너는 한국 가정식에 능숙한 요리사야. 사용자의 냉장고 재료로 집에서 바로 만들 수 있는 레시피를 하나 만든다.',
    '규칙:',
    `- 재료는 [냉장고 재료]와 기본 양념(${PANTRY.join(', ')}) 안에서만 쓴다. 목록에 없는 재료를 새로 사게 만들지 않는다.`,
    '- 냉장고 재료의 name 은 목록에 적힌 이름과 정확히 똑같이 적는다 (예: "대파" 를 "파" 로 바꾸지 않는다).',
    '- [꼭 쓸 재료]가 있으면 반드시 모두 사용한다. 유통기한이 가까운 재료를 우선 활용한다.',
    '- 분량은 보유 수량을 넘지 않게 잡는다.',
    '- 조리 순서는 초보자도 따라 할 수 있게 구체적으로 3~8단계로 쓴다.',
    '- 모든 텍스트는 한국어로 쓴다.',
  ].join('\n');

  const user = [
    `[오늘 날짜] ${new Date().toISOString().slice(0, 10)}`,
    `[냉장고 재료] ${available.map(describe).join(', ')}`,
    `[꼭 쓸 재료] ${mustUse.length ? mustUse.map((i) => i.name).join(', ') : '없음'}`,
    `[인분] ${servings}인분`,
    `[최대 조리 시간] ${maxMinutes ? `${maxMinutes}분 이내` : '상관없음'}`,
    `[요청사항] ${preference || '없음'}`,
  ].join('\n');

  let res;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        reasoning_effort: 'low',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_schema', json_schema: { name: 'recipe', strict: true, schema: RECIPE_SCHEMA } },
      }),
      signal: AbortSignal.timeout(50000),
    });
  } catch (err) {
    throw userError(504, 'AI 응답이 너무 늦어요. 잠시 뒤 다시 시도해주세요.');
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[OpenAI]', res.status, json.error && json.error.message);
    if (res.status === 401) throw userError(502, 'OpenAI 키가 거부됐어요. 서버의 OPENAI_API_KEY 를 확인해주세요.');
    if (res.status === 429) throw userError(429, 'AI 요청이 너무 잦거나 크레딧이 부족해요. 잠시 뒤 다시 시도해주세요.');
    throw userError(502, 'AI 가 레시피를 만들지 못했어요. 다시 시도해주세요.');
  }

  const message = json.choices && json.choices[0] && json.choices[0].message;
  if (!message || message.refusal) throw userError(422, 'AI 가 이 요청으로는 레시피를 만들 수 없대요. 요청사항을 바꿔보세요.');

  const recipe = JSON.parse(message.content);
  // 스키마로 모양은 보장되지만, 저장 전에 한 번 더 다듬는다
  return {
    name: recipe.name.trim(),
    emoji: recipe.emoji.trim() || '🍽️',
    minutes: Math.max(1, recipe.minutes),
    difficulty: DIFFICULTIES.includes(recipe.difficulty) ? recipe.difficulty : '보통',
    servings: Math.max(1, recipe.servings),
    description: recipe.description.trim(),
    ingredients: recipe.ingredients.filter((i) => i.name.trim()).map((i) => ({ name: i.name.trim(), amount: i.amount.trim() || '적당량' })),
    steps: recipe.steps.map((s) => s.trim()).filter(Boolean),
    tip: recipe.tip.trim(),
  };
}

// ── 인증 (JWT) ────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const publicUser = (u) => ({ id: u.id, email: u.email, nickname: u.nickname });

// 토큰 안에는 사용자 id(sub)만 담는다. 비밀번호·이메일 같은 정보는 넣지 않는다.
const signToken = (user) => jwt.sign({ sub: String(user.id) }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

// Authorization: Bearer <token> 을 검사하고 req.userId 를 채운다
async function requireAuth(req, res, next) {
  const [scheme, token] = String(req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ success: false, message: '로그인이 필요해요.' });
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    const message = err.name === 'TokenExpiredError' ? '로그인이 만료됐어요. 다시 로그인해주세요.' : '로그인 정보가 올바르지 않아요. 다시 로그인해주세요.';
    return res.status(401).json({ success: false, message });
  }
  try {
    // 토큰은 유효해도 그 사이 탈퇴한 사용자일 수 있어 DB 에서 한 번 확인한다
    const { rows: [user] } = await pool.query('SELECT id, email, nickname FROM users WHERE id = $1', [Number(payload.sub)]);
    if (!user) return res.status(401).json({ success: false, message: '계정을 찾을 수 없어요. 다시 로그인해주세요.' });
    req.userId = user.id;
    req.user = user;
    next();
  } catch (err) { next(err); }
}

// ── 입력 검증 ─────────────────────────────────
const badRequest = (res, message) => res.status(400).json({ success: false, message });
const parseId = (raw) => (/^\d+$/.test(raw) ? Number(raw) : null);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

// 재료: partial=true 면 넘어온 필드만 검사한다 (수정용)
function validateIngredient(body, partial = false) {
  const b = body || {};
  const has = (k) => b[k] !== undefined;
  if ((!partial || has('name')) && !String(b.name || '').trim()) return '재료 이름을 입력해주세요.';
  if (has('category') && !CATEGORIES.includes(b.category)) return '분류 값이 올바르지 않아요.';
  if (has('storage') && !STORAGES.includes(b.storage)) return '보관 위치 값이 올바르지 않아요.';
  if ((!partial || has('quantity')) && !(Number(b.quantity) > 0)) return '수량은 0보다 커야 해요.';
  if ((!partial || has('expiresAt')) && !isDate(b.expiresAt)) return '유통기한은 YYYY-MM-DD 형식이어야 해요.';
  return null;
}

function validateRecipe(body, partial = false) {
  const b = body || {};
  const has = (k) => b[k] !== undefined;
  if ((!partial || has('name')) && !String(b.name || '').trim()) return '요리 이름을 입력해주세요.';
  if (has('difficulty') && !DIFFICULTIES.includes(b.difficulty)) return '난이도 값이 올바르지 않아요.';
  if (has('favorite') && typeof b.favorite !== 'boolean') return 'favorite 은 true/false 여야 해요.';
  if (!partial || has('ingredients')) {
    const ok = Array.isArray(b.ingredients) && b.ingredients.length > 0 &&
      b.ingredients.every((i) => i && String(i.name || '').trim());
    if (!ok) return '재료를 한 개 이상 입력해주세요.';
  }
  if (!partial || has('steps')) {
    const ok = Array.isArray(b.steps) && b.steps.length > 0 && b.steps.every((s) => String(s || '').trim());
    if (!ok) return '조리 순서를 한 줄 이상 입력해주세요.';
  }
  return null;
}

// ── Middleware ───────────────────────────────
app.use(express.json({ limit: '1mb' }));

// .env 같은 dotfile 은 어떤 경로로도 내보내지 않는다.
// (정적 미들웨어보다 먼저 걸어야 하고, 아래 SPA fallback 이 대신 응답하는 것도 막는다)
app.use((req, res, next) => {
  if (/(^|\/)\.[^/]/.test(req.path)) {
    return res.status(404).json({ success: false, message: '찾을 수 없어요.' });
  }
  next();
});

// server.js / package.json 같은 서버 파일도 정적으로 내보내지 않는다
app.use((req, res, next) => {
  if (/^\/(server\.js|package(-lock)?\.json|vercel\.json)$/i.test(req.path)) {
    return res.status(404).json({ success: false, message: '찾을 수 없어요.' });
  }
  next();
});

app.use(express.static(path.join(__dirname), { index: 'index.html', dotfiles: 'deny' }));

// 모든 /api 요청 전에 설정과 테이블 준비를 보장한다
app.use('/api', async (_req, _res, next) => {
  if (!JWT_SECRET) {
    return next(Object.assign(new Error('JWT_SECRET 이 없습니다. 서버 .env 를 확인해주세요.'), { status: 503 }));
  }
  try {
    await ensureDB();
    next();
  } catch (err) {
    next(err);
  }
});

// ── API routes: 인증 (로그인 없이 호출 가능) ────

// POST /api/auth/signup — 회원가입. body: { email, password, nickname }
app.post('/api/auth/signup', async (req, res, next) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  const nickname = String(b.nickname || '').trim();
  if (!EMAIL_RE.test(email) || email.length > 254) return badRequest(res, '올바른 이메일을 입력해주세요.');
  if (password.length < 8 || password.length > 72) return badRequest(res, '비밀번호는 8~72자로 입력해주세요.');
  if (!nickname || nickname.length > 20) return badRequest(res, '닉네임은 1~20자로 입력해주세요.');

  const client = await pool.connect().catch(next);
  if (!client) return;
  try {
    // 비밀번호는 원문 대신 bcrypt 해시로만 저장한다
    const passwordHash = await bcrypt.hash(password, 10);
    await client.query('BEGIN');
    const { rows: [user] } = await client.query(
      'INSERT INTO users (email, password_hash, nickname) VALUES ($1, $2, $3) RETURNING id, email, nickname',
      [email, passwordHash, nickname]
    );
    await seedUserData(client, user.id);
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { token: signToken(user), user: publicUser(user) } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ success: false, message: '이미 가입된 이메일이에요.' });
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/auth/login — 로그인. body: { email, password }
app.post('/api/auth/login', async (req, res, next) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!email || !password) return badRequest(res, '이메일과 비밀번호를 입력해주세요.');
  try {
    const { rows: [user] } = await pool.query('SELECT id, email, nickname, password_hash FROM users WHERE email = $1', [email]);
    // 이메일이 없는지 비밀번호가 틀렸는지 구분해서 알려주지 않는다 (가입 여부 추측 방지)
    const ok = user && await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ success: false, message: '이메일 또는 비밀번호가 올바르지 않아요.' });
    res.json({ success: true, data: { token: signToken(user), user: publicUser(user) } });
  } catch (err) { next(err); }
});

// GET /api/auth/me — 토큰으로 내 정보 확인 (새로고침 시 로그인 유지용)
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, data: publicUser(req.user) });
});

// 여기부터 아래의 모든 /api 경로는 로그인이 필요하다
app.use('/api', requireAuth);

// ── API routes: 재료 (모두 내 것만) ────────────

// GET /api/ingredients — 전체 재료 (유통기한 임박 순)
app.get('/api/ingredients', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${INGREDIENT_COLUMNS} FROM ingredients WHERE user_id = $1 ORDER BY expires_at, id`,
      [req.userId]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// POST /api/ingredients — 재료 추가
app.post('/api/ingredients', async (req, res, next) => {
  const error = validateIngredient(req.body);
  if (error) return badRequest(res, error);
  const { name, category = '기타', quantity, unit = '개', storage = '냉장', expiresAt } = req.body;
  try {
    const { rows: [item] } = await pool.query(
      `INSERT INTO ingredients (user_id, name, category, quantity, unit, storage, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${INGREDIENT_COLUMNS}`,
      [req.userId, String(name).trim(), category, Number(quantity), String(unit).trim() || '개', storage, expiresAt]
    );
    res.status(201).json({ success: true, data: item });
  } catch (err) { next(err); }
});

// PUT /api/ingredients/:id — 재료 수정 (넘어온 필드만 바뀐다)
app.put('/api/ingredients/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '잘못된 id 예요.');
  const error = validateIngredient(req.body, true);
  if (error) return badRequest(res, error);
  const b = req.body || {};
  try {
    const { rows: [item] } = await pool.query(
      `UPDATE ingredients SET
         name       = COALESCE($2, name),
         category   = COALESCE($3, category),
         quantity   = COALESCE($4, quantity),
         unit       = COALESCE($5, unit),
         storage    = COALESCE($6, storage),
         expires_at = COALESCE($7::date, expires_at)
       WHERE id = $1 AND user_id = $8 RETURNING ${INGREDIENT_COLUMNS}`,
      [id, b.name === undefined ? null : String(b.name).trim(), b.category ?? null,
        b.quantity === undefined ? null : Number(b.quantity), b.unit ?? null, b.storage ?? null, b.expiresAt ?? null,
        req.userId]
    );
    if (!item) return res.status(404).json({ success: false, message: '재료를 찾을 수 없어요.' });
    res.json({ success: true, data: item });
  } catch (err) { next(err); }
});

// DELETE /api/ingredients/:id — 재료 삭제
app.delete('/api/ingredients/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '잘못된 id 예요.');
  try {
    const { rowCount } = await pool.query('DELETE FROM ingredients WHERE id = $1 AND user_id = $2', [id, req.userId]);
    if (!rowCount) return res.status(404).json({ success: false, message: '재료를 찾을 수 없어요.' });
    res.json({ success: true, data: { id } });
  } catch (err) { next(err); }
});

// ── API routes: 레시피 ────────────────────────

// GET /api/recipes — 전체 레시피
app.get('/api/recipes', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT ${RECIPE_COLUMNS} FROM recipes WHERE user_id = $1 ORDER BY id`, [req.userId]);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/recipes/:id — 레시피 하나
app.get('/api/recipes/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '잘못된 id 예요.');
  try {
    const { rows: [item] } = await pool.query(`SELECT ${RECIPE_COLUMNS} FROM recipes WHERE id = $1 AND user_id = $2`, [id, req.userId]);
    if (!item) return res.status(404).json({ success: false, message: '레시피를 찾을 수 없어요.' });
    res.json({ success: true, data: item });
  } catch (err) { next(err); }
});

// POST /api/recipes — 레시피 등록
app.post('/api/recipes', async (req, res, next) => {
  const error = validateRecipe(req.body);
  if (error) return badRequest(res, error);
  const b = req.body;
  const ingredients = b.ingredients.map((i) => ({ name: String(i.name).trim(), amount: String(i.amount || '적당량').trim() }));
  const steps = b.steps.map((s) => String(s).trim());
  try {
    const { rows: [item] } = await pool.query(
      `INSERT INTO recipes (user_id, name, emoji, minutes, difficulty, servings, description, favorite, ingredients, steps)
       VALUES ($9, $1, $2, $3, $4, $5, $6, false, $7, $8) RETURNING ${RECIPE_COLUMNS}`,
      [String(b.name).trim(), b.emoji || '🍽️', Math.max(0, parseInt(b.minutes, 10) || 0),
        b.difficulty || '쉬움', Math.max(1, parseInt(b.servings, 10) || 1), String(b.description || '').trim(),
        JSON.stringify(ingredients), JSON.stringify(steps), req.userId]
    );
    res.status(201).json({ success: true, data: item });
  } catch (err) { next(err); }
});

// POST /api/recipes/generate — 냉장고 재료로 AI 레시피 초안 만들기 (DB 에 저장하지 않음)
// body: { mustUseIds?: number[], preference?: string, maxMinutes?: number, servings?: number }
// 저장은 화면에서 확인한 뒤 POST /api/recipes 로 따로 한다.
app.post('/api/recipes/generate', async (req, res, next) => {
  if (!OPENAI_API_KEY) {
    return res.status(503).json({ success: false, message: 'AI 기능이 꺼져 있어요. 서버 .env 에 OPENAI_API_KEY 를 넣어주세요.' });
  }
  const b = req.body || {};
  const mustUseIds = Array.isArray(b.mustUseIds) ? b.mustUseIds.map(Number).filter(Number.isInteger) : [];
  const preference = String(b.preference || '').trim();
  if (preference.length > 200) return badRequest(res, '요청사항은 200자 이내로 적어주세요.');
  const maxMinutes = [15, 30, 60].includes(Number(b.maxMinutes)) ? Number(b.maxMinutes) : null;
  const servings = Math.min(6, Math.max(1, parseInt(b.servings, 10) || 2));

  try {
    // 재료 목록은 브라우저가 보낸 값이 아니라 DB 에서 직접 읽는다 (유통기한 지난 재료는 제외)
    const { rows: available } = await pool.query(
      `SELECT ${INGREDIENT_COLUMNS} FROM ingredients WHERE user_id = $1 AND expires_at >= CURRENT_DATE ORDER BY expires_at, id`,
      [req.userId]
    );
    if (available.length === 0) return badRequest(res, '쓸 수 있는 재료가 없어요. 냉장고에 재료를 먼저 추가해주세요.');
    const mustUse = available.filter((i) => mustUseIds.includes(i.id));

    const recipe = await generateRecipe({ available, mustUse, preference, maxMinutes, servings });
    res.json({ success: true, data: recipe });
  } catch (err) { next(err); }
});

// PATCH /api/recipes/:id — 레시피 일부 수정 (즐겨찾기 토글 등)
app.patch('/api/recipes/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '잘못된 id 예요.');
  const error = validateRecipe(req.body, true);
  if (error) return badRequest(res, error);
  const b = req.body || {};
  const json = (v) => (v === undefined ? null : JSON.stringify(v));
  try {
    const { rows: [item] } = await pool.query(
      `UPDATE recipes SET
         name        = COALESCE($2, name),
         emoji       = COALESCE($3, emoji),
         minutes     = COALESCE($4, minutes),
         difficulty  = COALESCE($5, difficulty),
         servings    = COALESCE($6, servings),
         description = COALESCE($7, description),
         favorite    = COALESCE($8, favorite),
         ingredients = COALESCE($9::jsonb, ingredients),
         steps       = COALESCE($10::jsonb, steps)
       WHERE id = $1 AND user_id = $11 RETURNING ${RECIPE_COLUMNS}`,
      [id, b.name === undefined ? null : String(b.name).trim(), b.emoji ?? null,
        b.minutes === undefined ? null : Math.max(0, parseInt(b.minutes, 10) || 0), b.difficulty ?? null,
        b.servings === undefined ? null : Math.max(1, parseInt(b.servings, 10) || 1), b.description ?? null,
        b.favorite ?? null, json(b.ingredients), json(b.steps), req.userId]
    );
    if (!item) return res.status(404).json({ success: false, message: '레시피를 찾을 수 없어요.' });
    res.json({ success: true, data: item });
  } catch (err) { next(err); }
});

// DELETE /api/recipes/:id — 레시피 삭제
app.delete('/api/recipes/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '잘못된 id 예요.');
  try {
    const { rowCount } = await pool.query('DELETE FROM recipes WHERE id = $1 AND user_id = $2', [id, req.userId]);
    if (!rowCount) return res.status(404).json({ success: false, message: '레시피를 찾을 수 없어요.' });
    res.json({ success: true, data: { id } });
  } catch (err) { next(err); }
});

// 없는 API 경로는 HTML 대신 JSON 으로 답한다
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: '없는 API 경로예요.' });
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  // DB 에러 원문(테이블 구조·접속 정보)은 로그에만 남기고 화면엔 일반 안내만 내린다
  const message = status === 503 || err.expose ? err.message : '서버에서 문제가 생겼어요. 잠시 뒤 다시 시도해주세요.';
  console.error('[에러]', status, err.message);
  res.status(status).json({ success: false, message });
});

// ── Startup & export ─────────────────────────
// 로컬에서 직접 실행할 때만 포트를 연다 (Vercel 에서는 module.exports 만 쓴다)
if (require.main === module) {
  app.listen(PORT, (err) => {
    // Express 5 는 포트 충돌 같은 에러를 콜백으로 넘기고 조용히 종료한다
    if (err) {
      console.error(`❌ ${PORT} 포트를 열 수 없어요 (${err.code}). PORT=다른번호 node server.js 로 실행해보세요.`);
      process.exit(1);
    }
    console.log(`냉장고 파먹기 서버 실행 중 → http://localhost:${PORT}`);
    if (!DATABASE_URL) console.log('⚠️  DATABASE_URL 이 없습니다. .env 파일을 확인해주세요.');
    if (!OPENAI_API_KEY) console.log('⚠️  OPENAI_API_KEY 가 없어 AI 레시피 생성이 꺼져 있습니다.');
    if (!JWT_SECRET) console.log('⚠️  JWT_SECRET 이 없어 API 가 동작하지 않습니다. .env 파일을 확인해주세요.');
  });
}

module.exports = app;
