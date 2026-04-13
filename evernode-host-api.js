#!/usr/bin/env node
/**
 * Evernode Host Discovery API
 *
 * Maintains a real-time cache of all Evernode host data via local Xahau node.
 * Serves filtered host queries instantly via REST API.
 *
 * Usage: node evernode-host-api.js
 */

'use strict';

const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');
const express  = require('express');

// ── Config ────────────────────────────────────────────────────
const VERSION           = '1.3.0';
const XAHAU_WS          = process.env.XAHAU_WS        || 'ws://localhost:6008';
const API_PORT          = parseInt(process.env.API_PORT || '3001');
const HEARTBEAT_ACCOUNT = 'rHktfGUbjqzU4GsYCMc1pDjdHXb5CJamto';
const XRPLWIN_API       = 'https://xahau.xrplwin.com/api/evernode/hosts';
const BATCH_SIZE        = 50;
const BATCH_DELAY_MS    = 100;
const DB_PATH           = path.join(__dirname, 'hosts.db');
const EVDEVKIT_PATH     = '/root/.nvm/versions/node/v22.16.0/lib/node_modules/evdevkit/node_modules';
const HISTORY_MAX_ROWS  = 500;

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
        description TEXT,
        uriTokenId TEXT,
        registrationLedger INTEGER,
        registrationFee INTEGER,
        isATransferer INTEGER,
        transferTimestamp INTEGER,
        supportVoteSent INTEGER,
        reputedOnHeartbeat INTEGER,
        lastVoteCandidateIdx INTEGER,
        lastVoteTimestamp INTEGER,
        lastUpdated INTEGER
    );
    CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
    );
    CREATE TABLE IF NOT EXISTS host_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        active INTEGER,
        hostReputation INTEGER,
        availableInstances INTEGER,
        activeInstances INTEGER,
        maxInstances INTEGER,
        xahBalance REAL,
        evrBalance REAL,
        leaseDrops INTEGER,
        accumulatedReward TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_host_history_address ON host_history(address);
    CREATE INDEX IF NOT EXISTS idx_host_history_timestamp ON host_history(timestamp);
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
    try { return await registryClient.getHostInfo(address); } catch { return null; }
};

// ── Upsert host to DB ─────────────────────────────────────────
const upsertHost = db.prepare(`
    INSERT OR REPLACE INTO hosts (
        address, active, domain, countryCode, maxInstances, activeInstances,
        availableInstances, leaseAmount, leaseDrops, hostReputation, version,
        cpuModelName, cpuCount, cpuMHz, cpuMicrosec, ramMb, diskMb, email,
        accumulatedReward, xahBalance, evrBalance, registrationTimestamp,
        lastHeartbeatIndex, description, uriTokenId, registrationLedger,
        registrationFee, isATransferer, transferTimestamp, supportVoteSent,
        reputedOnHeartbeat, lastVoteCandidateIdx, lastVoteTimestamp, lastUpdated
    ) VALUES (
        @address, @active, @domain, @countryCode, @maxInstances, @activeInstances,
        @availableInstances, @leaseAmount, @leaseDrops, @hostReputation, @version,
        @cpuModelName, @cpuCount, @cpuMHz, @cpuMicrosec, @ramMb, @diskMb, @email,
        @accumulatedReward, @xahBalance, @evrBalance, @registrationTimestamp,
        @lastHeartbeatIndex, @description, @uriTokenId, @registrationLedger,
        @registrationFee, @isATransferer, @transferTimestamp, @supportVoteSent,
        @reputedOnHeartbeat, @lastVoteCandidateIdx, @lastVoteTimestamp, @lastUpdated
    )
`);

const insertHistory = db.prepare(`
    INSERT INTO host_history (
        address, timestamp, active, hostReputation, availableInstances,
        activeInstances, maxInstances, xahBalance, evrBalance, leaseDrops, accumulatedReward
    ) VALUES (
        @address, @timestamp, @active, @hostReputation, @availableInstances,
        @activeInstances, @maxInstances, @xahBalance, @evrBalance, @leaseDrops, @accumulatedReward
    )
`);

