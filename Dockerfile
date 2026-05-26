# syntax=docker/dockerfile:1

# --- Builder stage: install all deps, compile TypeScript ---
FROM node:24-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY packages/ ./packages/
RUN npm run build

# --- Runtime stage: production deps + compiled artefacts only ---
FROM node:24-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf AS runtime

ARG BUILD_SHA=unknown
LABEL org.openclown.build_sha=${BUILD_SHA}
ENV BUILD_SHA=${BUILD_SHA}

WORKDIR /app

COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

COPY --from=builder /app/dist ./dist

USER node
CMD ["node", "dist/src/main.js"]
