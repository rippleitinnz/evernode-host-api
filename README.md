# Evernode Host API

Real-time Evernode host discovery API. Maintains a local SQLite cache of all Evernode host data via a local Xahau node, updated in real-time via heartbeat subscriptions to the Xahau ledger. Serves filtered host queries instantly via REST.

Live at: **https://api.onledger.net**
Developer portal: **https://api.onledger.net/**

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
- **ASN/provider enrichment** with hosting type classification (cloud/dedicated/vps/residential) — from v1.5.0
- **Provider centralisation metrics** with HHI (Herfindahl-Hirschman Index) score — from v1.5.0
- **Community report system** — flag problem hosts, weighted by severity, auto-flag at threshold — from v1.5.0
- **Multi-provider include/exclude** filtering — from v1.5.1
- SQLite-backed — zero external dependencies for the data layer
- CORS enabled for browser requests

---

## Requirements

- Node.js v22+
- A local Xahau node running on `ws://localhost:6008`
- nginx (for reverse proxy / SSL)
- evdevkit installed globally (`npm install -g evdevkit`)
- **MaxMind GeoLite2-ASN database** (optional, for provider enrichment) — free registration at [maxmind.com](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data)

---

## Setup

### 1. Clone and install

```
git clone https://github.com/rippleitinnz/evernode-host-api.git
cd evernode-host-api
npm install
```

### 2. ASN enrichment (optional but recommended)

Register for a free MaxMind account, then:

```
curl -L "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-ASN&license_key=YOUR_LICENCE_KEY&suffix=tar.gz" -o GeoLite2-ASN.tar.gz
tar -xzf GeoLite2-ASN.tar.gz --wildcards --no-anchored '*.mmdb' --strip-components=1
```

The API auto-detects `GeoLite2-ASN.mmdb` in the project root. Without it, ASN/hosting type fields will be null and the `/providers` endpoint returns an empty list.

### 3. Nginx

```
cp deploy/nginx-evernode-host-api.conf /etc/nginx/sites-enabled/evernode-host-api
nginx -t && systemctl reload nginx
```

The nginx location regex must include every top-level API route:

```
location ~ ^/(hosts|stats|health|scan|versions|countries|leaderboard|providers|report-categories|admin) {
    proxy_pass http://localhost:3001;
}
```

### 4. Systemd service

```
cp deploy/evernode-host-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable evernode-host-api
systemctl start evernode-host-api
```

### 5. Verify

```
systemctl status evernode-host-api
curl http://localhost:3001/health
```

---

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| XAHAU_WS | ws://localhost:6008 | Xahau WebSocket endpoint |
| API_PORT | 3001 | API listen port |
| ASN_DB_PATH | ./GeoLite2-ASN.mmdb | Path to MaxMind GeoLite2-ASN database |
| ADMIN_TOKEN | — | Bearer token for admin endpoints (required to enable admin routes) |

---

## API Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | /hosts | Filtered, paginated host list |
| GET | /hosts/search | Full text search across domain, email, description |
| GET | /hosts/expiring | Active hosts silent for N hours |
| GET | /hosts/compare | Compare multiple hosts by address |
| GET | /hosts/random | Random host sample with optional filters |
| GET | /hosts/flagged | All flagged hosts (community-flagged or admin-flagged) |
| GET | /hosts/:address | Single host full data |
| GET | /hosts/:address/history | Heartbeat history for a host |
| GET | /hosts/:address/reports | All community reports for a host |
| POST | /hosts/:address/report | Submit a community report for a host |
| GET | /leaderboard | Top hosts by metric |
| POST | /hosts/batch | Bulk address lookup (up to 100) |
| GET | /countries | Host counts by country |
| GET | /versions | Sashimono version distribution |
| GET | /providers | ASN provider breakdown with HHI centralisation score |
| GET | /report-categories | Valid report categories and severity weights |
| GET | /stats | Network summary statistics |
| GET | /health | API health check |
| POST | /scan | Trigger manual full rescan |
| POST | /admin/hosts/:address/flag | Flag or unflag a host (requires ADMIN_TOKEN) |
| DELETE | /admin/hosts/:address/reports | Delete all reports for a host (requires ADMIN_TOKEN) |

---

