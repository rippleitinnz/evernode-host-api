#!/usr/bin/env node
/**
 * Evernode Host Discovery API
 *
 * Maintains a real-time cache of all Evernode host data via local Xahau node.
 * Serves filtered host queries instantly via REST API.
 *
 * Usage: node server.js
 */

'use strict';

const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');
const express  = require('express');

// ── Config ────────────────────────────────────────────────────
const XAHAU_WS          = process.env.XAHAU_WS        || 'ws://localhost:6008';
const API_PORT          = parseInt(process.env.API_PORT || '3001');
const HEARTBEAT_ACCOUNT = 'rHktfGUbjqzU4GsYCMc1pDjdHXb5CJamto';
const XRPLWIN_API       = 'https://xahau.xrplwin.com/api/evernode/hosts';
const BATCH_SIZE        = 50;   // hosts per parallel batch
const BATCH_DELAY_MS    = 100;  // ms between batches to avoid overwhelming local node
const DB_PATH           = path.join(__dirname, 'hosts.db');
const EVDEVKIT_PATH     = '/root/.nvm/versions/node/v22.16.0/lib/node_modules/evdevkit/node_modules';

// ── Database ──────────────────────────────────────────────────
const db = new Database(DB_PATH);

db.exec(`
    CREATE TABLE IF NOT EXISTS hosts (
        address TEXT PRIMARY KEY,
        active INTEGER,
        domain TEXT,
        countryCode TEXT,
        maxInstances INTEGER,
        activeInstances INTEGER,
        availableInstances INTEGER,
        leaseAmount TEXT,
        leaseDrops INTEGER,
        hostReputation INTEGER,
        version TEXT,
        cpuModelName TEXT,
        cpuCount INTEGER,
        cpuMHz INTEGER,
        cpuMicrosec INTEGER,
        ramMb INTEGER,
        diskMb INTEGER,
        email TEXT,
        accumulatedReward TEXT,
        xahBalance REAL,
        evrBalance REAL,
        registrationTimestamp INTEGER,
        lastHeartbeatIndex INTEGER,
        lastUpdated INTEGER
    );
    CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
    );
`);

const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)');
const getMeta = (key) => { const r = db.prepare('SELECT value FROM meta WHERE key=?').get(key); return r?.value; };

// ── Evernode client setup ─────────────────────────────────────
let evernode, xrplApi, registryClient;

const initEvernode = async () => {
    evernode = require(path.join(EVDEVKIT_PATH, 'evernode-js-client'));
    await evernode.Defaults.useNetwork('mainnet');
    xrplApi = new evernode.XrplApi(XAHAU_WS);
    evernode.Defaults.set({ xrplApi, useCentralizedRegistry: true });
    await xrplApi.connect();
    console.log(`[API] Connected to Xahau node: ${XAHAU_WS}`);
    registryClient = await evernode.HookClientFactory.create(evernode.HookTypes.registry);
    await registryClient.connect();
    console.log('[API] Registry client connected');
};

// ── Balance fetcher ───────────────────────────────────────────
const WS = require(path.join(EVDEVKIT_PATH, 'ws'));

const fetchBalances = (addresses) => new Promise((resolve) => {
    const results = {};
    addresses.forEach(a => { results[a] = { xah: 0, evr: 0 }; });
    if (!addresses.length) { resolve(results); return; }

    let ws;
    try { ws = new WS(XAHAU_WS); } catch { resolve(results); return; }

    let pending = addresses.length * 2;
    const finish = () => { try { ws.close(); } catch {} resolve(results); };
    const timer = setTimeout(finish, 30000);
    const dec = () => { if (--pending <= 0) { clearTimeout(timer); finish(); } };

    ws.on('open', () => {
        addresses.forEach(addr => {
            ws.send(JSON.stringify({ command:'account_info',  account:addr, ledger_index:'current', id:'info_'+addr  }));
            ws.send(JSON.stringify({ command:'account_lines', account:addr, ledger_index:'current', id:'lines_'+addr }));
        });
    });
    ws.on('message', (data) => {
        try {
            const r = JSON.parse(data);
            if (r.id?.startsWith('info_')) {
                const addr = r.id.replace('info_','');
                if (r.result?.account_data) results[addr].xah = parseInt(r.result.account_data.Balance)/1000000;
                dec();
            } else if (r.id?.startsWith('lines_')) {
                const addr = r.id.replace('lines_','');
                const evr = r.result?.lines?.find(l=>l.currency==='EVR');
                if (evr) results[addr].evr = parseFloat(evr.balance);
                dec();
            }
        } catch { dec(); }
    });
    ws.on('error', () => { clearTimeout(timer); resolve(results); });
});

