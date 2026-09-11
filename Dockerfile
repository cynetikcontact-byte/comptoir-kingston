# KINGTOOLS (Comptoir API) — image de production, sans apt-get (les miroirs Ubuntu bloquaient la construction Nixpacks).
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
EXPOSE 3000
CMD ["node", "comptoir-server.js"]
