-- Mino M4 Multi-Shop RBAC, Invitations, Audit Logs & Controlled AI Migration

CREATE TYPE "shop_member_role" AS ENUM ('owner', 'staff');
CREATE TYPE "shop_membership_status" AS ENUM ('active', 'revoked');
CREATE TYPE "ai_interaction_outcome" AS ENUM (
    'answered_grounded',
    'handoff_human_requested',
    'handoff_low_confidence',
    'blocked_unverified_price',
    'blocked_forbidden_claim',
    'fallback_disabled_or_budget',
    'provider_error'
);

ALTER TABLE "shops"
    ADD COLUMN "slug" VARCHAR(64),
    ADD COLUMN "ai_enabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "ai_channels" TEXT[] NOT NULL DEFAULT ARRAY['web']::TEXT[],
    ADD COLUMN "ai_daily_token_budget" INTEGER NOT NULL DEFAULT 50000;

UPDATE "shops"
SET "slug" = CASE
    WHEN "id" = '11111111-1111-4111-8111-111111111111' THEN 'cua-hang-mino'
    ELSE 'shop-' || substr(replace("id"::text, '-', ''), 1, 12)
END
WHERE "slug" IS NULL;

ALTER TABLE "shops"
    ALTER COLUMN "slug" SET DEFAULT gen_random_uuid()::text,
    ALTER COLUMN "slug" SET NOT NULL,
    ADD CONSTRAINT "shops_slug_chk" CHECK (char_length(btrim("slug")) BETWEEN 2 AND 64),
    ADD CONSTRAINT "shops_ai_budget_chk" CHECK ("ai_daily_token_budget" BETWEEN 0 AND 100000000);

CREATE UNIQUE INDEX "shops_slug_key" ON "shops"("slug");

ALTER TABLE "admin_sessions"
    ADD COLUMN "active_shop_id" UUID;

UPDATE "admin_sessions" AS s
SET "active_shop_id" = u."shop_id"
FROM "admin_users" AS u
WHERE s."admin_user_id" = u."id" AND s."active_shop_id" IS NULL;

ALTER TABLE "admin_sessions"
    ADD CONSTRAINT "admin_sessions_active_shop_id_fkey" FOREIGN KEY ("active_shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "shop_memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "admin_user_id" UUID NOT NULL,
    "role" "shop_member_role" NOT NULL DEFAULT 'staff',
    "status" "shop_membership_status" NOT NULL DEFAULT 'active',
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_memberships_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "shop_memberships_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "shop_memberships_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "shop_memberships_shop_user_key" ON "shop_memberships"("shop_id", "admin_user_id");
CREATE INDEX "shop_memberships_user_status_idx" ON "shop_memberships"("admin_user_id", "status");

-- Backfill owner membership for all existing admin_users
INSERT INTO "shop_memberships" ("shop_id", "admin_user_id", "role", "status")
SELECT "shop_id", "id", 'owner', 'active'
FROM "admin_users"
ON CONFLICT ("shop_id", "admin_user_id") DO NOTHING;

CREATE TABLE "shop_invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "email_normalized" VARCHAR(254) NOT NULL,
    "role" "shop_member_role" NOT NULL DEFAULT 'staff',
    "token_hash" BYTEA NOT NULL,
    "invited_by_user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_invitations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "shop_invitations_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "shop_invitations_invited_by_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "shop_invitations_token_hash_key" ON "shop_invitations"("token_hash");
CREATE INDEX "shop_invitations_shop_created_idx" ON "shop_invitations"("shop_id", "created_at" DESC);

CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "actor_admin_user_id" UUID,
    "action" VARCHAR(80) NOT NULL,
    "target_type" VARCHAR(64) NOT NULL,
    "target_id" VARCHAR(128),
    "summary" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_logs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "audit_logs_actor_admin_fkey" FOREIGN KEY ("actor_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "audit_logs_shop_created_idx" ON "audit_logs"("shop_id", "created_at" DESC, "id" DESC);

CREATE TABLE "ai_interaction_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "chat_session_id" UUID NOT NULL,
    "channel" "chat_channel" NOT NULL,
    "customer_query_preview" VARCHAR(300) NOT NULL,
    "reply_preview" VARCHAR(500) NOT NULL,
    "outcome" "ai_interaction_outcome" NOT NULL,
    "confidence" DOUBLE PRECISION,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost_micro_usd" BIGINT NOT NULL DEFAULT 0,
    "model" VARCHAR(80),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_interaction_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_interaction_logs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "ai_interaction_logs_shop_created_idx" ON "ai_interaction_logs"("shop_id", "created_at" DESC);
