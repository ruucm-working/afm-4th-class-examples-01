// ============================================================
// 포켓몬 도감 API 서버
// PokéAPI 대신 이 서버가 도감 데이터를 직접 제공한다.
// 로컬: node server.js  /  Vercel: module.exports 로 서버리스 동작
// ============================================================
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── 이미지 경로 ──────────────────────────────
// 도트/일러스트 이미지는 아직 외부 스프라이트를 그대로 링크한다.
// 직접 이미지를 준비하면 이 두 함수만 바꾸면 된다.
const SPRITE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';
const spriteUrl = id => `${SPRITE_BASE}/${id}.png`;
const artworkUrl = id => `${SPRITE_BASE}/other/official-artwork/${id}.png`;

// ── 인메모리 데이터 ──────────────────────────
// 타입 슬러그 → 한국어 이름
const TYPE_NAMES = {
  normal: '노말', fighting: '격투', flying: '비행', poison: '독',
  ground: '땅', rock: '바위', bug: '벌레', ghost: '고스트',
  steel: '강철', fire: '불꽃', water: '물', grass: '풀',
  electric: '전기', psychic: '에스퍼', ice: '얼음', dragon: '드래곤',
  dark: '악', fairy: '페어리',
};

// 종족값 슬러그 → 한국어 라벨 (표시 순서도 이 순서를 따른다)
const STAT_LABELS = {
  hp: 'HP',
  attack: '공격',
  defense: '방어',
  'special-attack': '특수공격',
  'special-defense': '특수방어',
  speed: '스피드',
};

