import "dotenv/config";
import { PrismaClient } from "@prisma/client";

export const DEFAULT_SHOP_ID = "11111111-1111-4111-8111-111111111111";

export const SEED_PRODUCTS = [
  {
    id: "22222222-2222-4222-8222-222222222201",
    name: "Set khăn mặt cotton",
    priceVnd: 129000n,
    emoji: "🧺",
    description: "Mềm, thấm nước tốt, đóng hộp quà xinh."
  },
  {
    id: "22222222-2222-4222-8222-222222222202",
    name: "Nến thơm vanilla",
    priceVnd: 185000n,
    emoji: "🕯️",
    description: "Cháy 35 giờ, thơm dịu phòng ngủ."
  },
  {
    id: "22222222-2222-4222-8222-222222222203",
    name: "Bộ túi tote canvas",
    priceVnd: 99000n,
    emoji: "👜",
    description: "Vải dày, mặc sức đựng laptop sách vở."
  },
  {
    id: "22222222-2222-4222-8222-222222222204",
    name: "Hộp trà hoa sấy",
    priceVnd: 159000n,
    emoji: "🌸",
    description: "8 vị trà hoa, uống đẹp da thư giãn."
  },
  {
    id: "22222222-2222-4222-8222-222222222205",
    name: "Sổ tay kế hoạch",
    priceVnd: 89000n,
    emoji: "📔",
    description: "Giấy dày không lem mực, kèm sticker."
  },
  {
    id: "22222222-2222-4222-8222-222222222206",
    name: "Cốc gốm vẽ tay",
    priceVnd: 145000n,
    emoji: "☕",
    description: "Mỗi chiếc một nét vẽ, giữ nhiệt tốt."
  },
  {
    id: "22222222-2222-4222-8222-222222222207",
    name: "Dép đi trong nhà",
    priceVnd: 79000n,
    emoji: "🩴",
    description: "Đế êm, chống trượt, nhiều size."
  },
  {
    id: "22222222-2222-4222-8222-222222222208",
    name: "Combo quà tặng",
    priceVnd: 399000n,
    emoji: "🎁",
    description: "Nến + trà + thiệp, gói hộp sẵn."
  }
] as const;

export const SEED_BOT_RULES = [
  {
    id: "33333333-3333-4333-8333-333333333301",
    priority: 10,
    keywords: ["gia", "giá", "bao nhiêu", "bao nhiu", "price"],
    answer:
      "Giá từng món anh/chị xem ngay mục “Sản phẩm đang bán” trên trang này nha, hoặc nhắn tên món để em báo giá niêm yết ạ!"
  },
  {
    id: "33333333-3333-4333-8333-333333333302",
    priority: 20,
    keywords: ["con khong", "còn không", "con hang khong", "còn hàng không", "còn hàng", "con hang", "het hang", "hết hàng", "stock"],
    answer:
      "Dạ hệ thống chưa theo dõi tồn kho tự động; các món đang niêm yết đều nhận đặt đơn và chủ shop sẽ gọi xác nhận tình trạng thực tế ngay sau khi anh/chị gửi đơn nha! 🛒"
  },
  {
    id: "33333333-3333-4333-8333-333333333303",
    priority: 30,
    keywords: ["dat", "đặt", "đặt hàng", "mua", "order", "chot", "chốt"],
    answer:
      "Anh/chị bấm nút “Đặt đơn” để chọn món và điền tên, SĐT, địa chỉ nhận hàng nhé. Chủ shop sẽ gọi xác nhận phí vận chuyển và tổng tiền cuối cùng ạ! 🧾"
  },
  {
    id: "33333333-3333-4333-8333-333333333304",
    priority: 40,
    keywords: ["ship", "giao", "vận chuyển", "bao lâu", "khi nào"],
    answer:
      "Shop giao COD toàn quốc ạ: nội thành TP.HCM dự kiến trong ngày, tỉnh khác 2–4 ngày. Phí ship cụ thể sẽ được chủ shop báo khi gọi xác nhận đơn nha! 🚚"
  },
  {
    id: "33333333-3333-4333-8333-333333333305",
    priority: 50,
    keywords: ["doi", "đổi", "tra", "hoàn", "bảo hành"],
    answer:
      "Hàng lỗi do vận chuyển shop hỗ trợ đổi mới trong 7 ngày, anh/chị quay clip khi mở hàng để được hỗ trợ nhanh nhất nhé 🙏"
  },
  {
    id: "33333333-3333-4333-8333-333333333306",
    priority: 60,
    keywords: ["thanh toan", "thanh toán", "chuyển khoản", "cod"],
    answer: "Dạ hiện website nhận đặt đơn COD (nhận hàng thanh toán) toàn quốc ạ 😄"
  },
  {
    id: "33333333-3333-4333-8333-333333333307",
    priority: 70,
    keywords: ["dia chi", "địa chỉ", "ở đâu"],
    answer: "Shop ở Số 1 Đường Hoa, Phường BV, TP. Hồ Chí Minh. Anh/chị đặt online trên trang để shop giao tận nơi nha 😊"
  },
  {
    id: "33333333-3333-4333-8333-333333333308",
    priority: 80,
    keywords: ["chao", "chào", "hello", "hi", "alo"],
    answer: "Dạ em chào anh/chị! 🤖 Em là trợ lý của shop, trực 24/7. Anh/chị cần xem giá, hỏi phí giao hàng hay đặt đơn cứ nhắn nha!"
  },
  {
    id: "33333333-3333-4333-8333-333333333309",
    priority: 90,
    keywords: ["cam on", "cảm ơn", "thanks"],
    answer: "Dạ không có gì ạ! Cần hỗ trợ thêm anh/chị cứ nhắn hoặc đặt đơn để chủ shop liên hệ nha 💜"
  }
] as const;

