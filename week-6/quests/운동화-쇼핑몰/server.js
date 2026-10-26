// ============================================================
// NALSSI · 날씨 운동화 쇼핑몰 API 서버 (Express + PostgreSQL/Supabase)
//  1) 데모 데이터(카테고리 · 상품 · 컬러 · 사이즈별 재고 · 리뷰 · 룩북)를 DB 에 넣고, 화면은 DB 만 읽는다
//  2) 이메일 + 비밀번호 회원가입 / 로그인 (JWT)
//  3) 토스페이먼츠 결제위젯 → 서버 승인 → 재고 차감 → 마이페이지 주문 내역
//     (무통장입금 = 가상계좌는 "입금 대기" 로 두고, 입금 웹훅 · 상태 조회로 결제 완료 처리)
//  4) 관리자 API (role = 'admin' 계정만) — 상품 썸네일 · 설명 수정, 회원 · 주문 조회
//  이미지는 ImageKit CDN 주소를 DB 에 저장해 쓴다.
//
// DB 접속 주소 · 토스 시크릿 키 · JWT 비밀키 · ImageKit 비공개 키는 .env 에만 둔다. 브라우저는 절대 모른다.
// 로컬: node server.js  /  Vercel: module.exports = app 으로 서버리스 동작
// 관리자 계정 만들기: node server.js create-admin <이메일> [비밀번호] [이름]
// ============================================================
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
// 다른 폴더에서 node .../server.js 로 띄워도 이 폴더의 .env 를 읽도록 경로를 고정한다
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 6070;

// ── 환경변수 ─────────────────────────────────
// Vercel 등에서 값 끝에 줄바꿈이 붙는 경우가 있어 .trim() 을 건다.
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();

// 토스 시크릿 키는 "절대" 브라우저로 내려보내지 않는다. 이 키가 있어야만 결제를 승인할 수 있다.
const TOSS_SECRET_KEY = (process.env.TOSS_SECRET_KEY || '').trim();
// 클라이언트 키는 공개되어도 되는 값이지만, index.html 에 박지 않고 /api/config 로 내려준다.
// (테스트 상점 → 실제 상점 전환을 .env 하나로 끝내려고)
const TOSS_CLIENT_KEY = (process.env.TOSS_CLIENT_KEY || '').trim();
const TOSS_API = 'https://api.tosspayments.com/v1';

// JWT 서명 비밀키. 이 값이 새면 누구나 아무 사용자인 척 토큰을 만들 수 있다.
const JWT_SECRET = (process.env.JWT_SECRET || '').trim();
const JWT_EXPIRES_IN = '7d';

// ImageKit — 관리자 페이지에서 썸네일을 올릴 때 쓴다. 비공개 키는 업로드 서명을 만드는 데만 쓰고
// 브라우저로 내려보내지 않는다. (공개 키는 이름 그대로 공개되어도 되는 값)
const IMAGEKIT_PUBLIC_KEY = (process.env.IMAGEKIT_PUBLIC_KEY || '').trim();
const IMAGEKIT_PRIVATE_KEY = (process.env.IMAGEKIT_PRIVATE_KEY || '').trim();
const IMAGEKIT_UPLOAD_URL = 'https://upload.imagekit.io/api/v1/files/upload';
const IMAGEKIT_UPLOAD_FOLDER = '/nalssi/uploads';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5, // 서버리스에서 연결이 과하게 늘지 않도록 작게 둔다
});

const SHIPPING_FEE = 3000;
const FREE_SHIPPING_OVER = 100000;
const SIZES = Array.from({ length: 15 }, (_, i) => 220 + i * 5); // 220 ~ 290mm, 5mm 단위
const MAX_QTY_PER_LINE = 10;

// 결제 후 토스가 브라우저를 되돌려 보낼 화면 (해시 라우터 경로)
const AFTER_PAYMENT = {
  success: (orderId) => `/#/orders/${encodeURIComponent(orderId)}?paid=1`,
  fail: (orderId, message) =>
    `/#/cart?failed=1${orderId ? `&orderId=${encodeURIComponent(orderId)}` : ''}&message=${encodeURIComponent(message || '결제가 취소되었습니다.')}`,
};

// 상품 · 룩북 이미지는 ImageKit(이미지 CDN)에 올려 두고 그 주소를 DB 에 저장한다.
// 화면에서는 주소 뒤에 ?tr=w-600 처럼 붙여 크기를 줄여 받는다. (공개 주소라 .env 에 둘 필요가 없다)
const IMAGE_BASE = 'https://ik.imagekit.io/fbfjqppqm/nalssi';
const img = (name) => `${IMAGE_BASE}/${name}.webp`;

