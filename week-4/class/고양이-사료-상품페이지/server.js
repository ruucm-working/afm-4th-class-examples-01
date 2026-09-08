// ============================================================
// 고양이 사료 상품페이지 API 서버
// - 상품 정보는 서버가 갖고 있고, 화면은 /api/product 로 받아 그린다.
// - 문의하기 폼은 Supabase Postgres 의 cat_food_inquiries 테이블에 저장한다.
// - DB 접속 정보는 .env 에만 두고, 브라우저(index.html)로는 절대 내려보내지 않는다.
// 로컬: node server.js  /  Vercel: module.exports 로 서버리스 동작
// ============================================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 6004;

// ── .env 읽기 ─────────────────────────────────
// 우선순위: 시스템 환경변수 → 같은 폴더의 .env 파일
(function loadEnvFile() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // .env 가 없어도 무시 — 환경변수만으로 동작
  }
})();

// Vercel 등에서 환경변수 끝에 줄바꿈이 붙는 경우가 있어 항상 .trim()
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();

// ── DB 연결 풀 ────────────────────────────────
// Supabase 는 SSL 을 요구한다. 풀 크기는 서버리스를 고려해 작게 잡는다.
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

// ── 테이블 lazy init ──────────────────────────
// 서버리스는 cold start 마다 초기화가 불릴 수 있어 flag 로 중복 실행을 막는다.
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cat_food_inquiries (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      phone      TEXT,
      topic      TEXT NOT NULL,
      option_key TEXT,
      message    TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  dbInitialized = true;
}

// ── 상품 데이터 (수업용이라 코드 안에 상수로 둔다) ─
const PRODUCT = {
  id: 'cat-food-01',
  name: '연어 & 닭고기 그레인프리 사료',
  brand: '냥이곳간',
  tagline: '입 짧은 우리 아이도 그릇을 싹 비우는 전연령 사료',
  rating: 4.8,
  reviewCount: 1247,
  badges: ['그레인프리', '전연령용', '휴먼그레이드 원료', '국내 생산'],
  options: [
    { key: '400g', label: '400g 체험팩', price: 12900, listPrice: 15900, stock: 42 },
    { key: '1.5kg', label: '1.5kg 스탠다드', price: 32900, listPrice: 42900, stock: 18 },
    { key: '5kg', label: '5kg 대용량', price: 89000, listPrice: 119000, stock: 0 },
  ],
  highlights: [
    { icon: '🐟', title: '동물성 단백질 76%', desc: '연어와 닭고기를 1·2순위 원료로 썼습니다.' },
    { icon: '🌾', title: '곡물 4無', desc: '옥수수·밀·콩·글루텐을 넣지 않았습니다.' },
    { icon: '💧', title: '수분 섭취 설계', desc: '알갱이를 작게 만들고 오일 코팅을 줄였습니다.' },
    { icon: '🧪', title: '전 배치 검사', desc: '생산 배치마다 중금속·살모넬라 검사 성적서를 공개합니다.' },
  ],
  nutrition: [
    { label: '조단백', value: '36% 이상' },
    { label: '조지방', value: '16% 이상' },
    { label: '조섬유', value: '3% 이하' },
    { label: '조회분', value: '9% 이하' },
    { label: '수분', value: '10% 이하' },
    { label: '칼슘 : 인', value: '1.2 : 1' },
    { label: '타우린', value: '0.25% 이상' },
    { label: '열량', value: '3,850 kcal/kg' },
  ],
  ingredients: '연어 34%, 건조 닭고기 28%, 고구마, 완두, 닭지방(토코페롤 보존), 연어오일, 건조 계란, 크랜베리, 타우린, 유카 추출물, 프락토올리고당, 비타민·미네랄 프리믹스',
  feeding: [
    { weight: '2kg 미만', amount: '25 ~ 35g' },
    { weight: '2 ~ 4kg', amount: '35 ~ 55g' },
    { weight: '4 ~ 6kg', amount: '55 ~ 75g' },
    { weight: '6kg 이상', amount: '75g 이상 (체중의 2%)' },
  ],
  shipping: '오후 2시 이전 주문 시 당일 출고 · 3만원 이상 무료배송 · 제주/도서산간 3,000원 추가',
  reviews: [
    { id: 1, author: '치즈집사', rating: 5, date: '2026-08-28', body: '입 짧은 8살 코숏인데 첫날부터 그릇을 싹 비웠어요. 알갱이가 작아서 잘 씹습니다.' },
    { id: 2, author: '삼색이맘', rating: 5, date: '2026-08-21', body: '2주 먹이니 변 냄새가 확실히 줄었어요. 5kg 재입고도 빨리 됐으면 좋겠네요.' },
    { id: 3, author: '까망이누나', rating: 4, date: '2026-08-14', body: '기호성은 최고인데 지퍼백이 조금 얇습니다. 밀폐용기에 옮겨 담아 씁니다.' },
  ],
};

const TOPICS = ['상품 문의', '배송 문의', '교환/반품', '대량 구매', '기타'];

