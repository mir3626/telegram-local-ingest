import assert from "node:assert/strict";
import test from "node:test";

import {
  detectLanguage,
  detectLanguageAcrossArtifacts,
} from "@telegram-local-ingest/language-detector";

test("detectLanguage identifies Korean target text without translation", () => {
  const result = detectLanguage("회의록을 정리하고 주요 액션 아이템을 추출합니다.");

  assert.equal(result.primaryLanguage, "ko");
  assert.equal(result.translationNeeded, false);
  assert.equal(result.targetLanguage, "ko");
  assert.ok(result.confidence > 0.9);
});

test("detectLanguage flags English text for Korean translation", () => {
  const result = detectLanguage("Please translate this quarterly business review into natural Korean.");

  assert.equal(result.primaryLanguage, "en");
  assert.equal(result.translationNeeded, true);
  assert.ok(result.confidence > 0.9);
});

test("detectLanguage separates Japanese kana from Chinese han text", () => {
  const japanese = detectLanguage("これは日本語の会議メモです。次の対応を確認します。");
  const chinese = detectLanguage("这是中文会议记录，需要整理重点和后续事项。");

  assert.equal(japanese.primaryLanguage, "ja");
  assert.equal(japanese.translationNeeded, true);
  assert.equal(chinese.primaryLanguage, "zh");
  assert.equal(chinese.translationNeeded, true);
});

test("detectLanguageAcrossArtifacts aggregates mixed uploads", () => {
  const result = detectLanguageAcrossArtifacts([
    { id: "a", text: "This is an English paragraph about a customer meeting." },
    { id: "b", text: "한국어 메모도 함께 포함되어 있습니다." },
  ]);

  assert.equal(result.primaryLanguage, "mixed");
  assert.equal(result.translationNeeded, true);
  assert.equal(result.artifactCount, 2);
  assert.ok(result.textCharCount > 0);
});
