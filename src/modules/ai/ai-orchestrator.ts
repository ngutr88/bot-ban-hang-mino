import type { ChatChannel, Prisma, PrismaClient, Shop } from "@prisma/client";
import type { AppConfig } from "../../config/env.js";
import {
  matchBotReplyDetailed,
  type MatchableBotRule,
  type MatchableProduct
} from "../../shared/bot-matcher.js";
import {
  detectHumanHandoffIntent,
  sanitizeQueryForLog,
  validateAiReplySafety
} from "./ai-guardrails.js";
import type { GroundedAiProvider } from "./ai-provider.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface SmartBotReplyResult {
  reply: string;
  escalateToShop: boolean;
  switchToHumanMode: boolean;
}

function truncateLogReply(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= 500 ? clean : clean.slice(0, 497) + "...";
}

export async function resolveControlledBotReply(
  db: DbClient,
  config: AppConfig,
  aiProvider: GroundedAiProvider,
  params: {
    shop: Shop;
    channel: ChatChannel;
    chatSessionId: string;
    message: string;
    products: MatchableProduct[];
    rules: MatchableBotRule[];
  }
): Promise<SmartBotReplyResult> {
  const { shop, channel, chatSessionId, message, products, rules } = params;
  const queryPreview = sanitizeQueryForLog(message);

  // 1. Explicit customer request for human support -> immediate handoff without calling AI
  if (detectHumanHandoffIntent(message)) {
    const handoffReply =
      "Dạ em đã chuyển cuộc trò chuyện sang chủ shop/nhân viên để hỗ trợ trực tiếp cho anh/chị ngay ạ! 🙏";
    await db.aiInteractionLog.create({
      data: {
        shopId: shop.id,
        chatSessionId,
        channel,
        customerQueryPreview: queryPreview,
        replyPreview: truncateLogReply(handoffReply),
        outcome: "handoff_human_requested"
      }
    });
    return {
      reply: handoffReply,
      escalateToShop: true,
      switchToHumanMode: true
    };
  }

  // 2. Deterministic authoritative product/keyword rules ALWAYS run first
  const det = matchBotReplyDetailed({
    message,
    products,
    rules,
    fallbackReply: shop.fallbackReply
  });

  if (det.matchedBy !== "fallback") {
    return {
      reply: det.reply,
      escalateToShop: false,
      switchToHumanMode: false
    };
  }

  // 3. Fallback reached: check per-shop & per-channel kill switch + API key + daily token budget
  const channelAllowed = shop.aiChannels.includes(channel);
  if (!shop.aiEnabled || !channelAllowed || !config.aiApiKey) {
    await db.aiInteractionLog.create({
      data: {
        shopId: shop.id,
        chatSessionId,
        channel,
        customerQueryPreview: queryPreview,
        replyPreview: truncateLogReply(shop.fallbackReply),
        outcome: "fallback_disabled_or_budget"
      }
    });
    return {
      reply: shop.fallbackReply,
      escalateToShop: true,
      switchToHumanMode: false
    };
  }

  const startOfUtcDay = new Date();
  startOfUtcDay.setUTCHours(0, 0, 0, 0);

  const tokenAgg = await db.aiInteractionLog.aggregate({
    where: {
      shopId: shop.id,
      createdAt: { gte: startOfUtcDay }
    },
    _sum: {
      promptTokens: true,
      completionTokens: true
    }
  });

  const usedTokensToday =
    (tokenAgg._sum.promptTokens ?? 0) + (tokenAgg._sum.completionTokens ?? 0);

  if (usedTokensToday >= shop.aiDailyTokenBudget) {
    await db.aiInteractionLog.create({
      data: {
        shopId: shop.id,
        chatSessionId,
        channel,
        customerQueryPreview: queryPreview,
        replyPreview: truncateLogReply(shop.fallbackReply),
        outcome: "fallback_disabled_or_budget"
      }
    });
    return {
      reply: shop.fallbackReply,
      escalateToShop: true,
      switchToHumanMode: false
    };
  }

  // 4. Call grounded AI provider
  const aiOut = await aiProvider.generateGroundedReply({
    shopName: shop.name,
    publicPhone: shop.publicPhone,
    publicAddress: shop.publicAddress,
    botName: shop.botName,
    products,
    rules,
    customerMessage: message
  });

  if (!aiOut.ok) {
    await db.aiInteractionLog.create({
      data: {
        shopId: shop.id,
        chatSessionId,
        channel,
        customerQueryPreview: queryPreview,
        replyPreview: truncateLogReply(shop.fallbackReply),
        outcome: "provider_error",
        promptTokens: aiOut.promptTokens,
        completionTokens: aiOut.completionTokens,
        estimatedCostMicroUsd: aiOut.estimatedCostMicroUsd,
        model: aiOut.model
      }
    });
    return {
      reply: shop.fallbackReply,
      escalateToShop: true,
      switchToHumanMode: false
    };
  }

  // 5. Enforce deterministic post-generation guardrails (no fabricated prices, stock, or delivery dates!)
  const safety = validateAiReplySafety({
    reply: aiOut.answer,
    confidence: aiOut.confidence,
    needsHuman: aiOut.needsHuman,
    allowedPricesVnd: products.map((p) => BigInt(p.priceVnd)),
    allowedRuleAnswers: rules.map((r) => r.answer)
  });

  if (!safety.safe) {
    await db.aiInteractionLog.create({
      data: {
        shopId: shop.id,
        chatSessionId,
        channel,
        customerQueryPreview: queryPreview,
        replyPreview: truncateLogReply(aiOut.answer || shop.fallbackReply),
        outcome: safety.outcome,
        confidence: aiOut.confidence,
        promptTokens: aiOut.promptTokens,
        completionTokens: aiOut.completionTokens,
        estimatedCostMicroUsd: aiOut.estimatedCostMicroUsd,
        model: aiOut.model
      }
    });
    return {
      reply: shop.fallbackReply,
      escalateToShop: true,
      switchToHumanMode: false
    };
  }

  await db.aiInteractionLog.create({
    data: {
      shopId: shop.id,
      chatSessionId,
      channel,
      customerQueryPreview: queryPreview,
      replyPreview: truncateLogReply(aiOut.answer),
      outcome: "answered_grounded",
      confidence: aiOut.confidence,
      promptTokens: aiOut.promptTokens,
      completionTokens: aiOut.completionTokens,
      estimatedCostMicroUsd: aiOut.estimatedCostMicroUsd,
      model: aiOut.model
    }
  });

  return {
    reply: aiOut.answer,
    escalateToShop: false,
    switchToHumanMode: false
  };
}
