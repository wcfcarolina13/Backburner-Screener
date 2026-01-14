# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Install PM2 globally
RUN npm install -g pm2

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy built files and config
COPY --from=builder /app/dist ./dist
COPY ecosystem.config.cjs ./

# Create data and logs directories
RUN mkdir -p data/signals data/trades data/daily data/market data/configs data/positions data/crashes logs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/state || exit 1

# Run with PM2 (no daemon mode for Docker)
CMD ["pm2-runtime", "start", "ecosystem.config.cjs"]
