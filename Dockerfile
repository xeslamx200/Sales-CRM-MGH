# CRM — internal Staging image (no database inside; the app talks to hosted Supabase Staging).
# Build ONLY with the Staging public values; NEXT_PUBLIC_* are inlined into the bundle at build time (Next.js self-hosting guide).
# The anon key is public by design (it ships in the browser bundle), so passing it as a build argument is acceptable.
# NEVER pass SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET or any other server secret as a build argument: they are runtime-only (env file).
#
#   docker build -t crm-internal-staging:<tag> \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=https://oqwmgtayvsmbobwaunph.supabase.co \
#     --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$STAGING_ANON_KEY" .
#
# The build downloads npm packages and the Google font used by src/app/layout.tsx (next/font/google): it needs internet access.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
# Fail closed: refuse to build without the Staging public values, and refuse any project other than Staging.
RUN test -n "$NEXT_PUBLIC_SUPABASE_URL" && test -n "$NEXT_PUBLIC_SUPABASE_ANON_KEY" \
 && test "$NEXT_PUBLIC_SUPABASE_URL" = "https://oqwmgtayvsmbobwaunph.supabase.co"
RUN NEXT_PUBLIC_SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL" NEXT_PUBLIC_SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY" npm run build \
 && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/package.json /app/next.config.ts ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
# The image is read-only at runtime (compose: read_only + tmpfs for /tmp and /app/.next/cache). Runs as the unprivileged "node" user.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "node_modules/next/dist/bin/next", "start"]
