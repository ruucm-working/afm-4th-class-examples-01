// ============================================================
// MOOM · 무움가구 쇼핑몰 API 서버 (Express + PostgreSQL/Supabase)
//  1) 이메일 + 비밀번호 회원가입 / 로그인 (JWT)
//  2) 토스페이먼츠 결제 승인 + 주문 내역 조회 (마이페이지)
//
// DB 접속 주소·토스 시크릿 키는 .env 에만 둔다. 브라우저는 절대 모른다.
// 로컬: node server.js  /  Vercel: module.exports = app 으로 서버리스 동작
// ============================================================
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 6060;

// ── 환경변수 ─────────────────────────────────
// Vercel 등에서 값 끝에 줄바꿈이 붙는 경우가 있어 .trim() 을 건다.
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();

// 토스 시크릿 키는 "절대" 브라우저로 내려보내지 않는다. 이 키가 있어야만 결제를 승인할 수
// 있으므로, 키가 새면 남이 내 상점 이름으로 결제를 승인/취소할 수 있다.
const TOSS_SECRET_KEY = (process.env.TOSS_SECRET_KEY || '').trim();
// 반대로 클라이언트 키는 공개되어도 되는 값이다. 그래도 index.html 에 박아 두지 않고
// /api/config 로 내려줘서, 테스트 상점 → 실제 상점 전환을 .env 하나로 끝낸다.
const TOSS_CLIENT_KEY = (process.env.TOSS_CLIENT_KEY || '').trim();
const TOSS_API = 'https://api.tosspayments.com/v1';

// JWT 서명 비밀키. 이 값이 새면 누구나 아무 사용자인 척 토큰을 만들 수 있다.
const JWT_SECRET = (process.env.JWT_SECRET || '').trim();
const JWT_EXPIRES_IN = '7d';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5, // 서버리스에서 연결이 과하게 늘지 않도록 작게 둔다
});

// ── 상품 카탈로그 (index.html 의 PRODUCTS 와 가격이 같아야 한다) ──
// 가격을 서버가 따로 들고 있는 이유: 브라우저가 보낸 금액을 그대로 믿으면
// "1,290,000원짜리 소파를 100원에 결제" 가 가능해진다. 금액은 항상 서버가 계산한다.
const PRODUCTS = [
  { id: 'sofa-linen',        name: '오슬로 린넨 3인 소파',   price: 1290000, image: 'images/sofa-linen.png',        colors: ['오트밀', '차콜', '샌드'],        stock: 12 },
  { id: 'sofa-leather',      name: '헤이든 가죽 2인 소파',   price: 1740000, image: 'images/sofa-leather.png',      colors: ['카멜', '다크브라운'],            stock: 4 },
  { id: 'chair-lounge',      name: '루미 라운지 체어',       price: 489000,  image: 'images/chair-lounge.png',      colors: ['아이보리 부클레', '모카'],       stock: 21 },
  { id: 'chair-dining',      name: '베른 라탄 다이닝 체어',  price: 168000,  image: 'images/chair-dining.png',      colors: ['내추럴 오크', '블랙 애쉬'],      stock: 60 },
  { id: 'table-dining',      name: '필드 오크 4인 식탁',     price: 890000,  image: 'images/table-dining.png',      colors: ['내추럴', '라이트월넛'],          stock: 8 },
  { id: 'table-coffee',      name: '스톤 라운드 커피테이블', price: 372000,  image: 'images/table-coffee.png',      colors: ['화이트 마블', '블랙 마블'],      stock: 15 },
  { id: 'bed-frame',         name: '무브 저상형 퀸 침대',    price: 1120000, image: 'images/bed-frame.png',         colors: ['오트밀', '그레이'],              stock: 6 },
  { id: 'bed-nightstand',    name: '코어 원목 2단 협탁',     price: 219000,  image: 'images/bed-nightstand.png',    colors: ['오크', '월넛'],                  stock: 33 },
  { id: 'storage-bookshelf', name: '라인 5단 오픈 책장',     price: 328000,  image: 'images/storage-bookshelf.png', colors: ['오크', '화이트'],                stock: 19 },
  { id: 'storage-cabinet',   name: '리플 월넛 사이드보드',   price: 745000,  image: 'images/storage-cabinet.png',   colors: ['월넛', '블랙'],                  stock: 5 },
  { id: 'light-floor',       name: '아크 플로어 램프',       price: 189000,  image: 'images/light-floor.png',       colors: ['매트 블랙', '아이보리'],         stock: 27 },
  { id: 'light-pendant',     name: '윈드 라탄 펜던트',       price: 134000,  image: 'images/light-pendant.png',     colors: ['내추럴 라탄'],                   stock: 41 },
];
const productById = new Map(PRODUCTS.map((p) => [p.id, p]));

