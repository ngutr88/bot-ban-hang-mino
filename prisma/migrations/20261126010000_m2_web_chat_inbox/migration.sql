-- Mino M2 Web Chat & Shared Inbox Migration

CREATE TYPE "chat_channel" AS ENUM ('web');
CREATE TYPE "chat_session_status" AS ENUM ('open', 'waiting_shop', 'waiting_customer', 'closed');
CREATE TYPE "chat_handling_mode" AS ENUM ('bot', 'human');
CREATE TYPE "chat_sender_type" AS ENUM ('customer', 'bot', 'admin', 'system');

CREATE TABLE "chat_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "channel" "chat_channel" NOT NULL DEFAULT 'web',
    "visitor_token_hash" BYTEA,
    "visitor_name" VARCHAR(120),
    "visitor_phone" VARCHAR(32),
    "visitor_phone_norm" VARCHAR(32),
    "status" "chat_session_status" NOT NULL DEFAULT 'open',
    "handling_mode" "chat_handling_mode" NOT NULL DEFAULT 'bot',
    "unread_for_shop" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_preview" VARCHAR(160),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chat_sessions_unread_chk" CHECK ("unread_for_shop" >= 0),
    CONSTRAINT "chat_sessions_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "chat_sessions_visitor_token_hash_key" ON "chat_sessions"("visitor_token_hash");
CREATE UNIQUE INDEX "chat_sessions_id_shop_key" ON "chat_sessions"("id", "shop_id");
CREATE INDEX "chat_sessions_shop_last_msg_idx" ON "chat_sessions"("shop_id", "last_message_at" DESC, "id" DESC);
CREATE INDEX "chat_sessions_shop_status_last_msg_idx" ON "chat_sessions"("shop_id", "status", "last_message_at" DESC, "id" DESC);
CREATE INDEX "chat_sessions_shop_phone_norm_idx" ON "chat_sessions"("shop_id", "visitor_phone_norm");

CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "chat_session_id" UUID NOT NULL,
    "sender_type" "chat_sender_type" NOT NULL,
    "actor_admin_user_id" UUID,
    "body" VARCHAR(2000) NOT NULL,
    "idempotency_key" VARCHAR(128),
    "request_fingerprint" BYTEA,
    "provider_message_id" VARCHAR(128),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chat_messages_body_chk" CHECK (char_length(btrim("body")) BETWEEN 1 AND 2000),
    CONSTRAINT "chat_messages_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "chat_messages_session_shop_fkey" FOREIGN KEY ("chat_session_id", "shop_id") REFERENCES "chat_sessions"("id", "shop_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "chat_messages_actor_admin_fkey" FOREIGN KEY ("actor_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "chat_messages_session_idem_key" ON "chat_messages"("chat_session_id", "idempotency_key");
CREATE UNIQUE INDEX "chat_messages_shop_provider_msg_key" ON "chat_messages"("shop_id", "provider_message_id") WHERE "provider_message_id" IS NOT NULL;
CREATE INDEX "chat_messages_session_created_idx" ON "chat_messages"("chat_session_id", "created_at" ASC, "id" ASC);

CREATE TABLE "chat_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "chat_session_id" UUID NOT NULL,
    "author_admin_user_id" UUID NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_notes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chat_notes_body_chk" CHECK (char_length(btrim("body")) BETWEEN 1 AND 2000),
    CONSTRAINT "chat_notes_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "chat_notes_session_shop_fkey" FOREIGN KEY ("chat_session_id", "shop_id") REFERENCES "chat_sessions"("id", "shop_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "chat_notes_author_admin_fkey" FOREIGN KEY ("author_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "chat_notes_session_created_idx" ON "chat_notes"("chat_session_id", "created_at" ASC, "id" ASC);

CREATE TABLE "chat_session_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "chat_session_id" UUID NOT NULL,
    "actor_admin_user_id" UUID,
    "event_type" VARCHAR(64) NOT NULL,
    "detail" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_session_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chat_session_events_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "chat_session_events_session_shop_fkey" FOREIGN KEY ("chat_session_id", "shop_id") REFERENCES "chat_sessions"("id", "shop_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "chat_session_events_actor_admin_fkey" FOREIGN KEY ("actor_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "chat_session_events_session_created_idx" ON "chat_session_events"("chat_session_id", "created_at" ASC, "id" ASC);