// 준비된 포켓몬 데이터 (10마리). 여기에 객체를 추가하면 도감 후보가 늘어난다.
const ALL_POKEMONS = [
  {
    id: 1, name: '이상해씨', enName: 'bulbasaur', genus: '씨앗포켓몬',
    types: ['grass', 'poison'],
    abilities: [{ slug: 'overgrow', name: '심록' }, { slug: 'chlorophyll', name: '엽록소', hidden: true }],
    description: '태어났을 때부터 등에 이상한 씨앗이 심어져 있으며 몸과 함께 씨앗도 자란다고 한다.',
    height: 0.7, weight: 6.9,
    baseStats: { hp: 45, attack: 49, defense: 49, 'special-attack': 65, 'special-defense': 65, speed: 45 },
  },
  {
    id: 2, name: '이상해풀', enName: 'ivysaur', genus: '씨앗포켓몬',
    types: ['grass', 'poison'],
    abilities: [{ slug: 'overgrow', name: '심록' }, { slug: 'chlorophyll', name: '엽록소', hidden: true }],
    description: '등의 봉오리가 커지면 두 다리로 버티고 서는 힘이 강해진다. 햇볕을 쬐는 시간도 길어진다.',
    height: 1.0, weight: 13.0,
    baseStats: { hp: 60, attack: 62, defense: 63, 'special-attack': 80, 'special-defense': 80, speed: 60 },
  },
  {
    id: 3, name: '이상해꽃', enName: 'venusaur', genus: '씨앗포켓몬',
    types: ['grass', 'poison'],
    abilities: [{ slug: 'overgrow', name: '심록' }, { slug: 'chlorophyll', name: '엽록소', hidden: true }],
    description: '등의 꽃이 태양 에너지를 흡수한다. 꽃의 향기는 사람의 마음을 편안하게 만든다.',
    height: 2.0, weight: 100.0,
    baseStats: { hp: 80, attack: 82, defense: 83, 'special-attack': 100, 'special-defense': 100, speed: 80 },
  },
  {
    id: 4, name: '파이리', enName: 'charmander', genus: '도마뱀포켓몬',
    types: ['fire'],
    abilities: [{ slug: 'blaze', name: '맹화' }, { slug: 'solar-power', name: '선파워', hidden: true }],
    description: '태어날 때부터 꼬리에 불꽃이 타오른다. 불꽃이 꺼지면 생명도 끝난다고 전해진다.',
    height: 0.6, weight: 8.5,
    baseStats: { hp: 39, attack: 52, defense: 43, 'special-attack': 60, 'special-defense': 50, speed: 65 },
  },
  {
    id: 5, name: '리자드', enName: 'charmeleon', genus: '화염포켓몬',
    types: ['fire'],
    abilities: [{ slug: 'blaze', name: '맹화' }, { slug: 'solar-power', name: '선파워', hidden: true }],
    description: '강한 상대를 만나면 흥분해서 꼬리의 불꽃이 푸르스름하게 타오른다.',
    height: 1.1, weight: 19.0,
    baseStats: { hp: 58, attack: 64, defense: 58, 'special-attack': 80, 'special-defense': 65, speed: 80 },
  },
  {
    id: 6, name: '리자몽', enName: 'charizard', genus: '화염포켓몬',
    types: ['fire', 'flying'],
    abilities: [{ slug: 'blaze', name: '맹화' }, { slug: 'solar-power', name: '선파워', hidden: true }],
    description: '거대한 날개로 하늘 높이 날아오른다. 강한 상대에게만 뜨거운 불꽃을 내뿜는다.',
    height: 1.7, weight: 90.5,
    baseStats: { hp: 78, attack: 84, defense: 78, 'special-attack': 109, 'special-defense': 85, speed: 100 },
  },
  {
    id: 7, name: '꼬부기', enName: 'squirtle', genus: '꼬마거북포켓몬',
    types: ['water'],
    abilities: [{ slug: 'torrent', name: '급류' }, { slug: 'rain-dish', name: '젖은접시', hidden: true }],
    description: '등껍질에 몸을 숨기고 물을 내뿜는다. 껍질은 몸을 지키면서 물속에서의 저항도 줄여 준다.',
    height: 0.5, weight: 9.0,
    baseStats: { hp: 44, attack: 48, defense: 65, 'special-attack': 50, 'special-defense': 64, speed: 43 },
  },
  {
    id: 8, name: '어니부기', enName: 'wartortle', genus: '거북포켓몬',
    types: ['water'],
    abilities: [{ slug: 'torrent', name: '급류' }, { slug: 'rain-dish', name: '젖은접시', hidden: true }],
    description: '털이 많은 꼬리로 균형을 잡아 헤엄이 빠르다. 오래 산 개체일수록 꼬리 색이 짙어진다.',
    height: 1.0, weight: 22.5,
    baseStats: { hp: 59, attack: 63, defense: 80, 'special-attack': 65, 'special-defense': 80, speed: 58 },
  },
  {
    id: 9, name: '거북왕', enName: 'blastoise', genus: '조개포켓몬',
    types: ['water'],
    abilities: [{ slug: 'torrent', name: '급류' }, { slug: 'rain-dish', name: '젖은접시', hidden: true }],
    description: '등껍질의 물대포에서 강력한 물줄기를 쏜다. 무거운 몸으로 상대를 눌러 버리기도 한다.',
    height: 1.6, weight: 85.5,
    baseStats: { hp: 79, attack: 83, defense: 100, 'special-attack': 85, 'special-defense': 105, speed: 78 },
  },
  {
    id: 10, name: '캐터피', enName: 'caterpie', genus: '벌레포켓몬',
    types: ['bug'],
    abilities: [{ slug: 'shield-dust', name: '인분' }, { slug: 'run-away', name: '도주', hidden: true }],
    description: '머리의 더듬이에서 지독한 냄새를 내뿜어 적을 쫓아낸다. 나뭇잎을 아주 좋아한다.',
    height: 0.3, weight: 2.9,
    baseStats: { hp: 45, attack: 30, defense: 35, 'special-attack': 20, 'special-defense': 20, speed: 45 },
  },
];

// 지금은 도감에 딱 1마리만 노출한다.
// 숫자를 늘리면 그만큼, ALL_POKEMONS.length 로 두면 준비된 전부가 나온다.
const DEX_SIZE = 1;
let pokemons = ALL_POKEMONS.slice(0, DEX_SIZE);

// ── 응답 변환 헬퍼 ───────────────────────────
const toTypes = slugs => slugs.map(slug => ({ slug, name: TYPE_NAMES[slug] || slug }));