// ── Host info fetcher ─────────────────────────────────────────
const fetchHostInfo = async (address) => {
    try {
        return await registryClient.getHostInfo(address);
    } catch { return null; }
};

// ── Upsert host to DB ─────────────────────────────────────────
const upsertHost = db.prepare(`
    INSERT OR REPLACE INTO hosts (
        address, active, domain, countryCode, maxInstances, activeInstances,
        availableInstances, leaseAmount, leaseDrops, hostReputation, version,
        cpuModelName, cpuCount, cpuMHz, cpuMicrosec, ramMb, diskMb, email,
        accumulatedReward, xahBalance, evrBalance, registrationTimestamp,
        lastHeartbeatIndex, lastUpdated
    ) VALUES (
        @address, @active, @domain, @countryCode, @maxInstances, @activeInstances,
        @availableInstances, @leaseAmount, @leaseDrops, @hostReputation, @version,
        @cpuModelName, @cpuCount, @cpuMHz, @cpuMicrosec, @ramMb, @diskMb, @email,
        @accumulatedReward, @xahBalance, @evrBalance, @registrationTimestamp,
        @lastHeartbeatIndex, @lastUpdated
    )
`);

const hostToRow = (info, balances = { xah: 0, evr: 0 }) => ({
    address:              info.address,
    active:               info.active ? 1 : 0,
    domain:               info.domain || null,
    countryCode:          info.countryCode || null,
    maxInstances:         info.maxInstances || 0,
    activeInstances:      info.activeInstances || 0,
    availableInstances:   (info.maxInstances || 0) - (info.activeInstances || 0),
    leaseAmount:          info.leaseAmount?.toString() || null,
    leaseDrops:           info.leaseAmount ? Math.round(parseFloat(info.leaseAmount) * 1000000) : null,
    hostReputation:       info.hostReputation ?? null,
    version:              info.version || null,
    cpuModelName:         info.cpuModelName || null,
    cpuCount:             info.cpuCount || null,
    cpuMHz:               info.cpuMHz || null,
    cpuMicrosec:          info.cpuMicrosec || null,
    ramMb:                info.ramMb || null,
    diskMb:               info.diskMb || null,
    email:                info.email || null,
    accumulatedReward:    info.accumulatedRewardAmount?.toString() || null,
    xahBalance:           balances.xah,
    evrBalance:           balances.evr,
    registrationTimestamp: info.registrationTimestamp || null,
    lastHeartbeatIndex:   info.lastHeartbeatIndex || null,
    lastUpdated:          Date.now()
});

// ── Full scan ─────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let scanInProgress = false;