// ── 데모 데이터 (첫 실행 때 DB 에 한 번 넣는다) ─────────────
// 여기 값은 "씨앗" 이다. 한 번 들어간 뒤로는 DB 가 원본이고, 화면 · 주문 금액 · 재고 모두 DB 를 읽는다.
// (DB 에서 가격을 바꾸면 화면과 결제 금액이 같이 바뀐다. 여기 숫자를 고쳐도 이미 들어간 행은 그대로다.)
const DEMO = {
  categories: [
    { id: 'running',  name: '러닝',     description: '가볍게, 멀리. 아침저녁 달리기를 위한 러너', image: img('breeze-sky') },
    { id: 'sneakers', name: '스니커즈', description: '매일 신는 한 켤레. 출근길부터 주말까지',     image: img('snow-white') },
    { id: 'outdoor',  name: '아웃도어', description: '비 · 눈 · 흙길. 날씨가 궂을수록 든든하게',  image: img('frost-ice') },
    { id: 'hightop',  name: '하이탑',   description: '발목까지 단단하게, 룩의 주인공으로',          image: img('tropical-lagoon') },
  ],

  // colors: [variantId(=이미지 파일 이름), 컬러 이름, 스와치 색]
  products: [
    {
      id: 'breeze', category: 'running', name: 'BREEZE 러너', price: 129000, listPrice: 129000, badge: 'BEST', releasedOn: '2026-03-12',
      tagline: '봄바람처럼 가벼운 데일리 러너',
      description: '통기 구멍을 촘촘히 낸 엔지니어드 메쉬 어퍼에 가벼운 EVA 폼을 얹었습니다. 출근길 5km 도, 주말 한강 10km 도 같은 한 켤레로.',
      material: '엔지니어드 메쉬 · EVA 미드솔 · 러버 아웃솔', weight: '230g (270mm 기준)',
      features: ['통기성 메쉬 어퍼', '쿠션 EVA 미드솔', '야간 반사 힐 탭'],
      colors: [['breeze-mint', '민트', '#a7e3cf'], ['breeze-sky', '스카이', '#a9d4ea']],
    },
    {
      id: 'dawn', category: 'running', name: 'DAWN 니트', price: 139000, listPrice: 159000, badge: null, releasedOn: '2026-05-02',
      tagline: '새벽 여섯 시, 첫 조깅을 위한 니트 러너',
      description: '한 가닥 실로 짜 올린 니트 어퍼가 발등을 부드럽게 감쌉니다. 반발력 좋은 폼이 이른 아침 굳은 다리도 가볍게 밀어 줍니다.',
      material: '3D 니트 어퍼 · 고반발 폼 미드솔', weight: '245g (270mm 기준)',
      features: ['이음매 없는 니트 어퍼', '고반발 폼', '뒤꿈치 풀탭'],
      colors: [['dawn-lilac', '라일락', '#c7b8e6'], ['dawn-midnight', '미드나잇', '#2c3e73']],
    },
    {
      id: 'dusk', category: 'running', name: 'DUSK 삭스 러너', price: 149000, listPrice: 149000, badge: 'NEW', releasedOn: '2026-09-25',
      tagline: '해질녘 노을빛, 양말처럼 신는 러너',
      description: '끈을 묶지 않아도 발목까지 쏙 들어가는 삭스 핏. 두툼한 로커 솔이 착지부터 발끝 차기까지 굴러가듯 이어 줍니다.',
      material: '스트레치 니트 · 로커 폼 솔', weight: '260g (270mm 기준)',
      features: ['삭스 핏 칼라', '로커 지오메트리 솔', '슬립온 겸용'],
      colors: [['dusk-amber', '앰버', '#f0a73a'], ['dusk-sunset', '선셋', '#e2553f']],
    },
    {
      id: 'dust', category: 'sneakers', name: 'DUST 청키', price: 159000, listPrice: 179000, badge: null, releasedOn: '2026-04-18',
      tagline: '흙먼지 색 레트로 청키 스니커',
      description: '90년대 러닝화를 닮은 두툼한 레이어드 솔. 스웨이드와 메쉬를 겹쳐 어떤 바지에도 무심하게 어울립니다.',
      material: '스웨이드 · 메쉬 · 레이어드 EVA 솔', weight: '380g (270mm 기준)',
      features: ['레이어드 청키 솔', '스웨이드 오버레이', '키 높이 4.5cm'],
      colors: [['dust-clay', '클레이', '#c4654f'], ['dust-sand', '샌드', '#e3d3bd']],
    },
    {
      id: 'fog', category: 'sneakers', name: 'FOG 스웨이드', price: 119000, listPrice: 119000, badge: null, releasedOn: '2026-02-20',
      tagline: '안개처럼 차분한 스웨이드 로우',
      description: '군더더기 없는 로우컷 실루엣에 부드러운 스웨이드와 검 솔을 맞췄습니다. 셔츠에도, 트레이닝복에도.',
      material: '소가죽 스웨이드 · 생고무 검 솔', weight: '340g (270mm 기준)',
      features: ['프리미엄 스웨이드', '생고무 검 솔', '가죽 안감'],
      colors: [['fog-charcoal', '차콜', '#55575b'], ['fog-grey', '그레이', '#c9c9c6']],
    },
    {
      id: 'frost', category: 'outdoor', name: 'FROST 트레일', price: 179000, listPrice: 179000, badge: 'NEW', releasedOn: '2026-10-01',
      tagline: '서리 내린 산길도 미끄러지지 않게',
      description: '영하에서도 굳지 않는 컴파운드 러버와 5mm 러그가 언 땅을 붙잡습니다. 발수 코팅 어퍼라 눈길 산책도 가뿐합니다.',
      material: '발수 립스탑 · 저온 컴파운드 러버', weight: '320g (270mm 기준)',
      features: ['5mm 멀티 러그', '저온 그립 러버', '발수 코팅 어퍼', '토 캡 보호'],
      colors: [['frost-blackice', '블랙아이스', '#2a2d31'], ['frost-ice', '아이스', '#d8e6ef']],
    },
    {
      id: 'maple', category: 'sneakers', name: 'MAPLE 테라스', price: 109000, listPrice: 109000, badge: null, releasedOn: '2026-08-29',
      tagline: '단풍 · 은행빛 70s 트레이너',
      description: '70년대 실내 트레이닝화를 그대로 옮긴 납작한 실루엣. 가을빛 스웨이드에 검 솔을 대 어디서든 포인트가 됩니다.',
      material: '스웨이드 · 검 러버 솔', weight: '300g (270mm 기준)',
      features: ['로우 프로파일', 'T-토 스웨이드', '검 러버 솔'],
      colors: [['maple-ginkgo', '은행', '#d7a531'], ['maple-maple', '단풍', '#7d1f2c']],
    },
    {
      id: 'monsoon', category: 'outdoor', name: 'MONSOON 하이커', price: 189000, listPrice: 209000, badge: null, releasedOn: '2026-06-10',
      tagline: '장마철 출근길을 위한 방수 하이커',
      description: '방수 멤브레인이 빗물은 막고 땀은 내보냅니다. 젖은 보도블록에서도 미끄러지지 않는 웻그립 아웃솔.',
      material: '방수 멤브레인 · 나일론 · 웻그립 러버', weight: '410g (270mm 기준)',
      features: ['완전 방수 멤브레인', '웻그립 아웃솔', '스피드 레이스'],
      colors: [['monsoon-olive', '올리브', '#5d6248'], ['monsoon-rain', '레인', '#4b6584']],
    },
    {
      id: 'shower', category: 'sneakers', name: 'SHOWER 캔버스', price: 69000, listPrice: 69000, badge: null, releasedOn: '2026-07-04',
      tagline: '소나기 그친 뒤의 쨍한 캔버스',
      description: '빨아 신을 수 있는 코튼 캔버스 로우탑. 가볍고 값도 가벼워서 색깔별로 두 켤레.',
      material: '코튼 캔버스 · 바닐라 러버 솔', weight: '280g (270mm 기준)',
      features: ['세탁 가능한 캔버스', '쿠션 인솔', '러버 토 캡'],
      colors: [['shower-cobalt', '코발트', '#1f5fd1'], ['shower-lemon', '레몬', '#f2e27a']],
    },
    {
      id: 'snow', category: 'sneakers', name: 'SNOW 레더 코트', price: 99000, listPrice: 119000, badge: 'BEST', releasedOn: '2026-01-15',
      tagline: '첫눈처럼 깨끗한 미니멀 레더',
      description: '로고를 덜어 낸 소가죽 코트 스니커. 어떤 옷에도 맞는, 신발장에 하나쯤 있어야 할 흰 운동화.',
      material: '풀그레인 소가죽 · 스티치 컵솔', weight: '350g (270mm 기준)',
      features: ['풀그레인 레더', '스티치 컵솔', '가죽 깔창'],
      colors: [['snow-milktea', '밀크티', '#d8bfa0'], ['snow-white', '화이트', '#f4f2ee']],
    },
    {
      id: 'tropical', category: 'hightop', name: 'TROPICAL 하이탑', price: 169000, listPrice: 169000, badge: null, releasedOn: '2026-07-22',
      tagline: '열대 컬러 농구화 하이탑',
      description: '발목을 단단히 잡아 주는 패디드 칼라와 코트용 에어 쿠션. 원색 컬러로 룩의 주인공이 되는 하이탑.',
      material: '합성 가죽 · 메쉬 · 에어 쿠션', weight: '460g (270mm 기준)',
      features: ['패디드 하이 칼라', '에어 쿠션 유닛', '헤링본 아웃솔'],
      colors: [['tropical-jungle', '정글', '#1f6b3a'], ['tropical-lagoon', '라군', '#2a6f92']],
    },
    {
      id: 'whitenight', category: 'hightop', name: 'WHITE NIGHT 하이탑', price: 199000, listPrice: 199000, badge: 'LIMITED', releasedOn: '2026-08-20',
      tagline: '백야처럼 빛나는 레더 하이탑',
      description: '사이드 지퍼로 신고 벗기 쉬운 레더 하이탑. 메탈릭 실버와 글로시 오닉스, 밤에 더 빛나는 두 가지.',
      material: '글로시 레더 · 사이드 지퍼 · 컵솔', weight: '480g (270mm 기준)',
      features: ['사이드 지퍼', '글로시 레더', '한정 수량'],
      colors: [['whitenight-onyx', '오닉스', '#121212'], ['whitenight-silver', '실버', '#c0c3c7']],
    },
  ],

  // [상품, 구매 컬러, 작성자, 별점, 사이즈, 착용감, 내용, 작성일]
  reviews: [
    ['breeze', 'breeze-mint', '김*연', 5, 245, '정사이즈', '진짜 가벼워요. 출퇴근 왕복 40분 걷는데 발이 하나도 안 아파요. 민트색이 사진보다 살짝 더 연해요.', '2026-09-28'],
    ['breeze', 'breeze-sky', '박*호', 4, 270, '정사이즈', '한강 10km 뛰어봤는데 쿠션 괜찮습니다. 볼이 넓은 편이면 반 치수 업 추천.', '2026-09-15'],
    ['breeze', 'breeze-mint', '이*진', 5, 235, '커요', '평소 240 신는데 235도 딱 맞아요. 메쉬라 여름에 시원할 듯.', '2026-08-30'],
    ['dawn', 'dawn-midnight', '정*우', 5, 265, '정사이즈', '니트가 발등을 감싸는 느낌이 좋아요. 미드나잇은 청바지랑 잘 어울립니다.', '2026-10-02'],
    ['dawn', 'dawn-lilac', '최*아', 5, 240, '정사이즈', '라일락 색감이 너무 예뻐요. 새벽 러닝 나갈 맛 납니다.', '2026-09-21'],
    ['dawn', 'dawn-lilac', '한*결', 4, 250, '작아요', '앞코가 살짝 좁아요. 발볼 넓으신 분은 5mm 크게.', '2026-09-03'],
    ['dusk', 'dusk-sunset', '윤*서', 5, 245, '정사이즈', '양말처럼 쏙 들어가요. 끈 안 묶고 슬립온처럼 신어요.', '2026-10-05'],
    ['dusk', 'dusk-amber', '강*민', 4, 275, '작아요', '앰버 색 예쁜데 칼라가 좀 조여서 반 치수 크게 갔어요.', '2026-09-29'],
    ['dust', 'dust-sand', '조*희', 5, 240, '정사이즈', '키 높이 효과 확실하고 생각보다 무겁지 않아요. 샌드 색 어디에나 어울려요.', '2026-09-12'],
    ['dust', 'dust-clay', '임*준', 4, 270, '커요', '클레이 색감이 독특해요. 살짝 커서 깔창 하나 깔았습니다.', '2026-08-25'],
    ['dust', 'dust-sand', '서*은', 5, 235, '정사이즈', '어글리 슈즈 처음인데 성공. 와이드 슬랙스랑 찰떡.', '2026-08-11'],
    ['fog', 'fog-grey', '오*영', 5, 250, '정사이즈', '스웨이드 결이 고급스러워요. 검 솔 조합 최고.', '2026-09-18'],
    ['fog', 'fog-charcoal', '배*현', 4, 280, '정사이즈', '비 오는 날엔 피하세요(스웨이드라). 그 외엔 완벽.', '2026-09-01'],
    ['frost', 'frost-blackice', '신*훈', 5, 275, '정사이즈', '작년 겨울 빙판길에서 한 번도 안 미끄러졌어요. 올해 한 켤레 더.', '2026-10-08'],
    ['frost', 'frost-ice', '홍*나', 5, 240, '정사이즈', '등산화처럼 투박하지 않아서 평소에도 신어요.', '2026-09-26'],
    ['frost', 'frost-blackice', '권*재', 4, 265, '작아요', '두꺼운 양말 신으면 좀 끼어요. 겨울용이면 반 치수 업.', '2026-09-09'],
    ['maple', 'maple-ginkgo', '문*지', 5, 235, '정사이즈', '은행잎 색이라 가을에 신기 딱이에요. 바닥이 납작해서 오래 걸으면 살짝 피곤.', '2026-10-01'],
    ['maple', 'maple-maple', '양*석', 4, 265, '커요', '와인색 스웨이드 실물이 훨씬 예뻐요. 5mm 작게 사세요.', '2026-09-14'],
    ['monsoon', 'monsoon-rain', '구*빈', 5, 270, '정사이즈', '장마 내내 이것만 신었는데 양말 한 번도 안 젖었어요.', '2026-08-20'],
    ['monsoon', 'monsoon-olive', '노*율', 4, 255, '정사이즈', '방수는 확실해요. 조금 무거운 건 감안해야 해요.', '2026-07-30'],
    ['shower', 'shower-lemon', '유*림', 5, 230, '커요', '레몬색 너무 귀여워요. 평소보다 5mm 작게 신어요.', '2026-09-05'],
    ['shower', 'shower-cobalt', '차*원', 4, 260, '정사이즈', '이 가격에 이 퀄리티면 만족. 세탁기 돌려도 멀쩡해요.', '2026-08-17'],
    ['shower', 'shower-cobalt', '전*하', 5, 245, '정사이즈', '코발트 색 사진 그대로예요. 두 켤레 샀어요.', '2026-07-22'],
    ['snow', 'snow-white', '송*아', 5, 240, '정사이즈', '흰 운동화 유목민 정착합니다. 가죽이 부드러워서 길들일 필요가 없어요.', '2026-10-06'],
    ['snow', 'snow-milktea', '남*우', 5, 265, '정사이즈', '밀크티 컬러 실물이 더 예뻐요. 크림색 바지랑 깔맞춤.', '2026-09-24'],
    ['snow', 'snow-white', '황*솔', 4, 255, '커요', '조금 커서 5mm 줄여도 될 듯. 마감은 완벽합니다.', '2026-09-10'],
    ['tropical', 'tropical-lagoon', '백*진', 5, 270, '정사이즈', '핑크 포인트 때문에 샀어요. 발목 잡아주는 느낌 좋아요.', '2026-09-19'],
    ['tropical', 'tropical-jungle', '류*현', 4, 280, '정사이즈', '정글 색이 꽤 쨍해요. 농구할 때 신으니 접지력 좋아요.', '2026-08-28'],
    ['whitenight', 'whitenight-silver', '하*은', 5, 245, '정사이즈', '실버 실물 진짜 예뻐요. 지퍼라 신고 벗기 편해요.', '2026-10-03'],
    ['whitenight', 'whitenight-onyx', '장*훈', 5, 275, '정사이즈', '한정이라 바로 샀는데 후회 없음. 광택이 고급스러워요.', '2026-09-27'],
    ['whitenight', 'whitenight-silver', '성*희', 4, 235, '작아요', '앞코가 좁은 편이라 5mm 크게 추천드려요.', '2026-09-16'],
  ],

  // 홈 화면의 히어로 · 룩북 · 스토리 · 다음 드롭
  stories: [
    { id: 'hero', kind: 'hero', eyebrow: 'FW 2026 · RAINY DAYS', title: '오늘 날씨에 맞는 한 켤레',
      body: '비 갠 골목, 젖은 보도블록 위로 첫발. 맑은 날부터 눈 오는 날까지, 날씨마다 다른 열두 켤레를 만났습니다.',
      image: img('hero'), link: '/shop', cta: '컬렉션 보기' },
    { id: 'look-dawn', kind: 'look', eyebrow: '06:00 · DAWN', title: '새벽 조깅',
      body: '아직 불 꺼진 골목, 라일락 니트로 가볍게 첫 1km.',
      image: img('look-dawn'), link: '/product/dawn?color=dawn-lilac', cta: 'DAWN 니트 보기' },
    { id: 'look-dusk', kind: 'look', eyebrow: '19:00 · DUSK', title: '퇴근 후 강변',
      body: '노을이 다 지기 전에, 끈을 한 번 더 묶는다.',
      image: img('look-dusk'), link: '/product/dusk?color=dusk-sunset', cta: 'DUSK 삭스 러너 보기' },
    { id: 'look-night', kind: 'look', eyebrow: '23:30 · NIGHT', title: '막차 플랫폼',
      body: '하루의 끝까지 같이 걷는 하이탑.',
      image: img('look-night'), link: '/product/whitenight?color=whitenight-onyx', cta: 'WHITE NIGHT 보기' },
    { id: 'craft', kind: 'story', eyebrow: 'CRAFT', title: '한 가닥 실로 짠 어퍼',
      body: 'DAWN 과 DUSK 의 니트 어퍼는 3,200개의 바늘이 한 번에 짜 올립니다. 이음매가 없어 발등이 쓸리지 않고, 재단하고 남는 자투리 원단도 거의 없습니다.',
      image: img('craft'), link: '/product/dawn', cta: 'DAWN 니트 보기' },
    { id: 'drop', kind: 'drop', eyebrow: 'NEXT DROP · 11.07 10:00', title: 'NIGHT GLOW',
      body: '어두울수록 밑창이 빛나는 야간 러너. 11월 7일 오전 10시, 200켤레 한정으로 공개합니다.',
      image: img('drop'), link: null, cta: null },
  ],
};

