# Docker Setup Guide

This project is configured to run in Docker with TypeScript scripts compiled to JavaScript.

## Building the Docker Image

```bash
# Using Docker directly
docker build -t newsserver:latest .

# Or using docker-compose
docker-compose build
```

## Running the Container

### Using Docker Compose (Recommended)

```bash
# Start the service
docker-compose up -d

# View logs
docker-compose logs -f app

# Stop the service
docker-compose down
```

### Using Docker CLI

```bash
# Run the container
docker run -p 3000:3000 -e NODE_ENV=production newsserver:latest

# Run with environment file
docker run -p 3000:3000 --env-file .env newsserver:latest

# Run with volume for logs
docker run -p 3000:3000 -v $(pwd)/logs:/app/logs newsserver:latest
```

## Running the Pipeline

The pipeline orchestrates all three stages (crawler, scenarist, news-builder) using pipeline-orchestration.json.
The cron_wrapper with --no-cron is the entry point for running the pipeline once.

### Locally

```bash
# Compile and run in one command
pnpm run pipeline

# Or compile first, then run with cron_wrapper
pnpm run build:scripts
npx tsx scripts/cron_wrapper.ts --no-cron

# With options
npx tsx scripts/cron_wrapper.ts --no-cron --week=2026-09-21 --no-ocr
```

### In Docker

```bash
# Run in container
docker-compose run --rm app pnpm run pipeline

# Or with tsx directly
docker-compose run --rm app npx tsx scripts/cron_wrapper.ts --no-cron --week=2026-09-21
```

## Running Individual Compiled Scripts

The scripts are compiled to JavaScript and available in the `dist/scripts` directory. You can run them in several ways:

### Locally (Development)

First, compile the scripts:

```bash
pnpm run build:scripts
```

Then run a script:

```bash
node dist/scripts/cron_wrapper.js
node dist/scripts/install_cron.js
node dist/scripts/news_builder.js
node dist/scripts/khu_crawler.js
node dist/scripts/scenarist.js
```

### Inside Docker Container

```bash
# Execute a script inside a running container
docker exec <container-id> node dist/scripts/cron_wrapper.js

# Or start a container just to run a script
docker run --rm newsserver:latest node dist/scripts/news_builder.js
```

### Using Docker Compose

```bash
# Run a one-off command in the service
docker-compose run --rm app node dist/scripts/install_cron.js
```

## Environment Variables

The following environment variables can be configured:

- `NODE_ENV`: Set to `production` for production builds (default: development)
- `.env` file: Copy `.env.example` to `.env` if it exists, or set variables as needed

## Building Locally vs. in Docker

### Build Locally

```bash
pnpm install
pnpm run build
```

This compiles both the NestJS application and TypeScript scripts to JavaScript.

### Build in Docker

The Dockerfile handles all compilation steps automatically:
1. Installs dependencies
2. Builds the NestJS application
3. Compiles TypeScript scripts to JavaScript
4. Creates an optimized production image

## Image Size Optimization

This setup uses a multi-stage build to minimize the final image size:

- **Build stage**: Contains TypeScript compiler and dev dependencies
- **Production stage**: Only contains production dependencies and compiled code

The `node_modules` directory is optimized by installing only production dependencies in the final image.

## Troubleshooting

### Port Already in Use

If port 3000 is already in use:

```bash
# Using Docker
docker run -p 8000:3000 newsserver:latest

# Using docker-compose
# Edit docker-compose.yml and change the port mapping
```

### Build Failures

1. Ensure you have the latest Docker version
2. Clean and rebuild:
   ```bash
   docker-compose down
   docker-compose build --no-cache
   ```

3. Check for TypeScript compilation errors:
   ```bash
   pnpm run build
   ```

### Permission Issues

If you encounter permission issues with volumes:

```bash
# On Linux/Mac, adjust volume ownership
docker-compose exec app chown -R node:node /app/logs
```

## Next Steps

1. Test locally: `pnpm run start:prod`
2. Test in Docker: `docker-compose up`
3. Verify scripts compile: `pnpm run build:scripts`
4. Push to registry: `docker tag newsserver:latest your-registry/newsserver:latest && docker push your-registry/newsserver:latest`
