# 경제총조사 산업분류 챗봇

기업 활동을 채팅창에 입력하면 Gemini API로 활동내용을 정리하고, 산업분류표 JSON만 기준으로 산업분류를 판정하는 웹앱입니다.

## Vercel 배포

1. 이 프로젝트를 GitHub에 올립니다.
2. Vercel에서 프로젝트를 Import 합니다.
3. Vercel Project Settings > Environment Variables에 아래 값을 추가합니다.

```env
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-flash
```

4. Deploy를 실행합니다.

산업분류표는 프로젝트 루트의 `ecensus_industry_full.json`만 사용합니다. 사용자가 화면에서 다른 JSON을 업로드하거나 API 요청으로 산업분류표를 교체할 수 없도록 구성했습니다.

## 로컬 실행

1. `.env.example`을 복사해 `.env`를 만듭니다.
2. `.env`에 Gemini API 키를 입력합니다.

```env
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-flash
PORT=3000
```

3. 서버를 실행합니다.

```bash
npm start
```

4. 브라우저에서 `http://localhost:3000`을 엽니다.

## 산업분류표 없는 경우

산업분류표가 없으면 산업분류코드, 산업분류명, 색인은 임의 생성하지 않고 `산업분류파일 필요`라고 답하도록 프롬프트를 구성했습니다.
