// ============================================================
// 상상공작소 API 서버
// 브라우저는 fal.ai 키를 절대 보지 않는다. 이 서버가 대신 호출한다.
// 로컬: node server.js  /  Vercel: module.exports 로 서버리스 동작
// ============================================================
const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 6002;

// ── 환경변수 ─────────────────────────────────
// 키는 .env 에만 둔다. index.html 에 적으면 접속자 모두에게 노출된다.
// Vercel 등에서 값 끝에 줄바꿈이 붙는 경우가 있어 .trim() 을 건다.
const FAL_KEY = (process.env.FAL_KEY || '').trim();
const FAL_BASE = 'https://fal.run';

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

// ── 모델 카탈로그 ─────────────────────────────
// 여기에 항목을 추가하면 화면의 모델 선택지도 함께 늘어난다.
const MODELS = {
  schnell: {
    id: 'fal-ai/flux/schnell',
    label: '플럭스 슈넬',
    hint: '가장 빠름 · 4장에 약 2초',
    steps: 4,
    guidance: false,
    maxImages: 4,
  },
  dev: {
    id: 'fal-ai/flux/dev',
    label: '플럭스 디브이',
    hint: '고품질 · 장당 약 4초',
    steps: 28,
    guidance: true,
    maxImages: 4,
  },
};

// 한국어 프롬프트를 영어로 옮길 때 쓰는 LLM
const TRANSLATE_MODEL = 'google/gemini-flash-1.5';
const TRANSLATE_SYSTEM =
  'You turn a Korean image request into one vivid English image-generation prompt. ' +
  'Keep every subject, mood and detail the user asked for. Do not add a style that was not requested. ' +
  'Reply with ONLY the English prompt, no quotes, no explanation, under 60 words.';

// ── 스타일 프리셋 → 영어 화풍 지시어 ──────────
// FLUX 는 영어로 학습된 모델이라, 화풍은 영어 키워드로 붙여야 잘 먹는다.
const STYLE_SUFFIX = {
  photo: 'photorealistic, 35mm photograph, natural lighting, shallow depth of field, highly detailed',
  anime: 'anime illustration, cel shaded, vibrant colors, studio anime key visual',
  render3d: '3D render, octane render, soft studio lighting, subsurface scattering, glossy materials',
  oil: 'oil painting, thick impasto brush strokes, visible canvas texture, classical fine art',
  cyber: 'cyberpunk, neon signage, rain soaked streets, volumetric fog, cinematic teal and magenta',
  minimal: 'minimalist composition, generous negative space, muted palette, clean lines, editorial design',
};

// 화면의 비율 선택 → fal 의 image_size 값
const IMAGE_SIZE = {
  '1:1': 'square_hd',
  '3:2': 'landscape_4_3',
  '2:3': 'portrait_4_3',
  '16:9': 'landscape_16_9',
};

// 한글이 한 글자라도 섞여 있으면 번역 대상으로 본다
const hasHangul = (text) => /[ㄱ-ㆎ가-힣]/.test(text);

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

app.use(express.static(path.join(__dirname), {
  index: 'index.html',
  dotfiles: 'deny',
}));

