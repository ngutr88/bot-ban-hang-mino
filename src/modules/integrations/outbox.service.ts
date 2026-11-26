import type { PrismaClient } from "@prisma/client";
import type { MessengerAdapter } from "./messenger-adapter.js";

export async function dispatchOutboundMessage(
  prisma: PrismaClient,
  adapter: MessengerAdapter,
  outboundId: string
): Promise<{ status: "sent" | "failed" | "dead_letter"; errorCode: string | null }> {
  const item = await prisma.outboundMessage.findUnique({
    where: { id: outboundId },
    include: {
      chatMessage: true,
      integration: true
    }
  });

  if (!item) {
    return { status: "dead_letter", errorCode: "OUTBOUND_NOT_FOUND" };
  }

  if (item.status === "sent") {
    return { status: "sent", errorCode: null };
  }

  if (item.integration.status !== "active") {
    await prisma.$transaction([
      prisma.outboundMessage.update({
        where: { id: item.id },
        data: {
          status: "failed",
          lastErrorCode: "INTEGRATION_INACTIVE"
        }
      }),
      prisma.chatMessage.update({
        where: { id: item.chatMessageId },
        data: {
          deliveryStatus: "failed",
          deliveryErrorCode: "INTEGRATION_INACTIVE"
        }
      })
    ]);
    return { status: "failed", errorCode: "INTEGRATION_INACTIVE" };
  }

  const sendResult = await adapter.sendTextMessage({
    pageExternalId: item.integration.externalAccountId,
    recipientPsid: item.recipientExternalId,
    text: item.chatMessage.body
  });

  const now = new Date();
  const nextAttemptCount = item.attemptCount + 1;

  if (sendResult.ok) {
    await prisma.$transaction([
      prisma.outboundMessage.update({
        where: { id: item.id },
        data: {
          status: "sent",
          attemptCount: nextAttemptCount,
          providerMessageId: sendResult.providerMessageId,
          lastErrorCode: null,
          sentAt: now
        }
      }),
      prisma.chatMessage.update({
        where: { id: item.chatMessageId },
        data: {
          deliveryStatus: "sent",
          deliveryErrorCode: null,
          ...(sendResult.providerMessageId
            ? { providerMessageId: sendResult.providerMessageId }
            : {})
        }
      }),
      ...(item.integration.lastErrorCode
        ? [
            prisma.channelIntegration.update({
              where: { id: item.integration.id },
              data: { lastErrorCode: null }
            })
          ]
        : [])
    ]);

    return { status: "sent", errorCode: null };
  }

  const errorCode = sendResult.errorCode ?? "SEND_FAILED";
  const exhausted = !sendResult.retryable || nextAttemptCount >= item.maxAttempts;
  const nextStatus: "failed" | "dead_letter" = exhausted ? "dead_letter" : "failed";
  const backoffSeconds = Math.min(300, 15 * Math.pow(2, nextAttemptCount - 1));
  const nextAttemptAt = new Date(now.getTime() + backoffSeconds * 1000);

  await prisma.$transaction([
    prisma.outboundMessage.update({
      where: { id: item.id },
      data: {
        status: nextStatus,
        attemptCount: nextAttemptCount,
        nextAttemptAt,
        lastErrorCode: errorCode
      }
    }),
    prisma.chatMessage.update({
      where: { id: item.chatMessageId },
      data: {
        deliveryStatus: "failed",
        deliveryErrorCode: errorCode
      }
    }),
    prisma.channelIntegration.update({
      where: { id: item.integration.id },
      data: {
        lastErrorCode: errorCode,
        ...(sendResult.tokenRevoked ? { status: "error" } : {})
      }
    })
  ]);

  return { status: nextStatus, errorCode };
}

export async function processDueOutboundMessages(
  prisma: PrismaClient,
  adapter: MessengerAdapter,
  shopId?: string
): Promise<{ processed: number; sent: number; failed: number }> {
  const dueItems = await prisma.outboundMessage.findMany({
    where: {
      ...(shopId ? { shopId } : {}),
      status: { in: ["pending", "failed"] },
      nextAttemptAt: { lte: new Date() },
      integration: { status: "active" }
    },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: 20,
    select: { id: true }
  });

  let sent = 0;
  let failed = 0;
  for (const row of dueItems) {
    const res = await dispatchOutboundMessage(prisma, adapter, row.id);
    if (res.status === "sent") sent++;
    else failed++;
  }

  return {
    processed: dueItems.length,
    sent,
    failed
  };
}