const pruneHistory = db.prepare(`
    DELETE FROM host_history WHERE address = ? AND id NOT IN (
        SELECT id FROM host_history WHERE address = ? ORDER BY timestamp DESC LIMIT ?
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
    description:          info.description?.trim() || null,
    uriTokenId:           info.uriTokenId || null,
    registrationLedger:   info.registrationLedger || null,
    registrationFee:      info.registrationFee || null,
    isATransferer:        info.isATransferer ?? null,
    transferTimestamp:    info.transferTimestamp || null,
    supportVoteSent:      info.supportVoteSent ?? null,
    reputedOnHeartbeat:   info.reputedOnHeartbeat ? 1 : 0,
    lastVoteCandidateIdx: info.lastVoteCandidateIdx ?? null,
    lastVoteTimestamp:    info.lastVoteTimestamp || null,
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
        for (let i = 0; i < allAddresses.length; i += BATCH_SIZE) {
            const batch = allAddresses.slice(i, i + BATCH_SIZE);
            const infos = await Promise.all(batch.map(addr => fetchHostInfo(addr)));
            const activeInBatch = infos.filter(info => info?.active).map(info => info.address);
            const balances = activeInBatch.length > 0 ? await fetchBalances(activeInBatch) : {};
            const upsertMany = db.transaction((rows) => { rows.forEach(r => upsertHost.run(r)); });
            const rows = infos.filter(info => info !== null).map(info => hostToRow(info, balances[info.address] || { xah: 0, evr: 0 }));
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
        const existing = db.prepare('SELECT xahBalance, evrBalance FROM hosts WHERE address = ?').get(address);
        const row = hostToRow(info, { xah: existing?.xahBalance || 0, evr: existing?.evrBalance || 0 });
        upsertHost.run(row);
        insertHistory.run({
            address:            row.address,
            timestamp:          Date.now(),
            active:             row.active,
            hostReputation:     row.hostReputation,
            availableInstances: row.availableInstances,
            activeInstances:    row.activeInstances,
            maxInstances:       row.maxInstances,
            xahBalance:         row.xahBalance,
            evrBalance:         row.evrBalance,
            leaseDrops:         row.leaseDrops,
            accumulatedReward:  row.accumulatedReward
        });
        pruneHistory.run(address, address, HISTORY_MAX_ROWS);
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
        hbWs.send(JSON.stringify({ command: 'subscribe', accounts: [HEARTBEAT_ACCOUNT] }));
    });
    hbWs.on('message', (data) => {
        try {
            const r = JSON.parse(data);
            if (r.type === 'transaction' && r.transaction?.Account) updateHost(r.transaction.Account);
        } catch {}
    });
    hbWs.on('close', () => {
        console.log('[Heartbeat] Connection closed — reconnecting in 10s...');
        setTimeout(subscribeHeartbeat, 10000);
    });
    hbWs.on('error', (e) => { console.error('[Heartbeat] WebSocket error:', e.message); });
};

// ── REST API ──────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// ── Allowed sort fields ───────────────────────────────────────
const allowedSort = [
    'hostReputation','availableInstances','leaseDrops','xahBalance','evrBalance',
    'ramMb','diskMb','countryCode','version','lastHeartbeatIndex',
    'registrationTimestamp','accumulatedReward','lastUpdated'
];

// GET /hosts — filtered host list
app.get('/hosts', (req, res) => {
    const {
        active, minSlots, maxSlots, minRep, maxRep, includeUnscored,
        minXah = '5', minEvr = '5', minLease, maxLease, country, domain,
        version, minRam, minDisk, isATransferer, reputedOnHeartbeat,
        minAccumulatedReward,
        sortBy = 'hostReputation', sortDir = 'desc', limit = 100, offset = 0
    } = req.query;

    let where = [], params = [];
    if (active !== undefined)             { where.push('active = ?');                          params.push(active === 'true' || active === '1' ? 1 : 0); }
    if (minSlots !== undefined)           { where.push('availableInstances >= ?');             params.push(parseInt(minSlots)); }
    if (maxSlots !== undefined)           { where.push('availableInstances <= ?');             params.push(parseInt(maxSlots)); }
    if (minRep !== undefined) {
        if (includeUnscored === 'true' || includeUnscored === '1') {
            where.push('(hostReputation >= ? OR hostReputation = 0 OR hostReputation IS NULL)');
            params.push(parseInt(minRep));
        } else {
            where.push('hostReputation >= ?');
            params.push(parseInt(minRep));
        }
    }
    if (maxRep !== undefined)             { where.push('hostReputation <= ?');                 params.push(parseInt(maxRep)); }
    if (minXah !== undefined)             { where.push('xahBalance >= ?');                     params.push(parseFloat(minXah)); }
    if (minEvr !== undefined)             { where.push('evrBalance >= ?');                     params.push(parseFloat(minEvr)); }
    if (minLease !== undefined)           { where.push('leaseDrops >= ?');                     params.push(parseInt(minLease)); }
    if (maxLease !== undefined)           { where.push('leaseDrops <= ?');                     params.push(parseInt(maxLease)); }
    if (country !== undefined)            { where.push('countryCode = ?');                     params.push(country.toUpperCase()); }
    if (domain !== undefined)             { where.push('domain LIKE ?');                       params.push('%' + domain + '%'); }
    if (version !== undefined)            { where.push('version = ?');                         params.push(version); }
    if (minRam !== undefined)             { where.push('ramMb >= ?');                          params.push(parseInt(minRam)); }
    if (minDisk !== undefined)            { where.push('diskMb >= ?');                         params.push(parseInt(minDisk)); }
    if (isATransferer !== undefined)      { where.push('isATransferer = ?');                   params.push(parseInt(isATransferer)); }
    if (reputedOnHeartbeat !== undefined) { where.push('reputedOnHeartbeat = ?');              params.push(reputedOnHeartbeat === 'true' || reputedOnHeartbeat === '1' ? 1 : 0); }
    if (minAccumulatedReward !== undefined) { where.push('CAST(accumulatedReward AS REAL) >= ?'); params.push(parseFloat(minAccumulatedReward)); }

    const safeSort = allowedSort.includes(sortBy) ? sortBy : 'hostReputation';
    const safeDir  = sortDir === 'asc' ? 'ASC' : 'DESC';
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const sql = `SELECT * FROM hosts ${whereClause} ORDER BY ${safeSort} ${safeDir} LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    try {
        const hosts = db.prepare(sql).all(...params);
        const total = db.prepare(`SELECT COUNT(*) as count FROM hosts ${whereClause}`).get(...params.slice(0,-2))?.count || 0;
        res.json({ success: true, total, count: hosts.length, offset: parseInt(offset), hosts });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /hosts/search — full text search
app.get('/hosts/search', (req, res) => {
    const { q, active, limit = 50 } = req.query;
    if (!q || q.trim().length < 2) return res.status(400).json({ success: false, error: 'Query parameter q is required (min 2 chars)' });
    const term = '%' + q.trim() + '%';
    let where = ['(domain LIKE ? OR email LIKE ? OR description LIKE ?)'];
    let params = [term, term, term];
    if (active !== undefined) { where.push('active = ?'); params.push(active === 'true' ? 1 : 0); }
    const whereClause = 'WHERE ' + where.join(' AND ');
    const sql = `SELECT * FROM hosts ${whereClause} ORDER BY hostReputation DESC LIMIT ?`;
    params.push(Math.min(parseInt(limit) || 50, 200));
    try {
        const hosts = db.prepare(sql).all(...params);
        const total = db.prepare(`SELECT COUNT(*) as count FROM hosts ${whereClause}`).get(...params.slice(0,-1))?.count || 0;
        res.json({ success: true, query: q, total, count: hosts.length, hosts });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /hosts/expiring — hosts silent for N hours
app.get('/hosts/expiring', (req, res) => {
    const { hours = 24, limit = 50 } = req.query;
    const cutoff = Math.floor(Date.now() / 1000) - (parseInt(hours) * 3600);
    try {
        const hosts = db.prepare(`
            SELECT * FROM hosts
            WHERE active = 1 AND lastHeartbeatIndex < ?
            ORDER BY lastHeartbeatIndex ASC
            LIMIT ?
        `).all(cutoff, Math.min(parseInt(limit) || 50, 200));
        res.json({ success: true, silentSinceHours: parseInt(hours), count: hosts.length, hosts });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /hosts/compare — compare multiple hosts
app.get('/hosts/compare', (req, res) => {
    const { addresses } = req.query;
    if (!addresses) return res.status(400).json({ success: false, error: 'addresses parameter required (comma-separated)' });
    const addrs = addresses.split(',').map(a => a.trim()).filter(Boolean).slice(0, 20);
    if (!addrs.length) return res.status(400).json({ success: false, error: 'No valid addresses provided' });
    try {
        const placeholders = addrs.map(() => '?').join(',');
        const hosts = db.prepare(`SELECT * FROM hosts WHERE address IN (${placeholders})`).all(...addrs);
        const map = Object.fromEntries(hosts.map(h => [h.address, h]));
        const ordered = addrs.map(a => map[a] || { address: a, error: 'Not found' });
        res.json({ success: true, count: hosts.length, hosts: ordered });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /leaderboard — top hosts by metric
app.get('/leaderboard', (req, res) => {
    const { metric = 'hostReputation', limit = 20 } = req.query;
    const allowedMetrics = {
        hostReputation:     { col: 'hostReputation',              label: 'Top Reputation' },
        accumulatedReward:  { col: 'CAST(accumulatedReward AS REAL)', label: 'Top Earners' },
        xahBalance:         { col: 'xahBalance',                  label: 'Top XAH Balance' },
        evrBalance:         { col: 'evrBalance',                  label: 'Top EVR Balance' },
        ramMb:              { col: 'ramMb',                       label: 'Most RAM' },
        diskMb:             { col: 'diskMb',                      label: 'Most Disk' },
        availableInstances: { col: 'availableInstances',          label: 'Most Available Slots' }
    };
    const chosen = allowedMetrics[metric] || allowedMetrics.hostReputation;
    try {
        const hosts = db.prepare(`
            SELECT * FROM hosts
            WHERE active = 1 AND ${chosen.col} IS NOT NULL
            ORDER BY ${chosen.col} DESC
            LIMIT ?
        `).all(Math.min(parseInt(limit) || 20, 100));
        res.json({ success: true, metric, label: chosen.label, count: hosts.length, hosts });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /hosts/batch — bulk address lookup
app.post('/hosts/batch', (req, res) => {
    const { addresses } = req.body;
    if (!Array.isArray(addresses) || !addresses.length) {
        return res.status(400).json({ success: false, error: 'Body must contain addresses array' });
    }
    const addrs = addresses.map(a => String(a).trim()).filter(Boolean).slice(0, 100);
    try {
        const placeholders = addrs.map(() => '?').join(',');
        const hosts = db.prepare(`SELECT * FROM hosts WHERE address IN (${placeholders})`).all(...addrs);
        const map = Object.fromEntries(hosts.map(h => [h.address, h]));
        const results = addrs.map(a => map[a] || { address: a, found: false });
        res.json({ success: true, requested: addrs.length, found: hosts.length, hosts: results });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /hosts/:address/history — heartbeat history
app.get('/hosts/:address/history', (req, res) => {
    const { address } = req.params;
    const { limit = 100 } = req.query;
    try {
        const host = db.prepare('SELECT address, domain, active FROM hosts WHERE address = ?').get(address);
        if (!host) return res.status(404).json({ success: false, error: 'Host not found' });
        const history = db.prepare(`
            SELECT * FROM host_history WHERE address = ?
            ORDER BY timestamp DESC LIMIT ?
        `).all(address, Math.min(parseInt(limit) || 100, 500));
        res.json({ success: true, address, domain: host.domain, count: history.length, history });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /hosts/random — random sample
app.get('/hosts/random', (req, res) => {
    const { count = 10, minRep, minSlots, country, domain, active = 'true' } = req.query;
    const limit = Math.min(parseInt(count) || 10, 200);
    let where = [], params = [];
    if (active !== undefined)   { where.push('active = ?');               params.push(active === 'true' ? 1 : 0); }
    if (minRep !== undefined)   { where.push('hostReputation >= ?');       params.push(parseInt(minRep)); }
    if (minSlots !== undefined) { where.push('availableInstances >= ?');   params.push(parseInt(minSlots)); }
    if (country !== undefined)  { where.push('countryCode = ?');           params.push(country.toUpperCase()); }
    if (domain !== undefined)   { where.push('domain LIKE ?');             params.push('%' + domain + '%'); }
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const sql = `SELECT * FROM hosts ${whereClause} ORDER BY RANDOM() LIMIT ?`;
    params.push(limit);
    try {
        const hosts = db.prepare(sql).all(...params);
        res.json({ success: true, count: hosts.length, hosts });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /hosts/:address — single host
app.get('/hosts/:address', (req, res) => {
    const host = db.prepare('SELECT * FROM hosts WHERE address = ?').get(req.params.address);
    if (!host) return res.status(404).json({ success: false, error: 'Host not found' });
    res.json({ success: true, host });
});

// GET /versions
app.get('/versions', (req, res) => {
    const versions = db.prepare(`
        SELECT version, COUNT(*) as count FROM hosts
        WHERE version IS NOT NULL AND active = 1
        GROUP BY version ORDER BY count DESC
    `).all();
    res.json({ success: true, versions });
});

// GET /countries
app.get('/countries', (req, res) => {
    const countries = db.prepare(`
        SELECT countryCode,
            COUNT(*) as total,
            SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) as active,
            SUM(CASE WHEN active=1 THEN availableInstances ELSE 0 END) as availableSlots
        FROM hosts WHERE countryCode IS NOT NULL
        GROUP BY countryCode ORDER BY total DESC
    `).all();
    res.json({ success: true, countries });
});

// GET /stats
app.get('/stats', (req, res) => {
    const stats = db.prepare(`
        SELECT
            COUNT(*) as totalHosts,
            SUM(active) as activeHosts,
            SUM(CASE WHEN active=1 THEN maxInstances END) as totalInstances,
            SUM(CASE WHEN active=1 THEN activeInstances END) as activeInstances,
            SUM(CASE WHEN active=1 THEN availableInstances END) as totalAvailableInstances,
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
        SELECT countryCode, COUNT(*) as count FROM hosts
        WHERE active=1 AND countryCode IS NOT NULL
        GROUP BY countryCode ORDER BY count DESC LIMIT 10
    `).all();
    const versions = db.prepare(`
        SELECT version, COUNT(*) as count FROM hosts
        WHERE active=1 AND version IS NOT NULL
        GROUP BY version ORDER BY count DESC
    `).all();
    res.json({ success: true, lastFullScan: getMeta('lastFullScan'), lastUpdated: Date.now(), stats, topCountries: countries, versions });
});

// POST /scan
app.post('/scan', (req, res) => {
    if (scanInProgress) return res.json({ success: false, message: 'Scan already in progress' });
    res.json({ success: true, message: 'Scan started' });
    fullScan();
});

// GET /health
app.get('/health', (req, res) => {
    const hostCount = db.prepare('SELECT COUNT(*) as count FROM hosts').get()?.count || 0;
    const activeCount = db.prepare('SELECT COUNT(*) as count FROM hosts WHERE active=1').get()?.count || 0;
    const historyCount = db.prepare('SELECT COUNT(*) as count FROM host_history').get()?.count || 0;
    res.json({ success: true, status: 'ok', version: VERSION, hostCount, activeCount, historyCount, lastFullScan: getMeta('lastFullScan'), scanInProgress });
});

// ── Startup ───────────────────────────────────────────────────
const main = async () => {
    console.log('╔════════════════════════════════════════╗');
    console.log('║   Evernode Host Discovery API          ║');
    console.log('╚════════════════════════════════════════╝');
    console.log(`  Version    : ${VERSION}`);
    console.log(`  Xahau node : ${XAHAU_WS}`);
    console.log(`  API port   : ${API_PORT}`);
    console.log(`  Database   : ${DB_PATH}`);
    console.log('');
    await initEvernode();
    app.listen(API_PORT, () => { console.log(`[API] Listening on http://localhost:${API_PORT}`); });
    subscribeHeartbeat();
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
    setInterval(() => { console.log('[API] 6-hourly rescan triggered'); fullScan(); }, 6 * 3600000);
};

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
