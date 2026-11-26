export interface MatchableProduct {
  id: string;
  name: string;
  priceVnd: string;
  emoji: string | null;
  description: string | null;
}

export interface MatchableBotRule {
  id?: string;
  keywords: string[];
  answer: string;
  priority: number;
}

export function normalizeBotText(input: string): string {
  return input.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsWholePhrase(normalizedHaystack: string, normalizedNeedle: string): boolean {
  if (!normalizedNeedle) return false;
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeRegExp(normalizedNeedle)}($|[^\\p{L}\\p{N}])`,
    "u"
  );
  return pattern.test(normalizedHaystack);
}

function formatVndDisplay(priceVnd: string): string {
  const num = BigInt(priceVnd);
  return num.toLocaleString("vi-VN") + "đ";
}

export interface BotMatchResult {
  reply: string;
  matchedBy: "product" | "rule" | "fallback";
}

/**
 * Pure bot matching logic (M1.4 & M2):
 * 1. Match active product name first (reports listed price; never claims stock availability).
 * 2. Otherwise match enabled rules ordered by priority ASC, then id ASC for deterministic tie-breaking.
 * 3. Otherwise return fallbackReply.
 */
export function matchBotReplyDetailed(params: {
  message: string;
  products: MatchableProduct[];
  rules: MatchableBotRule[];
  fallbackReply: string;
}): BotMatchResult {
  const normalizedMsg = normalizeBotText(params.message);
  if (!normalizedMsg) {
    return { reply: params.fallbackReply, matchedBy: "fallback" };
  }

  // 1. Check exact product name phrase first, then distinctive >=4-char whole words
  let matchedProduct = params.products.find((p) => {
    const pNorm = normalizeBotText(p.name);
    return pNorm.length > 0 && containsWholePhrase(normalizedMsg, pNorm);
  });

  if (!matchedProduct) {
    const genericWords = new Set([
      "set",
      "hop",
      "hộp",
      "bo",
      "bộ",
      "qua",
      "quà",
      "tang",
      "tặng",
      "hang",
      "hàng",
      "mon",
      "món",
      "cua",
      "của",
      "cho",
      "trong",
      "nha",
      "nhà"
    ]);
    matchedProduct = params.products.find((p) => {
      const tokens = normalizeBotText(p.name)
        .split(" ")
        .filter((t) => t.length >= 4 && !genericWords.has(t));
      return tokens.length > 0 && tokens.some((t) => containsWholePhrase(normalizedMsg, t));
    });
  }

  if (matchedProduct) {
    const emojiPart = matchedProduct.emoji ? `${matchedProduct.emoji} ` : "";
    const descPart = matchedProduct.description ? ` — ${matchedProduct.description}` : "";
    return {
      reply:
        `Dạ món ${emojiPart}${matchedProduct.name} đang được niêm yết với giá ${formatVndDisplay(matchedProduct.priceVnd)}${descPart} ` +
        `Anh/chị bấm “Đặt đơn” để chủ shop liên hệ xác nhận tình trạng hàng và phí vận chuyển nha! 🧾`,
      matchedBy: "product"
    };
  }

  // 2. Deterministic rule ordering: priority ASC, then id ASC (if id available)
  const sortedRules = [...params.rules].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return (a.id ?? "").localeCompare(b.id ?? "");
  });

  for (const rule of sortedRules) {
    const hit = rule.keywords.some((kw) => {
      const kNorm = normalizeBotText(kw);
      return kNorm.length > 0 && containsWholePhrase(normalizedMsg, kNorm);
    });
    if (hit) {
      return { reply: rule.answer, matchedBy: "rule" };
    }
  }

  // 3. Fallback
  return { reply: params.fallbackReply, matchedBy: "fallback" };
}

export function matchBotReply(params: {
  message: string;
  products: MatchableProduct[];
  rules: MatchableBotRule[];
  fallbackReply: string;
}): string {
  return matchBotReplyDetailed(params).reply;
}