export async function seedDemoData(prisma: PrismaClient): Promise<{ shopId: string }> {
  const existingShop = await prisma.shop.findFirst({ orderBy: { createdAt: "asc" } });
  const shopId = existingShop?.id ?? DEFAULT_SHOP_ID;

  await prisma.shop.upsert({
    where: { id: shopId },
    update: {},
    create: {
      id: shopId,
      slug: "cua-hang-mino",
      name: "Cửa hàng của Mino",
      publicPhone: "0900 000 000",
      publicAddress: "Số 1 Đường Hoa, Phường BV, TP. Hồ Chí Minh",
      timezone: "Asia/Ho_Chi_Minh",
      currency: "VND",
      botName: "Mino",
      fallbackReply:
        "Dạ câu này em nhờ chủ shop tư vấn chi tiết hơn ạ 🙏 Anh/chị bấm “Đặt đơn” để chủ shop gọi lại hỗ trợ hoặc hỏi em về giá, ship, đặt hàng nha!"
    }
  });

  for (const p of SEED_PRODUCTS) {
    await prisma.product.upsert({
      where: { id: p.id },
      update: {
        name: p.name,
        priceVnd: p.priceVnd,
        emoji: p.emoji,
        description: p.description
      },
      create: {
        id: p.id,
        shopId,
        name: p.name,
        priceVnd: p.priceVnd,
        emoji: p.emoji,
        description: p.description,
        status: "active"
      }
    });
  }

  for (const r of SEED_BOT_RULES) {
    await prisma.botRule.upsert({
      where: { id: r.id },
      update: {
        keywords: [...r.keywords],
        answer: r.answer,
        priority: r.priority
      },
      create: {
        id: r.id,
        shopId,
        keywords: [...r.keywords],
        answer: r.answer,
        priority: r.priority,
        enabled: true
      }
    });
  }

  return { shopId };
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run demo seed when NODE_ENV=production.");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const { shopId } = await seedDemoData(prisma);
    console.log(`Seeded demo data successfully for shop ${shopId}.`);
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("seed.ts") || process.argv[1].endsWith("seed.js"));

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error("Failed to seed database:", err instanceof Error ? err.message : "Unknown error");
    process.exit(1);
  });
}
