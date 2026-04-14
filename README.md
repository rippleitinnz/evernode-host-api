# Evernode Host API

Real-time Evernode host discovery API. Maintains a local SQLite cache of all Evernode host data via a local Xahau node, updated in real-time via heartbeat subscriptions to the Xahau ledger. Serves filtered host queries instantly via REST.

Live at: **https://api.onledger.net**  
Developer portal: **https://api.onledger.net/public/**

---

## Features

- 12,000+ registered Evernode hosts tracked
- All host data sourced directly from the Xahau registry hook
- Real-time updates via Xahau heartbeat subscriptions
- Full host registry data including reputation, hardware specs, balances, governance fields
- Heartbeat history tracking per host (from v1.2.0)
- Full text search across domain, email and description
- Null/not-null filtering on description, email and domain fields
- Field selection — return only the fields you need
- Leaderboard, batch lookup, comparison and random sampling endpoints
- SQLite-backed — zero external dependencies for the data layer
- CORS enabled for browser requests

---

## Requirements

- Node.js v22+
- A local Xahau node running on `ws://localhost:6008`
- nginx (for reverse proxy / SSL)
- evdevkit installed globally (`npm install -g evdevkit`)

---

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

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| XAHAU_WS | ws://localhost:6008 | Xahau WebSocket endpoint |
| API_PORT | 3001 | API listen port |

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /hosts | Filtered, paginated host list |
| GET | /hosts/search | Full text search across domain, email, description |
| GET | /hosts/expiring | Active hosts silent for N hours |
| GET | /hosts/compare | Compare multiple hosts by address |
| GET | /hosts/random | Random host sample with optional filters |
| GET | /hosts/:address | Single host full data |
| GET | /hosts/:address/history | Heartbeat history for a host |
| GET | /leaderboard | Top hosts by metric |
| POST | /hosts/batch | Bulk address lookup (up to 100) |
| GET | /countries | Host counts by country |
| GET | /versions | Sashimono version distribution |
| GET | /stats | Network summary statistics |
| GET | /health | API health check |
| POST | /scan | Trigger manual full rescan |

---

## /hosts Filter Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| active | boolean | — | Filter by active status |
| minSlots / maxSlots | integer | — | Available instances range |
| minRep / maxRep | integer | — | Reputation score range (0–255) |
| includeUnscored | boolean | false | Include hosts with rep=0 |
| minXah | number | 5 | Minimum XAH balance |
| minEvr | number | 5 | Minimum EVR balance |
| minLease / maxLease | integer | — | Lease price range in drops |
| country | string | — | 2-letter ISO country code |
| domain | string | — | Partial domain match |
| version | string | — | Sashimono version |
| minRam / minDisk | integer | — | Minimum RAM or disk in MB |
| isATransferer | integer | — | 0=exclude transferring hosts, 1=only transferring |
| reputedOnHeartbeat | boolean | — | true=only reputation-tested hosts |
| minAccumulatedReward | number | — | Minimum lifetime EVR rewards earned |
| hasDescription | boolean | — | true=only hosts with a description set, false=only hosts without |
| hasEmail | boolean | — | true=only hosts with an email set, false=only hosts without |
| hasDomain | boolean | — | true=only hosts with a domain set, false=only hosts without |
| description_like | string | — | Partial match on description field |
| fields | string | — | Comma-separated fields to return e.g. address,domain,hostReputation |
| sort | string | — | Shorthand sort e.g. sort=hostReputation:desc (alternative to sortBy + sortDir) |
| sortBy | string | hostReputation | hostReputation, availableInstances, leaseDrops, xahBalance, evrBalance, ramMb, diskMb, lastHeartbeatIndex, registrationTimestamp, accumulatedReward, lastUpdated |
| sortDir | string | desc | asc or desc |
| limit / offset | integer | 100 / 0 | Pagination |

---

## /hosts/search Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| q | string | — | Search term (min 2 chars) — matches domain, email and description. Optional if hasDescription or description_like is provided. |
| hasDescription | boolean | — | true=only hosts with a description set |
| description_like | string | — | Partial match on description only |
| active | boolean | — | Filter by active status |
| fields | string | — | Comma-separated fields to return |
| limit | integer | 50 | Max results (up to 200) |