// 사이즈별 데모 재고. 같은 입력이면 항상 같은 숫자가 나오는 가짜 난수라,
// 다른 컴퓨터에서 처음 띄워도 똑같은 재고로 시작한다. (일부는 0 = 품절, 양 끝 사이즈는 적게)
function demoStock(variantId, size) {
  const h = crypto.createHash('md5').update(`${variantId}:${size}`).digest()[0]; // 0 ~ 255
  if (h % 7 === 0) return 0;
  return size <= 225 || size >= 285 ? h % 4 : 2 + (h % 14);
}

// ── 미들웨어 ─────────────────────────────────
app.use(express.json({ limit: '100kb' }));
// 정적 파일은 index.html 하나뿐이라 express.static 으로 폴더를 열지 않는다 (아래 SPA fallback 이 보낸다).
// 폴더째 열면 /server.js · /package.json 까지 그대로 내려받아진다. 이미지는 ImageKit 에서 받는다.

// ── DB 준비 (lazy init) ───────────────────────
// 서버리스는 cold start 마다 이 파일이 다시 로드되므로, 플래그로 중복 실행을 막는다.
// 테이블 이름에 nalssi_ 를 붙여 같은 DB 의 다른 예제와 섞이지 않게 한다.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS nalssi_categories (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    image       TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS nalssi_products (
    id          TEXT PRIMARY KEY,
    category_id TEXT NOT NULL REFERENCES nalssi_categories(id),
    name        TEXT NOT NULL,
    tagline     TEXT NOT NULL,
    description TEXT NOT NULL,
    price       INTEGER NOT NULL CHECK (price >= 0),
    list_price  INTEGER NOT NULL CHECK (list_price >= 0),
    badge       TEXT,
    material    TEXT NOT NULL,
    weight      TEXT NOT NULL,
    features    JSONB NOT NULL DEFAULT '[]',
    released_on DATE NOT NULL DEFAULT CURRENT_DATE,
    sort_order  INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS nalssi_variants (
    id         TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES nalssi_products(id) ON DELETE CASCADE,
    color_name TEXT NOT NULL,
    color_hex  TEXT NOT NULL,
    image      TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS nalssi_stock (
    variant_id TEXT    NOT NULL REFERENCES nalssi_variants(id) ON DELETE CASCADE,
    size       INTEGER NOT NULL,
    qty        INTEGER NOT NULL CHECK (qty >= 0),
    PRIMARY KEY (variant_id, size)
  );
  CREATE TABLE IF NOT EXISTS nalssi_reviews (
    id         TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES nalssi_products(id) ON DELETE CASCADE,
    variant_id TEXT REFERENCES nalssi_variants(id) ON DELETE SET NULL,
    author     TEXT NOT NULL,
    rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    size       INTEGER,
    fit        TEXT,
    body       TEXT NOT NULL,
    created_on DATE NOT NULL DEFAULT CURRENT_DATE
  );
  CREATE TABLE IF NOT EXISTS nalssi_stories (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    eyebrow    TEXT,
    title      TEXT NOT NULL,
    body       TEXT,
    image      TEXT NOT NULL,
    link       TEXT,
    cta        TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS nalssi_users (
    id            SERIAL PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    customer_key  TEXT UNIQUE NOT NULL DEFAULT gen_random_uuid()::text,
    -- 'customer' | 'admin'. 회원가입으로는 항상 customer 이고, admin 은 node server.js create-admin 으로만 만든다
    role          TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  -- 관리자 기능 전에 만든 DB 에도 role 컬럼을 붙인다 (이미 있으면 건너뛴다)
  ALTER TABLE nalssi_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin'));
  CREATE TABLE IF NOT EXISTS nalssi_orders (
    id          TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES nalssi_users(id) ON DELETE CASCADE,
    items       JSONB   NOT NULL,
    subtotal    INTEGER NOT NULL,
    shipping    INTEGER NOT NULL,
    amount      INTEGER NOT NULL,
    order_name  TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'READY',
    payment     JSONB,
    fail_reason JSONB,
    deposit_secret TEXT, -- 가상계좌 입금 웹훅이 진짜 토스에서 왔는지 맞춰 볼 값 (화면에는 안 내려간다)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at     TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS nalssi_variants_product_idx ON nalssi_variants (product_id);
  CREATE INDEX IF NOT EXISTS nalssi_reviews_product_idx  ON nalssi_reviews (product_id, created_on DESC);
  CREATE INDEX IF NOT EXISTS nalssi_orders_user_idx      ON nalssi_orders (user_id, created_at DESC);
`;

// BEGIN ~ COMMIT 을 한 연결에서 처리한다. fn 이 throw 하면 전부 되돌린다(ROLLBACK).
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// JS 배열을 JSON 하나로 보내 INSERT 한 번에 여러 행을 넣는다 (jsonb_to_recordset).
// table · columns 는 코드에 박힌 상수라 SQL 에 그대로 넣어도 안전하다 (사용자 입력이 아니다).
// ON CONFLICT DO NOTHING → 이미 있는 행은 건드리지 않는다 (DB 에서 고친 가격 · 줄어든 재고가 유지된다).
async function insertRows(db, table, columns, rows) {
  const names = Object.keys(columns).join(', ');
  const types = Object.entries(columns).map(([col, type]) => `${col} ${type}`).join(', ');
  await db.query(
    `INSERT INTO ${table} (${names})
     SELECT ${names} FROM jsonb_to_recordset($1::jsonb) AS x(${types})
     ON CONFLICT DO NOTHING`,
    [JSON.stringify(rows)],
  );
}

async function seedDemo(db) {
  const variants = DEMO.products.flatMap((p) =>
    p.colors.map(([id, colorName, colorHex], i) => ({
      id, product_id: p.id, color_name: colorName, color_hex: colorHex, image: img(id), sort_order: i,
    })),
  );

  await insertRows(db, 'nalssi_categories',
    { id: 'text', name: 'text', description: 'text', image: 'text', sort_order: 'int' },
    DEMO.categories.map((c, i) => ({ ...c, sort_order: i })));

  await insertRows(db, 'nalssi_products',
    { id: 'text', category_id: 'text', name: 'text', tagline: 'text', description: 'text', price: 'int', list_price: 'int',
      badge: 'text', material: 'text', weight: 'text', features: 'jsonb', released_on: 'date', sort_order: 'int' },
    DEMO.products.map((p, i) => ({
      id: p.id, category_id: p.category, name: p.name, tagline: p.tagline, description: p.description,
      price: p.price, list_price: p.listPrice, badge: p.badge, material: p.material, weight: p.weight,
      features: p.features, released_on: p.releasedOn, sort_order: i,
    })));

  await insertRows(db, 'nalssi_variants',
    { id: 'text', product_id: 'text', color_name: 'text', color_hex: 'text', image: 'text', sort_order: 'int' },
    variants);

  await insertRows(db, 'nalssi_stock',
    { variant_id: 'text', size: 'int', qty: 'int' },
    variants.flatMap((v) => SIZES.map((size) => ({ variant_id: v.id, size, qty: demoStock(v.id, size) }))));

  await insertRows(db, 'nalssi_reviews',
    { id: 'text', product_id: 'text', variant_id: 'text', author: 'text', rating: 'int', size: 'int', fit: 'text', body: 'text', created_on: 'date' },
    DEMO.reviews.map(([productId, variantId, author, rating, size, fit, body, createdOn], i) => ({
      id: `rv-${String(i + 1).padStart(3, '0')}`, product_id: productId, variant_id: variantId,
      author, rating, size, fit, body, created_on: createdOn,
    })));

  await insertRows(db, 'nalssi_stories',
    { id: 'text', kind: 'text', eyebrow: 'text', title: 'text', body: 'text', image: 'text', link: 'text', cta: 'text', sort_order: 'int' },
    DEMO.stories.map((s, i) => ({ ...s, sort_order: i })));
}

let dbInitialized = false;
let dbInitializing = null; // 첫 화면이 API 를 여러 개 동시에 불러도 준비 작업은 한 번만 돈다
async function initDB() {
  if (dbInitialized) return;
  dbInitializing ||= (async () => {
    await pool.query(SCHEMA_SQL);
    // 상품이 데모 개수보다 적을 때만 씨앗을 뿌린다 → 평소 cold start 에는 쿼리 2번으로 끝난다
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM nalssi_products');
    if (rows[0].n < DEMO.products.length) {
      await withTransaction(seedDemo);
      console.log('🌱 데모 데이터를 DB 에 넣었습니다.');
    }
    dbInitialized = true;
  })().finally(() => { dbInitializing = null; });
  await dbInitializing;
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

// ── SQL 조각 ─────────────────────────────────
// 상품 목록 · 상세가 같이 쓰는 SELECT. 평점 · 리뷰 수 · 남은 재고는 따로 저장하지 않고
// 매번 리뷰 · 재고 테이블에서 센다 → 결제로 재고가 빠지면 화면에 바로 반영된다.
const PRODUCT_SELECT = `
  SELECT p.id, p.category_id AS "categoryId", c.name AS "categoryName",
         p.name, p.tagline, p.description, p.price, p.list_price AS "listPrice", p.badge,
         p.material, p.weight, p.features,
         to_char(p.released_on, 'YYYY-MM-DD') AS "releasedOn",
         COALESCE(r.rating, 0)::float AS rating,
         COALESCE(r.count, 0)::int   AS "reviewCount",
         COALESCE(s.total, 0)::int   AS "totalStock",
         COALESCE(v.variants, '[]')  AS variants
    FROM nalssi_products p
    JOIN nalssi_categories c ON c.id = p.category_id
    LEFT JOIN LATERAL (
      SELECT round(avg(rating), 1) AS rating, count(*) AS count
        FROM nalssi_reviews WHERE product_id = p.id
    ) r ON TRUE
    LEFT JOIN LATERAL (
      SELECT sum(st.qty) AS total
        FROM nalssi_stock st JOIN nalssi_variants vv ON vv.id = st.variant_id
       WHERE vv.product_id = p.id
    ) s ON TRUE
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('id', id, 'colorName', color_name, 'colorHex', color_hex, 'image', image)
                      ORDER BY sort_order) AS variants
        FROM nalssi_variants WHERE product_id = p.id
    ) v ON TRUE`;

// 정렬은 화이트리스트에서만 고른다 (사용자 입력을 ORDER BY 에 그대로 넣지 않는다)
const PRODUCT_SORTS = {
  recommended: 'p.sort_order',
  new: 'p.released_on DESC, p.sort_order',
  'price-asc': 'p.price, p.sort_order',
  'price-desc': 'p.price DESC, p.sort_order',
  rating: 'rating DESC, "reviewCount" DESC, p.sort_order',
};

// DB 컬럼(snake_case) → 화면에서 쓰는 모양(camelCase).
// TIMESTAMPTZ 를 그대로 받으면 JS Date 로 바뀌며 시간대 때문에 값이 밀릴 수 있어 문자열로 뽑는다.
const ORDER_COLUMNS = `
  id AS "orderId", order_name AS "orderName", items, subtotal, shipping, amount, status,
  payment, fail_reason AS "failReason",
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt",
  to_char(paid_at    AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "paidAt"`;

// 주문 줄들을 한 번의 UPDATE 로 빼거나(예약) 돌려놓는다(복구).
// 예약은 "남은 수량 >= 주문 수량" 인 줄만 바뀌므로, 바뀐 줄 수가 주문 줄 수보다 적으면 품절이 있는 것이다.
const STOCK_RESERVE_SQL = `
  UPDATE nalssi_stock s SET qty = s.qty - x.qty
    FROM jsonb_to_recordset($1::jsonb) AS x(variant_id text, size int, qty int)
   WHERE s.variant_id = x.variant_id AND s.size = x.size AND s.qty >= x.qty`;
const STOCK_RESTORE_SQL = `
  UPDATE nalssi_stock s SET qty = s.qty + x.qty
    FROM jsonb_to_recordset($1::jsonb) AS x(variant_id text, size int, qty int)
   WHERE s.variant_id = x.variant_id AND s.size = x.size`;
const stockRows = (items) => JSON.stringify(items.map((i) => ({ variant_id: i.variantId, size: i.size, qty: i.qty })));

// ── 작은 도우미들 ─────────────────────────────
const userError = (status, message, code) => Object.assign(new Error(message), { status, code, expose: true });
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
// 이미지 주소는 https 만 받는다 (javascript: · http: · 상대 경로 차단)
const isImageUrl = (v) => {
  if (!v || v.length > 500) return false;
  try { return new URL(v).protocol === 'https:'; } catch { return false; }
};
// 검색어 → ILIKE 패턴. 와일드카드(% _)를 사용자가 넣어도 글자 그대로 찾도록 이스케이프한다
const likePattern = (q) => {
  const s = String(q || '').trim().slice(0, 50);
  return s ? `%${s.replace(/[\\%_]/g, '\\$&')}%` : '';
};
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt });
const USER_COLUMNS = `id, email, name, role, customer_key AS "customerKey",
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt"`;

// 가상계좌 은행 코드 → 이름 (토스 bankCode 2자리)
const BANK_NAMES = {
  '02': '산업', '03': '기업', '04': '국민', '07': '수협', '11': '농협', '20': '우리', '23': 'SC제일', '27': '씨티',
  '31': '대구', '32': '부산', '34': '광주', '35': '제주', '37': '전북', '39': '경남', '45': '새마을', '48': '신협',
  '71': '우체국', '81': '하나', '88': '신한', '89': '케이뱅크', '90': '카카오뱅크', '92': '토스뱅크',
};

// 토스 API 는 시크릿 키를 Basic 인증의 "아이디" 자리에 넣고 비밀번호는 비운다 → "키:" 를 base64
const tossAuthHeader = () => 'Basic ' + Buffer.from(`${TOSS_SECRET_KEY}:`).toString('base64');

// 주문번호. 토스 규격은 영문/숫자/-/_ 로 6~64자.
const makeOrderId = () =>
  `NALSSI-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

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
    const { rows } = await pool.query(`SELECT ${USER_COLUMNS} FROM nalssi_users WHERE id = $1`, [payload.sub]);
    if (rows.length === 0) return next(userError(401, '탈퇴했거나 없는 계정입니다.'));
    req.user = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

// 관리자만 통과시키는 문지기 (requireAuth 뒤에 건다).
// 토큰에는 회원 번호만 들어 있고, 관리자인지는 requireAuth 가 매 요청 DB 에서 읽어 온 role 로 판단한다
// → 토큰을 위조할 수 없고, DB 에서 권한을 빼면 이미 로그인한 관리자도 바로 막힌다.
function requireAdmin(req, _res, next) {
  if (req.user?.role !== 'admin') return next(userError(403, '관리자만 사용할 수 있습니다.'));
  next();
}

// 내 주문인지 확인하고 꺼내 온다
async function findMyOrder(orderId, userId) {
  const { rows } = await pool.query(
    `SELECT ${ORDER_COLUMNS}, user_id AS "userId" FROM nalssi_orders WHERE id = $1`,
    [String(orderId || '')],
  );
  const order = rows[0];
  if (!order || order.userId !== userId) throw userError(404, '주문을 찾을 수 없습니다.');
  return order;
}

const markFailed = (db, orderId, failReason, fromStatus) =>
  db.query(`UPDATE nalssi_orders SET status = 'FAILED', fail_reason = $2 WHERE id = $1 AND status = $3`,
    [orderId, failReason, fromStatus]);

// 토스 결제 승인 → 재고 차감 → 주문에 결과 기록.
// 금액 검증 · 재고 예약 · 승인이 모두 여기 모여 있어서, 브라우저에서 부르든
// 토스 리다이렉트로 들어오든 같은 규칙이 적용된다.
// 주문 상태: READY(주문서) → PAYING(재고 잡고 승인 중) → PAID / WAITING_FOR_DEPOSIT(가상계좌) / FAILED
async function confirmPayment({ order, paymentKey, amount }) {
  // ① 이미 끝났거나 처리 중인 주문이면 토스를 다시 부르지 않는다 (새로고침 · 중복 클릭 방어)
  if (order.status === 'PAID') return { ok: true, order };
  if (order.status === 'PAYING') {
    return { ok: false, status: 409, error: { code: 'ALREADY_PROCESSING', message: '결제를 확인하고 있습니다. 잠시 후 주문 내역을 확인해주세요.' } };
  }
  if (order.status !== 'READY') {
    return { ok: false, status: 400, error: order.failReason || { code: 'ORDER_CLOSED', message: '이미 종료된 주문입니다.' } };
  }

  // ② 브라우저가 보낸 금액과 서버가 계산해 둔 금액이 다르면 즉시 중단
  if (Number(amount) !== order.amount) {
    const failReason = { code: 'AMOUNT_MISMATCH', message: '결제 금액이 주문 금액과 다릅니다.' };
    await markFailed(pool, order.orderId, failReason, 'READY');
    return { ok: false, status: 400, error: failReason };
  }

  // ③ 승인 전에 재고부터 잡는다. 주문을 PAYING 으로 바꾸는 것과 재고 차감을 한 트랜잭션에 묶어서
  //    같은 주문이 두 번 들어와도 재고는 한 번만 빠지고, 한 줄이라도 모자라면 아무것도 안 빠진다.
  const reserved = await withTransaction(async (db) => {
    const lock = await db.query(`UPDATE nalssi_orders SET status = 'PAYING' WHERE id = $1 AND status = 'READY'`, [order.orderId]);
    if (lock.rowCount === 0) return 'BUSY';
    const r = await db.query(STOCK_RESERVE_SQL, [stockRows(order.items)]);
    if (r.rowCount !== order.items.length) throw Object.assign(new Error('SOLD_OUT'), { soldOut: true });
    return 'OK';
  }).catch((err) => {
    if (err.soldOut) return 'SOLD_OUT';
    throw err;
  });

  if (reserved === 'BUSY') {
    return { ok: false, status: 409, error: { code: 'ALREADY_PROCESSING', message: '결제를 확인하고 있습니다. 잠시 후 주문 내역을 확인해주세요.' } };
  }
  if (reserved === 'SOLD_OUT') {
    const failReason = { code: 'OUT_OF_STOCK', message: '결제하는 사이 품절된 사이즈가 있습니다. 장바구니를 다시 확인해주세요.' };
    await markFailed(pool, order.orderId, failReason, 'READY');
    return { ok: false, status: 409, error: failReason };
  }

  // ④ 토스에 최종 승인 요청. 여기서 성공해야 진짜 결제된 것이다.
  let res = null;
  let data;
  try {
    res = await fetch(`${TOSS_API}/payments/confirm`, {
      method: 'POST',
      headers: {
        Authorization: tossAuthHeader(),
        'Content-Type': 'application/json',
        'Idempotency-Key': `confirm-${order.orderId}`, // 같은 주문을 두 번 승인하지 않도록
      },
      body: JSON.stringify({ paymentKey, orderId: order.orderId, amount: order.amount }),
      signal: AbortSignal.timeout(20000),
    });
    data = await res.json().catch(() => ({}));
  } catch {
    data = { code: 'NETWORK_ERROR', message: '결제 서버와 통신하지 못했습니다. 잠시 후 다시 시도해주세요.' };
  }

  if (!res || !res.ok) {
    // 승인 실패 → 잡아 둔 재고를 돌려놓고 실패로 기록
    const failReason = { code: data.code || 'CONFIRM_FAILED', message: data.message || '결제 승인에 실패했습니다.' };
    await withTransaction(async (db) => {
      await db.query(STOCK_RESTORE_SQL, [stockRows(order.items)]);
      await markFailed(db, order.orderId, failReason, 'PAYING');
    });
    return { ok: false, status: res ? res.status : 502, error: failReason };
  }

  // 무통장입금(가상계좌)은 승인 = "계좌 발급" 이다. 돈은 아직 안 들어왔으므로 입금 대기로 두고
  // 재고는 계속 잡아 둔다. 입금되면 웹훅(또는 주문 조회 때의 상태 확인)이 PAID 로 바꾼다.
  const waiting = data.status === 'WAITING_FOR_DEPOSIT';
  const va = data.virtualAccount;
  const payment = {
    paymentKey: data.paymentKey,
    method: data.method,                       // 카드 · 간편결제 · 계좌이체 · 가상계좌 …
    approvedAt: data.approvedAt,
    receiptUrl: data.receipt ? data.receipt.url : null,
    cardCompany: data.card ? data.card.issuerCode : null,
    cardNumber: data.card ? data.card.number : null,
    easyPayProvider: data.easyPay ? data.easyPay.provider : null,
    virtualAccount: va
      ? { bank: BANK_NAMES[va.bankCode] || va.bankCode, accountNumber: va.accountNumber, customerName: va.customerName, dueDate: va.dueDate }
      : null,
  };
  const { rows } = await pool.query(
    `UPDATE nalssi_orders
        SET status = $4, payment = $2, fail_reason = NULL, deposit_secret = $5,
            paid_at = CASE WHEN $4 = 'PAID' THEN COALESCE($3::timestamptz, now()) END
      WHERE id = $1
      RETURNING ${ORDER_COLUMNS}`,
    [order.orderId, payment, data.approvedAt || null, waiting ? 'WAITING_FOR_DEPOSIT' : 'PAID', data.secret || null],
  );
  return { ok: true, order: rows[0] };
}

// 토스 결제 상태 → 입금 대기 주문에 반영 (웹훅 · 주문 조회가 같이 쓴다)
//  DONE                      → 입금 완료 = PAID
//  CANCELED · EXPIRED · ABORTED → 입금 기한 지남/취소 = FAILED + 잡아 둔 재고 복구
// 입금 대기 상태인 주문만 바꾸므로 같은 웹훅이 여러 번 와도 결과는 한 번만 반영된다.
async function applyDepositStatus(orderId, tossStatus) {
  if (tossStatus === 'DONE') {
    const { rows } = await pool.query(
      `UPDATE nalssi_orders SET status = 'PAID', paid_at = now()
        WHERE id = $1 AND status = 'WAITING_FOR_DEPOSIT'
        RETURNING ${ORDER_COLUMNS}`,
      [orderId],
    );
    return rows[0] || null;
  }
  if (['CANCELED', 'EXPIRED', 'ABORTED'].includes(tossStatus)) {
    return withTransaction(async (db) => {
      const failReason = { code: `DEPOSIT_${tossStatus}`, message: '입금 기한이 지나 주문이 취소되었습니다.' };
      const { rows } = await db.query(
        `UPDATE nalssi_orders SET status = 'FAILED', fail_reason = $2
          WHERE id = $1 AND status = 'WAITING_FOR_DEPOSIT'
          RETURNING ${ORDER_COLUMNS}`,
        [orderId, failReason],
      );
      if (rows[0]) await db.query(STOCK_RESTORE_SQL, [stockRows(rows[0].items)]);
      return rows[0] || null;
    });
  }
  return null;
}

// 입금 대기 주문을 열 때 토스에 지금 상태를 물어본다.
// 웹훅을 등록하지 못한 환경(로컬 · 문서용 테스트 키)에서도 입금이 반영되게 하는 안전망이다.
async function syncDeposit(order) {
  if (order.status !== 'WAITING_FOR_DEPOSIT' || !order.payment?.paymentKey) return order;
  try {
    const res = await fetch(`${TOSS_API}/payments/${encodeURIComponent(order.payment.paymentKey)}`, {
      headers: { Authorization: tossAuthHeader() },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return order;
    const data = await res.json();
    return (await applyDepositStatus(order.orderId, data.status)) || order;
  } catch {
    return order; // 조회가 실패해도 화면은 기존 상태로 보여 준다
  }
}

// ============================================================
// 설정
// ============================================================

// GET /api/config — 브라우저가 토스 SDK 를 켤 때 필요한 "공개" 값만 내려준다
app.get('/api/config', (_req, res) => {
  res.json({
    success: true,
    data: {
      tossClientKey: TOSS_CLIENT_KEY,
      shippingFee: SHIPPING_FEE,
      freeShippingOver: FREE_SHIPPING_OVER,
      maxQtyPerLine: MAX_QTY_PER_LINE,
      paymentEnabled: Boolean(TOSS_CLIENT_KEY && TOSS_SECRET_KEY),
    },
  });
});

// ============================================================
// 카탈로그 (전부 DB 에서 읽는다)
// ============================================================

// GET /api/categories — 카테고리 + 상품 수
app.get('/api/categories', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.name, c.description, c.image, count(p.id)::int AS "productCount"
        FROM nalssi_categories c
        LEFT JOIN nalssi_products p ON p.category_id = c.id
       GROUP BY c.id
       ORDER BY c.sort_order`);
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/stories — 홈 화면의 히어로 · 룩북 · 스토리 · 드롭
app.get('/api/stories', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, kind, eyebrow, title, body, image, link, cta FROM nalssi_stories ORDER BY sort_order`,
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/products?category=running&sort=new&q=니트&limit=4
app.get('/api/products', async (req, res, next) => {
  try {
    const category = String(req.query.category || '').trim();
    const sort = PRODUCT_SORTS[String(req.query.sort || '')] ? String(req.query.sort) : 'recommended';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 50);
    const like = likePattern(req.query.q);

    const { rows } = await pool.query(
      `${PRODUCT_SELECT}
        WHERE ($1::text = '' OR p.category_id = $1)
          AND ($2::text = '' OR p.name ILIKE $2 OR p.tagline ILIKE $2 OR c.name ILIKE $2
               OR EXISTS (SELECT 1 FROM nalssi_variants WHERE product_id = p.id AND color_name ILIKE $2))
        ORDER BY ${PRODUCT_SORTS[sort]}
        LIMIT $3`,
      [category, like, limit],
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/products/:id — 상세: 컬러별 사이즈 재고 + 리뷰 + 착용감 요약
app.get('/api/products/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [product, variants, reviews] = await Promise.all([
      pool.query(`${PRODUCT_SELECT} WHERE p.id = $1`, [id]),
      pool.query(
        `SELECT v.id, v.color_name AS "colorName", v.color_hex AS "colorHex", v.image,
                COALESCE(json_agg(json_build_object('size', s.size, 'stock', s.qty) ORDER BY s.size)
                         FILTER (WHERE s.size IS NOT NULL), '[]') AS sizes
           FROM nalssi_variants v
           LEFT JOIN nalssi_stock s ON s.variant_id = v.id
          WHERE v.product_id = $1
          GROUP BY v.id
          ORDER BY v.sort_order`,
        [id],
      ),
      pool.query(
        `SELECT r.id, r.author, r.rating, r.size, r.fit, r.body, v.color_name AS "colorName",
                to_char(r.created_on, 'YYYY-MM-DD') AS "createdOn"
           FROM nalssi_reviews r
           LEFT JOIN nalssi_variants v ON v.id = r.variant_id
          WHERE r.product_id = $1
          ORDER BY r.created_on DESC, r.id`,
        [id],
      ),
    ]);
    if (product.rows.length === 0) throw userError(404, '상품을 찾을 수 없습니다.');

    const fit = { small: 0, true: 0, large: 0 };
    for (const r of reviews.rows) {
      if (r.fit === '작아요') fit.small += 1;
      else if (r.fit === '커요') fit.large += 1;
      else if (r.fit === '정사이즈') fit.true += 1;
    }

    res.json({
      success: true,
      data: { ...product.rows[0], variants: variants.rows, reviews: reviews.rows, fit },
    });
  } catch (err) {
    next(err);
  }
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
    const typedName = String(req.body?.name || '').trim();
    const name = typedName || email.split('@')[0].slice(0, 20); // 이름을 비우면 이메일 앞부분

    if (!isEmail(email)) throw userError(400, '이메일 형식이 올바르지 않습니다.');
    if (password.length < 8) throw userError(400, '비밀번호는 8자 이상이어야 합니다.');
    if (Buffer.byteLength(password) > 72) throw userError(400, '비밀번호가 너무 깁니다. (영문 기준 72자 이하)'); // bcrypt 한계
    if (typedName.length > 20) throw userError(400, '이름은 20자 이하로 입력해주세요.');

    // 비밀번호는 원문 대신 bcrypt 해시로만 저장한다 (DB 가 털려도 원문은 모른다)
    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO nalssi_users (email, name, password_hash)
            VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING
         RETURNING ${USER_COLUMNS}`,
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
      `SELECT ${USER_COLUMNS}, password_hash FROM nalssi_users WHERE email = $1`,
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
// body: { items: [{ variantId, size, qty }] }
// 응답의 orderId · amount 를 그대로 토스 SDK 에 넘겨야 승인 단계에서 금액 검증이 통과한다.
app.post('/api/orders', requireAuth, async (req, res, next) => {
  try {
    const raw = Array.isArray(req.body?.items) ? req.body.items : [];
    if (raw.length === 0) throw userError(400, '장바구니가 비어 있습니다.');
    if (raw.length > 20) throw userError(400, '한 번에 최대 20종까지 주문할 수 있습니다.');

    // 같은 컬러 · 사이즈가 두 줄로 오면 한 줄로 합친다 (재고 차감을 줄 단위로 정확히 하려고)
    const lines = new Map();
    for (const line of raw) {
      const variantId = String(line?.variantId || '');
      const size = Number(line?.size);
      const qty = Number(line?.qty);
      if (!variantId || !Number.isInteger(size)) throw userError(400, '상품 · 사이즈 정보가 올바르지 않습니다.');
      if (!Number.isInteger(qty) || qty < 1) throw userError(400, '수량이 올바르지 않습니다.');
      const key = `${variantId}:${size}`;
      const merged = (lines.get(key)?.qty || 0) + qty;
      if (merged > MAX_QTY_PER_LINE) throw userError(400, `같은 상품은 한 사이즈당 ${MAX_QTY_PER_LINE}개까지 주문할 수 있습니다.`);
      lines.set(key, { variantId, size, qty: merged });
    }

    // 가격 · 재고는 브라우저가 보낸 값을 버리고 DB 에서 읽는다
    const { rows: found } = await pool.query(
      `SELECT x.variant_id AS "variantId", x.size, v.product_id AS "productId", p.name, p.price,
              v.color_name AS "colorName", v.image, s.qty AS stock
         FROM jsonb_to_recordset($1::jsonb) AS x(variant_id text, size int)
         LEFT JOIN nalssi_variants v ON v.id = x.variant_id
         LEFT JOIN nalssi_products p ON p.id = v.product_id
         LEFT JOIN nalssi_stock    s ON s.variant_id = x.variant_id AND s.size = x.size`,
      [JSON.stringify([...lines.values()].map((l) => ({ variant_id: l.variantId, size: l.size })))],
    );
    const byKey = new Map(found.map((r) => [`${r.variantId}:${r.size}`, r]));

    const items = [...lines.entries()].map(([key, line]) => {
      const row = byKey.get(key);
      if (!row || !row.productId) throw userError(400, `없는 상품입니다: ${line.variantId}`);
      const label = `${row.name} ${row.colorName} ${line.size}`;
      if (row.stock == null) throw userError(400, `${row.name} ${row.colorName} 에는 ${line.size} 사이즈가 없습니다.`);
      if (row.stock === 0) throw userError(409, `${label} 은(는) 품절되었습니다.`, 'OUT_OF_STOCK');
      if (line.qty > row.stock) throw userError(409, `${label} 은(는) ${row.stock}개 남았습니다.`, 'OUT_OF_STOCK');
      return {
        variantId: row.variantId, productId: row.productId, name: row.name, colorName: row.colorName,
        image: row.image, size: line.size, qty: line.qty, price: row.price,
      };
    });

    const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
    const shipping = subtotal >= FREE_SHIPPING_OVER ? 0 : SHIPPING_FEE;
    const head = `${items[0].name} ${items[0].colorName} ${items[0].size}`;
    const orderName = (items.length > 1 ? `${head} 외 ${items.length - 1}건` : head).slice(0, 100); // 토스 100자 제한

    const { rows } = await pool.query(
      `INSERT INTO nalssi_orders (id, user_id, items, subtotal, shipping, amount, order_name, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY')
         RETURNING ${ORDER_COLUMNS}`,
      [makeOrderId(), req.user.id, JSON.stringify(items), subtotal, shipping, subtotal + shipping, orderName],
    );

    res.status(201).json({
      success: true,
      data: {
        ...rows[0],
        // 토스 SDK 에 그대로 넘기는 값들.
        // customerKey 는 토스 권고대로 추측할 수 없는 무작위 값(가입 때 DB 가 만든 UUID)을 쓴다.
        customerKey: req.user.customerKey,
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
// 기본은 결제를 시도한 주문만 보여 준다 (결제창만 열고 만 READY 는 숨긴다).
// ?status=PAID · FAILED 로 콕 집어 보거나, ?status=all 로 전부 볼 수 있다.
app.get('/api/orders', requireAuth, async (req, res, next) => {
  try {
    const status = String(req.query.status || '').toUpperCase();
    const { rows } = await pool.query(
      `SELECT ${ORDER_COLUMNS}
         FROM nalssi_orders
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
      summary: {
        count: rows.length,
        paidCount: paid.length,
        paidTotal: paid.reduce((sum, o) => sum + o.amount, 0),
        pairs: paid.reduce((sum, o) => sum + o.items.reduce((s, i) => s + i.qty, 0), 0),
        waitingCount: rows.filter((o) => o.status === 'WAITING_FOR_DEPOSIT').length,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/orders/:orderId — 주문 한 건 상세 (입금 대기면 토스에 입금 여부를 한 번 확인한다)
app.get('/api/orders/:orderId', requireAuth, async (req, res, next) => {
  try {
    const { userId, ...order } = await findMyOrder(req.params.orderId, req.user.id);
    res.json({ success: true, data: await syncDeposit(order) });
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
    const { rows } = await pool.query(`SELECT ${ORDER_COLUMNS} FROM nalssi_orders WHERE id = $1`, [String(orderId || '')]);
    if (rows.length === 0) throw userError(404, '주문을 찾을 수 없습니다.');

    const result = await confirmPayment({ order: rows[0], paymentKey: String(paymentKey || ''), amount });
    // 다른 요청이 승인 중(ALREADY_PROCESSING)이면 주문 화면에서 결과를 기다리게 한다
    if (!result.ok && result.error.code !== 'ALREADY_PROCESSING') {
      return res.redirect(AFTER_PAYMENT.fail(rows[0].orderId, result.error.message));
    }
    res.redirect(AFTER_PAYMENT.success(rows[0].orderId));
  } catch (err) {
    if (err.expose) return res.redirect(AFTER_PAYMENT.fail(String(orderId || ''), err.message));
    next(err);
  }
});

// GET /api/payments/fail — 사용자가 결제창을 닫거나 카드사에서 거절당한 경우 (아직 재고를 안 잡은 상태)
app.get('/api/payments/fail', async (req, res, next) => {
  const { orderId, code, message } = req.query;
  try {
    await markFailed(pool, String(orderId || ''),
      { code: String(code || 'PAY_PROCESS_CANCELED'), message: String(message || '결제가 취소되었습니다.') }, 'READY');
    res.redirect(AFTER_PAYMENT.fail(String(orderId || ''), String(message || '')));
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

// POST /api/payments/webhook — 토스 개발자센터에 등록하는 웹훅 주소 (DEPOSIT_CALLBACK: 가상계좌 입금 · 취소).
// body: { createdAt, secret, status, transactionKey, orderId }
// 로그인 없이 누구나 부를 수 있는 주소라, 승인 때 받아 둔 secret 과 같을 때만 반영한다.
app.post('/api/payments/webhook', async (req, res, next) => {
  try {
    const { secret, status, orderId } = req.body || {};
    const { rows } = await pool.query(`SELECT deposit_secret FROM nalssi_orders WHERE id = $1`, [String(orderId || '')]);
    const expected = rows[0]?.deposit_secret;
    const given = String(secret || '');
    const valid = expected && given.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!valid) return res.status(400).json({ success: false, message: '검증할 수 없는 웹훅입니다.' });

    const order = await applyDepositStatus(String(orderId), String(status || ''));
    // 토스는 10초 안에 200 을 받아야 재전송을 멈춘다. 이미 반영된 이벤트여도 200 으로 답한다.
    res.json({ success: true, data: { orderId, status: order ? order.status : 'UNCHANGED' } });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// 관리자 (role = 'admin' 계정만)
// ============================================================

// /api/admin 아래 모든 주소에 문지기를 한 번에 건다 → 관리자 API 를 새로 만들 때 깜빡해도 열리지 않는다.
// (로그인 안 함 401 · 일반 회원 403)
app.use('/api/admin', requireAuth, requireAdmin);

// GET /api/admin/upload-auth — 썸네일 업로드용 1회용 서명.
// 브라우저가 ImageKit 에 파일을 "직접" 올리게 해서, 큰 이미지가 우리 서버(서버리스 요청 4.5MB 제한)를 거치지 않게 한다.
// 서명 = HMAC-SHA1(비공개 키, token + expire). 비공개 키 자체는 응답에 넣지 않는다.
app.get('/api/admin/upload-auth', (_req, res, next) => {
  if (!IMAGEKIT_PUBLIC_KEY || !IMAGEKIT_PRIVATE_KEY) {
    return next(userError(503, '서버에 ImageKit 키가 없어 업로드할 수 없습니다. 이미지 주소를 직접 붙여 넣어 주세요.'));
  }
  const token = crypto.randomUUID();                      // 서명 하나로 한 번만 올릴 수 있다
  const expire = Math.floor(Date.now() / 1000) + 10 * 60; // 10분 뒤 만료 (ImageKit 은 1시간 안쪽만 받는다)
  const signature = crypto.createHmac('sha1', IMAGEKIT_PRIVATE_KEY).update(token + expire).digest('hex');
  res.json({
    success: true,
    data: { uploadUrl: IMAGEKIT_UPLOAD_URL, folder: IMAGEKIT_UPLOAD_FOLDER, publicKey: IMAGEKIT_PUBLIC_KEY, token, expire, signature },
  });
});

// 관리자가 고칠 수 있는 글자 칸 (DB 컬럼 → 화면 이름 · 최대 길이)
const PRODUCT_TEXT_FIELDS = {
  tagline:     { label: '한 줄 소개', max: 60 },
  description: { label: '상세 설명', max: 1000 },
};

// PATCH /api/admin/products/:id — 썸네일(컬러별 이미지) · 한 줄 소개 · 상세 설명 수정. 보낸 칸만 바꾼다.
// body: { tagline?, description?, images?: [{ variantId, image }] }
// 가격 · 재고는 결제 금액과 묶여 있어 여기서 바꾸지 않는다.
app.patch('/api/admin/products/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const body = req.body || {};

    const text = {};
    for (const [key, { label, max }] of Object.entries(PRODUCT_TEXT_FIELDS)) {
      if (body[key] === undefined) continue;
      const value = String(body[key]).trim();
      if (!value) throw userError(400, `${label}: 비워 둘 수 없습니다.`);
      if (value.length > max) throw userError(400, `${label}: ${max}자 이하로 입력해주세요.`);
      text[key] = value;
    }

    if (body.images !== undefined && !Array.isArray(body.images)) throw userError(400, '이미지 목록 형식이 올바르지 않습니다.');
    const images = new Map(); // variantId → 이미지 주소 (같은 컬러가 두 번 오면 마지막 값)
    for (const item of body.images || []) {
      const variantId = String(item?.variantId || '');
      const image = String(item?.image || '').trim();
      if (!variantId) throw userError(400, '어느 컬러의 이미지인지 알 수 없습니다.');
      if (!isImageUrl(image)) throw userError(400, '이미지 주소는 https:// 로 시작해야 합니다. (500자 이하)');
      images.set(variantId, image);
    }
    if (Object.keys(text).length === 0 && images.size === 0) throw userError(400, '바꿀 내용이 없습니다.');

    // 글자와 이미지를 한 트랜잭션으로 바꾼다 → 하나라도 잘못되면 아무것도 안 바뀐다
    await withTransaction(async (db) => {
      const found = await db.query(
        `UPDATE nalssi_products
            SET tagline = COALESCE($2, tagline), description = COALESCE($3, description)
          WHERE id = $1`,
        [id, text.tagline ?? null, text.description ?? null],
      );
      if (found.rowCount === 0) throw userError(404, '상품을 찾을 수 없습니다.');
      if (images.size === 0) return;

      const updated = await db.query(
        `UPDATE nalssi_variants v SET image = x.image
           FROM jsonb_to_recordset($2::jsonb) AS x(id text, image text)
          WHERE v.id = x.id AND v.product_id = $1`,
        [id, JSON.stringify([...images].map(([variantId, image]) => ({ id: variantId, image })))],
      );
      // 다른 상품의 컬러를 섞어 보내면 그 줄은 안 바뀐다 → 전부 되돌린다
      if (updated.rowCount !== images.size) throw userError(400, '이 상품의 컬러가 아닌 이미지가 섞여 있습니다.');
    });

    const { rows } = await pool.query(`${PRODUCT_SELECT} WHERE p.id = $1`, [id]);
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/users?q=검색어 — 회원 목록 (최근 가입순, 최대 500명) + 회원별 주문 수 · 결제 금액
// 비밀번호 해시 · 토스 customerKey 는 내려보내지 않는다.
app.get('/api/admin/users', async (req, res, next) => {
  try {
    const like = likePattern(req.query.q);
    const [list, summary] = await Promise.all([
      pool.query(
        `SELECT u.id, u.email, u.name, u.role,
                to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt",
                COALESCE(o.tried, 0)::int      AS "orderCount",
                COALESCE(o.paid, 0)::int       AS "paidCount",
                COALESCE(o.paid_total, 0)::int AS "paidTotal",
                to_char(o.last_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "lastOrderAt"
           FROM nalssi_users u
           LEFT JOIN LATERAL (
             -- 주문 수는 결제를 시도한 것만 센다 (주문서만 만들고 끝난 READY 제외 · 마이페이지와 같은 기준)
             SELECT count(*) FILTER (WHERE status <> 'READY')        AS tried,
                    count(*) FILTER (WHERE status = 'PAID')          AS paid,
                    sum(amount) FILTER (WHERE status = 'PAID')       AS paid_total,
                    max(created_at) FILTER (WHERE status <> 'READY') AS last_at
               FROM nalssi_orders WHERE user_id = u.id
           ) o ON TRUE
          WHERE ($1::text = '' OR u.email ILIKE $1 OR u.name ILIKE $1)
          ORDER BY u.created_at DESC
          LIMIT 500`,
        [like],
      ),
      pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE role = 'admin')::int AS admins,
                count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS "newThisWeek",
                (SELECT count(DISTINCT user_id)::int FROM nalssi_orders WHERE status = 'PAID') AS buyers
           FROM nalssi_users`,
      ),
    ]);
    res.json({ success: true, data: list.rows, summary: summary.rows[0] });
  } catch (err) {
    next(err);
  }
});

// 상태 필터로 받는 값. 비우면 결제를 시도한 주문 전부(READY 제외), ALL 이면 READY 까지 전부
const ADMIN_ORDER_STATUSES = ['PAID', 'WAITING_FOR_DEPOSIT', 'PAYING', 'FAILED', 'READY', 'ALL'];

// GET /api/admin/orders?status=PAID&userId=3&q=검색어 — 모든 회원의 주문 (최신순, 최대 300건)
//  q: 주문번호 · 상품명 · 회원 이메일 · 이름
//  summary.byStatus: 상태별 건수 · 금액 · 켤레 수 (상태 필터 · 검색어와 상관없이, 회원을 골랐으면 그 회원 기준)
app.get('/api/admin/orders', async (req, res, next) => {
  try {
    const raw = String(req.query.status || '').toUpperCase();
    const status = ADMIN_ORDER_STATUSES.includes(raw) ? raw : '';
    const userId = /^\d{1,9}$/.test(String(req.query.userId || '')) ? Number(req.query.userId) : null;
    const like = likePattern(req.query.q);

    const [list, byStatus, customer] = await Promise.all([
      pool.query(
        `SELECT ${ORDER_COLUMNS},
                (SELECT json_build_object('id', u.id, 'email', u.email, 'name', u.name)
                   FROM nalssi_users u WHERE u.id = o.user_id) AS customer
           FROM nalssi_orders o
          WHERE ($1::int IS NULL OR o.user_id = $1)
            AND CASE
                  WHEN $2::text = 'ALL' THEN TRUE
                  WHEN $2::text <> ''   THEN o.status = $2::text
                  ELSE o.status <> 'READY'
                END
            AND ($3::text = '' OR o.id ILIKE $3 OR o.order_name ILIKE $3
                 OR EXISTS (SELECT 1 FROM nalssi_users u
                             WHERE u.id = o.user_id AND (u.email ILIKE $3 OR u.name ILIKE $3)))
          ORDER BY o.created_at DESC
          LIMIT 300`,
        [userId, status, like],
      ),
      pool.query(
        `SELECT o.status, count(*)::int AS count,
                COALESCE(sum(o.amount), 0)::int AS amount,
                COALESCE(sum(q.pairs), 0)::int  AS pairs
           FROM nalssi_orders o
           CROSS JOIN LATERAL (
             SELECT sum((i->>'qty')::int) AS pairs FROM jsonb_array_elements(o.items) AS i
           ) q
          WHERE ($1::int IS NULL OR o.user_id = $1)
          GROUP BY o.status`,
        [userId],
      ),
      userId ? pool.query(`SELECT id, email, name FROM nalssi_users WHERE id = $1`, [userId]) : null,
    ]);

    res.json({
      success: true,
      data: list.rows,
      summary: {
        byStatus: Object.fromEntries(byStatus.rows.map(({ status: s, ...counts }) => [s, counts])),
        customer: customer ? customer.rows[0] || null : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── API 404 (여기까지 안 걸리면 없는 엔드포인트) ──
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: '없는 API 주소입니다.' });
});

// ── SPA fallback (Express 5 문법) ─────────────
// 화면은 해시 라우터(/#/shop)라 실제 페이지 주소는 / 하나뿐이다.
// 확장자가 붙었거나 점으로 시작하는 주소(/server.js · /.env)는 index.html 로 덮지 않고 404 로 돌려준다.
app.get('/{*splat}', (req, res) => {
  if (path.extname(req.path) || req.path.split('/').some((seg) => seg.startsWith('.'))) {
    return res.status(404).type('text').send('Not found');
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── 에러 핸들러 ───────────────────────────────
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: '요청 본문(JSON)을 읽지 못했습니다.' });
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err); // 스택 트레이스는 서버 로그에만
  res.status(status).json({
    success: false,
    message: err.expose ? err.message : '서버에서 문제가 발생했습니다.',
    ...(err.code && err.expose ? { code: err.code } : {}),
  });
});

// ── 관리자 계정 만들기 (터미널 전용) ─────────────
// node server.js create-admin <이메일> [비밀번호] [이름]
//  · 없는 이메일 → 관리자 계정을 새로 만든다. 비밀번호를 비우면 무작위로 만들어 한 번만 보여 준다
//  · 이미 있는 회원 → 관리자로 올린다. 비밀번호는 새로 줬을 때만 바꾼다
// 웹(회원가입 API)으로는 관리자를 만들 수 없게, 서버 .env(DB 주소)를 가진 사람만 쓰는 터미널 명령으로 둔다.
async function createAdmin(emailArg, passwordArg, nameArg) {
  if (!DATABASE_URL) throw new Error('DATABASE_URL 이 없습니다. .env 를 확인해주세요.');
  const email = String(emailArg || '').trim().toLowerCase();
  if (!isEmail(email)) throw new Error('사용법: node server.js create-admin <이메일> [비밀번호] [이름]');
  if (passwordArg !== undefined && passwordArg.length < 8) throw new Error('비밀번호는 8자 이상이어야 합니다.');
  if (passwordArg !== undefined && Buffer.byteLength(passwordArg) > 72) throw new Error('비밀번호가 너무 깁니다. (영문 기준 72자 이하)');

  await initDB(); // 테이블 · role 컬럼이 없으면 먼저 만든다
  const { rows: found } = await pool.query(`SELECT id FROM nalssi_users WHERE email = $1`, [email]);

  if (found.length > 0) {
    const hash = passwordArg ? await bcrypt.hash(passwordArg, 10) : null;
    await pool.query(
      `UPDATE nalssi_users SET role = 'admin', password_hash = COALESCE($2, password_hash) WHERE id = $1`,
      [found[0].id, hash],
    );
    console.log(`✅ ${email} (회원 번호 ${found[0].id}) 을(를) 관리자로 올렸습니다.${hash ? ' 비밀번호도 바꿨습니다.' : ''}`);
    return;
  }

  const password = passwordArg || crypto.randomBytes(12).toString('base64url'); // 16자 무작위
  const name = String(nameArg || '관리자').trim().slice(0, 20);
  const { rows } = await pool.query(
    `INSERT INTO nalssi_users (email, name, password_hash, role) VALUES ($1, $2, $3, 'admin') RETURNING id`,
    [email, name, await bcrypt.hash(password, 10)],
  );
  console.log(`✅ 관리자 계정을 만들었습니다 → ${email} (회원 번호 ${rows[0].id}, 이름 ${name})`);
  if (!passwordArg) console.log(`   비밀번호: ${password}   ← 지금 한 번만 보여 줍니다`);
}

// ── 시작 & export ─────────────────────────────
if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'create-admin') {
    createAdmin(...args)
      .catch((err) => { console.error(`❌ ${err.message}`); process.exitCode = 1; })
      .finally(() => pool.end());
  } else {
    if (!DATABASE_URL) console.warn('⚠️  DATABASE_URL 이 비어 있습니다 — 모든 /api 요청이 503 으로 막힙니다.');
    if (!JWT_SECRET) console.warn('⚠️  JWT_SECRET 이 비어 있습니다 — 회원가입/로그인이 503 으로 막힙니다.');
    if (!TOSS_SECRET_KEY || !TOSS_CLIENT_KEY) console.warn('⚠️  토스 키가 비어 있습니다 — 결제가 동작하지 않습니다.');
    if (!IMAGEKIT_PUBLIC_KEY || !IMAGEKIT_PRIVATE_KEY) console.warn('⚠️  ImageKit 키가 비어 있습니다 — 관리자 페이지에서 썸네일을 올릴 수 없습니다 (주소 붙여 넣기는 됩니다).');
    app.listen(PORT, () => console.log(`NALSSI 서버 실행 중 → http://localhost:${PORT}`));
  }
}
module.exports = app;
