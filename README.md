# ytworldcup — YouTube 라이브 채팅/투표 → vMix 오버레이

YouTube 라이브의 채팅을 받아 **투표를 집계**하고, 예쁜 HTML5 오버레이로 그려서
**vMix의 Web Browser 입력**으로 띄우는 로컬 서버입니다. (SDI 캡처카드 불필요)

## 동작 방식

```
YouTube 라이브 ──(masterchat 크롤링, 쿼터 무제한)──▶ server.js
   · 채팅 키워드 집계(A/B, 팀명, 이모지)
   · 네이티브 설문 감지(best effort)
        │ WebSocket 실시간 푸시
        ▼
   public/overlay.html (투명 배경)
        │
   vMix ▶ Add Input ▶ Web Browser ▶ http://localhost:3000/overlay.html
```

## 설치 & 실행

```powershell
cd "G:\내 드라이브\S\servers\ytworldcup"
npm install
npm start
```

콘솔에 오버레이 URL이 출력됩니다. 라이브 영상이 바뀌면 `config.json`의 `videoId`만 수정.

## vMix 설정

1. **Add Input → Web Browser**
2. URL: `http://localhost:3000/overlay.html`
3. Width `1920`, Height `1080`
4. **Transparent Background 체크** ← 투명 합성 핵심
5. 이 입력을 Overlay 채널에 올려 라이브 영상 위에 합성

> 같은 PC면 위처럼 Web Browser 입력이면 끝입니다.
> 렌더 PC와 vMix PC가 **분리**된 경우에만 렌더 PC를 풀스크린(`overlay.html`)으로
> 띄우고 DeckLink 등 SDI 카드로 캡처해서 vMix에 SDI 입력으로 넣으세요.

## 투표 방식 (config.json → poll.mode)

| mode | 설명 |
|------|------|
| `keyword` | 채팅에 키워드(A/B, 울산/서울, 이모지 등) 입력을 집계 |
| `native`  | 유튜브 네이티브 설문 결과만 표시 |
| `auto`    | 네이티브 설문이 감지되면 그걸 쓰고, 없으면 키워드 집계 (기본값) |

- `oneVotePerUser: true` → 한 사람당 1표(마지막 입력 기준)
- 팀/키워드/색상은 `config.json`의 `poll.teams`에서 수정

## 주의

- **masterchat 크롤링**은 유튜브 내부 포맷에 의존합니다. 깨지면 `npm update masterchat`.
- **네이티브 설문 파싱**은 best-effort 휴리스틱입니다. 실제 설문을 열고
  콘솔 로그를 보면서 `findPollData()`를 영상 포맷에 맞게 조정해야 할 수 있습니다.
- 공식 YouTube Data API는 쿼터(1만 units/일, 채팅 폴링 시 ~1시간 소진) 때문에
  장시간 라이브에는 부적합하여 크롤링 방식을 채택했습니다.
