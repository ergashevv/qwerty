# Railway / Docker: ffmpeg + yt-dlp (Reels)
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
# yt-dlp: umumiy "yt-dlp" fayli Python zipapp — python3 talab qiladi.
# Linux uchun standalone binary (amd64 / aarch64).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && ARCH=$(uname -m) \
  && if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then \
       YTDLP_ASSET="yt-dlp_linux_aarch64"; \
     else \
       YTDLP_ASSET="yt-dlp_linux"; \
     fi \
  && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}" -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && /usr/local/bin/yt-dlp --version \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
ENV NODE_ENV=production
CMD ["node", "dist/bot.js"]
