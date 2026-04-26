FROM node:20-alpine AS base
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/

FROM base AS deps
RUN npm ci --workspace=apps/api --workspace=packages/shared

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.base.json ./
COPY apps/api ./apps/api
COPY packages/shared ./packages/shared
RUN npm run build --workspace=packages/shared 2>/dev/null || true
RUN npm run build --workspace=apps/api

# Use debian-based image so playwright --with-deps can run apt-get
FROM node:20 AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Copy built application and runtime dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./dist

# Install Chromium and OS-level dependencies for Playwright crawlers
RUN node node_modules/.bin/playwright install --with-deps chromium

EXPOSE 3001
CMD ["node", "dist/index.js"]
