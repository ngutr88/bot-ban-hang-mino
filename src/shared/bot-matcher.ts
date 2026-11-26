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

function formatVndDisplay(priceVnd: string): string {
  const num = BigInt(priceVnd);
  return num.toLocaleString("vi-VN") + "đ";
}

/**
 * Pure bot matching logic (M1.4):
 * 1. Match active product name first (reports listed price; never claims stock availability).
 * 2. Otherwise match enabled rules ordered by priority ASC, then id ASC for deterministic tie-breaking.
 * 3. Otherwise return fallbackReply.
 */
export function matchBotReply(params: {
  message: string;
  products: MatchableProduct[];
  rules: MatchableBotRule[];
  fallbackReply: string;
}): string {
  const normalizedMsg = normalizeBotText(params.message);
  if (!normalizedMsg) {
    return params.fallbackReply;
  }

  // 1. Check exact product name substring first, then distinctive multi-word / >=4-char tokens
  let matchedProduct = params.products.find((p) => {
    const pNorm = normalizeBotText(p.name);
    return pNorm.length > 0 && normalizedMsg.includes(pNorm);
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
      return tokens.length > 0 && tokens.some((t) => normalizedMsg.includes(t));
    });
  }

  if (matchedProduct) {
    const emojiPart = matchedProduct.emoji ? `${matchedProduct.emoji} ` : "";
    const descPart = matchedProduct.description ? ` — ${matchedProduct.description}` : "";
    return (
      `Dạ món ${emojiPart}${matchedProduct.name} đang được niêm yết với giá ${formatVndDisplay(matchedProduct.priceVnd)}${descPart} ` +
      `Anh/chị bấm “Đặt đơn” để chủ shop liên hệ xác nhận tình trạng hàng và phí vận chuyển nha! 🧾`
    );
  }

  // 2. Deterministic rule ordering: priority ASC, then id ASC (if id available)
  const sortedRules = [...params.rules].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return (a.id ?? "").localeCompare(b.id ?? "");
  });

  for (const rule of sortedRules) {
    const hit = rule.keywords.some((kw) => {
      const kNorm = normalizeBotText(kw);
      return kNorm.length > 0 && normalizedMsg.includes(kNorm);
    });
    if (hit) {
      return rule.answer;
    }
  }

  // 3. Fallback
  return params.fallbackReply;
}
