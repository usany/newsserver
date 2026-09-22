# Two-Container Setup Guide

This project is configured to run with two separate Docker containers:

## Container Architecture

### 1. **App Container** (newsserver-app)
- **Purpose**: Serves the NestJS application and provides file storage/serving to clients
- **Port**: 3000 (HTTP)
- **Command**: `node dist/main`
- **Volumes**:
  - `app-storage` - Shared volume for pipeline outputs (`_workspace`)
  - `./logs` - Application logs
- **Dependencies**: Depends on cron service

### 2. **Cron Container** (newsserver-cron)
- **Purpose**: Runs the pipeline orchestrator on a scheduled cron job
- **Command**: `node dist/scripts/cron_wrapper.js`
- **Volumes**:
  - `app-storage` - Shared volume for pipeline outputs (`_workspace`)
  - `./logs` - Application logs
- **Schedule**: Default Friday 22:00 (configurable via `SCHEDULE` env var)

## Shared Storage

Both containers share a Docker volume `app-storage` that maps to `_workspace`. This allows:
- The **cron service** to write pipeline outputs
- The **app service** to read and serve those files to clients
- Persistent data across container restarts

## Building the Docker Images

### Using Docker Compose (Recommended)

```bash
# Build both services
docker-compose build

# Or rebuild without cache
docker-compose build --no-cache
```

### Using Docker CLI

```bash
docker build -t newsserver:latest .
```

## Running the Containers

### Start Both Services

```bash
# Start in background
docker-compose up -d

# View logs
docker-compose logs -f

# View specific service logs
docker-compose logs -f app
docker-compose logs -f cron

# Stop services
docker-compose down
```

### Running Services Individually

```bash
# Run only the app service
docker-compose up -d app

# Run only the cron service
docker-compose up -d cron

# Run a one-time command (e.g., run pipeline immediately with --no-cron)
docker-compose run --rm cron npx tsx scripts/cron_wrapper.ts --no-cron
```

## Environment Configuration

### Via Environment Variables

```bash
# Run with custom schedule (cron expression)
SCHEDULE="0 9 * * 1" docker-compose up -d cron

# Or set in .env file
echo "SCHEDULE=0 9 * * 1" >> .env
docker-compose up -d
```

### Cron Schedule Examples

The cron schedule uses standard cron syntax (minute hour day month dayofweek):

```
0 22 * * 5      # Friday 22:00 (default)
0 9 * * 1       # Monday 09:00
0 0 * * *       # Daily at midnight
*/30 * * * *    # Every 30 minutes
0 2 1 * *       # Monthly at 2:00 on the 1st
```

Set via: `docker-compose.yml` environment variable or `SCHEDULE` env var.

## Language Support (Python, Node, etc.)

The Docker image includes:
- **Node.js 20** - For TypeScript/JavaScript scripts
- **Python 3** - For OCR and other Python scripts (easyocr_helper.py, etc.)

All scripts files are copied to `/app/scripts` in the container, making them accessible to both Node and Python processes:
- TypeScript scripts compile to `dist/scripts/`
- Python scripts remain in `scripts/` directory
- The cron service can invoke both compiled JS and native Python scripts

## Pipeline Execution Flow

```
┌─────────────────────────────────────────────┐
│         Cron Service                        │
│  (runs on schedule: Friday 22:00)           │
└──────────┬──────────────────────────────────┘
           │
           ├─> orchestration (from cron_wrapper --no-cron)
           │   ├─> khu_crawler.ts
           │   │   └─> easyocr_helper.py (Python OCR)
           │   ├─> scenarist.ts
           │   └─> news_builder.ts
           │
           └─> Writes outputs to app-storage (_workspace)
                │
                ├─> 01_notice.md
                ├─> 02_ocr_results.md
                ├─> 03_scenarios.md
                └─> 04_news.json
                
                ↓ (shared volume)
                
┌─────────────────────────────────────────────┐
│         App Service                         │
│  (serves files to clients on port 3000)     │
│                                             │
│  GET /storage/{file} → _workspace files    │
└─────────────────────────────────────────────┘
```

## Monitoring

### View Cron Logs

```bash
# Watch cron logs in real-time
docker-compose logs -f cron

# Cron logs are also written to:
# _workspace/cron.log (persisted on host)
```

### Check Service Health

```bash
# View running containers
docker-compose ps

# Inspect app service
docker-compose exec app ps aux

# Inspect cron service
docker-compose exec cron ps aux
```

## Troubleshooting

### Containers Not Starting

```bash
# Check logs for errors
docker-compose logs

# Rebuild images
docker-compose build --no-cache

# Remove and recreate
docker-compose down -v
docker-compose up -d
```

### Pipeline Not Running on Schedule

```bash
# Check cron service logs
docker-compose logs cron

# Verify schedule is valid
docker-compose exec cron node -e "
  const cron = require('node-cron');
  console.log('Valid:', cron.validate('0 22 * * 5'));
"

# Test pipeline manually with --no-cron
docker-compose run --rm cron npx tsx scripts/cron_wrapper.ts --no-cron
```

### File Permissions Issues

```bash
# Fix ownership of _workspace volume on host
sudo chown -R $(id -u):$(id -g) _workspace/

# Or inside container
docker-compose exec app chown -R node:node /app/_workspace
```

### Python/OCR Errors

```bash
# Check Python is installed in container
docker-compose exec cron python3 --version

# Test easyocr helper directly
docker-compose exec cron python3 scripts/easyocr_helper.py --help
```

## Development vs Production

### Development (Hot Reload - Not in Docker)

```bash
pnpm install
pnpm run start:dev      # App
pnpm run build:scripts
node dist/scripts/cron_wrapper.js --run-now  # Cron
```

### Production (Docker)

```bash
docker-compose build
docker-compose up -d
```

## Next Steps

1. **Configure schedule**: Update `SCHEDULE` env var or docker-compose.yml
2. **Add API endpoints**: Extend the app service to expose pipeline outputs
3. **Set up monitoring**: Use tools like Prometheus/Grafana for pipeline metrics
4. **Configure CI/CD**: Push images to registry for automated deployments
