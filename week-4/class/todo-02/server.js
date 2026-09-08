// ============================================================
// 투두 앱 API 서버 (todo-02) — PostgreSQL 버전
// todo-01 은 txt 파일에 저장했지만, 여기서는 Supabase Postgres 에 저장한다.
// DB 접속 정보는 .env 에만 두고, 브라우저(index.html)로는 절대 내려보내지 않는다.
// 로컬: node server.js  /  Vercel: module.exports 로 서버리스 동작
// ============================================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 6002;

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
    CREATE TABLE IF NOT EXISTS todos (
      id         SERIAL PRIMARY KEY,
      text       TEXT NOT NULL,
      done       BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  dbInitialized = true;
}

// DB 행(snake_case)을 화면이 쓰는 형태(camelCase)로 바꾼다.
const toTodo = row => ({
  id: row.id,
  text: row.text,
  done: row.done,
  createdAt: row.created_at,
});

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

// ── API: 목록 조회 ────────────────────────────
app.get('/api/todos', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM todos ORDER BY id ASC');
    res.json({ success: true, data: rows.map(toTodo) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '할 일을 불러오지 못했습니다.' });
  }
});

// ── API: DB 상태 ──────────────────────────────
// 화면에서 "지금 DB에 몇 건 들어 있는지"를 확인하기 위한 엔드포인트.
// 접속 문자열은 절대 응답에 담지 않는다.
app.get('/api/db-status', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE done)::int AS done,
             MAX(created_at) AS last_created,
             current_database() AS database,
             NOW() AS now
      FROM todos
    `);
    res.json({ success: true, data: { connected: true, table: 'todos', ...rows[0] } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'DB 상태를 확인하지 못했습니다.' });
  }
});

// ── API: 추가 ─────────────────────────────────
app.post('/api/todos', async (req, res) => {
  try {
    const text = (req.body?.text || '').trim();
    if (!text) {
      return res.status(400).json({ success: false, message: '할 일 내용을 입력해 주세요.' });
    }
    if (text.length > 200) {
      return res.status(400).json({ success: false, message: '할 일은 200자까지 입력할 수 있습니다.' });
    }

    // 값은 항상 파라미터로 넘긴다 (문자열을 이어붙이면 SQL 인젝션에 뚫린다)
    const { rows } = await pool.query(
      'INSERT INTO todos (text) VALUES ($1) RETURNING *',
      [text]
    );
    res.status(201).json({ success: true, data: toTodo(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '할 일을 저장하지 못했습니다.' });
  }
});

// ── API: 수정 (완료 토글 / 내용 변경) ─────────
app.patch('/api/todos/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: '올바르지 않은 id 입니다.' });
    }

    const done = typeof req.body?.done === 'boolean' ? req.body.done : null;

    let text = null;
    if (typeof req.body?.text === 'string') {
      text = req.body.text.trim();
      if (!text) {
        return res.status(400).json({ success: false, message: '할 일 내용은 비울 수 없습니다.' });
      }
    }

    if (done === null && text === null) {
      return res.status(400).json({ success: false, message: '수정할 내용이 없습니다.' });
    }

    // COALESCE: 넘어오지 않은($1 이 NULL) 칸은 기존 값을 그대로 둔다.
    const { rows } = await pool.query(
      `UPDATE todos
          SET done = COALESCE($1, done),
              text = COALESCE($2, text)
        WHERE id = $3
        RETURNING *`,
      [done, text, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '할 일을 찾지 못했습니다.' });
    }
    res.json({ success: true, data: toTodo(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '할 일을 수정하지 못했습니다.' });
  }
});

// ── API: 삭제 ─────────────────────────────────
app.delete('/api/todos/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: '올바르지 않은 id 입니다.' });
    }

    const { rows } = await pool.query('DELETE FROM todos WHERE id = $1 RETURNING *', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '할 일을 찾지 못했습니다.' });
    }
    res.json({ success: true, data: toTodo(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '할 일을 삭제하지 못했습니다.' });
  }
});

// ── API: 완료된 항목 전체 삭제 ────────────────
app.delete('/api/todos', async (_req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM todos WHERE done = TRUE');
    res.json({ success: true, data: { deleted: rowCount } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '완료 항목을 삭제하지 못했습니다.' });
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
    console.log(`투두 앱(DB 버전) 서버 실행 중 → http://localhost:${PORT}`);
  });
}
module.exports = app;
