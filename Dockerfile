# The Signal — render worker. Remotion needs Chrome Headless Shell + system libs.
FROM node:20-bookworm-slim

# Dependencies required by Chrome Headless Shell (Remotion) + ffmpeg is bundled by Remotion.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 \
    libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 libatk-bridge2.0-0 \
    libcups2 libxshmfence1 libglu1-mesa ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Download the Chrome Headless Shell at build time so first render is fast.
RUN npx remotion browser ensure

ENV NODE_ENV=production
EXPOSE 8080
CMD ["npm", "start"]
