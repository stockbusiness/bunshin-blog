-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MONITOR');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'PAUSED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "BlogPurpose" AS ENUM ('AFFILIATE', 'DISPLAY_AD', 'MIXED');

-- CreateEnum
CREATE TYPE "BlogStatus" AS ENUM ('SETUP', 'ACTIVE', 'PAUSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('UNTESTED', 'CONNECTED', 'FAILED', 'REVOKED');

-- CreateEnum
CREATE TYPE "CompetitionLevel" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "YmylRisk" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "GenreStatus" AS ENUM ('CANDIDATE', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "FactType" AS ENUM ('EXPERIENCE', 'OPINION', 'PROFILE', 'FAILURE', 'PRODUCT_REVIEW');

-- CreateEnum
CREATE TYPE "FactSource" AS ENUM ('USER_INPUT', 'ADMIN_INTERVIEW', 'EXISTING_CONTENT', 'AI_INFERENCE');

-- CreateEnum
CREATE TYPE "FactVerification" AS ENUM ('VERIFIED', 'UNVERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ConversionType" AS ENUM ('FREE_SIGNUP', 'REQUEST', 'TRIAL', 'PURCHASE', 'OTHER');

-- CreateEnum
CREATE TYPE "UserExperience" AS ENUM ('USED', 'NOT_USED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "BannerSlot" AS ENUM ('TOP', 'AFTER_FIRST_HEADING', 'MIDDLE', 'BOTTOM', 'SIDEBAR');

-- CreateEnum
CREATE TYPE "BannerStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ENDED');

-- CreateEnum
CREATE TYPE "StrategyType" AS ENUM ('STANDARD', 'HIGH_VOLUME', 'HIGH_QUALITY', 'REVENUE_FOCUSED', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PlanType" AS ENUM ('INITIAL', 'MONTHLY', 'AD_HOC');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('DRAFT', 'APPROVED', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('INFORMATIONAL', 'EXPERIENCE', 'FAQ', 'COMPARISON', 'AFFILIATE');

-- CreateEnum
CREATE TYPE "Objective" AS ENUM ('TRAFFIC', 'TRUST', 'REVENUE', 'INTERNAL_LINK');

-- CreateEnum
CREATE TYPE "ContentItemStatus" AS ENUM ('PLANNED', 'GENERATING', 'READY_FOR_REVIEW', 'APPROVED', 'POSTED', 'PUBLISHED', 'REJECTED');

-- CreateEnum
CREATE TYPE "FactCheckStatus" AS ENUM ('NOT_CHECKED', 'PASSED', 'WARNING', 'FAILED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'VIEWED', 'APPROVED', 'REVISION_REQUESTED', 'SKIPPED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ProposalType" AS ENUM ('NEW_ARTICLE', 'REWRITE', 'TITLE', 'CTA', 'INTERNAL_LINK', 'BANNER');

-- CreateEnum
CREATE TYPE "RevisionRequestType" AS ENUM ('SHORTER', 'SOFTER', 'CHANGE_TITLE', 'CHANGE_PRODUCT', 'FACT_ERROR', 'FREE_TEXT');

-- CreateEnum
CREATE TYPE "WpPostStatus" AS ENUM ('DRAFT', 'PENDING', 'PUBLISH', 'TRASH');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PlanningStepStatus" AS ENUM ('PASSED', 'WARNED', 'BLOCKED', 'OVERRIDDEN');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MONITOR',
    "display_name" TEXT NOT NULL,
    "email" TEXT,
    "line_user_id" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Tokyo',
    "terms_accepted_at" TIMESTAMPTZ(6),
    "data_use_consent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitor_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "affiliate_experience_years" INTEGER,
    "monthly_goal_yen" INTEGER,
    "primary_asp_names" TEXT[],
    "notification_days" INTEGER[],
    "notification_time" TIME(6) NOT NULL,
    "max_daily_proposals" INTEGER NOT NULL DEFAULT 1,
    "onboarding_status" "OnboardingStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "monitor_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blogs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "genre_id" UUID,
    "pen_name" TEXT,
    "targetReader" TEXT NOT NULL,
    "purpose" "BlogPurpose" NOT NULL DEFAULT 'AFFILIATE',
    "status" "BlogStatus" NOT NULL DEFAULT 'SETUP',
    "slot_number" INTEGER NOT NULL,
    "launch_date" DATE,
    "article_ratio" JSONB NOT NULL,
    "experiment_group_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "blogs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wordpress_connections" (
    "id" UUID NOT NULL,
    "blog_id" UUID NOT NULL,
    "site_url" TEXT NOT NULL,
    "wp_username_encrypted" TEXT NOT NULL,
    "app_password_encrypted" TEXT NOT NULL,
    "api_base_url" TEXT NOT NULL,
    "connection_status" "ConnectionStatus" NOT NULL DEFAULT 'UNTESTED',
    "can_create_posts" BOOLEAN NOT NULL DEFAULT false,
    "can_edit_posts" BOOLEAN NOT NULL DEFAULT false,
    "can_upload_media" BOOLEAN NOT NULL DEFAULT false,
    "last_tested_at" TIMESTAMPTZ(6),
    "last_synced_at" TIMESTAMPTZ(6),
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "wordpress_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "genres" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "competition_level" "CompetitionLevel" NOT NULL DEFAULT 'UNKNOWN',
    "ymyl_risk" "YmylRisk" NOT NULL,
    "notes" TEXT,
    "status" "GenreStatus" NOT NULL DEFAULT 'CANDIDATE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "genres_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_personas" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "base_profile" JSONB NOT NULL,
    "tone" JSONB NOT NULL,
    "values" JSONB NOT NULL,
    "ng_expressions" TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_personas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_persona_settings" (
    "id" UUID NOT NULL,
    "blog_id" UUID NOT NULL,
    "pen_name" TEXT NOT NULL,
    "tone_override" JSONB NOT NULL,
    "target_reader" JSONB NOT NULL,
    "allowed_experiences" UUID[],
    "ng_topics" TEXT[],
    "writing_rules" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "blog_persona_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "persona_facts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "blog_id" UUID,
    "fact_type" "FactType" NOT NULL,
    "content" TEXT NOT NULL,
    "source" "FactSource" NOT NULL,
    "verification" "FactVerification" NOT NULL DEFAULT 'UNVERIFIED',
    "usable_first_person" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "persona_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_offers" (
    "id" UUID NOT NULL,
    "blog_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "asp_name" TEXT NOT NULL,
    "advertiser_name" TEXT,
    "landing_page_url" TEXT NOT NULL,
    "affiliate_url" TEXT NOT NULL,
    "reward_yen" INTEGER,
    "conversion_type" "ConversionType" NOT NULL,
    "facts" JSONB NOT NULL,
    "user_experience" "UserExperience" NOT NULL DEFAULT 'UNKNOWN',
    "user_rating" INTEGER,
    "deny_conditions" TEXT[],
    "lp_form_fields" INTEGER,
    "lp_mobile_ready" BOOLEAN,
    "lp_evaluated_at" TIMESTAMPTZ(6),
    "selection_score" INTEGER,
    "score_breakdown" JSONB,
    "status" "OfferStatus" NOT NULL DEFAULT 'DRAFT',
    "starts_at" DATE,
    "ends_at" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "affiliate_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banners" (
    "id" UUID NOT NULL,
    "blog_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "image_url" TEXT NOT NULL,
    "destination_url" TEXT NOT NULL,
    "affiliate_offer_id" UUID,
    "slot" "BannerSlot" NOT NULL,
    "target_categories" TEXT[],
    "status" "BannerStatus" NOT NULL DEFAULT 'ACTIVE',
    "starts_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "banners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiment_groups" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "strategy_type" "StrategyType" NOT NULL,
    "settings" JSONB NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "experiment_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_plans" (
    "id" UUID NOT NULL,
    "blog_id" UUID NOT NULL,
    "plan_type" "PlanType" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "PlanStatus" NOT NULL DEFAULT 'DRAFT',
    "strategy_snapshot" JSONB NOT NULL,
    "generated_by_job_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "content_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_items" (
    "id" UUID NOT NULL,
    "content_plan_id" UUID NOT NULL,
    "blog_id" UUID NOT NULL,
    "sequence_no" INTEGER NOT NULL,
    "content_type" "ContentType" NOT NULL,
    "title" TEXT NOT NULL,
    "primary_keyword" TEXT,
    "search_intent" TEXT NOT NULL,
    "objective" "Objective" NOT NULL,
    "affiliate_offer_id" UUID,
    "target_revenue_item_id" UUID,
    "inbound_link_item_ids" UUID[],
    "outbound_link_item_ids" UUID[],
    "publish_priority" INTEGER NOT NULL,
    "planned_publish_week" INTEGER,
    "planned_publish_date" DATE,
    "status" "ContentItemStatus" NOT NULL DEFAULT 'PLANNED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "content_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article_versions" (
    "id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "answer_capsule" TEXT NOT NULL,
    "body_html" TEXT NOT NULL,
    "faq_json" JSONB NOT NULL,
    "structured_data_json" JSONB NOT NULL,
    "fact_check_status" "FactCheckStatus" NOT NULL DEFAULT 'NOT_CHECKED',
    "risk_flags" JSONB NOT NULL,
    "used_fact_ids" UUID[],
    "unverified_claims" JSONB NOT NULL,
    "model_provider" TEXT NOT NULL,
    "model_name" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "estimated_cost_usd" DECIMAL(10,6) NOT NULL,
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "blog_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "article_version_id" UUID NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "proposal_type" "ProposalType" NOT NULL,
    "priority_score" INTEGER NOT NULL,
    "proposal_reason" TEXT NOT NULL,
    "sent_at" TIMESTAMPTZ(6),
    "viewed_at" TIMESTAMPTZ(6),
    "responded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revision_requests" (
    "id" UUID NOT NULL,
    "approval_id" UUID NOT NULL,
    "request_type" "RevisionRequestType" NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revision_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wordpress_posts" (
    "id" UUID NOT NULL,
    "blog_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "wp_post_id" INTEGER NOT NULL,
    "wp_post_url" TEXT,
    "wp_edit_url" TEXT,
    "wp_status" "WpPostStatus" NOT NULL DEFAULT 'DRAFT',
    "last_content_hash" TEXT NOT NULL,
    "posted_at" TIMESTAMPTZ(6) NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "last_synced_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "wordpress_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metrics_daily" (
    "id" UUID NOT NULL,
    "blog_id" UUID NOT NULL,
    "content_item_id" UUID,
    "metric_date" DATE NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "search_clicks" INTEGER NOT NULL DEFAULT 0,
    "average_position" DECIMAL(6,2),
    "page_views" INTEGER,
    "affiliate_clicks" INTEGER NOT NULL DEFAULT 0,
    "ai_referrals" INTEGER NOT NULL DEFAULT 0,
    "banner_impressions" INTEGER NOT NULL DEFAULT 0,
    "banner_clicks" INTEGER NOT NULL DEFAULT 0,
    "conversions" INTEGER NOT NULL DEFAULT 0,
    "revenue_yen" INTEGER NOT NULL DEFAULT 0,
    "indexed" BOOLEAN,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "metrics_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "blog_id" UUID,
    "content_item_id" UUID,
    "job_id" UUID,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "web_search_calls" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(10,6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "job_type" TEXT NOT NULL,
    "user_id" UUID,
    "blog_id" UUID,
    "target_id" UUID,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT NOT NULL,
    "input_json" JSONB NOT NULL,
    "output_json" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "metadata" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planning_runs" (
    "id" UUID NOT NULL,
    "blog_id" UUID NOT NULL,
    "content_plan_id" UUID,
    "step1_status" "PlanningStepStatus" NOT NULL,
    "step1_reasons" JSONB NOT NULL,
    "rejection_count" INTEGER NOT NULL DEFAULT 0,
    "overridden_at" TIMESTAMPTZ(6),
    "selected_offers" JSONB NOT NULL,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "constraint_result" JSONB NOT NULL,
    "succeeded" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "planning_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_versions" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "prompt_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_links" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "affiliate_offer_id" UUID NOT NULL,
    "content_item_id" UUID,
    "destination_url" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "link_clicks" (
    "id" UUID NOT NULL,
    "affiliate_link_id" UUID NOT NULL,
    "referrer_host" TEXT,
    "is_ai_referral" BOOLEAN NOT NULL DEFAULT false,
    "user_agent_hash" TEXT,
    "clicked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_clicks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_console_connections" (
    "id" UUID NOT NULL,
    "blog_id" UUID NOT NULL,
    "property_url" TEXT NOT NULL,
    "refresh_token_encrypted" TEXT NOT NULL,
    "connection_status" "ConnectionStatus" NOT NULL DEFAULT 'UNTESTED',
    "last_synced_at" TIMESTAMPTZ(6),
    "last_error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "search_console_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_line_user_id_key" ON "users"("line_user_id");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE UNIQUE INDEX "monitor_profiles_user_id_key" ON "monitor_profiles"("user_id");

-- CreateIndex
CREATE INDEX "blogs_user_id_status_idx" ON "blogs"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "blogs_user_id_slot_number_key" ON "blogs"("user_id", "slot_number");

-- CreateIndex
CREATE UNIQUE INDEX "wordpress_connections_blog_id_key" ON "wordpress_connections"("blog_id");

-- CreateIndex
CREATE UNIQUE INDEX "genres_name_key" ON "genres"("name");

-- CreateIndex
CREATE UNIQUE INDEX "user_personas_user_id_key" ON "user_personas"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "blog_persona_settings_blog_id_key" ON "blog_persona_settings"("blog_id");

-- CreateIndex
CREATE INDEX "persona_facts_user_id_verification_idx" ON "persona_facts"("user_id", "verification");

-- CreateIndex
CREATE INDEX "persona_facts_blog_id_idx" ON "persona_facts"("blog_id");

-- CreateIndex
CREATE INDEX "affiliate_offers_blog_id_status_idx" ON "affiliate_offers"("blog_id", "status");

-- CreateIndex
CREATE INDEX "banners_blog_id_status_idx" ON "banners"("blog_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "content_plans_blog_id_plan_type_version_key" ON "content_plans"("blog_id", "plan_type", "version");

-- CreateIndex
CREATE INDEX "content_items_blog_id_content_type_idx" ON "content_items"("blog_id", "content_type");

-- CreateIndex
CREATE INDEX "content_items_blog_id_primary_keyword_idx" ON "content_items"("blog_id", "primary_keyword");

-- CreateIndex
CREATE UNIQUE INDEX "content_items_content_plan_id_sequence_no_key" ON "content_items"("content_plan_id", "sequence_no");

-- CreateIndex
CREATE INDEX "article_versions_fact_check_status_idx" ON "article_versions"("fact_check_status");

-- CreateIndex
CREATE UNIQUE INDEX "article_versions_content_item_id_version_no_key" ON "article_versions"("content_item_id", "version_no");

-- CreateIndex
CREATE INDEX "approvals_user_id_status_idx" ON "approvals"("user_id", "status");

-- CreateIndex
CREATE INDEX "approvals_blog_id_status_idx" ON "approvals"("blog_id", "status");

-- CreateIndex
CREATE INDEX "revision_requests_approval_id_idx" ON "revision_requests"("approval_id");

-- CreateIndex
CREATE UNIQUE INDEX "wordpress_posts_content_item_id_key" ON "wordpress_posts"("content_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "wordpress_posts_blog_id_wp_post_id_key" ON "wordpress_posts"("blog_id", "wp_post_id");

-- CreateIndex
CREATE INDEX "metrics_daily_metric_date_idx" ON "metrics_daily"("metric_date");

-- CreateIndex
CREATE UNIQUE INDEX "metrics_daily_blog_id_content_item_id_metric_date_key" ON "metrics_daily"("blog_id", "content_item_id", "metric_date");

-- CreateIndex
CREATE INDEX "ai_usage_logs_user_id_created_at_idx" ON "ai_usage_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_usage_logs_blog_id_created_at_idx" ON "ai_usage_logs"("blog_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_idempotency_key_key" ON "jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "jobs_status_job_type_idx" ON "jobs"("status", "job_type");

-- CreateIndex
CREATE INDEX "jobs_blog_id_idx" ON "jobs"("blog_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "planning_runs_blog_id_created_at_idx" ON "planning_runs"("blog_id", "created_at");

-- CreateIndex
CREATE INDEX "prompt_versions_key_is_active_idx" ON "prompt_versions"("key", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_versions_key_version_key" ON "prompt_versions"("key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_links_code_key" ON "affiliate_links"("code");

-- CreateIndex
CREATE INDEX "affiliate_links_affiliate_offer_id_idx" ON "affiliate_links"("affiliate_offer_id");

-- CreateIndex
CREATE INDEX "link_clicks_affiliate_link_id_clicked_at_idx" ON "link_clicks"("affiliate_link_id", "clicked_at");

-- CreateIndex
CREATE UNIQUE INDEX "search_console_connections_blog_id_key" ON "search_console_connections"("blog_id");

-- AddForeignKey
ALTER TABLE "monitor_profiles" ADD CONSTRAINT "monitor_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blogs" ADD CONSTRAINT "blogs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blogs" ADD CONSTRAINT "blogs_genre_id_fkey" FOREIGN KEY ("genre_id") REFERENCES "genres"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blogs" ADD CONSTRAINT "blogs_experiment_group_id_fkey" FOREIGN KEY ("experiment_group_id") REFERENCES "experiment_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wordpress_connections" ADD CONSTRAINT "wordpress_connections_blog_id_fkey" FOREIGN KEY ("blog_id") REFERENCES "blogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_personas" ADD CONSTRAINT "user_personas_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_persona_settings" ADD CONSTRAINT "blog_persona_settings_blog_id_fkey" FOREIGN KEY ("blog_id") REFERENCES "blogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "persona_facts" ADD CONSTRAINT "persona_facts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "persona_facts" ADD CONSTRAINT "persona_facts_blog_id_fkey" FOREIGN KEY ("blog_id") REFERENCES "blogs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_offers" ADD CONSTRAINT "affiliate_offers_blog_id_fkey" FOREIGN KEY ("blog_id") REFERENCES "blogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banners" ADD CONSTRAINT "banners_blog_id_fkey" FOREIGN KEY ("blog_id") REFERENCES "blogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banners" ADD CONSTRAINT "banners_affiliate_offer_id_fkey" FOREIGN KEY ("affiliate_offer_id") REFERENCES "affiliate_offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_plans" ADD CONSTRAINT "content_plans_blog_id_fkey" FOREIGN KEY ("blog_id") REFERENCES "blogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_content_plan_id_fkey" FOREIGN KEY ("content_plan_id") REFERENCES "content_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_blog_id_fkey" FOREIGN KEY ("blog_id") REFERENCES "blogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_affiliate_offer_id_fkey" FOREIGN KEY ("affiliate_offer_id") REFERENCES "affiliate_offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_target_revenue_item_id_fkey" FOREIGN KEY ("target_revenue_item_id") REFERENCES "content_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_versions" ADD CONSTRAINT "article_versions_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_blog_id_fkey" FOREIGN KEY ("blog_id") REFERENCES "blogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_article_version_id_fkey" FOREIGN KEY ("article_version_id") REFERENCES "article_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revision_requests" ADD CONSTRAINT "revision_requests_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "approvals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wordpress_posts" ADD CONSTRAINT "wordpress_posts_blog_id_fkey" FOREIGN KEY ("blog_id") REFERENCES "blogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wordpress_posts" ADD CONSTRAINT "wordpress_posts_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metrics_daily" ADD CONSTRAINT "metrics_daily_blog_id_fkey" FOREIGN KEY ("blog_id") REFERENCES "blogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metrics_daily" ADD CONSTRAINT "metrics_daily_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_blog_id_fkey" FOREIGN KEY ("blog_id") REFERENCES "blogs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_runs" ADD CONSTRAINT "planning_runs_blog_id_fkey" FOREIGN KEY ("blog_id") REFERENCES "blogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_runs" ADD CONSTRAINT "planning_runs_content_plan_id_fkey" FOREIGN KEY ("content_plan_id") REFERENCES "content_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_links" ADD CONSTRAINT "affiliate_links_affiliate_offer_id_fkey" FOREIGN KEY ("affiliate_offer_id") REFERENCES "affiliate_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_links" ADD CONSTRAINT "affiliate_links_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_clicks" ADD CONSTRAINT "link_clicks_affiliate_link_id_fkey" FOREIGN KEY ("affiliate_link_id") REFERENCES "affiliate_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_console_connections" ADD CONSTRAINT "search_console_connections_blog_id_fkey" FOREIGN KEY ("blog_id") REFERENCES "blogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CHECK制約（DATA_MODEL 4章）
-- Prisma のスキーマでは表現できないため手で追加している。
-- 制約の判定は原則アプリ層（modules/content-planning/constraints.ts）に
-- 一本化するが、以下2件は取り違えると事故になるためDB側にも入れる。

-- 1ユーザー3ブログ上限。UNIQUE(user_id, slot_number) と合わせて
-- 4件目が構造的に登録できないことを保証する（SPEC 2.5 / DATA_MODEL 4章）
ALTER TABLE "blogs" ADD CONSTRAINT "blogs_slot_range" CHECK ("slot_number" BETWEEN 1 AND 3);

-- 集客記事からの発リンクは2件以下（SPEC 9.2.5 / DATA_MODEL 4章）
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_outbound_max" CHECK (array_length("outbound_link_item_ids", 1) IS NULL OR array_length("outbound_link_item_ids", 1) <= 2);