const fullScan = async () => {
    if (scanInProgress) { console.log('[Scan] Already in progress, skipping'); return; }
    scanInProgress = true;
    const start = Date.now();
    console.log('[Scan] Starting full host scan...');

    try {
        // Fetch host list from XRPLWin
        const data = await new Promise((resolve, reject) => {
            https.get(XRPLWIN_API, res => {
                let d = ''; res.on('data', c => d += c);
                res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
            }).on('error', reject);
        });

        const priceMap = {};
        const allAddresses = data.data
            .filter(h => h.host)
            .map(h => { if (h.leaseprice_evr_drops) priceMap[h.host] = h.leaseprice_evr_drops; return h.host; });

        console.log(`[Scan] ${allAddresses.length} registered hosts found`);
        setMeta.run('totalRegistered', String(allAddresses.length));

        let processed = 0, active = 0;

        // Process in batches
        for (let i = 0; i < allAddresses.length; i += BATCH_SIZE) {
            const batch = allAddresses.slice(i, i + BATCH_SIZE);

            // Fetch host info in parallel
            const infos = await Promise.all(batch.map(addr => fetchHostInfo(addr)));

            // Fetch balances for active hosts only
            const activeInBatch = infos.filter(info => info?.active).map(info => info.address);
            const balances = activeInBatch.length > 0 ? await fetchBalances(activeInBatch) : {};

            // Upsert to DB
            const upsertMany = db.transaction((rows) => { rows.forEach(r => upsertHost.run(r)); });
            const rows = infos
                .filter(info => info !== null)
                .map(info => hostToRow(info, balances[info.address] || { xah: 0, evr: 0 }));
            upsertMany(rows);

            processed += batch.length;
            active += activeInBatch.length;
            process.stdout.write(`[Scan] ${processed}/${allAddresses.length} | Active: ${active}\r`);

            if (i + BATCH_SIZE < allAddresses.length) await sleep(BATCH_DELAY_MS);
        }

        const elapsed = Math.round((Date.now() - start) / 1000);
        console.log(`\n[Scan] Complete — ${processed} hosts processed, ${active} active in ${elapsed}s`);
        setMeta.run('lastFullScan', String(Date.now()));
        setMeta.run('activeHosts', String(active));

    } catch(e) {
        console.error('[Scan] Error:', e.message);
    } finally {
        scanInProgress = false;
    }
};

// ── Update single host (called on heartbeat) ──────────────────
const updateHost = async (address) => {
    try {
        const info = await fetchHostInfo(address);
        if (!info) return;
        // Keep existing balance from DB — only updated during full scan
        const existing = db.prepare('SELECT xahBalance, evrBalance FROM hosts WHERE address = ?').get(address);
        upsertHost.run(hostToRow(info, { xah: existing?.xahBalance || 0, evr: existing?.evrBalance || 0 }));
        console.log(`[Heartbeat] Updated ${address} | active=${info.active} slots=${info.maxInstances-info.activeInstances} rep=${info.hostReputation}`);
    } catch(e) {
        console.error(`[Heartbeat] Error updating ${address}:`, e.message);
    }
};

// ── Heartbeat subscription ────────────────────────────────────
let hbWs = null;

const subscribeHeartbeat = () => {
    if (hbWs) { try { hbWs.close(); } catch {} }

    hbWs = new WS(XAHAU_WS);

    hbWs.on('open', () => {
        console.log('[Heartbeat] Subscribed to heartbeat account');
        hbWs.send(JSON.stringify({
            command: 'subscribe',
            accounts: [HEARTBEAT_ACCOUNT]
        }));
    });

    hbWs.on('message', (data) => {
        try {
            const r = JSON.parse(data);
            if (r.type === 'transaction' && r.transaction?.Account) {
                updateHost(r.transaction.Account);
            }
        } catch {}
    });

    hbWs.on('close', () => {
        console.log('[Heartbeat] Connection closed — reconnecting in 10s...');
        setTimeout(subscribeHeartbeat, 10000);
    });

    hbWs.on('error', (e) => {
        console.error('[Heartbeat] WebSocket error:', e.message);
    });
};

// ── REST API ──────────────────────────────────────────────────
const app = express();
app.use(express.json());

