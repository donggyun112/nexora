# Nexora — multi-stage production build
#
# Stage 1: Install dependencies + build
# Stage 2: Runtime-only (no devDependencies, no source)

FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/ packages/
COPY platform/ platform/
COPY examples/ examples/

RUN pnpm install --frozen-lockfile
RUN pnpm build

# Prune devDependencies
RUN pnpm prune --prod

# ─── Runtime ────────────────────────────────────────────────────────────────

FROM node:20-alpine AS runtime

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/platform ./platform
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/package.json ./package.json

# Create data directory for stores
RUN mkdir -p /app/data /app/agents /app/context

EXPOSE 3000

CMD ["node", "platform/cli/dist/cli.js", "dev", "--port", "3000"]
