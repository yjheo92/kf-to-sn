# Kissflow → ServiceNow Migration Server

Kissflow HTML 파일을 분석하여 ServiceNow Catalog Item, Variables, Tasks를 자동으로 생성하는 서버입니다.

## 기능

- 📄 Kissflow HTML 파일 업로드 및 분석
- 🔍 필드 자동 추출 및 ServiceNow 타입 매핑
- 📊 분석 결과 시각화
- 🚀 ServiceNow API 호출로 자동 생성
  - Catalog Item
  - Variables (필드)
  - Choice Options (드롭다운)
  - Catalog Tasks (워크플로우)
- 📥 API Request Body JSON 다운로드

## 설치 및 실행

```bash
# 의존성 설치
npm install

# 서버 실행
npm start
```

브라우저에서 http://localhost:3000 접속

## 사용 방법

### Step 1: ServiceNow 연결
1. ServiceNow Instance URL 입력 (예: `your-instance` 또는 `https://your-instance.service-now.com`)
2. Username / Password 입력
3. "연결 테스트" 클릭

### Step 2: HTML 업로드
1. Kissflow Admin에서 export한 HTML 파일을 드래그 앤 드롭
2. 또는 클릭하여 파일 선택

### Step 3: 분석 결과 확인
- 필드 목록 및 타입 매핑 확인
- API Request Body 미리보기
- JSON 다운로드 가능

### Step 4: ServiceNow에 생성
1. Catalog Item 이름 및 설명 입력
2. "ServiceNow에 생성" 버튼 클릭
3. 실시간 로그 확인
4. 생성 완료 후 ServiceNow 링크로 이동

## API Endpoints

| Method | Endpoint | 설명 |
|--------|----------|------|
| POST | `/api/snow/connect` | ServiceNow 연결 |
| GET | `/api/snow/status` | 연결 상태 확인 |
| POST | `/api/analyze` | HTML 파일 업로드 및 분석 |
| POST | `/api/analyze-text` | HTML 텍스트 분석 |
| POST | `/api/snow/create-catalog` | ServiceNow에 전체 생성 |
| POST | `/api/snow/create-item` | 개별 레코드 생성 |
| GET | `/api/analysis/:id` | 분석 결과 조회 |
| GET | `/api/export/:id` | API JSON 다운로드 |

## 프로젝트 구조

```
kissflow-to-snow-server/
├── server.js         # Express 서버
├── parser.js         # HTML 파싱 모듈
├── snowClient.js     # ServiceNow API 클라이언트
├── public/
│   └── index.html    # 웹 UI
├── uploads/          # 임시 업로드 폴더
└── package.json
```

## ServiceNow 요구사항

- REST API 활성화
- 계정에 `admin` 또는 `catalog_admin` 역할 필요
- CORS 설정 (로컬 개발 시):
  - `System Properties` → `glide.rest.cors.enabled` = `true`

## 지원하는 Kissflow 필드 타입

| Kissflow Type | ServiceNow Variable Type |
|---------------|-------------------------|
| Text Area | Text Area (7) |
| Number | Numeric Scale (5) |
| Date | Date (10) |
| Date/Time | Date/Time (9) |
| Dropdown | Select Box (1) |
| Multi-select | List Collector (21) |
| User | Reference (8) |
| Lookup | Reference (8) |
| Attachment | Attachment (14) |
| Formula | Single Line Text (6, Read-only) |
| Sequence Number | Single Line Text (6) |

## 라이선스

MIT