// 목록 카드에 필요한 최소 정보만
function toSummary(p) {
  return {
    id: p.id,
    name: p.name,
    enName: p.enName,
    genus: p.genus,
    types: toTypes(p.types),
    sprite: spriteUrl(p.id),
    artwork: artworkUrl(p.id),
  };
}

// 상세 모달용 전체 정보
function toDetail(p) {
  const stats = Object.keys(STAT_LABELS).map(slug => ({
    slug,
    label: STAT_LABELS[slug],
    value: p.baseStats[slug] || 0,
  }));
  return {
    ...toSummary(p),
    abilities: p.abilities.map(a => ({ slug: a.slug, name: a.name, hidden: !!a.hidden })),
    description: p.description,
    height: p.height,
    weight: p.weight,
    stats,
    total: stats.reduce((sum, s) => sum + s.value, 0),
  };
}

// ── 미들웨어 ─────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── API 라우트 ───────────────────────────────
// 타입 목록 (필터 칩 등에 사용)
app.get('/api/types', (_req, res) => {
  const data = Object.keys(TYPE_NAMES).map(slug => ({ slug, name: TYPE_NAMES[slug] }));
  res.json({ success: true, data });
});

// 도감 목록 — ?search=파이리 · ?type=fire 로 서버에서도 걸러낼 수 있다
app.get('/api/pokemon', (req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase();
  const type = String(req.query.type || '').trim().toLowerCase();
  const numeric = search.replace(/[^0-9]/g, '').replace(/^0+/, ''); // '#0004' -> '4'

  const data = pokemons
    .filter(p => !type || type === 'all' || p.types.includes(type))
    .filter(p => {
      if (!search) return true;
      return (
        p.name.toLowerCase().includes(search) ||
        p.enName.toLowerCase().includes(search) ||
        (numeric && String(p.id).includes(numeric))
      );
    })
    .sort((a, b) => a.id - b.id)
    .map(toSummary);

  res.json({ success: true, data, total: data.length });
});

// 개별 포켓몬 상세 — 도감 번호 또는 영문 이름으로 조회
app.get('/api/pokemon/:idOrName', (req, res) => {
  const key = String(req.params.idOrName).toLowerCase();
  const found = pokemons.find(p => String(p.id) === key || p.enName === key);

  if (!found) {
    return res.status(404).json({ success: false, message: `포켓몬을 찾을 수 없습니다: ${req.params.idOrName}` });
  }
  res.json({ success: true, data: toDetail(found) });
});

// 새 포켓몬 등록 — 도감을 직접 늘려 볼 때 사용 (서버 재시작하면 초기화)
app.post('/api/pokemon', (req, res) => {
  const { name, enName, types } = req.body || {};
  if (!name || !enName || !Array.isArray(types) || types.length === 0) {
    return res.status(400).json({ success: false, message: 'name, enName, types 는 필수입니다' });
  }

  const id = Number(req.body.id) || Math.max(0, ...pokemons.map(p => p.id)) + 1;
  if (pokemons.some(p => p.id === id)) {
    return res.status(400).json({ success: false, message: `이미 존재하는 도감 번호입니다: ${id}` });
  }

  const created = {
    id,
    name,
    enName: String(enName).toLowerCase(),
    genus: req.body.genus || '',
    types,
    abilities: Array.isArray(req.body.abilities) ? req.body.abilities : [],
    description: req.body.description || '설명이 등록되지 않은 포켓몬입니다.',
    height: Number(req.body.height) || 0,
    weight: Number(req.body.weight) || 0,
    baseStats: {
      hp: 0, attack: 0, defense: 0,
      'special-attack': 0, 'special-defense': 0, speed: 0,
      ...(req.body.baseStats || {}),
    },
  };
  pokemons.push(created);
  res.status(201).json({ success: true, data: toDetail(created) });
});

// ── SPA fallback (Express 5 문법) ────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── 에러 핸들러 ──────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: '서버 내부 오류가 발생했습니다' });
});

// 로컬 실행 / Vercel 서버리스 듀얼 모드
if (require.main === module) {
  app.listen(PORT, () => console.log(`포켓몬 도감 서버: http://localhost:${PORT}`));
}
module.exports = app;
