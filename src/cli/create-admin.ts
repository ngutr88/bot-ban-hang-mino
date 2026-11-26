import "dotenv/config";
import readline from "node:readline";
import { PrismaClient } from "@prisma/client";
import { createAdminUser } from "../modules/auth/auth.service.js";

function promptLine(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdout.isTTY
    });

    if (hidden && process.stdout.isTTY) {
      process.stdout.write(question);
      const origWrite = (rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput;
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (str: string) => {
        if (str.includes("\n") || str.includes("\r")) {
          origWrite?.call(rl, str);
        } else {
          process.stdout.write("*");
        }
      };
      rl.question("", (answer) => {
        rl.close();
        process.stdout.write("\n");
        resolve(answer);
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const shop = await prisma.shop.findFirst({ orderBy: { createdAt: "asc" } });
    if (!shop) {
      console.error(
        "Không tìm thấy dữ liệu shop trong database. Hãy chạy migration và seed shop trước."
      );
      process.exit(1);
    }

    const email = (await promptLine("Email chủ shop: ", false)).trim();
    const password = await promptLine("Mật khẩu (tối thiểu 12 ký tự): ", true);
    const confirmPassword = await promptLine("Nhập lại mật khẩu: ", true);

    if (password !== confirmPassword) {
      console.error("Mật khẩu xác nhận không khớp.");
      process.exit(1);
    }

    const created = await createAdminUser(prisma, {
      shopId: shop.id,
      email,
      password
    });

    console.log(
      `Đã tạo tài khoản quản trị thành công cho shop "${shop.name}" (${created.email}).`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(
    "Không thể tạo tài khoản admin:",
    err instanceof Error ? err.message : "Lỗi không xác định"
  );
  process.exit(1);
});