const SHIPPING_FEE = 30000;
const FREE_SHIPPING_OVER = 1000000;

// 결제 후 토스가 브라우저를 되돌려 보낼 화면 (해시 라우터 경로)
const AFTER_PAYMENT = {
  success: (orderId) => `/#/orders/${orderId}?paid=1`,
  fail: (orderId, message) =>
    `/#/cart?failed=1${orderId ? `&orderId=${encodeURIComponent(orderId)}` : ''}&message=${encodeURIComponent(message || '결제가 취소되었습니다.')}`,
};

// ── 미들웨어 ─────────────────────────────────
app.use(express.json());
// dotfiles: 'ignore' → /.env 같은 주소로 DB 주소·시크릿 키가 새 나가지 않게 막는다.
app.use(express.static(path.join(__dirname), { dotfiles: 'ignore' }));

// ── DB 준비 (lazy init) ───────────────────────
// 서버리스는 cold start 마다 이 파일이 다시 로드되므로, 플래그로 중복 실행을 막는다.
// 테이블 이름에 moom_ 을 붙여 같은 DB 의 다른 수업 예제와 섞이지 않게 한다.
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS moom_users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      name          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS moom_orders (
      id          TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES moom_users(id) ON DELETE CASCADE,
      items       JSONB   NOT NULL,
      subtotal    INTEGER NOT NULL,
      shipping    INTEGER NOT NULL,
      amount      INTEGER NOT NULL,
      order_name  TEXT    NOT NULL,
      status      TEXT    NOT NULL DEFAULT 'READY',
      payment     JSONB,
      fail_reason JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS moom_orders_user_idx ON moom_orders (user_id, created_at DESC);
  `);
  dbInitialized = true;
}

app.use('/api', async (_req, res, next) => {
  if (!DATABASE_URL) {
    return res.status(503).json({ success: false, message: 'DATABASE_URL 이 없습니다. 서버 .env 를 확인해주세요.' });
  }
  try {
    await initDB();
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '데이터베이스 준비에 실패했습니다.' });
  }
});

// DB 컬럼(snake_case) → 화면에서 쓰는 모양(camelCase).
// TIMESTAMPTZ 를 그대로 받으면 JS Date 로 바뀌며 시간대 때문에 값이 밀릴 수 있어 문자열로 뽑는다.
const ORDER_COLUMNS = `
  id AS "orderId", order_name AS "orderName", items, subtotal, shipping, amount, status,
  payment, fail_reason AS "failReason",
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt",
  to_char(paid_at    AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "paidAt"`;

// ── 작은 도우미들 ─────────────────────────────
const userError = (status, message) => Object.assign(new Error(message), { status, expose: true });
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, createdAt: u.createdAt });

// 토스 API 는 시크릿 키를 Basic 인증의 "아이디" 자리에 넣고 비밀번호는 비운다 → "키:" 를 base64
const tossAuthHeader = () => 'Basic ' + Buffer.from(`${TOSS_SECRET_KEY}:`).toString('base64');

// 주문번호. 토스 규격은 영문/숫자/-/_ 로 6~64자.
const makeOrderId = () =>
  `MOOM-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

const signToken = (user) => jwt.sign({ sub: String(user.id) }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

// 로그인한 사람만 통과시키는 문지기
async function requireAuth(req, _res, next) {
  if (!JWT_SECRET) return next(userError(503, 'JWT_SECRET 이 없습니다. 서버 .env 를 확인해주세요.'));

  const [scheme, token] = String(req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return next(userError(401, '로그인이 필요합니다.'));

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return next(userError(401, '로그인이 만료되었습니다. 다시 로그인해주세요.'));
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, email, name, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt"
         FROM moom_users WHERE id = $1`,
      [payload.sub],
    );
    if (rows.length === 0) return next(userError(401, '탈퇴했거나 없는 계정입니다.'));
    req.user = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

// 내 주문인지 확인하고 꺼내 온다
async function findMyOrder(orderId, userId) {
  const { rows } = await pool.query(
    `SELECT ${ORDER_COLUMNS}, user_id AS "userId" FROM moom_orders WHERE id = $1`,
    [String(orderId || '')],
  );
  const order = rows[0];
  if (!order || order.userId !== userId) throw userError(404, '주문을 찾을 수 없습니다.');
  return order;
}

// 토스 결제 승인 호출 → 주문에 결과를 기록한다.
// 성공/실패 판단과 금액 검증이 모두 여기 모여 있어서, 브라우저에서 부르든
// 토스 리다이렉트로 들어오든 같은 규칙이 적용된다.
async function confirmPayment({ order, paymentKey, amount }) {
  // ① 이미 결제된 주문이면 토스를 다시 부르지 않는다 (새로고침·중복 클릭 방어)
  if (order.status === 'PAID') return { ok: true, order };

  // ② 브라우저가 보낸 금액과 서버가 계산해 둔 금액이 다르면 즉시 중단
  if (Number(amount) !== order.amount) {
    const failReason = { code: 'AMOUNT_MISMATCH', message: '결제 금액이 주문 금액과 다릅니다.' };
    await pool.query(`UPDATE moom_orders SET status = 'FAILED', fail_reason = $2 WHERE id = $1`, [order.orderId, failReason]);
    return { ok: false, status: 400, error: failReason };
  }

  // ③ 토스에 최종 승인 요청. 여기서 성공해야 진짜 결제된 것이다.
  const res = await fetch(`${TOSS_API}/payments/confirm`, {
    method: 'POST',
    headers: {
      Authorization: tossAuthHeader(),
      'Content-Type': 'application/json',
      'Idempotency-Key': `confirm-${order.orderId}`, // 같은 주문을 두 번 승인하지 않도록
    },
    body: JSON.stringify({ paymentKey, orderId: order.orderId, amount: order.amount }),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const failReason = { code: data.code || 'CONFIRM_FAILED', message: data.message || '결제 승인에 실패했습니다.' };
    await pool.query(`UPDATE moom_orders SET status = 'FAILED', fail_reason = $2 WHERE id = $1`, [order.orderId, failReason]);
    return { ok: false, status: res.status, error: failReason };
  }

  const payment = {
    paymentKey: data.paymentKey,
    method: data.method,                       // 카드 · 간편결제 · 계좌이체 …
    approvedAt: data.approvedAt,
    receiptUrl: data.receipt ? data.receipt.url : null,
    cardCompany: data.card ? data.card.issuerCode : null,
    cardNumber: data.card ? data.card.number : null,
    easyPayProvider: data.easyPay ? data.easyPay.provider : null,
  };
  const { rows } = await pool.query(
    `UPDATE moom_orders
        SET status = 'PAID', payment = $2, fail_reason = NULL, paid_at = COALESCE($3::timestamptz, now())
      WHERE id = $1
      RETURNING ${ORDER_COLUMNS}`,
    [order.orderId, payment, data.approvedAt || null],
  );
  return { ok: true, order: rows[0] };
}

// ============================================================
// 설정
// ============================================================

// GET /api/config — 브라우저가 토스 SDK 를 켤 때 필요한 "공개" 키만 내려준다
app.get('/api/config', (_req, res) => {
  res.json({
    success: true,
    data: {
      tossClientKey: TOSS_CLIENT_KEY,
      shippingFee: SHIPPING_FEE,
      freeShippingOver: FREE_SHIPPING_OVER,
      paymentEnabled: Boolean(TOSS_CLIENT_KEY && TOSS_SECRET_KEY),
    },
  });
});

// ============================================================
// 회원가입 · 로그인 (JWT)
// ============================================================

// POST /api/auth/signup — body: { email, password, name }
app.post('/api/auth/signup', async (req, res, next) => {
  try {
    if (!JWT_SECRET) throw userError(503, 'JWT_SECRET 이 없습니다. 서버 .env 를 확인해주세요.');

    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const name = String(req.body?.name || '').trim() || email.split('@')[0];

    if (!isEmail(email)) throw userError(400, '이메일 형식이 올바르지 않습니다.');
    if (password.length < 8) throw userError(400, '비밀번호는 8자 이상이어야 합니다.');
    if (name.length > 20) throw userError(400, '이름은 20자 이하로 입력해주세요.');

    // 비밀번호는 원문 대신 bcrypt 해시로만 저장한다 (DB 가 털려도 원문은 모른다)
    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO moom_users (email, name, password_hash)
            VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING
         RETURNING id, email, name,
                   to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt"`,
      [email, name, passwordHash],
    );
    // ON CONFLICT DO NOTHING → 행이 안 돌아오면 이미 가입된 이메일
    if (rows.length === 0) throw userError(409, '이미 가입된 이메일입니다.');

    const user = rows[0];
    res.status(201).json({ success: true, data: { token: signToken(user), user: publicUser(user) } });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login — body: { email, password }
app.post('/api/auth/login', async (req, res, next) => {
  try {
    if (!JWT_SECRET) throw userError(503, 'JWT_SECRET 이 없습니다. 서버 .env 를 확인해주세요.');

    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const { rows } = await pool.query(
      `SELECT id, email, name, password_hash,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt"
         FROM moom_users WHERE email = $1`,
      [email],
    );
    const user = rows[0];

    // 이메일이 없는 건지 비밀번호가 틀린 건지 알려주지 않는다 (계정 존재 여부 유출 방지)
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) throw userError(401, '이메일 또는 비밀번호가 올바르지 않습니다.');

    res.json({ success: true, data: { token: signToken(user), user: publicUser(user) } });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me — 토큰으로 내 정보 확인 (새로고침 시 로그인 유지용)
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, data: { user: publicUser(req.user) } });
});

// ============================================================
// 주문 · 결제
// ============================================================

// POST /api/orders — 결제 직전에 "주문서"를 먼저 만든다.
// body: { items: [{ id, color, qty }] }
// 응답의 orderId · amount 를 그대로 토스 SDK 에 넘겨야 승인 단계에서 금액 검증이 통과한다.
app.post('/api/orders', requireAuth, async (req, res, next) => {
  try {
    const raw = Array.isArray(req.body?.items) ? req.body.items : [];
    if (raw.length === 0) throw userError(400, '장바구니가 비어 있습니다.');
    if (raw.length > 50) throw userError(400, '한 번에 최대 50종까지 주문할 수 있습니다.');

    const items = raw.map((line) => {
      const product = productById.get(String(line?.id || ''));
      if (!product) throw userError(400, `없는 상품입니다: ${line?.id}`);

      const qty = Number(line?.qty);
      if (!Number.isInteger(qty) || qty < 1) throw userError(400, `${product.name} 의 수량이 올바르지 않습니다.`);
      if (qty > product.stock) throw userError(409, `${product.name} 은(는) 현재 ${product.stock}개까지 주문할 수 있습니다.`);

      const color = String(line?.color || product.colors[0]);
      if (!product.colors.includes(color)) throw userError(400, `${product.name} 에 없는 색상입니다: ${color}`);

      // 가격은 클라이언트가 보낸 값을 버리고 서버 카탈로그에서 가져온다
      return { id: product.id, name: product.name, image: product.image, color, qty, price: product.price };
    });

    const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
    const shipping = subtotal >= FREE_SHIPPING_OVER ? 0 : SHIPPING_FEE;
    const head = items[0].name;
    const orderName = (items.length > 1 ? `${head} 외 ${items.length - 1}건` : head).slice(0, 100); // 토스 100자 제한

    const { rows } = await pool.query(
      `INSERT INTO moom_orders (id, user_id, items, subtotal, shipping, amount, order_name, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY')
         RETURNING ${ORDER_COLUMNS}`,
      [makeOrderId(), req.user.id, JSON.stringify(items), subtotal, shipping, subtotal + shipping, orderName],
    );

    res.status(201).json({
      success: true,
      data: {
        ...rows[0],
        // 토스 SDK 에 그대로 넘기는 값들
        customerKey: `user-${req.user.id}`,
        customerName: req.user.name,
        customerEmail: req.user.email,
        successUrl: '/api/payments/success',
        failUrl: '/api/payments/fail',
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/orders — 마이페이지 주문 내역 (최신순).
// 기본은 "결제된 내역" 이므로, 결제창만 열고 만 주문(READY)은 숨긴다.
// ?status=PAID · FAILED 로 콕 집어 보거나, ?status=all 로 전부 볼 수 있다.
app.get('/api/orders', requireAuth, async (req, res, next) => {
  try {
    const status = String(req.query.status || '').toUpperCase();
    const { rows } = await pool.query(
      `SELECT ${ORDER_COLUMNS}
         FROM moom_orders
        WHERE user_id = $1
          AND CASE
                WHEN $2::text = 'ALL' THEN TRUE
                WHEN $2::text <> ''   THEN status = $2::text
                ELSE status <> 'READY'
              END
        ORDER BY created_at DESC`,
      [req.user.id, status],
    );

    const paid = rows.filter((o) => o.status === 'PAID');
    res.json({
      success: true,
      data: rows,
      summary: { count: rows.length, paidCount: paid.length, paidTotal: paid.reduce((sum, o) => sum + o.amount, 0) },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/orders/:orderId — 주문 한 건 상세
app.get('/api/orders/:orderId', requireAuth, async (req, res, next) => {
  try {
    const { userId, ...order } = await findMyOrder(req.params.orderId, req.user.id);
    res.json({ success: true, data: order });
  } catch (err) {
    next(err);
  }
});

// GET /api/payments/success — 토스가 결제창을 닫고 브라우저를 여기로 되돌려 보낸다.
// 리다이렉트에는 Authorization 헤더를 붙일 수 없으므로, 토스만 알려줄 수 있는
// paymentKey + 서버가 들고 있는 주문 금액으로 검증한다.
app.get('/api/payments/success', async (req, res, next) => {
  const { paymentKey, orderId, amount } = req.query;
  try {
    const { rows } = await pool.query(`SELECT ${ORDER_COLUMNS} FROM moom_orders WHERE id = $1`, [String(orderId || '')]);
    if (rows.length === 0) throw userError(404, '주문을 찾을 수 없습니다.');

    const result = await confirmPayment({ order: rows[0], paymentKey: String(paymentKey || ''), amount });
    if (!result.ok) return res.redirect(AFTER_PAYMENT.fail(rows[0].orderId, result.error.message));

    res.redirect(AFTER_PAYMENT.success(rows[0].orderId));
  } catch (err) {
    if (err.expose) return res.redirect(AFTER_PAYMENT.fail(orderId, err.message));
    next(err);
  }
});

// GET /api/payments/fail — 사용자가 결제창을 닫거나 카드사에서 거절당한 경우
app.get('/api/payments/fail', async (req, res, next) => {
  const { orderId, code, message } = req.query;
  try {
    await pool.query(
      `UPDATE moom_orders SET status = 'FAILED', fail_reason = $2 WHERE id = $1 AND status = 'READY'`,
      [String(orderId || ''), { code: String(code || 'PAY_PROCESS_CANCELED'), message: String(message || '결제가 취소되었습니다.') }],
    );
    res.redirect(AFTER_PAYMENT.fail(orderId, message));
  } catch (err) {
    next(err);
  }
});

// POST /api/payments/confirm — 리다이렉트 대신 브라우저에서 직접 승인하고 싶을 때.
// body: { paymentKey, orderId, amount }
app.post('/api/payments/confirm', requireAuth, async (req, res, next) => {
  try {
    const { paymentKey, orderId, amount } = req.body || {};
    if (!paymentKey || !orderId) throw userError(400, 'paymentKey 와 orderId 가 필요합니다.');

    const { userId, ...order } = await findMyOrder(orderId, req.user.id);
    const result = await confirmPayment({ order, paymentKey: String(paymentKey), amount });
    if (!result.ok) {
      return res.status(result.status || 400).json({ success: false, message: result.error.message, code: result.error.code });
    }
    res.json({ success: true, data: result.order });
  } catch (err) {
    next(err);
  }
});

// ── API 404 (여기까지 안 걸리면 없는 엔드포인트) ──
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: '없는 API 주소입니다.' });
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── 에러 핸들러 ───────────────────────────────
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err); // 스택 트레이스는 서버 로그에만
  res.status(status).json({
    success: false,
    message: err.expose ? err.message : '서버에서 문제가 발생했습니다.',
  });
});

// ── 시작 & export ─────────────────────────────
if (require.main === module) {
  if (!DATABASE_URL) console.warn('⚠️  DATABASE_URL 이 비어 있습니다 — 모든 /api 요청이 503 으로 막힙니다.');
  if (!JWT_SECRET) console.warn('⚠️  JWT_SECRET 이 비어 있습니다 — 회원가입/로그인이 503 으로 막힙니다.');
  if (!TOSS_SECRET_KEY || !TOSS_CLIENT_KEY) console.warn('⚠️  토스 키가 비어 있습니다 — 결제가 동작하지 않습니다.');
  app.listen(PORT, () => console.log(`MOOM 서버 실행 중 → http://localhost:${PORT}`));
}
module.exports = app;
