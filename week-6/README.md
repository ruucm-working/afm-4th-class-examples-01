# MOOM · 무움가구 쇼핑몰 (week-6)

CDN React 한 파일(`index.html`) + Express 한 파일(`server.js`) 로 만든 가구 쇼핑몰.
이번 주에 **회원가입·로그인(JWT)** 과 **토스페이먼츠 결제 + 마이페이지 결제 내역** 을 붙였다.

## 실행

```bash
npm install
node server.js      # http://localhost:6060
```

`.env` 가 필요하다 (`.env.example` 참고). **`.env` 는 깃에 올라가지 않는다.**

| 키 | 쓰임 |
| --- | --- |
| `DATABASE_URL` | Supabase Postgres 연결 문자열 (Transaction pooler, 6543) |
| `TOSS_CLIENT_KEY` | 결제위젯 클라이언트 키. 공개되어도 되는 값 → `/api/config` 로 브라우저에 내려준다 |
| `TOSS_SECRET_KEY` | 결제 승인용 시크릿 키. **브라우저에 절대 내려보내지 않는다** |
| `JWT_SECRET` | 토큰 서명 키. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |

테이블(`moom_users`, `moom_orders`)은 첫 `/api` 요청 때 자동으로 만들어진다(lazy init).

## API

| 메서드 | 경로 | 요청 | 응답 |
| --- | --- | --- | --- |
| GET | `/api/config` | — | `{ tossClientKey, shippingFee, freeShippingOver, paymentEnabled }` |
| POST | `/api/auth/signup` | `{ email, password, name? }` | `{ token, user }` · 비밀번호 8자 이상 |
| POST | `/api/auth/login` | `{ email, password }` | `{ token, user }` |
| GET | `/api/auth/me` | 🔒 | `{ user }` — 새로고침 시 로그인 유지 |
| POST | `/api/orders` | 🔒 `{ items: [{ id, color?, qty }] }` | 주문서 + `customerKey`, 금액은 **서버가 계산** |
| GET | `/api/orders` | 🔒 `?status=PAID\|FAILED\|all` | 결제 내역(최신순) + `summary`. 기본은 결제 시도한 주문만 |
| GET | `/api/orders/:orderId` | 🔒 | 주문 상세 (본인 것만) |
| GET | `/api/payments/success` | 토스 리다이렉트 | 승인 후 `#/orders/:id?paid=1` 로 이동 |
| GET | `/api/payments/fail` | 토스 리다이렉트 | 실패 기록 후 `#/cart?failed=1` 로 이동 |
| POST | `/api/payments/confirm` | 🔒 `{ paymentKey, orderId, amount }` | 브라우저에서 직접 승인하고 싶을 때 |

🔒 = `Authorization: Bearer <token>` 필요. 응답은 전부 `{ success, data, message? }` 모양.

## 결제가 도는 순서

1. `/checkout` 이 `POST /api/orders` 로 **주문서를 먼저 만든다** → 서버가 카탈로그 가격으로 금액을 계산한다
2. 그 금액으로 토스 결제위젯을 그린다 (카드번호는 토스만 본다. 우리 서버는 모른다)
3. 결제가 끝나면 토스가 `/api/payments/success` 로 되돌려 보내고, **서버가** 시크릿 키로 최종 승인한다
4. 승인 결과를 DB 에 적고 `#/orders/:id` 로 보낸다 → 마이페이지에 남는다

금액을 브라우저에서 받지 않는 게 핵심이다. 승인 직전에 `보낸 금액 === 주문 금액` 을 다시 확인한다.

## 검증 (2026-09-22, 실제 브라우저로 진행)

`screenshots/` 에 01~12 단계가 순서대로 들어 있다.

| # | 단계 | 결과 |
| --- | --- | --- |
| 01 | 홈 (로그아웃) | 헤더에 로그인·회원가입 |
| 02–03 | 회원가입 | 가입 → 자동 로그인 → 마이페이지 |
| 04 | 틀린 비밀번호 | `이메일 또는 비밀번호가 올바르지 않습니다.` |
| 05 | 로그인 | 성공 |
| 06 | 장바구니 3개 | 670,000원 (상품 640,000 + 배송 30,000) |
| 07 | 결제 페이지 | 토스 결제위젯 렌더 · 주문번호 발급 |
| 08–10 | 토스 테스트 결제창 | 퀵계좌이체 · 테스트 비밀번호 `000000` |
| 11 | 결제 완료 | 계좌이체 · 670,000원 · 영수증 링크 · 장바구니 자동 비움 |
| 12 | 마이페이지 | 결제 완료 1건 · 합계 670,000원 |

DB 에도 그대로 남았다 — 비밀번호는 bcrypt 해시(`$2b$10$…`, 60자)로만, 주문에는 토스 `paymentKey`(`tgen_…`)가 저장된다.

**막아 둔 것** (직접 찔러서 확인)

- 클라이언트가 `price: 100` 을 보내도 무시하고 서버 카탈로그 가격으로 계산
- 승인 요청 금액을 100원으로 조작 → `AMOUNT_MISMATCH` 로 차단 (토스까지 가지도 않음)
- 남의 주문 조회 → 404 · 위조 토큰 → 401 · 재고 초과/없는 상품/빈 장바구니 → 400·409
- `/.env` 로 접근해도 설정이 노출되지 않음 (`dotfiles: 'ignore'`)

**확인 못 한 것** — 카드 결제와 토스페이는 카드사 앱·토스 앱의 실제 본인인증으로 넘어가서, 자동화로 끝까지 진행할 수 없었다. 위젯을 띄우고 검증 메시지가 뜨는 것까지는 확인했다. 승인 로직 자체는 퀵계좌이체로 끝까지 돌렸고, 결제수단이 달라져도 서버가 부르는 API(`/v1/payments/confirm`)는 같다.
