# ---- IOMS API ----
FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies (cached layer).
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Generate Prisma client.
COPY prisma ./prisma
RUN npx prisma generate

# App source.
COPY . .

ENV NODE_ENV=production
EXPOSE 4000

# Apply migrations then start. (Uses prisma migrate deploy for prod.)
CMD ["sh", "-c", "npx prisma migrate deploy && node src/index.js"]
