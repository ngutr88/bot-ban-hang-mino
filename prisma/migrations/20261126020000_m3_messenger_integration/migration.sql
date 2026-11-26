-- Mino M3 Facebook Messenger Integration, Webhook Idempotency & Outbox Migration

ALTER TYPE "chat_channel" ADD VALUE IF NOT EXISTS 'messenger';

CREATE TYPE "chat_message_delivery_status" AS ENUM ('delivered', 'pending', 'sent', 'failed');
CREATE TYPE "integration_status" AS ENUM ('active', 'disconnected', 'error');
CREATE TYPE "webhook_event_status" AS ENUM ('processed', 'ignored', 'failed');
CREATE TYPE "outbound_message_status" AS ENUM ('pending', 'sent', 'failed', 'dead_letter');

CREATE TABLE "channel_integrations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "external_account_id" VARCHAR(128) NOT NULL,
    "display_name" VARCHAR(120) NOT NULL,
    "status" "integration_status" NOT NULL DEFAULT 'active',
    "secret_ref" VARCHAR(64) NOT NULL DEFAULT 'ENV_MESSENGER_DEFAULT',
    "last_webhook_at" TIMESTAMPTZ(6),
    "last_error_code" VARCHAR(80),
    "disconnected_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_integrations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "channel_integrations_provider_chk" CHECK ("provider" IN ('messenger')),
    CONSTRAINT "channel_integrations_ext_id_chk" CHECK (char_length(btrim("external_account_id")) BETWEEN 1 AND 128),
    CONSTRAINT "channel_integrations_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "channel_integrations_shop_provider_key" ON "channel_integrations"("shop_id", "provider");
CREATE UNIQUE INDEX "channel_integrations_provider_ext_account_key" ON "channel_integrations"("provider", "external_account_id");

ALTER TABLE "chat_sessions"
    ADD COLUMN "integration_id" UUID,
    ADD COLUMN "external_user_id" VARCHAR(128);

ALTER TABLE "chat_sessions"
    ADD CONSTRAINT "chat_sessions_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "channel_integrations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE UNIQUE INDEX "chat_sessions_shop_channel_ext_user_key" ON "chat_sessions"("shop_id", "channel", "external_user_id");

ALTER TABLE "chat_messages"
    ADD COLUMN "delivery_status" "chat_message_delivery_status" NOT NULL DEFAULT 'delivered',
    ADD COLUMN "delivery_error_code" VARCHAR(80);

CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID,
    "provider" VARCHAR(32) NOT NULL,
    "provider_event_id" VARCHAR(160) NOT NULL,
    "external_account_id" VARCHAR(128) NOT NULL,
    "status" "webhook_event_status" NOT NULL DEFAULT 'processed',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(80),
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_events_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "webhook_events_provider_event_key" ON "webhook_events"("provider", "provider_event_id");
CREATE INDEX "webhook_events_shop_received_idx" ON "webhook_events"("shop_id", "received_at" DESC);

CREATE TABLE "outbound_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "chat_session_id" UUID NOT NULL,
    "chat_message_id" UUID NOT NULL,
    "recipient_external_id" VARCHAR(128) NOT NULL,
    "status" "outbound_message_status" NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider_message_id" VARCHAR(128),
    "last_error_code" VARCHAR(80),
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "outbound_messages_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "outbound_messages_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "channel_integrations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "outbound_messages_session_shop_fkey" FOREIGN KEY ("chat_session_id", "shop_id") REFERENCES "chat_sessions"("id", "shop_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "outbound_messages_chat_message_id_fkey" FOREIGN KEY ("chat_message_id") REFERENCES "chat_messages"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "outbound_messages_chat_message_key" ON "outbound_messages"("chat_message_id");
CREATE INDEX "outbound_messages_status_next_idx" ON "outbound_messages"("status", "next_attempt_at");
CREATE INDEX "outbound_messages_shop_created_idx" ON "outbound_messages"("shop_id", "created_at" DESC);