// DB 행(snake_case)을 화면이 쓰는 형태(camelCase)로 바꾼다.
const toInquiry = row => ({
  id: row.id,
  name: row.name,
  email: row.email,
  phone: row.phone,
  topic: row.topic,
  optionKey: row.option_key,
  message: row.message,
  createdAt: row.created_at,
});

// 목록에 남의 연락처를 그대로 노출하지 않도록 가린다. (hong@x.com → ho**@x.com)
function maskEmail(email) {
  const at = String(email).indexOf('@');
  if (at < 1) return '***';
  const id = String(email).slice(0, at);
  const domain = String(email).slice(at + 1);
  const stars = '*'.repeat(Math.max(id.length - 2, 1));
  return id.slice(0, 2) + stars + '@' + domain;
}

// ── 미들웨어 ──────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// /api 로 들어오는 모든 요청 전에 테이블이 준비됐는지 확인한다.
app.use('/api', async (_req, res, next) => {
  try {
    if (!DATABASE_URL) {
      return res.status(500).json({ success: false, message: 'DATABASE_URL 이 설정되지 않았습니다. .env 를 확인하세요.' });
    }
    await initDB();
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'DB 연결에 실패했습니다.' });
  }
});

// ── API: 상품 정보 ────────────────────────────
app.get('/api/product', (_req, res) => {
  res.json({ success: true, data: { ...PRODUCT, topics: TOPICS } });
});

// ── API: 문의 목록 (최근 20건, 연락처는 가려서) ─
app.get('/api/inquiries', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM cat_food_inquiries ORDER BY id DESC LIMIT 20'
    );
    const data = rows.map(toInquiry).map(item => ({
      id: item.id,
      name: item.name,
      email: maskEmail(item.email),
      topic: item.topic,
      optionKey: item.optionKey,
      message: item.message,
      createdAt: item.createdAt,
    }));
    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '문의 내역을 불러오지 못했습니다.' });
  }
});

// ── API: 문의 등록 ────────────────────────────
app.post('/api/inquiries', async (req, res) => {
  try {
    const name = (req.body?.name || '').trim();
    const email = (req.body?.email || '').trim();
    const phone = (req.body?.phone || '').trim();
    const topic = (req.body?.topic || '').trim();
    const optionKey = (req.body?.optionKey || '').trim();
    const message = (req.body?.message || '').trim();

    // 서버에서도 반드시 검증한다. 브라우저 검증은 언제든 우회될 수 있다.
    if (!name) {
      return res.status(400).json({ success: false, message: '이름을 입력해 주세요.' });
    }
    if (name.length > 40) {
      return res.status(400).json({ success: false, message: '이름은 40자까지 입력할 수 있습니다.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: '이메일 형식을 확인해 주세요.' });
    }
    if (phone && !/^[0-9+\-\s()]{7,20}$/.test(phone)) {
      return res.status(400).json({ success: false, message: '연락처 형식을 확인해 주세요.' });
    }
    if (!TOPICS.includes(topic)) {
      return res.status(400).json({ success: false, message: '문의 유형을 선택해 주세요.' });
    }
    if (optionKey && !PRODUCT.options.some(o => o.key === optionKey)) {
      return res.status(400).json({ success: false, message: '존재하지 않는 옵션입니다.' });
    }
    if (message.length < 5) {
      return res.status(400).json({ success: false, message: '문의 내용을 5자 이상 적어 주세요.' });
    }
    if (message.length > 1000) {
      return res.status(400).json({ success: false, message: '문의 내용은 1000자까지 입력할 수 있습니다.' });
    }

    // 값은 항상 파라미터로 넘긴다 (문자열을 이어붙이면 SQL 인젝션에 뚫린다)
    const { rows } = await pool.query(
      `INSERT INTO cat_food_inquiries (name, email, phone, topic, option_key, message)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, email, phone || null, topic, optionKey || null, message]
    );
    res.status(201).json({ success: true, data: toInquiry(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '문의를 저장하지 못했습니다.' });
  }
});

// ── API: DB 상태 ──────────────────────────────
// 화면에서 "지금 DB에 문의가 몇 건 쌓였는지" 확인하기 위한 엔드포인트.
// 접속 문자열은 절대 응답에 담지 않는다.
app.get('/api/db-status', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS total,
             MAX(created_at) AS last_created,
             current_database() AS database,
             NOW() AS now
      FROM cat_food_inquiries
    `);
    res.json({ success: true, data: { connected: true, table: 'cat_food_inquiries', ...rows[0] } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'DB 상태를 확인하지 못했습니다.' });
  }
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── 에러 핸들러 ───────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
});

// 로컬: 서버 시작 / Vercel: app export
if (require.main === module) {
  if (!DATABASE_URL) {
    console.warn('⚠️  DATABASE_URL 이 없습니다. .env 파일이나 환경변수를 확인하세요.');
  }
  app.listen(PORT, () => {
    console.log(`고양이 사료 상품페이지 서버 실행 중 → http://localhost:${PORT}`);
  });
}
module.exports = app;
