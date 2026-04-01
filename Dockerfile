FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HYDRAFLOW_DATA_FILE=/data/hydraflow-db.json

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.mjs ./server.mjs

VOLUME ["/data"]

EXPOSE 3000

CMD ["node", "server.mjs"]
