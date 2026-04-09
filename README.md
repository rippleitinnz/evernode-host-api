# Evernode Host API

Real-time Evernode host discovery API. Maintains a local SQLite cache of all
Evernode host data via a local Xahau node, updated in real-time via heartbeat
subscriptions. Serves filtered host queries instantly via REST.

## Requirements

- Node.js v22+
- A local Xahau node running on `ws://localhost:6008`
- nginx
- evdevkit installed globally (`npm install -g evdevkit`)

## Setup

### 1. Clone and install
```bash
git clone https://github.com/rippleitinnz/evernode-host-api.git
cd evernode-host-api
npm install
```

### 2. Nginx
```bash
cp deploy/nginx-evernode-host-api.conf /etc/nginx/sites-enabled/evernode-host-api
nginx -t && systemctl reload nginx
```

### 3. Systemd service
```bash
cp deploy/evernode-host-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable evernode-host-api
systemctl start evernode-host-api
```

### 4. Verify
```bash
systemctl status evernode-host-api
curl http://localhost:3001/health
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /hosts | Filtered, paginated host list |
| GET | /hosts/:address | Single host full data |
| GET | /hosts/random | Random host sample |
| GET | /countries | Host counts by country |
| GET | /versions | Sashimono version distribution |
| GET | /stats | Network summary statistics |
| GET | /health | API health check |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| XAHAU_WS | ws://localhost:6008 | Xahau WebSocket endpoint |
| API_PORT | 3001 | API listen port |

## Notes

- Database (`hosts.db`) is excluded from the repo — generated on first run
- Full scan runs on startup if no data exists, then every 6 hours
- Real-time updates via heartbeat subscription to the Xahau ledger
