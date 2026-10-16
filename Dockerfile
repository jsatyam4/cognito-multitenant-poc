# Sample API (same code that runs on Lambda), served locally on :8787.
# Credentials come from .env at run time (docker compose env_file) and are never copied into the image.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY shared ./shared
COPY lambda ./lambda
COPY scripts ./scripts
COPY config ./config
ENV PORT=8787
EXPOSE 8787
USER node
CMD ["npx", "tsx", "scripts/api-server.ts"]
