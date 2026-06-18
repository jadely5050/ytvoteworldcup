"use strict";

/**
 * masterchat 패치: 라이브 설문 질문(pollQuestion)을 simpleText 뿐 아니라
 * runs 형식에서도 읽도록 수정한다. (현재 유튜브 포맷은 runs 로 내려옴)
 *
 * masterchat 원본:  question: ...pollQuestion?.simpleText
 * 패치 후:          question: stringify(...pollQuestion)   // simpleText/runs 모두 처리
 *
 * package.json 의 postinstall 로 등록되어 npm install 후 자동 적용된다. (idempotent)
 */

const fs = require("fs");
const path = require("path");

const files = [
  path.join(__dirname, "..", "node_modules", "masterchat", "lib", "masterchat.js"),
  path.join(__dirname, "..", "node_modules", "masterchat", "lib", "masterchat.mjs"),
];

const replacements = [
  [
    "question: rdr.header.pollHeaderRenderer.pollQuestion?.simpleText,",
    "question: stringify(rdr.header.pollHeaderRenderer.pollQuestion),",
  ],
  [
    "question: header.pollQuestion?.simpleText,",
    "question: stringify(header.pollQuestion),",
  ],
];

let touched = 0;
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  let src = fs.readFileSync(file, "utf8");
  let changed = false;
  for (const [from, to] of replacements) {
    if (src.includes(from)) {
      src = src.split(from).join(to);
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(file, src, "utf8");
    touched++;
    console.log("[patch-masterchat] patched:", path.relative(path.join(__dirname, ".."), file));
  }
}

if (touched === 0) {
  console.log("[patch-masterchat] 이미 패치되어 있거나 대상 파일 없음 (skip).");
}