## /hosts Filter Parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
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
| hostingType | string | — | cloud, dedicated, vps, residential, unknown |
| asnOrg | string | — | Partial match on ASN organisation name. Comma-separated values are OR-joined (e.g. `OVH,Hetzner`) |
| excludeAsnOrg | string | — | Exclude hosts matching ASN organisation. Comma-separated values are AND-joined (e.g. `OVH,netcup,OPTAGE`). Hosts without ASN data pass through |
| includeFlagged | boolean | false | Include flagged/reported hosts in results |
| fields | string | — | Comma-separated fields to return e.g. address,domain,hostReputation |
| sort | string | — | Shorthand sort e.g. sort=hostReputation:desc (alternative to sortBy + sortDir) |
| sortBy | string | hostReputation | hostReputation, availableInstances, leaseDrops, xahBalance, evrBalance, ramMb, diskMb, lastHeartbeatIndex, registrationTimestamp, accumulatedReward, lastUpdated |
| sortDir | string | desc | asc or desc |
| limit / offset | integer | 100 / 0 | Pagination |

---

## /hosts/search Parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| q | string | — | Search term (min 2 chars) — matches domain, email and description. Optional if hasDescription or description_like is provided |
| hasDescription | boolean | — | true=only hosts with a description set |
| description_like | string | — | Partial match on description only |
| active | boolean | — | Filter by active status |
| fields | string | — | Comma-separated fields to return |
| limit | integer | 50 | Max results (up to 200) |

---

## Community Report System

Hosts can be reported by the community for issues like broken peer ports, security vulnerabilities, or fake hardware specs. Reports are scored by severity — when a host's cumulative score reaches the threshold (default 3) within the rolling window (default 90 days), the host is automatically flagged and excluded from default search results.

**Anti-abuse:** one report per IP per host per 24 hours, enforced at the SQL layer.

### Report Categories

| Category | Severity | Description |
| --- | --- | --- |
| peer_port_broken | 1 | Host passes reputation but peer port doesn't accept connections |
| instance_unreachable | 1 | Acquired instance never comes up or is unreachable |
| slow_provision | 1 | Excessive time to provision instances |
| bad_peering | 2 | Weakly connected / INTERNAL_SECURITY=mid configuration |
| fake_specs | 2 | Advertised RAM/CPU doesn't match reality |
| security_issue | 3 | Known security vulnerability |
| other | 1 | Other issues not covered above |

### Submit a report

```
curl -X POST "https://api.onledger.net/hosts/rXXX/report" \
  -H "Content-Type: application/json" \
  -d '{
    "category": "peer_port_broken",
    "reason": "Peer port 22861 not responding despite reputation 252",
    "evidence": "Optional URL, tx hash, or log excerpt"
  }'
```

### View reports for a host

```
curl "https://api.onledger.net/hosts/rXXX/reports"
```

### View all flagged hosts

```
curl "https://api.onledger.net/hosts/flagged"
```

### Admin: flag/unflag and report cleanup

Requires `Authorization: Bearer $ADMIN_TOKEN` header.

```
# Flag a host directly
curl -X POST "https://api.onledger.net/admin/hosts/rXXX/flag" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Confirmed compromised — see incident report"}'

# Unflag
curl -X POST "https://api.onledger.net/admin/hosts/rXXX/flag" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"unflag": true}'

# Clear all reports for a host (false-positive cleanup)
curl -X DELETE "https://api.onledger.net/admin/hosts/rXXX/reports" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## Provider Centralisation

The `/providers` endpoint returns a breakdown of hosts by ASN organisation, useful for assessing decentralisation risk. The response includes an **HHI (Herfindahl-Hirschman Index)** concentration score based on each provider's share of active hosts.

| HHI Range | Interpretation |
| --- | --- |
| < 1,500 | Competitive — well-distributed across providers |
| 1,500 – 2,500 | Moderately concentrated |
| > 2,500 | Highly concentrated |

```
curl "https://api.onledger.net/providers" | jq '{hhi, hhiRating, byType, top: (.providers[:5])}'
```

Returns providers with at least 1 active host, sorted by active count descending. Hosting types are derived from ASN organisation lookup:

| Type | Examples |
| --- | --- |
| cloud | AWS, GCP, Azure, DigitalOcean |
| dedicated | OVH, Hetzner, Leaseweb, netcup |
| vps | Contabo, Hostinger |
| residential | Spark NZ, Comcast, BT, Orange |
| unknown | ASNs not in the classification lookup |

---

## Pagination

All list endpoints return the following pagination metadata alongside results:

| Field | Description |
| --- | --- |
| total | Total matching records |
| limit | Page size used |
| offset | Current offset |
| hasMore | true if more results are available |
| nextOffset | Pass as offset for the next page (null if last page) |
| prevOffset | Pass as offset for the previous page (null if first page) |

---

## Host Object Fields

| Field | Type | Description |
| --- | --- | --- |
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
| asnNumber | integer | Autonomous System Number (null if ASN DB not loaded) |
| asnOrg | string | ASN organisation name (e.g. "OVH SAS") |
| hostingType | string | cloud, dedicated, vps, residential, or unknown |
| flagged | integer | 1=flagged, excluded from default results |
| flaggedAt | integer | Timestamp when flagged (ms) |
| flagReason | string | Reason set by admin if admin-flagged |
| reportCount | integer | Number of community reports in last 90 days |
| reportScore | integer | Cumulative severity score (≥3 triggers auto-flag) |

---

## Quick Start

```
# Active hosts with reputation and available slots
curl "https://api.onledger.net/hosts?active=true&minRep=200&minSlots=1&limit=10"

