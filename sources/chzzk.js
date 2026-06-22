// 치지직(CHZZK) 라이브 채팅 커넥터.
// masterchat 커넥터(server.js)와 동일한 "세대 무효화 + 디바운스 재연결" 패턴을 따른다.
// 공개 라이브 채팅은 로그인/인증 없이 채널 ID 만으로 수신 가능(서버 환경).
// onMessage({ author, channelId, text, isDonation }) 로 정규화된 채팅 한 건을 전달한다.

let ChzzkClient;
try {
  ({ ChzzkClient } = require("chzzk"));
} catch (e) {
  console.warn("[warn] chzzk 로드 실패 — 치지직 채팅 수신 없이 동작합니다.", e.message);
}

/** 프로필에서 뱃지 이미지 URL 모음(구독·실시간후원·활동 뱃지). 중복 제거, 최대 5개. */
function collectBadges(profile) {
  if (!profile) return [];
  const urls = [];
  const push = (u) => { if (typeof u === "string" && u && !urls.includes(u)) urls.push(u); };
  if (profile.badge) push(profile.badge.imageUrl);
  const sp = profile.streamingProperty || {};
  if (sp.subscription && sp.subscription.badge) push(sp.subscription.badge.imageUrl);
  if (sp.realTimeDonationRanking && sp.realTimeDonationRanking.badge) push(sp.realTimeDonationRanking.badge.imageUrl);
  for (const b of profile.activityBadges || []) {
    if (b && b.activated !== false) push(b.imageUrl);
  }
  return urls.slice(0, 5);
}

/** 채팅 이벤트에서 이모티콘 맵(키→URL) 추출. 없으면 null. */
function emojisOf(e) {
  return e && e.extras && typeof e.extras.emojis === "object" ? e.extras.emojis : null;
}

/**
 * 치지직 채팅 소스를 생성한다.
 * @param {{ onMessage: (msg: {author:string, channelId:string|null, text:string, isDonation:boolean, emojis?:object|null, badges?:string[]}) => void }} opts
 * @returns {{ start: (channelId: string) => void, stop: () => void }}
 */
function createChzzkSource({ onMessage }) {
  let chat = null;
  let generation = 0; // 재시작 시 이전 세대의 콜백/재연결을 무효화
  let retryTimer = null;

  // disconnect() 는 async 라 연결 전 호출 시 'Not connected' 로 reject 된다 →
  // 동기 try/catch 로는 못 잡으므로 promise 거부까지 흡수한다.
  function safeDisconnect(c) {
    if (!c) return;
    try {
      const p = c.disconnect();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* ignore */
    }
  }

  function stop() {
    generation++; // 진행 중인 connect 루프/재연결 타이머 무효화
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    safeDisconnect(chat);
    chat = null;
  }

  function start(channelId) {
    if (!ChzzkClient) return;
    const id = String(channelId || "").trim();
    if (!id) {
      console.warn("[chzzk] 채널 ID 가 비어 있습니다. 치지직 수신을 건너뜁니다.");
      console.warn("        admin.html 에서 치지직 채널 ID 를 넣고 저장&재시작 하세요.");
      return;
    }

    const myGen = ++generation;
    const isStale = () => myGen !== generation;

    const scheduleReconnect = (why, ms = 15000) => {
      if (isStale() || retryTimer) return;
      console.warn(`[chzzk] ${why} — ${Math.round(ms / 1000)}초 후 재연결.`);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, ms);
    };

    const connect = async () => {
      if (isStale()) return;
      // 이전 인스턴스 정리(중복 리스너/소켓 방지)
      safeDisconnect(chat);
      chat = null;
      try {
        console.log(`[chzzk] 연결 시도: ${id}`);
        const client = new ChzzkClient(); // 인증 없이 공개 채팅 수신
        const c = client.chat({ channelId: id });
        if (isStale()) {
          safeDisconnect(c);
          return;
        }
        chat = c;

        c.on("chat", (e) => {
          if (isStale()) return;
          try {
            onMessage({
              author: (e.profile && e.profile.nickname) || (e.profile && e.profile.userIdHash) || "익명",
              channelId: (e.profile && e.profile.userIdHash) || null,
              text: e.message || "",
              isDonation: false,
              emojis: emojisOf(e),
              badges: collectBadges(e.profile),
            });
          } catch {
            /* 단일 채팅 처리 실패는 무시 */
          }
        });

        c.on("donation", (e) => {
          if (isStale()) return;
          try {
            onMessage({
              author: (e.profile && e.profile.nickname) || "익명",
              channelId: (e.profile && e.profile.userIdHash) || null,
              text: e.message || "",
              isDonation: true,
              emojis: emojisOf(e),
              badges: collectBadges(e.profile),
            });
          } catch {
            /* ignore */
          }
        });

        // 라이브러리는 일시 오류는 내부 재연결로 복구하지만, 소켓이 끊기면
        // chatChannelId 가 비워지므로(오프라인/방송 종료) 새 연결을 다시 맺는다.
        c.on("disconnect", () => {
          if (isStale()) return;
          scheduleReconnect("연결 끊김(방송 종료 등)");
        });

        await c.connect();
        if (isStale()) {
          safeDisconnect(c);
          return;
        }
        console.log("[chzzk] 채팅 수신 시작 ✔");
      } catch (e) {
        if (isStale()) return;
        // 채널이 아직 라이브가 아니면 status 조회/연결이 실패한다 → 잠시 후 재시도.
        console.error("[chzzk] 연결 실패:", (e && e.message) || e);
        scheduleReconnect("연결 실패");
      }
    };

    connect();
  }

  return { start, stop };
}

module.exports = { createChzzkSource };
