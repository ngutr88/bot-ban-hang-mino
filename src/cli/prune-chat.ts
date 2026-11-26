import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { loadConfig } from "../config/env.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.chatRetentionDays === null) {
    console.error(
      "CHAT_RETENTION_DAYS chưa được cấu hình. Không tự động xóa hội thoại khi chưa có thời hạn được duyệt."
    );
    process.exit(1);
  }

  const cutoff = new Date(
    Date.now() - config.chatRetentionDays * 24 * 3600 * 1000
  );
  const prisma = new PrismaClient();

  try {
    const expiredSessions = await prisma.chatSession.findMany({
      where: {
        status: "closed",
        closedAt: { lt: cutoff }
      },
      select: { id: true }
    });

    if (expiredSessions.length === 0) {
      console.log("Không có hội thoại đã đóng nào vượt quá thời hạn lưu trữ.");
      return;
    }

    const ids = expiredSessions.map((s) => s.id);
    await prisma.$transaction([
      prisma.chatNote.deleteMany({ where: { chatSessionId: { in: ids } } }),
      prisma.chatSessionEvent.deleteMany({ where: { chatSessionId: { in: ids } } }),
      prisma.chatMessage.deleteMany({ where: { chatSessionId: { in: ids } } }),
      prisma.chatSession.deleteMany({ where: { id: { in: ids } } })
    ]);

    console.log(
      `Đã dọn dẹp ${ids.length} hội thoại đã đóng trước ngày ${cutoff.toISOString()}.`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(
    "Lỗi khi dọn dẹp hội thoại:",
    err instanceof Error ? err.message : "Unknown error"
  );
  process.exit(1);
});