# Single host by address
curl "https://api.onledger.net/hosts/rnpkkEEMDSYAg1G6eHWF66kKjrKoAqMbtV"

# Search by domain, email or description
curl "https://api.onledger.net/hosts/search?q=onledger"

# Top hosts by accumulated reward
curl "https://api.onledger.net/leaderboard?metric=accumulatedReward&limit=10"

# Compare multiple hosts
curl "https://api.onledger.net/hosts/compare?addresses=rXXX,rYYY,rZZZ"

# Batch lookup
curl -X POST "https://api.onledger.net/hosts/batch" \
  -H "Content-Type: application/json" \
  -d '{"addresses":["rXXX","rYYY"]}'

# Network statistics and provider centralisation
curl "https://api.onledger.net/stats"
curl "https://api.onledger.net/providers"

# Filter by hosting type
curl "https://api.onledger.net/hosts?active=true&hostingType=dedicated&minRep=200"

# Include hosts from specific providers (OR logic)
curl "https://api.onledger.net/hosts?active=true&asnOrg=OVH,Hetzner"

# Exclude multiple providers (AND logic — must avoid all)
curl "https://api.onledger.net/hosts?active=true&excludeAsnOrg=OVH,netcup,OPTAGE"

# Report a problematic host
curl -X POST "https://api.onledger.net/hosts/rXXX/report" \
  -H "Content-Type: application/json" \
  -d '{"category":"peer_port_broken","reason":"Peer port not responding"}'

# View flagged hosts
curl "https://api.onledger.net/hosts/flagged"
```

---

## Notes

- `hosts.db` is excluded from the repo — generated on first run
- Full scan runs on startup if no data exists, then every 6 hours
- Host address list is sourced directly from the Xahau registry hook via `account_namespace` queries to the local node
- Real-time updates via heartbeat subscription to the Xahau ledger
- History snapshots accumulate from v1.2.0 onwards (max 500 per host)
- ASN data is refreshed on each full scan — domains are resolved to IPs, IPs looked up against the MaxMind database
- The MaxMind GeoLite2-ASN database is updated monthly (first Tuesday) — consider a cron job to refresh it
- The developer portal (`public/index.html`) is a single-file static site — no build step required

---

## Theming

The developer portal supports four NZ-themed colour palettes — Fiordland, Waitomo, Kauri and Southern Alps — each with a light and dark mode. The palette switcher is in the nav bar on tablet and desktop. The selected theme is saved to localStorage.

---

## Changelog

### v1.5.1
- Multi-provider include/exclude — `asnOrg` and `excludeAsnOrg` accept comma-separated values
- Providers list filtered to active ≥ 1 (zero-active providers hidden)
- Various UI polish on the developer portal: collapsible sections, mobile fixes, query builder improvements

### v1.5.0
- ASN/provider enrichment with hosting type classification
- `/providers` endpoint with HHI centralisation score and per-provider breakdown
- Community report system with severity-weighted scoring and auto-flag threshold
- `hostingType`, `asnOrg`, `includeFlagged` filters on `/hosts`
- Admin endpoints for manual flagging and report management
- Inline report form and flagged-hosts table on the developer portal

### v1.4.0
- Network centralisation analysis foundation
- Random host sampling endpoint
- Various developer portal enhancements

### v1.2.0
- Heartbeat history tracking per host (max 500 snapshots)
