"use strict";

/**
 * ytworldcup — YouTube 라이브 채팅 투표 → vMix HTML 오버레이 로컬 서버
 *
 *  YouTube 라이브 ──(masterchat 크롤링)──▶ server.js
 *     · 채팅 키워드 집계(A/B, 팀명, 이모지)
 *     · 네이티브 설문 감지(best-effort)
 *          │ WebSocket 실시간 푸시
 *          ▼
 *     public/overlay.html  ──▶  vMix Web Browser 입력
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const multer = require("multer");
const { WebSocketServer } = require("ws");

let Masterchat, stringify;
try {
  ({ Masterchat, stringify } = require("masterchat"));
} catch (e) {
  console.warn("[warn] masterchat 로드 실패 — 채팅 수신 없이 오버레이만 서빙합니다.", e.message);
}

// ---------- config ----------
const CONFIG_PATH = path.join(__dirname, "config.json");
function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}
let config = loadConfig();
const PORT = process.env.PORT || config.port || 3000;

/** 유튜브 URL 또는 raw ID 에서 11자리 videoId 추출 */
function extractVideoId(input) {
  const s = String(input || "").trim();
  if (!s) return "";
  // 이미 11자리 ID 형태면 그대로
  if (/^[\w-]{11}$/.test(s)) return s;
  const patterns = [
    /[?&]v=([\w-]{11})/, // watch?v=ID
    /youtu\.be\/([\w-]{11})/, // youtu.be/ID
    /\/live\/([\w-]{11})/, // /live/ID
    /\/embed\/([\w-]{11})/, // /embed/ID
    /\/shorts\/([\w-]{11})/, // /shorts/ID
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  // 마지막 경로 조각이 11자리면 사용
  const tail = s.split(/[/?#]/).filter(Boolean).pop();
  if (tail && /^[\w-]{11}$/.test(tail)) return tail;
  return s; // 추출 실패 시 원문 유지(사용자 확인용)
}

// ---------- state ----------
const CHAT_HISTORY_MAX = 30;
const chatHistory = [];
/** authorChannelId -> teamKey (oneVotePerUser 일 때 마지막 표 기준) */
const userVotes = new Map();
/** teamKey -> count (oneVotePerUser=false 일 때 누적) */
const rawCounts = new Map();
let nativePoll = null; // 네이티브 설문 감지 시 { question, options:[{label,votes}], total }
let onAir = false; // 송출 상태 (layout.html 그래픽 fade in/out)
let tallying = true; // 집계 상태 (false 면 득표 집계 정지 = 투표 종료)

// ---------- vote aggregation ----------
function teamByKey(key) {
  return config.poll.teams.find((t) => t.key === key);
}

/** 채팅 텍스트가 어느 팀에 해당하는지 판별. 매칭 없으면 null */
function matchTeam(text) {
  const lower = String(text || "").toLowerCase().trim();
  if (!lower) return null;
  // 토큰 단위 정확 매칭 우선, 없으면 포함 매칭
  const tokens = lower.split(/\s+/);
  for (const team of config.poll.teams) {
    for (const kw of team.keywords) {
      const k = String(kw).toLowerCase();
      if (tokens.includes(k)) return team.key;
    }
  }
  for (const team of config.poll.teams) {
    for (const kw of team.keywords) {
      const k = String(kw).toLowerCase();
      if (k.length >= 2 && lower.includes(k)) return team.key;
    }
  }
  return null;
}

/**
 * 별표 투표: 메시지가 "*1" 처럼 별표+숫자 "그것만"일 때만 인정(앞뒤 공백만 허용).
 * 키워드 사용 여부와 무관하게 항상 인정.
 *   "*1" → teams[0]    "*2" → teams[1]
 *   "* 1"(공백)·"*1 화이팅"·"*2 별로 *1" 등 다른 내용이 섞이면 불인정. 매칭 없으면 null.
 */
function matchStarVote(text) {
  const m = String(text || "").trim().match(/^\*(\d{1,2})$/);
  if (!m) return null;
  const idx = parseInt(m[1], 10) - 1;
  const team = config.poll.teams[idx];
  return team ? team.key : null;
}

function registerVote(channelId, teamKey) {
  if (!teamKey) return false;
  if (config.poll.oneVotePerUser) {
    const id = channelId || `anon-${userVotes.size}`;
    if (userVotes.get(id) === teamKey) return false;
    userVotes.set(id, teamKey);
  } else {
    rawCounts.set(teamKey, (rawCounts.get(teamKey) || 0) + 1);
  }
  return true;
}

/**
 * 채팅 한 건을 집계 규칙에 따라 처리(실제 채팅/테스트 공용).
 *  - 별표 투표(*N)는 키워드 사용 여부와 무관하게 항상 인정
 *  - useKeywords 가 꺼져 있지 않으면 등록 키워드로도 집계
 * 반환: 집계된 teamKey | null
 */
function countChatVote(channelId, text) {
  if (!tallying) return null;
  if (config.poll.mode !== "keyword" && config.poll.mode !== "auto") return null;
  let teamKey = matchStarVote(text);
  if (!teamKey && config.poll.useKeywords !== false) teamKey = matchTeam(text);
  if (registerVote(channelId, teamKey)) {
    pushPoll();
    return teamKey;
  }
  return null;
}

function tallyKeyword() {
  const counts = new Map();
  for (const t of config.poll.teams) counts.set(t.key, 0);
  if (config.poll.oneVotePerUser) {
    for (const key of userVotes.values()) {
      if (counts.has(key)) counts.set(key, counts.get(key) + 1);
    }
  } else {
    for (const [key, n] of rawCounts) {
      if (counts.has(key)) counts.set(key, n);
    }
  }
  return counts;
}

/** 오버레이가 기대하는 poll payload 생성 */
function buildPollPayload() {
  const useNative =
    (config.poll.mode === "native" || config.poll.mode === "auto") && nativePoll;

  const showChat = !!config.poll.showChat;
  const closed = !tallying;
  // 그래픽 모드(best 템플릿 전용). image 모드 시 시퀀스 재생 속도 동봉.
  const graphicMode = config.poll.graphicMode === "image" ? "image" : "bar";
  const imageFps = Number(config.poll.imageFps) > 0 ? Number(config.poll.imageFps) : 24;

  if (useNative) {
    const total = nativePoll.total || 0;
    const teams = nativePoll.options.slice(0, 5).map((opt, i) => {
      const cfg = config.poll.teams[i] || {};
      return {
        key: cfg.key || String.fromCharCode(65 + i),
        name: opt.label || cfg.name || "",
        subName: cfg.subName || "",
        color: cfg.color || PALETTE[i % PALETTE.length],
        count: opt.count || 0,
        pct: opt.pct != null ? opt.pct : 0,
        image: cfg.image || null,
      };
    });
    // 질문: admin 질문이 있으면 우선, 비어 있으면 유튜브 설문 질문 사용
    return {
      question: adminQuestion() || nativePoll.question || "",
      total,
      teams,
      showChat,
      closed,
      template: config.poll.template || "best",
      graphicMode,
      imageFps,
      source: "native",
    };
  }

  // keyword
  const counts = tallyKeyword();
  let total = 0;
  for (const n of counts.values()) total += n;
  const teams = config.poll.teams.map((t, i) => {
    const count = counts.get(t.key) || 0;
    return {
      key: t.key,
      name: t.name,
      subName: t.subName,
      color: t.color || PALETTE[i % PALETTE.length],
      count,
      pct: total ? Math.round((count / total) * 100) : 0,
      image: t.image || null,
    };
  });
  return {
    question: adminQuestion(),
    total,
    teams,
    showChat,
    closed,
    template: config.poll.template || "best",
    graphicMode,
    imageFps,
    source: "keyword",
  };
}

/** 선택지 기본 색상 팔레트 (최대 5개) */
const PALETTE = ["#1e6fd6", "#d6281e", "#01b22d", "#f59e0b", "#7c3aed"];

/** 단일 투표 질문 (구 config 의 questionKr 도 호환) */
function adminQuestion() {
  return config.poll.question || config.poll.questionKr || "";
}

// ---------- web + ws ----------
const ASSETS_DIR = path.join(__dirname, "public", "assets");
const PRESETS_DIR = path.join(__dirname, "presets");

function ensureDir(d) {
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
}
/** 투표 이름 → 파일명 안전화(한글 허용, 경로문자 제거) */
function presetIdFromName(name) {
  return String(name || "")
    .trim()
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}
/** 현재 config 를 이름 기준 프리셋 파일로 저장(업서트) */
function savePreset(cfg) {
  const name = cfg && cfg.name && String(cfg.name).trim();
  if (!name) return null;
  ensureDir(PRESETS_DIR);
  const id = presetIdFromName(name);
  const file = path.join(PRESETS_DIR, id + ".json");
  const toSave = Object.assign({}, cfg, { name, savedAt: Date.now() });
  fs.writeFileSync(file, JSON.stringify(toSave, null, 2) + "\n", "utf8");
  return id;
}

const app = express();
app.use(express.json({ limit: "256kb" }));
app.get("/", (_req, res) => res.redirect("/admin.html"));
app.use(express.static(path.join(__dirname, "public")));
app.get("/config", (_req, res) => res.json(config));
app.get("/poll", (_req, res) => res.json(buildPollPayload()));

// ---------- 그림 모드: 선택지 이미지 업로드 ----------
// PNG 한 장(스틸) 또는 여러 장(시퀀스)을 받아 public/assets/<id>/ 에 frame_0001.png… 로 정규화 저장.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 600 }, // 장당 8MB, 최대 600프레임
});
app.post("/admin/upload", upload.array("frames"), (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok: false, error: "업로드된 파일이 없습니다." });

    // 프레임 순서: 원본 파일명 기준 자연 정렬(숫자 인식)
    files.sort((a, b) =>
      a.originalname.localeCompare(b.originalname, undefined, { numeric: true, sensitivity: "base" })
    );

    // 이전 폴더 삭제(재업로드 누적 방지) — public/assets 하위만 허용
    const prevDir = typeof req.body.prevDir === "string" ? req.body.prevDir : "";
    safeRemoveAssetDir(prevDir);

    // 새 폴더 생성
    const key = String(req.body.key || "x").replace(/[^\w-]/g, "").slice(0, 8) || "x";
    const id = `${Date.now()}-${key}`;
    const destAbs = path.join(ASSETS_DIR, id);
    fs.mkdirSync(destAbs, { recursive: true });

    files.forEach((f, i) => {
      const n = String(i + 1).padStart(4, "0");
      fs.writeFileSync(path.join(destAbs, `frame_${n}.png`), f.buffer);
    });

    res.json({ ok: true, dir: `/assets/${id}/`, count: files.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** "/assets/<id>/" 형태의 디렉터리를 public/assets 하위에서만 안전하게 삭제 */
function safeRemoveAssetDir(urlDir) {
  if (!urlDir || typeof urlDir !== "string") return;
  const m = urlDir.match(/^\/assets\/([\w-]+)\/?$/);
  if (!m) return;
  const abs = path.join(ASSETS_DIR, m[1]);
  if (!abs.startsWith(ASSETS_DIR)) return; // 경로 이탈 방지
  try {
    fs.rmSync(abs, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// admin: 현재 config.json 원문 텍스트 반환
app.get("/admin/config", (_req, res) => {
  try {
    res.type("application/json").send(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// admin: 송출 상태 조회 / 토글
app.get("/admin/onair", (_req, res) => res.json({ on: onAir }));
app.post("/admin/onair", (req, res) => {
  onAir = !!(req.body && req.body.on);
  broadcast("onair", onAir);
  console.log(`[onair] ${onAir ? "ON (송출 시작)" : "OFF (송출 종료)"}`);
  res.json({ ok: true, on: onAir });
});

// admin: config 저장 + 재시작. body = { text: "<json 문자열>" }
app.post("/admin/save", (req, res) => {
  const text = req.body && typeof req.body.text === "string" ? req.body.text : null;
  if (text == null) return res.status(400).json({ ok: false, error: "text 필드가 필요합니다." });

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return res.status(400).json({ ok: false, error: "JSON 파싱 실패: " + e.message });
  }
  // 최소 스키마 검증
  if (!parsed.poll || !Array.isArray(parsed.poll.teams) || parsed.poll.teams.length < 2) {
    return res.status(400).json({ ok: false, error: "poll.teams 배열(2개 이상)이 필요합니다." });
  }

  // videoId 가 전체 URL 로 들어와도 ID 만 추출
  parsed.videoId = extractVideoId(parsed.videoId);

  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  } catch (e) {
    return res.status(500).json({ ok: false, error: "파일 저장 실패: " + e.message });
  }

  // 투표 이름이 있으면 프리셋으로도 저장(업서트)
  let presetId = null;
  try {
    presetId = savePreset(parsed);
  } catch (e) {
    /* 프리셋 저장 실패는 라이브 적용에 영향 없음 */
  }

  const keepStats = !!(req.body && req.body.keepStats);
  restartFromConfig(parsed, keepStats);
  res.json({
    ok: true,
    message:
      (keepStats ? "저장 완료 (통계 지속)." : "저장 완료 (통계 리셋).") +
      (presetId ? " · 프리셋 저장됨" : ""),
    videoId: parsed.videoId || "",
    presetId,
  });
});

// admin: 프리셋(저장된 투표) 목록
app.get("/admin/presets", (_req, res) => {
  ensureDir(PRESETS_DIR);
  let presets = [];
  try {
    presets = fs
      .readdirSync(PRESETS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const id = f.replace(/\.json$/, "");
        let name = id, savedAt = 0;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), "utf8"));
          name = j.name || id;
          savedAt = j.savedAt || 0;
        } catch { /* 손상 파일 무시 */ }
        return { id, name, savedAt };
      })
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
  res.json({ ok: true, presets });
});

// admin: 프리셋 하나 가져오기 (?id=<파일명>)
app.get("/admin/preset", (req, res) => {
  const id = presetIdFromName(req.query.id || "");
  const file = path.join(PRESETS_DIR, id + ".json");
  if (!file.startsWith(PRESETS_DIR) || !fs.existsSync(file)) {
    return res.status(404).json({ ok: false, error: "존재하지 않는 프리셋입니다." });
  }
  try {
    res.type("application/json").send(fs.readFileSync(file, "utf8"));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// admin: 프리셋 삭제 (?id=<파일명>)
app.post("/admin/preset/delete", (req, res) => {
  const id = presetIdFromName((req.body && req.body.id) || "");
  const file = path.join(PRESETS_DIR, id + ".json");
  if (!file.startsWith(PRESETS_DIR) || !fs.existsSync(file)) {
    return res.status(404).json({ ok: false, error: "존재하지 않는 프리셋입니다." });
  }
  try {
    fs.rmSync(file, { force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// admin: 통계 즉시 리셋 (config 변경 없음)
app.post("/admin/reset", (_req, res) => {
  resetStats();
  pushPoll();
  console.log("[reset] 통계 초기화");
  res.json({ ok: true, message: "통계를 리셋했습니다." });
});

// admin: 집계 상태 조회 / 토글 (false = 투표 종료, 득표 정지)
app.get("/admin/tally", (_req, res) => res.json({ on: tallying }));
app.post("/admin/tally", (req, res) => {
  tallying = !!(req.body && req.body.on);
  pushPoll();
  console.log(`[tally] ${tallying ? "ON (집계 시작)" : "OFF (집계 종료)"}`);
  res.json({ ok: true, on: tallying });
});

// admin: 테스트 채팅 주입 (YouTube 없이 집계 테스트). test.html 에서 사용.
// body = { text, author?, channelId?, isSuperchat? }
app.post("/admin/testchat", (req, res) => {
  const b = req.body || {};
  const text = typeof b.text === "string" ? b.text : "";
  if (!text.trim()) return res.status(400).json({ ok: false, error: "text 가 필요합니다." });
  const author = (typeof b.author === "string" && b.author.trim()) || "테스터";
  const channelId = (typeof b.channelId === "string" && b.channelId) || `test-${author}`;
  const isSuperchat = !!b.isSuperchat;

  pushChat(author, text, isSuperchat);
  const teamKey = countChatVote(channelId, text);
  res.json({ ok: true, counted: !!teamKey, teamKey: teamKey || null });
});

// admin: 집계 키워드 사용 on/off (test.html 에서 즉시 토글). config.json 에도 반영.
app.get("/admin/usekeywords", (_req, res) => res.json({ on: config.poll.useKeywords !== false }));
app.post("/admin/usekeywords", (req, res) => {
  const on = !!(req.body && req.body.on);
  config.poll.useKeywords = on;
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  } catch (e) {
    /* 파일 저장 실패해도 메모리 설정은 적용됨 */
  }
  console.log(`[usekeywords] ${on ? "ON (키워드 집계)" : "OFF (별표 투표만)"}`);
  res.json({ ok: true, on });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}
function pushPoll() {
  broadcast("poll", buildPollPayload());
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "chatHistory", data: chatHistory.slice(-10) }));
  ws.send(JSON.stringify({ type: "poll", data: buildPollPayload() }));
  ws.send(JSON.stringify({ type: "onair", data: onAir }));
});

// ---------- masterchat ----------
let _chatSeen = 0;
function pushChat(author, text, isSuperchat) {
  if (process.env.DEBUG_CHAT) {
    _chatSeen++;
    if (_chatSeen <= 20) console.log(`[chat#${_chatSeen}] ${author}: ${text}`);
  }
  const entry = { author, text, isSuperchat: !!isSuperchat };
  chatHistory.push(entry);
  if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.shift();
  broadcast("chat", entry);
}

/** YTText / runs / 문자열 → 평문 텍스트 */
function textOf(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (v.simpleText) return v.simpleText;
  try {
    return stringify ? stringify(v) : String(v);
  } catch {
    return "";
  }
}
/** "45%" / "45.2%" → 45,  "1,234 votes" / "1,234" → 1234 */
function parseNum(v) {
  if (typeof v === "number") return v;
  const s = textOf(v).replace(/[^0-9.]/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/**
 * 네이티브 설문 파싱. masterchat 의 세 가지 poll 액션을 모두 처리:
 *  - showPollPanelAction : 설문 시작 (보통 0표)
 *  - updatePollAction    : 진행 중 (voteCount + choice.voteRatio)
 *  - addPollResultAction : 종료 결과 (total + choice.votePercentage 문자열)
 * 반환: { question, total, options:[{label, count, pct}] } | null
 */
function findPollData(action) {
  const t = action && action.type;
  if (t !== "showPollPanelAction" && t !== "updatePollAction" && t !== "addPollResultAction") {
    return null;
  }
  const choices = action.choices || [];
  if (!Array.isArray(choices) || choices.length < 2) return null;

  const question = textOf(action.question);

  if (t === "addPollResultAction") {
    // 종료 결과: % 문자열 기반
    const total = parseNum(action.total);
    const options = choices.map((c) => {
      const pct = Math.round(parseNum(c.votePercentage));
      return { label: textOf(c.text), pct, count: Math.round((pct / 100) * total) };
    });
    return { question, total, options };
  }

  // 진행 중(update) 또는 시작(show)
  const total = parseNum(action.voteCount); // show 에는 없을 수 있음 → 0
  const options = choices.map((c) => {
    let pct;
    if (typeof c.voteRatio === "number") pct = Math.round(c.voteRatio * 100);
    else if (c.votePercentage != null) pct = Math.round(parseNum(c.votePercentage));
    else pct = 0;
    return { label: textOf(c.text), pct, count: Math.round((pct / 100) * total) };
  });
  return { question, total, options };
}

const _seenTypes = new Set();
function handleAction(action) {
  if (!action || !action.type) return;
  const type = action.type;

  if (process.env.DEBUG_POLL) {
    if (!_seenTypes.has(type)) {
      _seenTypes.add(type);
      console.log("[type]", type);
    }
    if (/poll|panel/i.test(type)) {
      console.log("[POLL RAW]", JSON.stringify(action).slice(0, 600));
    }
  }

  // 네이티브 설문
  if (config.poll.mode === "native" || config.poll.mode === "auto") {
    const poll = findPollData(action);
    if (poll) {
      if (!tallying) return; // 집계 종료 시 득표 갱신 정지(현재 결과 유지)
      // updatePollAction 에는 question 이 없을 수 있음 → 직전 질문 유지
      if (!poll.question && nativePoll && nativePoll.question) poll.question = nativePoll.question;
      if (process.env.DEBUG_POLL) console.log("[POLL PARSED]", JSON.stringify(poll));
      nativePoll = poll;
      pushPoll();
      return;
    }
  }

  if (type === "addChatItemAction" || type === "addSuperChatItemAction") {
    const author = action.authorName || action.authorChannelId || "익명";
    const text = stringify ? stringify(action.message || []) : String(action.message || "");
    const isSuperchat = type === "addSuperChatItemAction";
    pushChat(author, text, isSuperchat);

    countChatVote(action.authorChannelId, text);
  }
}

let currentMc = null;
let mcGeneration = 0; // 재시작 시 이전 세대의 콜백/재연결을 무효화

function stopMasterchat() {
  mcGeneration++; // 진행 중인 connect 루프/재연결 타이머를 무효화
  if (currentMc) {
    try {
      currentMc.stop();
    } catch (e) {
      /* ignore */
    }
    currentMc = null;
  }
}

async function startMasterchat() {
  if (!Masterchat) return;
  const videoId = config.videoId && config.videoId.trim();
  if (!videoId) {
    console.warn("[warn] config.json 의 videoId 가 비어 있습니다. 채팅 수신을 건너뜁니다.");
    console.warn("       admin.html 에서 videoId 를 넣고 저장&재시작 하세요.");
    return;
  }

  const myGen = ++mcGeneration;
  const isStale = () => myGen !== mcGeneration;

  // 재연결 예약(디바운스): error 와 end 가 동시에 와도 1회만 예약.
  let retryTimer = null;
  const scheduleReconnect = (why, ms = 15000) => {
    if (isStale() || retryTimer) return;
    console.warn(`[masterchat] ${why} — ${Math.round(ms / 1000)}초 후 재연결.`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, ms);
  };

  const connect = async () => {
    if (isStale()) return;
    // 이전 인스턴스가 남아 있으면 정리(중복 리스너 방지)
    if (currentMc) {
      try { currentMc.stop(); } catch {}
      currentMc = null;
    }
    try {
      console.log(`[masterchat] 연결 시도: ${videoId}`);
      const mc = await Masterchat.init(videoId);
      if (isStale()) {
        try { mc.stop(); } catch {}
        return;
      }
      currentMc = mc;
      mc.on("actions", (actions) => {
        if (isStale()) return;
        // 정상 수신 = 연결 살아있음 → 예약된 재연결 취소(일시 오류 자체 복구 케이스)
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        for (const a of actions) {
          try {
            handleAction(a);
          } catch (e) {
            // 단일 액션 파싱 실패는 무시
          }
        }
      });
      mc.on("error", (err) => {
        if (isStale()) return;
        console.error("[masterchat] error:", err.message || err);
        // 일시 오류면 다음 actions 수신 시 위에서 취소됨. 끊긴 경우만 실제 재연결.
        scheduleReconnect("오류 후 재연결");
      });
      mc.on("end", () => {
        if (isStale()) return;
        scheduleReconnect("스트림 종료");
      });
      mc.listen();
      console.log("[masterchat] 채팅 수신 시작 ✔");
    } catch (e) {
      if (isStale()) return;
      console.error("[masterchat] 연결 실패:", e.message || e);
      scheduleReconnect("연결 실패");
    }
  };
  connect();
}

/** config 저장 후 호출: 메모리 config 갱신 + 투표 상태 초기화 + masterchat 재연결 */
/** 투표/채팅 통계 초기화 */
function resetStats() {
  userVotes.clear();
  rawCounts.clear();
  nativePoll = null;
  chatHistory.length = 0;
  tallying = true; // 리셋 시 집계 재개(새 투표 시작)
}

function restartFromConfig(newConfig, keepStats) {
  stopMasterchat();
  config = newConfig;
  if (!keepStats) resetStats();
  pushPoll();
  startMasterchat();
}

// ---------- boot ----------
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("==================================================");
    console.error(`  ✖ 포트 ${PORT} 가 이미 사용 중입니다.`);
    console.error("    이미 실행된 서버가 있는지 확인하세요.");
    console.error("    - 기존 서버 종료: 그 콘솔에서 Ctrl + C");
    console.error("    - 강제 종료(PowerShell): taskkill /F /IM node.exe");
    console.error("    - 또는 admin.html 에서 다른 포트로 변경");
    console.error("==================================================");
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log("==================================================");
  console.log("  ytworldcup 서버 실행 중");
  console.log(`  오버레이 URL : http://localhost:${PORT}/overlay.html`);
  console.log(`  투표 모드     : ${config.poll.mode}`);
  console.log(`  videoId       : ${config.videoId || "(미설정)"}`);
  console.log("  vMix → Add Input → Web Browser → 위 URL, Transparent Background 체크");
  console.log("==================================================");
  startMasterchat();
});