---

## Pagination

All list endpoints return the following pagination metadata alongside results:

| Field | Description |
|-------|-------------|
| total | Total matching records |
| limit | Page size used |
| offset | Current offset |
| hasMore | true if more results are available |
| nextOffset | Pass as offset for the next page (null if last page) |
| prevOffset | Pass as offset for the previous page (null if first page) |

---

## Host Object Fields

| Field | Type | Description |
|-------|------|-------------|
| address | string | XRPL address |
| active | integer | 1=active, 0=inactive |
| domain | string | Host domain |
| description | string | Operator-provided description (may be null) |
| countryCode | string | ISO 3166-1 alpha-2 country code |
| maxInstances | integer | Total instances configured |
| activeInstances | integer | Instances currently in use |
| availableInstances | integer | Free slots |
| leaseAmount | string | EVR per moment (1hr) |
| leaseDrops | integer | Lease price in drops (1 EVR = 1,000,000) |
| hostReputation | integer | 0–255, tested by reputation contract |
| reputedOnHeartbeat | integer | 1=reputation measured on heartbeat |
| version | string | Sashimono version |
| cpuModelName | string | CPU model |
| cpuCount | integer | Allocated CPU cores |
| cpuMHz | integer | Clock speed MHz |
| cpuMicrosec | integer | CPU microseconds per round |
| ramMb | integer | RAM in MB |
| diskMb | integer | Disk in MB |
| email | string | Operator contact email (may be null) |
| xahBalance | number | XAH balance |
| evrBalance | number | EVR balance |
| accumulatedReward | string | Lifetime EVR rewards earned |
| uriTokenId | string | NFT token ID for host registration |
| registrationLedger | integer | Ledger index when host registered |
| registrationTimestamp | integer | Unix timestamp of registration |
| registrationFee | integer | EVR paid to register |
| isATransferer | integer | 1=host is in transfer mode |
| transferTimestamp | integer | Unix timestamp of last transfer |
| supportVoteSent | integer | 1=host has sent a governance support vote |
| lastVoteCandidateIdx | integer | Index of last governance vote candidate |
| lastVoteTimestamp | integer | Unix timestamp of last governance vote |
| lastHeartbeatIndex | integer | Unix timestamp of last heartbeat |
| lastUpdated | integer | Last DB update in milliseconds |

---

## Quick Start

```bash
# Active hosts with reputation and available slots
curl "https://api.onledger.net/hosts?active=true&minRep=200&minSlots=1&limit=10"

# Single host by address
curl "https://api.onledger.net/hosts/rnpkkEEMDSYAg1G6eHWF66kKjrKoAqMbtV"

# Search by domain, email or description
curl "https://api.onledger.net/hosts/search?q=onledger"

# All hosts with a description set
curl "https://api.onledger.net/hosts/search?hasDescription=true&active=true"

# Top hosts by accumulated reward
curl "https://api.onledger.net/leaderboard?metric=accumulatedReward&limit=10"

# Compare multiple hosts
curl "https://api.onledger.net/hosts/compare?addresses=rXXX,rYYY,rZZZ"

# Batch lookup
curl -X POST "https://api.onledger.net/hosts/batch" \
  -H "Content-Type: application/json" \
  -d '{"addresses":["rXXX","rYYY"]}'

# Heartbeat history
curl "https://api.onledger.net/hosts/rnpkkEEMDSYAg1G6eHWF66kKjrKoAqMbtV/history"

# Network statistics
curl "https://api.onledger.net/stats"
```

---

## Notes

- `hosts.db` is excluded from the repo — generated on first run
- Full scan runs on startup if no data exists, then every 6 hours
- Host address list is sourced directly from the Xahau registry hook via `account_namespace` queries to the local node
- Real-time updates via heartbeat subscription to the Xahau ledger
- History snapshots accumulate from v1.2.0 onwards (max 500 per host)
- The developer portal (`public/index.html`) is a single-file static site — no build step required
