# Multi-stage build for production
FROM node:18-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy source code
COPY . .

# Build CSS
RUN npm run build:css

# Production stage
FROM node:18-alpine AS production

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S wawebhook -u 1001

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create necessary directories
RUN mkdir -p /usr/src/app/data /usr/src/app/sessions /usr/src/app/logs /usr/src/app/backups
RUN chown -R wawebhook:nodejs /usr/src/app

# Set working directory
WORKDIR /usr/src/app

# Copy built application from builder stage
COPY --from=builder --chown=wawebhook:nodejs /usr/src/app/node_modules ./node_modules
COPY --from=builder --chown=wawebhook:nodejs /usr/src/app/public ./public
COPY --from=builder --chown=wawebhook:nodejs /usr/src/app/views ./views
COPY --from=builder --chown=wawebhook:nodejs /usr/src/app/config ./config
COPY --from=builder --chown=wawebhook:nodejs /usr/src/app/scripts ./scripts
COPY --from=builder --chown=wawebhook:nodejs /usr/src/app/*.js ./
COPY --from=builder --chown=wawebhook:nodejs /usr/src/app/package*.json ./

# Switch to non-root user
USER wawebhook

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node scripts/health-check.js || exit 1

# Expose port
EXPOSE 3000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "server.js"] 