// CORS for public access
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// GET /hosts — filtered host list
app.get('/hosts', (req, res) => {
    const {
        active,
        minSlots,
        maxSlots,
        minRep,
        maxRep,
        includeUnscored,
        minXah = '5',
        minEvr = '5',
        minLease,
        maxLease,
        country,
        version,
        minRam,
        minDisk,
        sortBy = 'hostReputation',
        sortDir = 'desc',
        limit = 100,
        offset = 0
    } = req.query;

    let where = [];
    let params = [];

    if (active !== undefined)   { where.push('active = ?');                params.push(active === 'true' || active === '1' ? 1 : 0); }
    if (minSlots !== undefined)  { where.push('availableInstances >= ?');   params.push(parseInt(minSlots)); }
    if (maxSlots !== undefined)  { where.push('availableInstances <= ?');   params.push(parseInt(maxSlots)); }
    if (minRep !== undefined) {
        if (includeUnscored === 'true' || includeUnscored === '1') {
            where.push('(hostReputation >= ? OR hostReputation = 0 OR hostReputation IS NULL)');
            params.push(parseInt(minRep));
        } else {
            where.push('hostReputation >= ?');
            params.push(parseInt(minRep));
        }
    }
    if (maxRep !== undefined)    { where.push('hostReputation <= ?');        params.push(parseInt(maxRep)); }
    if (minXah !== undefined)    { where.push('xahBalance >= ?');            params.push(parseFloat(minXah)); }
    if (minEvr !== undefined)    { where.push('evrBalance >= ?');            params.push(parseFloat(minEvr)); }
    if (minLease !== undefined)  { where.push('leaseDrops >= ?');            params.push(parseInt(minLease)); }
    if (maxLease !== undefined)  { where.push('leaseDrops <= ?');            params.push(parseInt(maxLease)); }
    if (country !== undefined)   { where.push('countryCode = ?');            params.push(country.toUpperCase()); }
    if (version !== undefined)   { where.push('version = ?');                params.push(version); }
    if (minRam !== undefined)    { where.push('ramMb >= ?');                 params.push(parseInt(minRam)); }
    if (minDisk !== undefined)   { where.push('diskMb >= ?');                params.push(parseInt(minDisk)); }

    const allowedSort = ['hostReputation','availableInstances','leaseDrops','xahBalance','evrBalance','ramMb','diskMb','countryCode','version','lastHeartbeatIndex'];
    const safeSort = allowedSort.includes(sortBy) ? sortBy : 'hostReputation';
    const safeDir  = sortDir === 'asc' ? 'ASC' : 'DESC';

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const sql = `SELECT * FROM hosts ${whereClause} ORDER BY ${safeSort} ${safeDir} LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    try {
        const hosts = db.prepare(sql).all(...params);
        const total = db.prepare(`SELECT COUNT(*) as count FROM hosts ${whereClause}`).get(...params.slice(0,-2))?.count || 0;
        res.json({
            success: true,
            total,
            count: hosts.length,
            offset: parseInt(offset),
            hosts
        });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /hosts/random — random sample with optional filters
app.get('/hosts/random', (req, res) => {
    const { count = 10, minRep, minSlots, country, active = 'true' } = req.query;
    const limit = Math.min(parseInt(count) || 10, 200);

    let where = [];
    let params = [];

    if (active !== undefined)   { where.push('active = ?');               params.push(active === 'true' ? 1 : 0); }
    if (minRep !== undefined)   { where.push('hostReputation >= ?');       params.push(parseInt(minRep)); }
    if (minSlots !== undefined) { where.push('availableInstances >= ?');   params.push(parseInt(minSlots)); }
    if (country !== undefined)  { where.push('countryCode = ?');           params.push(country.toUpperCase()); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const sql = `SELECT * FROM hosts ${whereClause} ORDER BY RANDOM() LIMIT ?`;
    params.push(limit);

    try {
        const hosts = db.prepare(sql).all(...params);
        res.json({ success: true, count: hosts.length, hosts });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /hosts/:address — single host
app.get('/hosts/:address', (req, res) => {
    const host = db.prepare('SELECT * FROM hosts WHERE address = ?').get(req.params.address);
    if (!host) return res.status(404).json({ success: false, error: 'Host not found' });
    res.json({ success: true, host });
});

// GET /stats — network summary
app.get('/stats', (req, res) => {
    const stats = db.prepare(`
        SELECT
            COUNT(*) as totalHosts,
            SUM(active) as activeHosts,
            SUM(availableInstances) as totalAvailableSlots,
            SUM(maxInstances) as totalSlots,
            AVG(CASE WHEN active=1 THEN hostReputation END) as avgReputation,
            AVG(CASE WHEN active=1 THEN xahBalance END) as avgXah,
            AVG(CASE WHEN active=1 THEN evrBalance END) as avgEvr,
            MIN(CASE WHEN active=1 AND leaseDrops > 0 THEN leaseDrops END) as minLeaseDrops,
            MAX(CASE WHEN active=1 THEN leaseDrops END) as maxLeaseDrops
        FROM hosts
    `).get();

    const countries = db.prepare(`
        SELECT countryCode, COUNT(*) as count
        FROM hosts WHERE active=1 AND countryCode IS NOT NULL
        GROUP BY countryCode ORDER BY count DESC LIMIT 10
    `).all();

    const versions = db.prepare(`
        SELECT version, COUNT(*) as count
        FROM hosts WHERE active=1 AND version IS NOT NULL
        GROUP BY version ORDER BY count DESC
    `).all();

    res.json({
        success: true,
        lastFullScan: getMeta('lastFullScan'),
        lastUpdated: Date.now(),
        stats,
        topCountries: countries,
        versions
    });
});

// GET /scan — trigger manual rescan (for admin use)
app.post('/scan', (req, res) => {
    if (scanInProgress) {
        return res.json({ success: false, message: 'Scan already in progress' });
    }
    res.json({ success: true, message: 'Scan started' });
    fullScan();
});

// GET /health
app.get('/health', (req, res) => {
    const hostCount = db.prepare('SELECT COUNT(*) as count FROM hosts').get()?.count || 0;
    const activeCount = db.prepare('SELECT COUNT(*) as count FROM hosts WHERE active=1').get()?.count || 0;
    res.json({
        success: true,
        status: 'ok',
        hostCount,
        activeCount,
        lastFullScan: getMeta('lastFullScan'),
        scanInProgress
    });
});

// GET /versions — Sashimono version distribution
app.get('/versions', (req, res) => {
    const versions = db.prepare(`
        SELECT version, COUNT(*) as count
        FROM hosts
        WHERE version IS NOT NULL AND active = 1
        GROUP BY version
        ORDER BY count DESC
    `).all();
    res.json({ success: true, versions });
});

// GET /countries — host counts by country
app.get('/countries', (req, res) => {
    const countries = db.prepare(`
        SELECT
            countryCode,
            COUNT(*) as total,
            SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) as active,
            SUM(CASE WHEN active=1 THEN availableInstances ELSE 0 END) as availableSlots
        FROM hosts
        WHERE countryCode IS NOT NULL
        GROUP BY countryCode
        ORDER BY total DESC
    `).all();
    res.json({ success: true, countries });
});


// ── Startup ───────────────────────────────────────────────────
const main = async () => {
    console.log('╔════════════════════════════════════════╗');
    console.log('║   Evernode Host Discovery API          ║');
    console.log('╚════════════════════════════════════════╝');
    console.log(`  Xahau node : ${XAHAU_WS}`);
    console.log(`  API port   : ${API_PORT}`);
    console.log(`  Database   : ${DB_PATH}`);
    console.log('');

    await initEvernode();

    // Start REST API
    app.listen(API_PORT, () => {
        console.log(`[API] Listening on http://localhost:${API_PORT}`);
    });

    // Subscribe to heartbeats for real-time updates
    subscribeHeartbeat();

    // Check if we need an initial scan
    const lastScan = getMeta('lastFullScan');
    const hostCount = db.prepare('SELECT COUNT(*) as count FROM hosts').get()?.count || 0;

    if (!lastScan || hostCount === 0) {
        console.log('[API] No existing data — starting initial full scan...');
        await fullScan();
    } else {
        const age = Date.now() - parseInt(lastScan);
        const ageHours = Math.round(age / 3600000);
        console.log(`[API] Existing data loaded — ${hostCount} hosts, last scan ${ageHours}h ago`);
        if (age > 3600000) {
            console.log('[API] Data older than 1 hour — starting background rescan...');
            fullScan();
        }
    }

    // Schedule hourly rescan
    setInterval(() => {
        console.log('[API] 6-hourly rescan triggered');
        fullScan();
    }, 6 * 3600000);
};

main().catch(e => {
    console.error('Fatal:', e.message);
    process.exit(1);
});