// ── fal.ai 호출 공통 함수 ─────────────────────
async function callFal(endpoint, payload) {
  const res = await fetch(`${FAL_BASE}/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${FAL_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    data = { message: raw.slice(0, 300) };
  }

  if (!res.ok) {
    const detail = data && data.detail;
    const message =
      (Array.isArray(detail) && detail[0] && detail[0].msg) ||
      (typeof detail === 'string' && detail) ||
      data.error ||
      data.message ||
      `fal.ai 요청이 실패했어요 (HTTP ${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

// 한국어 → 영어 이미지 프롬프트
async function translatePrompt(korean) {
  const out = await callFal('fal-ai/any-llm', {
    model: TRANSLATE_MODEL,
    system_prompt: TRANSLATE_SYSTEM,
    prompt: korean,
  });
  const text = String(out.output || '').trim().replace(/^["']|["']$/g, '');
  return text || korean; // 번역이 비면 원문 그대로 보낸다
}

// ── API routes ───────────────────────────────

// GET /api/config — 화면이 켜질 때 "실제 생성이 가능한 상태인가"를 확인한다.
// 키 값 자체는 절대 내려보내지 않고, 있는지 여부(hasKey)만 알려준다.
app.get('/api/config', (_req, res) => {
  res.json({
    success: true,
    data: {
      hasKey: Boolean(FAL_KEY),
      models: Object.keys(MODELS).map((key) => ({
        value: key,
        label: MODELS[key].label,
        hint: MODELS[key].hint,
        guidance: MODELS[key].guidance,
        maxImages: MODELS[key].maxImages,
      })),
    },
  });
});

// POST /api/generate — 실제 이미지 생성.
// body: { prompt, styleKey, aspect, count, model, stylize, seed, translate }
app.post('/api/generate', async (req, res, next) => {
  if (!FAL_KEY) {
    return res.status(503).json({
      success: false,
      message: 'FAL_KEY 가 없습니다. .env 파일에 키를 넣고 서버를 다시 켜주세요.',
    });
  }

  const body = req.body || {};
  const prompt = String(body.prompt || '').trim();
  if (!prompt) {
    return res.status(400).json({ success: false, message: '프롬프트를 입력해주세요.' });
  }

  const spec = MODELS[body.model] || MODELS.schnell;
  const startedAt = Date.now();

  try {
    // 1) 한글이면 영어로 옮긴다
    let englishPrompt = prompt;
    let translatedFrom = null;
    if (body.translate !== false && hasHangul(prompt)) {
      englishPrompt = await translatePrompt(prompt);
      translatedFrom = prompt;
    }

    // 2) 스타일 지시어를 붙여 최종 프롬프트를 만든다
    const suffix = STYLE_SUFFIX[body.styleKey] || '';
    const finalPrompt = suffix ? `${englishPrompt}, ${suffix}` : englishPrompt;

    // 3) fal.ai 에 넘길 요청 본문
    const payload = {
      prompt: finalPrompt,
      image_size: IMAGE_SIZE[body.aspect] || 'square_hd',
      num_images: clamp(Number(body.count) || 1, 1, spec.maxImages),
      num_inference_steps: spec.steps,
      enable_safety_checker: true,
    };

    // 스타일화 슬라이더(0~1000)를 guidance_scale(1.5~7.0)로 옮긴다. 슈넬은 이 값을 받지 않는다.
    if (spec.guidance) {
      const stylize = clamp(Number(body.stylize) || 0, 0, 1000);
      payload.guidance_scale = Number((1.5 + (stylize / 1000) * 5.5).toFixed(2));
    }

    // 시드를 고정하면 같은 프롬프트로 같은 그림을 다시 만들 수 있다
    if (body.seed !== null && body.seed !== undefined && body.seed !== '' && Number.isFinite(Number(body.seed))) {
      payload.seed = Number(body.seed);
    }

    const falResult = await callFal(spec.id, payload);

    res.json({
      success: true,
      data: {
        images: (falResult.images || []).map((image, index) => ({
          index,
          url: image.url,
          width: image.width,
          height: image.height,
        })),
        seed: falResult.seed === undefined ? null : falResult.seed,
        finalPrompt,
        translatedFrom,
        model: spec.id,
        modelLabel: spec.label,
        elapsedMs: Date.now() - startedAt,
      },
    });
  } catch (err) {
    next(err); // 아래 에러 핸들러가 상태 코드에 맞는 안내로 바꿔 내려준다
  }
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

  // 자주 만나는 실패는 무슨 일인지 알아볼 수 있게 바꿔서 내려준다
  let message = err.message || '서버에서 문제가 생겼어요.';
  if (status === 401 || status === 403) message = 'fal.ai 키가 거부됐어요. .env 의 FAL_KEY 를 확인해주세요.';
  else if (status === 429) message = '요청이 너무 잦거나 크레딧이 부족해요. 잠시 뒤 다시 시도해주세요.';
  else if (status === 422) message = '요청 형식이 맞지 않아요. 프롬프트나 옵션을 바꿔서 다시 시도해주세요.';
  else if (status === 500) message = '이미지를 만들지 못했어요. 잠시 뒤 다시 시도해주세요.';

  console.error('[에러]', status, err.message);
  res.status(status).json({ success: false, message });
});

// ── Startup & export ─────────────────────────
// 로컬에서 직접 실행할 때만 포트를 연다 (Vercel 에서는 module.exports 만 쓴다)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`상상공작소 서버 실행 중 → http://localhost:${PORT}`);
    if (!FAL_KEY) {
      console.log('⚠️  FAL_KEY 가 없어 데모 모드로만 동작합니다. .env 파일을 확인해주세요.');
    }
  });
}

module.exports = app;
