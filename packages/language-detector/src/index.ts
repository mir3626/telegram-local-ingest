export type DetectedLanguage = "ko" | "en" | "zh" | "ja" | "mixed" | "unknown";

export interface LanguageDetectionOptions {
  targetLanguage?: Exclude<DetectedLanguage, "mixed" | "unknown">;
  minSignificantCharacters?: number;
}

export interface LanguageSignals {
  hangul: number;
  latin: number;
  han: number;
  kana: number;
  significant: number;
}

export interface LanguageDetection {
  primaryLanguage: DetectedLanguage;
  confidence: number;
  translationNeeded: boolean;
  targetLanguage: Exclude<DetectedLanguage, "mixed" | "unknown">;
  signals: LanguageSignals;
  reason: string;
}

export interface TextArtifactForLanguageDetection {
  id: string;
  text: string;
}

export interface AggregateLanguageDetection extends LanguageDetection {
  artifactCount: number;
  textCharCount: number;
}

const DEFAULT_TARGET_LANGUAGE: Exclude<DetectedLanguage, "mixed" | "unknown"> = "ko";
const DEFAULT_MIN_SIGNIFICANT_CHARACTERS = 12;

export function detectLanguage(text: string, options: LanguageDetectionOptions = {}): LanguageDetection {
  const targetLanguage = options.targetLanguage ?? DEFAULT_TARGET_LANGUAGE;
  const minSignificantCharacters = options.minSignificantCharacters ?? DEFAULT_MIN_SIGNIFICANT_CHARACTERS;
  const signals = countLanguageSignals(text);

  if (signals.significant < minSignificantCharacters) {
    return {
      primaryLanguage: "unknown",
      confidence: 0,
      translationNeeded: false,
      targetLanguage,
      signals,
      reason: "not_enough_text",
    };
  }

  const scores = languageScores(signals);
  const ranked = Object.entries(scores)
    .sort((left, right) => right[1] - left[1]) as Array<[Exclude<DetectedLanguage, "mixed" | "unknown">, number]>;
  const [topLanguage, topScore] = ranked[0] ?? [targetLanguage, 0];
  const secondScore = ranked[1]?.[1] ?? 0;
  const totalScore = ranked.reduce((sum, [, score]) => sum + score, 0);
  const topShare = totalScore > 0 ? topScore / totalScore : 0;
  const secondShare = totalScore > 0 ? secondScore / totalScore : 0;

  if (topShare < 0.75 && secondShare >= 0.2) {
    return {
      primaryLanguage: "mixed",
      confidence: roundConfidence(topShare),
      translationNeeded: true,
      targetLanguage,
      signals,
      reason: "mixed_language_signals",
    };
  }

  const primaryLanguage = topScore > 0 ? topLanguage : "unknown";
  return {
    primaryLanguage,
    confidence: primaryLanguage === "unknown" ? 0 : roundConfidence(topShare),
    translationNeeded: primaryLanguage !== "unknown" && primaryLanguage !== targetLanguage,
    targetLanguage,
    signals,
    reason: primaryLanguage === targetLanguage ? "target_language" : "non_target_language",
  };
}

export function detectLanguageAcrossArtifacts(
  artifacts: TextArtifactForLanguageDetection[],
  options: LanguageDetectionOptions = {},
): AggregateLanguageDetection {
  const text = artifacts.map((artifact) => artifact.text).join("\n\n");
  const detection = detectLanguage(text, options);
  return {
    ...detection,
    artifactCount: artifacts.length,
    textCharCount: text.length,
  };
}

export function countLanguageSignals(text: string): LanguageSignals {
  const signals: LanguageSignals = {
    hangul: 0,
    latin: 0,
    han: 0,
    kana: 0,
    significant: 0,
  };

  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (isHangul(codePoint)) {
      signals.hangul += 1;
      signals.significant += 1;
    } else if (isKana(codePoint)) {
      signals.kana += 1;
      signals.significant += 1;
    } else if (isHan(codePoint)) {
      signals.han += 1;
      signals.significant += 1;
    } else if (isLatinLetter(codePoint)) {
      signals.latin += 1;
      signals.significant += 1;
    }
  }

  return signals;
}

function languageScores(signals: LanguageSignals): Record<Exclude<DetectedLanguage, "mixed" | "unknown">, number> {
  return {
    ko: signals.hangul,
    en: signals.latin,
    zh: signals.kana > 0 ? signals.han * 0.25 : signals.han,
    ja: signals.kana > 0 ? signals.kana + signals.han * 0.35 : 0,
  };
}

function roundConfidence(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isHangul(codePoint: number): boolean {
  return (
    (codePoint >= 0xAC00 && codePoint <= 0xD7A3)
    || (codePoint >= 0x1100 && codePoint <= 0x11FF)
    || (codePoint >= 0x3130 && codePoint <= 0x318F)
  );
}

function isKana(codePoint: number): boolean {
  return codePoint >= 0x3040 && codePoint <= 0x30FF;
}

function isHan(codePoint: number): boolean {
  return codePoint >= 0x4E00 && codePoint <= 0x9FFF;
}

function isLatinLetter(codePoint: number): boolean {
  return (codePoint >= 0x41 && codePoint <= 0x5A) || (codePoint >= 0x61 && codePoint <= 0x7A);
}
