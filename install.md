# 설치 & 실행 (간단 가이드)

YouTube 라이브 채팅 투표를 vMix 투명 오버레이로 띄우는 로컬 서버입니다.

## 1. 준비물

- **Node.js 18 이상** — [nodejs.org](https://nodejs.org) 에서 LTS 버전 설치
- 설치 확인 (PowerShell):
  ```powershell
  node -v
  ```

## 2. 설치

프로젝트 폴더에서 한 번만 실행:

```powershell
cd "C:\Users\KBS\Documents\ora_html\ytworldcup"
npm install
```

## 3. 실행

```powershell
npm start
```

콘솔에 오버레이 URL이 뜨면 성공입니다.

```
오버레이 URL : http://localhost:3000/overlay.html
```

> 종료하려면 콘솔에서 `Ctrl + C`.

## 4. 설정 (브라우저에서)

서버를 켠 상태로 브라우저에서 접속:

```
http://localhost:3000/admin.html
```

- **유튜브 라이브 주소** 칸에 라이브 URL을 통째로 붙여넣기 (영상 ID 자동 추출)
- 질문, 팀/후보 이름, 색상, **집계 키워드**(쉼표로 구분) 입력
- **💾 저장 & 재시작** 클릭 → 즉시 반영 (서버 껐다 켤 필요 없음)

## 5. vMix 연동

1. **Add Input → Web Browser**
2. URL: `http://localhost:3000/overlay.html`
3. Width `1920`, Height `1080`
4. **Transparent Background 체크** ← 투명 합성 핵심
5. 이 입력을 Overlay 채널에 올려 라이브 영상 위에 합성

> 같은 PC면 위 설정으로 끝. SDI 캡처카드 불필요.

## 문제 해결

| 증상 | 해결 |
|------|------|
| `npm` 명령을 못 찾음 | Node.js 재설치 후 PowerShell 새로 열기 |
| 채팅이 안 들어옴 | admin.html 의 videoId 가 **현재 진행 중인 라이브**인지 확인 |
| 투표 집계가 0 | 시청자가 입력한 단어가 `keywords` 에 있는지 확인 (2글자 이상은 문장 포함도 매칭) |
| 포트 충돌 | admin.html 에서 포트 변경 후 저장 |
| masterchat 깨짐 | `npm update masterchat` (유튜브 포맷 변경 시) |
