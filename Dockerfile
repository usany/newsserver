# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code and scripts
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json tsconfig.build.json nest-cli.json ./

# Build application and scripts
RUN pnpm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install pnpm and Python (for OCR/easyocr in crawler)
RUN apk add --no-cache python3 py3-pip

RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built application and scripts from builder
COPY --from=builder /app/dist ./dist

# Copy original scripts directory (for Python and other language scripts)
COPY scripts ./scripts

# Create a scripts directory for the compiled scripts
RUN mkdir -p /app/bin

# Expose port (adjust as needed for your app)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Run the application (default)
CMD ["node", "dist/main"]
