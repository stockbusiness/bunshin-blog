# BUNSHIN BLOG を Cloud Run で動かすための像（OPEN_QUESTIONS Q-045）。
#
# **段をすべて同じ土台から作る。** Prisma のクエリエンジンは OS と
# OpenSSL の版に合わせて選ばれる（`binaryTargets` の既定は `native`）。
# 生成した段と実行する段で土台が違うと、**起動して最初のクエリで
# 「engine が見つからない」で落ちる**。ビルドは通るので、気づくのは本番。
#
# **最終段に残すのは実行に要るものだけ。** ソース・開発依存・
# ビルドの中間物は入らない。
#
# **マイグレーションはこの像で流さない**（`docs/DEPLOY.md` 2.2）。
# ビルドは何度も走るので、像の中に入れると**その全部が本番DBを触る**。

ARG NODE_VERSION=22-slim

FROM node:${NODE_VERSION} AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Prisma のクエリエンジンが OpenSSL を要る
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ---- 依存 ----------------------------------------------------------------
# `package*.json` と `prisma/` だけを先に写す。ソースを変えただけの
# ビルドで `npm ci` をやり直さないため
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ---- ビルド --------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# **ビルドに秘密は要らない。** `src/lib/env.ts` の検証は読んだときに走る
# （`next build` では走らない）。唯一の例外が次の値
ARG NEXT_PUBLIC_LIFF_ID=""
ENV NEXT_PUBLIC_LIFF_ID=${NEXT_PUBLIC_LIFF_ID}
RUN npx prisma generate
RUN npm run build

# ---- 実行 ----------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production

# root で動かさない
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# **クエリエンジンは output tracing に拾われないことがある。**
# 拾われていれば同じものを上書きするだけで害は無い
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma

USER nextjs

# Cloud Run は `PORT` を渡す。既定を合わせておく
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
EXPOSE 8080

CMD ["node", "server.js"]
