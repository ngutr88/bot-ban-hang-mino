import type { AppConfig } from "../../config/env.js";
import type { MatchableBotRule, MatchableProduct } from "../../shared/bot-matcher.js";

export interface GroundedAiInput {
  shopName: string;
  publicPhone: string | null;
  publicAddress: string | null;
  botName: string;
  products: MatchableProduct[];
  rules: MatchableBotRule[];
  customerMessage: string;
}

export interface GroundedAiOutput {
  ok: boolean;
  answer: string;
  confidence: number;
  needsHuman: boolean;
  promptTokens: number;
  completionTokens: number;
  estimatedCostMicroUsd: bigint;
  model: string;
}

export interface GroundedAiProvider {
  generateGroundedReply(input: GroundedAiInput): Promise<GroundedAiOutput>;
}

export function createGroundedAiProvider(
  config: AppConfig,
  fetchImpl: typeof fetch = globalThis.fetch
): GroundedAiProvider {
  return {
    async generateGroundedReply(input) {
      if (!config.aiApiKey) {
        return {
          ok: false,
          answer: "",
          confidence: 0,
          needsHuman: true,
          promptTokens: 0,
          completionTokens: 0,
          estimatedCostMicroUsd: 0n,
          model: config.aiModel
        };
      }

      const catalogSummary = input.products.map((p) => ({
        name: p.name,
        priceVnd: p.priceVnd,
        description: p.description ?? ""
      }));

      const rulesSummary = input.rules.map((r) => ({
        keywords: r.keywords,
        answer: r.answer
      }));

      const systemPrompt = [
        `Bạn là trợ lý bán hàng "${input.botName}" của cửa hàng "${input.shopName}".`,
        "QUY TẮC BẮT BUỘC:",
        "1. CHỈ sử dụng thông tin trong DANH MỤC SẢN PHẨM và KỊCH BẢN HỎI ĐÁP được cung cấp.",
        "2. TUYỆT ĐỐI KHÔNG tự suy đoán hoặc bịa giá, khuyến mãi, số lượng tồn kho, khẳng định 'còn hàng', hoặc cam kết ngày giao cụ thể.",
        "3. Nếu câu hỏi của khách nằm ngoài dữ liệu đã cung cấp hoặc cần xác nhận thực tế của chủ shop, đặt needsHuman=true và confidence=0.",
        '4. Trả về ĐÚNG định dạng JSON: {"answer":"...","confidence":0.85,"needsHuman":false}.'
      ].join("\n");

      const userPrompt = JSON.stringify({
        shop: {
          name: input.shopName,
          publicPhone: input.publicPhone,
          publicAddress: input.publicAddress
        },
        catalog: catalogSummary,
        faqRules: rulesSummary,
        customerQuestion: input.customerMessage
      });

      try {
        const res = await fetchImpl(`${config.aiBaseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.aiApiKey}`
          },
          body: JSON.stringify({
            model: config.aiModel,
            temperature: 0.1,
            max_tokens: 350,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ]
          }),
          signal: AbortSignal.timeout(config.aiTimeoutMs)
        });

        if (!res.ok) {
          return {
            ok: false,
            answer: "",
            confidence: 0,
            needsHuman: true,
            promptTokens: 0,
            completionTokens: 0,
            estimatedCostMicroUsd: 0n,
            model: config.aiModel
          };
        }

        const rawJson = (await res.json()) as {
          model?: string;
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };

        const content = rawJson.choices?.[0]?.message?.content ?? "{}";
        const parsed = JSON.parse(content) as {
          answer?: unknown;
          confidence?: unknown;
          needsHuman?: unknown;
        };

        const promptTokens = Number(rawJson.usage?.prompt_tokens ?? 0) || 0;
        const completionTokens = Number(rawJson.usage?.completion_tokens ?? 0) || 0;
        // Conservative micro-USD estimate: $0.15 / 1M input + $0.60 / 1M output -> 0.15 & 0.60 micro-USD per token
        const estimatedCostMicroUsd = BigInt(
          Math.ceil(promptTokens * 0.15 + completionTokens * 0.6)
        );

        return {
          ok: typeof parsed.answer === "string",
          answer: typeof parsed.answer === "string" ? parsed.answer.trim() : "",
          confidence:
            typeof parsed.confidence === "number" ? parsed.confidence : 0,
          needsHuman: Boolean(parsed.needsHuman),
          promptTokens,
          completionTokens,
          estimatedCostMicroUsd,
          model: rawJson.model ?? config.aiModel
        };
      } catch {
        return {
          ok: false,
          answer: "",
          confidence: 0,
          needsHuman: true,
          promptTokens: 0,
          completionTokens: 0,
          estimatedCostMicroUsd: 0n,
          model: config.aiModel
        };
      }
    }
  };
}
