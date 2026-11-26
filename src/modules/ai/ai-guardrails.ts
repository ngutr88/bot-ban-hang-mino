import { normalizeBotText } from "../../shared/bot-matcher.js";

const HUMAN_HANDOFF_PHRASES = [
  "gap chu shop",
  "gặp chủ shop",
  "gap nhan vien",
  "gặp nhân viên",
  "nguoi that",
  "người thật",
  "tu van vien",
  "tư vấn viên",
  "chuyen nhan vien",
  "chuyển nhân viên",
  "noi chuyen voi nguoi",
  "nói chuyện với người"
];

export function detectHumanHandoffIntent(message: string): boolean {
  const norm = normalizeBotText(message);
  if (!norm) return false;
  return HUMAN_HANDOFF_PHRASES.some((phrase) => norm.includes(phrase));
}

/**
 * Extracts all VND money mentions from a generated text (e.g. "185.000đ", "185,000 vnd", "185k", "185 nghìn")
 * so we can verify 100% of prices mentioned by AI exist in the authoritative catalog or shop rules.
 */
export function extractMentionedVndAmounts(text: string): bigint[] {
  const amounts: bigint[] = [];

  // Pattern 1: formatted VND like 185.000đ, 185,000 đ, 185000 vnd (Unicode boundary safe!)
  const fullVndRegex =
    /(?<![\p{L}\p{N}])(\d{1,3}(?:[.,]\d{3})+|\d{4,12})\s*(?:đ|₫|vnd|vnđ|đồng)(?![\p{L}\p{N}])/giu;
  for (const m of text.matchAll(fullVndRegex)) {
    const rawDigits = (m[1] ?? "").replace(/[.,]/g, "");
    if (/^\d+$/.test(rawDigits)) {
      amounts.push(BigInt(rawDigits));
    }
  }

  // Pattern 2: shorthand thousands like 185k, 399k, 185 nghìn, 185 ngàn (excludes 10kg etc.)
  const shortKRegex =
    /(?<![\p{L}\p{N}])(\d{1,6})\s*(?:k|nghìn|ngàn)(?![\p{L}\p{N}])/giu;
  for (const m of text.matchAll(shortKRegex)) {
    const rawNum = m[1] ?? "";
    if (/^\d+$/.test(rawNum)) {
      amounts.push(BigInt(rawNum) * 1000n);
    }
  }

  return amounts;
}

const FORBIDDEN_CLAIM_PATTERNS = [
  /(?<![\p{L}\p{N}])(còn\s+hàng|sẵn\s+hàng|hàng\s+có\s+sẵn|trong\s+kho\s+còn)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])còn\s+\d+\s*(cái|chiếc|hộp|bộ|phần|suất|sản\s+phẩm|món)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(cam\s+kết\s+giao\s+(ngày|trước)|chắc\s+chắn\s+giao\s+(ngày|đúng|trước))(?![\p{L}\p{N}])/iu
];

export type GuardrailDecision =
  | { safe: true }
  | {
      safe: false;
      outcome:
        | "handoff_low_confidence"
        | "blocked_unverified_price"
        | "blocked_forbidden_claim";
    };

export function validateAiReplySafety(params: {
  reply: string;
  confidence: number;
  needsHuman: boolean;
  allowedPricesVnd: bigint[];
  allowedRuleAnswers: string[];
}): GuardrailDecision {
  const trimmed = params.reply.trim();
  if (
    !trimmed ||
    trimmed.length > 1500 ||
    params.needsHuman ||
    !Number.isFinite(params.confidence) ||
    params.confidence < 0.75
  ) {
    return { safe: false, outcome: "handoff_low_confidence" };
  }

  // Collect all authoritative amounts from catalog + rule texts
  const allowedSet = new Set<bigint>(params.allowedPricesVnd);
  for (const ruleText of params.allowedRuleAnswers) {
    for (const ruleAmt of extractMentionedVndAmounts(ruleText)) {
      allowedSet.add(ruleAmt);
    }
  }

  const mentionedAmounts = extractMentionedVndAmounts(trimmed);
  for (const amt of mentionedAmounts) {
    if (!allowedSet.has(amt)) {
      return { safe: false, outcome: "blocked_unverified_price" };
    }
  }

  const combinedRulesNorm = normalizeBotText(params.allowedRuleAnswers.join(" \n "));
  for (const forbiddenRegex of FORBIDDEN_CLAIM_PATTERNS) {
    const match = trimmed.match(forbiddenRegex);
    if (match && match[0]) {
      const phraseNorm = normalizeBotText(match[0]);
      if (!combinedRulesNorm.includes(phraseNorm)) {
        return { safe: false, outcome: "blocked_forbidden_claim" };
      }
    }
  }

  return { safe: true };
}

export function sanitizeQueryForLog(rawQuery: string): string {
  // Mask phone-like digit sequences >= 9 digits in AI analytics preview
  const masked = rawQuery.replace(/\b(?:\+?84|0)[\d\s.-]{8,14}\b/g, "[SĐT_ĐÃ_ẨN]");
  const oneLine = masked.replace(/\s+/g, " ").trim();
  return oneLine.length <= 300 ? oneLine : oneLine.slice(0, 297) + "...";
}
