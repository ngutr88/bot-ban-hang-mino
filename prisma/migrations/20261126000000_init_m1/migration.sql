-- Mino M1 Initial Schema Migration (gen_random_uuid() is built into PostgreSQL 13+)

CREATE TYPE "admin_user_status" AS ENUM ('active', 'disabled');
CREATE TYPE "product_status" AS ENUM ('active', 'hidden', 'archived');
CREATE TYPE "order_status" AS ENUM ('new', 'confirmed', 'preparing', 'shipping', 'completed', 'cancelled');

CREATE TABLE "shops" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(120) NOT NULL,
    "public_phone" VARCHAR(40),
    "public_address" VARCHAR(500),
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    "currency" CHAR(3) NOT NULL DEFAULT 'VND',
    "bot_name" VARCHAR(60) NOT NULL,
    "fallback_reply" VARCHAR(1000) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "shops_name_chk" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
    CONSTRAINT "shops_currency_chk" CHECK ("currency" = 'VND'),
    CONSTRAINT "shops_bot_name_chk" CHECK (char_length(btrim("bot_name")) BETWEEN 1 AND 60),
    CONSTRAINT "shops_fallback_reply_chk" CHECK (char_length(btrim("fallback_reply")) BETWEEN 1 AND 1000)
);

CREATE TABLE "admin_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "email_normalized" VARCHAR(254) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" "admin_user_status" NOT NULL DEFAULT 'active',
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admin_users_email_chk" CHECK (char_length(btrim("email_normalized")) >= 3),
    CONSTRAINT "admin_users_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "admin_users_shop_email_key" ON "admin_users"("shop_id", "email_normalized");

CREATE TABLE "admin_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "admin_user_id" UUID NOT NULL,
    "session_token_hash" BYTEA NOT NULL,
    "csrf_token_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admin_sessions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "admin_sessions_token_hash_key" ON "admin_sessions"("session_token_hash");
CREATE INDEX "admin_sessions_user_idx" ON "admin_sessions"("admin_user_id");

CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" VARCHAR(1000),
    "price_vnd" BIGINT NOT NULL,
    "emoji" VARCHAR(16),
    "status" "product_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "products_name_chk" CHECK (char_length(btrim("name")) BETWEEN 1 AND 160),
    CONSTRAINT "products_price_chk" CHECK ("price_vnd" >= 0),
    CONSTRAINT "products_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "products_shop_status_name_idx" ON "products"("shop_id", "status", "name");

CREATE TABLE "bot_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "keywords" TEXT[] NOT NULL,
    "answer" VARCHAR(1000) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bot_rules_keywords_chk" CHECK (cardinality("keywords") BETWEEN 1 AND 20),
    CONSTRAINT "bot_rules_answer_chk" CHECK (char_length(btrim("answer")) BETWEEN 1 AND 1000),
    CONSTRAINT "bot_rules_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "bot_rules_shop_enabled_priority_idx" ON "bot_rules"("shop_id", "enabled", "priority");

CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "order_no" VARCHAR(40) NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'new',
    "recipient_name" VARCHAR(120) NOT NULL,
    "recipient_phone" VARCHAR(32) NOT NULL,
    "recipient_phone_norm" VARCHAR(32) NOT NULL,
    "shipping_address" VARCHAR(500) NOT NULL,
    "customer_note" VARCHAR(1000),
    "subtotal_vnd" BIGINT NOT NULL,
    "shipping_fee_vnd" BIGINT,
    "total_vnd" BIGINT,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "request_fingerprint" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "orders_recipient_name_chk" CHECK (char_length(btrim("recipient_name")) BETWEEN 1 AND 120),
    CONSTRAINT "orders_shipping_address_chk" CHECK (char_length(btrim("shipping_address")) BETWEEN 1 AND 500),
    CONSTRAINT "orders_subtotal_chk" CHECK ("subtotal_vnd" >= 0),
    CONSTRAINT "orders_totals_consistency_chk" CHECK (
        ("shipping_fee_vnd" IS NULL AND "total_vnd" IS NULL AND "status" IN ('new', 'cancelled'))
        OR
        ("shipping_fee_vnd" IS NOT NULL AND "shipping_fee_vnd" >= 0 AND "total_vnd" = "subtotal_vnd" + "shipping_fee_vnd" AND "status" IN ('confirmed', 'preparing', 'shipping', 'completed', 'cancelled'))
    ),
    CONSTRAINT "orders_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "orders_shop_order_no_key" ON "orders"("shop_id", "order_no");
CREATE UNIQUE INDEX "orders_shop_idempotency_key" ON "orders"("shop_id", "idempotency_key");
CREATE UNIQUE INDEX "orders_id_shop_key" ON "orders"("id", "shop_id");
CREATE INDEX "orders_shop_created_desc_idx" ON "orders"("shop_id", "created_at" DESC);
CREATE INDEX "orders_shop_status_created_desc_idx" ON "orders"("shop_id", "status", "created_at" DESC);
CREATE INDEX "orders_shop_phone_norm_idx" ON "orders"("shop_id", "recipient_phone_norm");

CREATE TABLE "order_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID,
    "product_name_snapshot" VARCHAR(160) NOT NULL,
    "unit_price_vnd" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "line_total_vnd" BIGINT NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "order_items_unit_price_chk" CHECK ("unit_price_vnd" >= 0),
    CONSTRAINT "order_items_quantity_chk" CHECK ("quantity" BETWEEN 1 AND 1000),
    CONSTRAINT "order_items_line_total_chk" CHECK ("line_total_vnd" = "unit_price_vnd" * "quantity"),
    CONSTRAINT "order_items_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "order_items_order_shop_fkey" FOREIGN KEY ("order_id", "shop_id") REFERENCES "orders"("id", "shop_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "order_items_order_idx" ON "order_items"("order_id");

CREATE TABLE "order_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "actor_admin_user_id" UUID,
    "event_type" VARCHAR(64) NOT NULL,
    "old_status" "order_status",
    "new_status" "order_status",
    "note" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "order_events_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "order_events_order_shop_fkey" FOREIGN KEY ("order_id", "shop_id") REFERENCES "orders"("id", "shop_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "order_events_actor_admin_user_id_fkey" FOREIGN KEY ("actor_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "order_events_order_created_idx" ON "order_events"("order_id", "created_at");
