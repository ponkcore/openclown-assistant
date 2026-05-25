# syntax=docker/dockerfile:1

# --- Builder stage: install all deps, compile TypeScript ---
FROM node:24-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY packages/ ./packages/
RUN npm run build

# --- Runtime stage: production deps + compiled artefacts only ---
FROM node:24-slim AS runtime

WORKDIR /app

COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

COPY --from=builder /app/dist ./dist

USER node
CMD ["node", "dist/src/main.js"]
