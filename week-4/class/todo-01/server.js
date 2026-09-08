// ============================================================
// 투두 앱 API 서버
// 할 일을 추가하면 같은 폴더의 todos.txt 파일에 저장된다.
// 서버를 껐다 켜도 todos.txt 를 다시 읽어서 목록을 복원한다.
// 로컬: node server.js  /  Vercel: module.exports 로 서버리스 동작
// ============================================================
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 6003;

// ── 저장 파일 경로 ────────────────────────────
// Vercel 서버리스는 프로젝트 폴더가 읽기 전용이라 /tmp 에만 쓸 수 있다.
// 로컬에서는 프로젝트 폴더 안 todos.txt 에 그대로 저장된다.
const DATA_FILE = process.env.VERCEL
  ? path.join('/tmp', 'todos.txt')
  : path.join(__dirname, 'todos.txt');

// ── 인메모리 저장소 ───────────────────────────
// 파일이 원본, 메모리는 빠르게 읽기 위한 사본이다.
let todos = [];
let nextId = 1;

// ── txt 파일 포맷 ─────────────────────────────
// 한 줄에 하나의 할 일. ' | ' 로 구분한다.
//   1 | 2026-09-08 21:30 | 진행중 | 우유 사기
const HEADER = [
  '# 투두 목록 (이 파일은 서버가 자동으로 관리합니다)',
  '# 형식: 번호 | 등록시각 | 상태 | 할 일',
  '',
].join('\n');

// 날짜를 "2026-09-08 21:30" 형태로 만든다.
function formatDate(iso) {
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 메모리의 todos 를 txt 파일로 통째로 다시 쓴다.
function saveToFile() {
  const lines = todos.map(t =>
    [t.id, formatDate(t.createdAt), t.done ? '완료' : '진행중', t.text].join(' | ')
  );
  fs.writeFileSync(DATA_FILE, HEADER + lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
}

// 서버가 켜질 때 txt 파일을 읽어 목록을 복원한다.
function loadFromFile() {
  if (!fs.existsSync(DATA_FILE)) return;

  const lines = fs.readFileSync(DATA_FILE, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue; // 빈 줄과 주석은 건너뛴다

    // 할 일 내용에 ' | ' 가 들어갈 수 있으므로 앞 3칸만 떼어내고 나머지는 다시 붙인다.
    const parts = trimmed.split(' | ');
    if (parts.length < 4) continue;
    const [rawId, rawDate, rawStatus, ...rest] = parts;

    const id = Number(rawId);
    if (!Number.isFinite(id)) continue;

    todos.push({
      id,
      text: rest.join(' | '),
      done: rawStatus === '완료',
      createdAt: new Date(rawDate.replace(' ', 'T')).toISOString(),
    });
    nextId = Math.max(nextId, id + 1);
  }
  console.log(`todos.txt 에서 ${todos.length}개의 할 일을 불러왔습니다.`);
}

loadFromFile();

// ── 미들웨어 ──────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── API: 목록 조회 ────────────────────────────
app.get('/api/todos', (_req, res) => {
  res.json({ success: true, data: todos });
});

// ── API: txt 파일 원본 보기 ───────────────────
// 화면에서 "지금 저장된 파일"을 그대로 확인하기 위한 엔드포인트.
app.get('/api/todos/file', (_req, res) => {
  try {
    const content = fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE, 'utf8') : '';
    res.json({ success: true, data: { fileName: path.basename(DATA_FILE), content } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '파일을 읽지 못했습니다.' });
  }
});

// ── API: 추가 ─────────────────────────────────
app.post('/api/todos', (req, res) => {
  try {
    const text = (req.body?.text || '').trim();
    if (!text) {
      return res.status(400).json({ success: false, message: '할 일 내용을 입력해 주세요.' });
    }
    if (text.length > 200) {
      return res.status(400).json({ success: false, message: '할 일은 200자까지 입력할 수 있습니다.' });
    }

    const todo = { id: nextId++, text, done: false, createdAt: new Date().toISOString() };
    todos.push(todo);
    saveToFile();

    res.status(201).json({ success: true, data: todo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '할 일을 저장하지 못했습니다.' });
  }
});

// ── API: 수정 (완료 토글 / 내용 변경) ─────────
app.patch('/api/todos/:id', (req, res) => {
  try {
    const todo = todos.find(t => t.id === Number(req.params.id));
    if (!todo) {
      return res.status(404).json({ success: false, message: '할 일을 찾지 못했습니다.' });
    }

    if (typeof req.body?.done === 'boolean') todo.done = req.body.done;

    if (typeof req.body?.text === 'string') {
      const text = req.body.text.trim();
      if (!text) {
        return res.status(400).json({ success: false, message: '할 일 내용은 비울 수 없습니다.' });
      }
      todo.text = text;
    }

    saveToFile();
    res.json({ success: true, data: todo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '할 일을 수정하지 못했습니다.' });
  }
});

// ── API: 삭제 ─────────────────────────────────
app.delete('/api/todos/:id', (req, res) => {
  try {
    const index = todos.findIndex(t => t.id === Number(req.params.id));
    if (index === -1) {
      return res.status(404).json({ success: false, message: '할 일을 찾지 못했습니다.' });
    }

    const [removed] = todos.splice(index, 1);
    saveToFile();

    res.json({ success: true, data: removed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '할 일을 삭제하지 못했습니다.' });
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
  app.listen(PORT, () => {
    console.log(`투두 앱 서버 실행 중 → http://localhost:${PORT}`);
    console.log(`저장 파일: ${DATA_FILE}`);
  });
}
module.exports = app;
