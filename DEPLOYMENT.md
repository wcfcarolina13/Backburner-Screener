# Backburner Deployment Guide

## Quick Start - Deploy to Railway (Recommended)

Railway offers a free tier with 500 hours/month and $5 credit.

### Option 1: One-Click Deploy
1. Go to [Railway](https://railway.app)
2. Click "New Project" → "Deploy from GitHub repo"
3. Connect your GitHub account
4. Select the `wcfcarolina13/AI-Player2` repository
5. Railway will auto-detect the Dockerfile and deploy

### Option 2: Using Railway CLI
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Initialize project in this directory
cd /path/to/Backburner
railway init

# Deploy
railway up
```

## Alternative: Deploy to Render (Free)

1. Go to [Render](https://render.com)
2. Click "New" → "Web Service"
3. Connect your GitHub account
4. Select the `wcfcarolina13/AI-Player2` repository
5. Render will use the `render.yaml` blueprint

## Local PM2 Setup (for running on a home server)

```bash
# Install PM2 globally
npm install -g pm2

# Build the project
npm run build

# Start with PM2
pm2 start ecosystem.config.cjs

# Save process list for auto-restart on reboot
pm2 save

# Enable startup script (auto-start on system boot)
pm2 startup

# View logs
pm2 logs backburner

# Monitor
pm2 monit
```

## Data Persistence

All data is stored in the `data/` directory:
- `data/signals/` - Daily signal events (YYYY-MM-DD.json)
- `data/trades/` - Daily trade events (YYYY-MM-DD.json)
- `data/positions/` - Bot position snapshots (persisted across restarts)
- `data/crashes/` - Crash logs with full stack traces
- `data/daily/` - Daily summary reports
- `data/market/` - Market condition snapshots
- `data/configs/` - Bot configuration history

Positions are:
- Saved every 60 seconds
- Saved on graceful shutdown (SIGINT/SIGTERM)
- Saved on crash (with crash log)
- Loaded automatically on startup

## Logs

PM2 logs are stored in:
- `logs/pm2-error.log` - Error output
- `logs/pm2-out.log` - Standard output
- `logs/pm2-combined.log` - Combined logs

Logs are rotated at 10MB and 30 files are retained.

## Health Check

The server exposes `/api/state` for health checks. Railway and Render are configured to use this endpoint.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | Server port |
| NODE_ENV | production | Environment |

## Troubleshooting

### Check if server is running
```bash
curl http://localhost:3000/api/state | jq '.meta'
```

### View crash logs
```bash
ls -la data/crashes/
cat data/crashes/crash-*.json
```

### View bot positions
```bash
cat data/positions/wide.json | jq '.openPositions | length'
```

### Restart PM2
```bash
pm2 restart backburner
```

### View PM2 logs
```bash
pm2 logs backburner --lines 100
```
