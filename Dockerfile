# ---------- build ----------
FROM node:20-bookworm-slim AS build
WORKDIR /app
# openssl is required by Prisma's query engine
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
# runs `prisma generate && tsc` -> dist/
RUN npm run build

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
# node_modules already has the generated Prisma client from the build stage
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
EXPOSE 4000
USER node
CMD ["node", "dist/index.js"]
