FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
COPY apps/dashboard/package.json ./apps/dashboard/
RUN npm ci --workspace=apps/dashboard

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY apps/dashboard ./apps/dashboard
# Copy workspace root package.json so Next can resolve workspace deps
COPY package.json ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build --workspace=apps/dashboard

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# standalone output bundles server.js + required node_modules
COPY --from=builder --chown=nextjs:nodejs /app/apps/dashboard/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/dashboard/public ./apps/dashboard/public

USER nextjs
EXPOSE 3000
# standalone server entry point emitted by Next at build time
CMD ["node", "apps/dashboard/server.js"]
