const { app, BrowserWindow, ipcMain, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
let DatabaseSync = null;
try {
    ({ DatabaseSync } = require('node:sqlite'));
} catch {
    DatabaseSync = null;
}

// --- ОПРЕДЕЛЕНИЕ ПУТЕЙ ---
const isDev = !app.isPackaged;
const folderPath = isDev 
    ? __dirname 
    : (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath));
const electronProfilePath = path.join(folderPath, 'electron_profile');
fs.mkdirSync(electronProfilePath, { recursive: true });
app.setPath('userData', electronProfilePath);

const dbPath = path.join(folderPath, 'history_database.json');
const trashPath = path.join(folderPath, 'trash_database.json'); // Исправлено для надежности
const splitPath = path.join(folderPath, 'split_payments.json');
const logPath = path.join(folderPath, 'daily_log.txt');
const historyClearMarkerPath = path.join(folderPath, 'history_clear_marker.json');
const networkConfigPath = path.join(folderPath, 'network_config.json');
const authAccountsPath = path.join(folderPath, 'auth_accounts.json');
const ratesSettingsPath = path.join(folderPath, 'rates_settings.json');
const networkPeersPath = path.join(folderPath, 'network_peers.json');
const sqlitePath = path.join(folderPath, 'fx_database.sqlite');
const shiftArchivePath = path.join(folderPath, 'shift_archive.json');
const APP_UPDATE_FILES = ['index.html', 'main.js', 'package.json', 'package-lock.json', 'start_fx.bat', 'publish_github.bat'];
const APP_VERSION = require('./package.json').version || '1.0.0';
const DEFAULT_RATES = { RUB: 3.7, USD: 320, EUR: 360 };

let sqliteDb = null;
let sqliteReady = false;

function parseRuDateTime(date = '', time = '') {
    const dateMatch = String(date || '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (!dateMatch) return 0;
    const timeMatch = String(time || '').match(/^(\d{1,2}):(\d{1,2})/);
    const day = Number(dateMatch[1]);
    const month = Number(dateMatch[2]) - 1;
    const year = Number(dateMatch[3]);
    const hour = timeMatch ? Number(timeMatch[1]) : 0;
    const minute = timeMatch ? Number(timeMatch[2]) : 0;
    const value = new Date(year, month, day, hour, minute).getTime();
    return Number.isFinite(value) ? value : 0;
}

function newestSortValue(item) {
    if (!item || typeof item !== 'object') return 0;
    const id = Number(item.id);
    if (Number.isFinite(id) && id > 0) return id;
    const createdAt = Date.parse(item.createdAt || item.updatedAt || '');
    if (Number.isFinite(createdAt)) return createdAt;
    return parseRuDateTime(item.date, item.time || item.deletedAt);
}

function sortNewestFirst(value) {
    if (!Array.isArray(value)) return value;
    return [...value].sort((a, b) => newestSortValue(b) - newestSortValue(a));
}

function readJson(filePath) {
    try {
        if (sqliteReady) {
            if (filePath === dbPath) return dbAllItems('bills');
            if (filePath === trashPath) return dbAllItems('trash');
            if (filePath === splitPath) return dbAllItems('bills').filter(item => item.isSplit);
        }
        if (!fs.existsSync(filePath)) return [];
        return sortNewestFirst(JSON.parse(fs.readFileSync(filePath, 'utf-8') || '[]'));
    } catch (err) {
        console.error(`[JSON] Cannot read ${filePath}:`, err);
        return [];
    }
}

function writeJson(filePath, data) {
    if (sqliteReady) {
        if (filePath === dbPath) {
            dbReplaceItems('bills', Array.isArray(data) ? data : []);
            writeJsonFile(filePath, Array.isArray(data) ? data : []);
            return;
        }
        if (filePath === trashPath) {
            dbReplaceItems('trash', Array.isArray(data) ? data : []);
            writeJsonFile(filePath, Array.isArray(data) ? data : []);
            return;
        }
        if (filePath === splitPath) {
            writeJsonFile(filePath, Array.isArray(data) ? data : []);
            return;
        }
    }
    writeJsonFile(filePath, data);
}

function writeJsonFile(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(sortNewestFirst(data), null, 2));
}

function readJsonObjectFile(filePath, fallback = {}) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8') || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function writeJsonObjectFile(filePath, data, fallback = {}) {
    const value = data && typeof data === 'object' && !Array.isArray(data) ? data : fallback;
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function normalizeRates(value = {}) {
    const normalized = {};
    Object.entries(DEFAULT_RATES).forEach(([code, fallback]) => {
        const num = Number(value?.[code]);
        normalized[code] = Number.isFinite(num) && num > 0 ? num : fallback;
    });
    return normalized;
}

function readRatesSettings() {
    const rates = normalizeRates(readJsonObjectFile(ratesSettingsPath, DEFAULT_RATES));
    if (!fs.existsSync(ratesSettingsPath)) writeJsonObjectFile(ratesSettingsPath, rates, DEFAULT_RATES);
    return rates;
}

function writeRatesSettings(value) {
    const rates = normalizeRates(value);
    writeJsonObjectFile(ratesSettingsPath, rates, DEFAULT_RATES);
    return rates;
}

function readNetworkPeers() {
    const peers = readJsonObjectFile(networkPeersPath, { hosts: [] });
    const hosts = Array.isArray(peers.hosts) ? peers.hosts : [];
    return { hosts: hosts.map(host => String(host || '').trim()).filter(Boolean) };
}

function rememberNetworkPeer(host) {
    const cleanHost = String(host || '').trim();
    if (!cleanHost) return readNetworkPeers();
    const peers = readNetworkPeers();
    peers.hosts = [cleanHost, ...peers.hosts.filter(item => item !== cleanHost)].slice(0, 12);
    writeJsonObjectFile(networkPeersPath, peers, { hosts: [] });
    return peers;
}

function remoteHostFromRequest(req) {
    let host = String(req?.socket?.remoteAddress || '').trim();
    if (host.startsWith('::ffff:')) host = host.slice(7);
    if (!host || host === '::1' || host === '127.0.0.1') return '';
    return host;
}

function rememberPeerFromRequest(req) {
    const host = remoteHostFromRequest(req);
    if (host && !localIPv4Addresses().includes(host)) rememberNetworkPeer(host);
    return host;
}

function normalizeAuthStore(store = {}) {
    const normalizeGroup = (group, role) => {
        const result = {};
        Object.entries(group || {}).forEach(([rawId, account]) => {
            const id = String(account?.id || rawId || '').trim();
            const name = String(account?.name || '').trim();
            const passwordHash = String(account?.passwordHash || '').trim();
            if (!id || !name || !passwordHash) return;
            result[id] = { id, name, role, passwordHash };
        });
        return result;
    };

    return {
        admins: normalizeGroup(store.admins, 'admin'),
        cashiers: normalizeGroup(store.cashiers, 'cashier')
    };
}

function readAuthStore() {
    const store = normalizeAuthStore(readJsonObjectFile(authAccountsPath, {}));
    if (!fs.existsSync(authAccountsPath)) {
        writeJsonObjectFile(authAccountsPath, store, { admins: {}, cashiers: {} });
    }
    return store;
}

function writeAuthStore(store) {
    const normalized = normalizeAuthStore(store);
    writeJsonObjectFile(authAccountsPath, normalized, { admins: {}, cashiers: {} });
    return normalized;
}

function saveAuthAccount(payload = {}) {
    const role = payload?.role === 'cashier' ? 'cashier' : 'admin';
    const bucket = role === 'cashier' ? 'cashiers' : 'admins';
    const id = String(payload?.id || payload?.account?.id || '').trim();
    const incoming = normalizeAuthStore({
        admins: role === 'admin' ? { [id]: payload?.account || {} } : {},
        cashiers: role === 'cashier' ? { [id]: payload?.account || {} } : {}
    });
    const account = incoming[bucket][id];

    if (!id || !account?.passwordHash || !account?.name) {
        return { ok: false, error: 'Недостаточно данных для сохранения аккаунта', store: readAuthStore() };
    }

    const store = readAuthStore();
    const existing = store[bucket][id];
    if (existing?.passwordHash && !payload?.overwrite) {
        return { ok: false, error: 'Этот слот уже зарегистрирован на главном ПК', store };
    }

    store[bucket][id] = account;
    return { ok: true, store: writeAuthStore(store), account };
}

function deleteAuthAccount(payload = {}) {
    const role = payload?.role === 'cashier' ? 'cashier' : 'admin';
    const bucket = role === 'cashier' ? 'cashiers' : 'admins';
    const id = String(payload?.id || '').trim();

    if (!id) {
        return { ok: false, error: 'Не указан слот аккаунта', store: readAuthStore() };
    }

    const store = readAuthStore();
    if (!store[bucket][id]?.passwordHash) {
        return { ok: false, error: 'Аккаунт не найден', store };
    }

    delete store[bucket][id];
    return { ok: true, store: writeAuthStore(store), deletedId: id };
}

function mergeAuthStore(payload = {}) {
    const current = readAuthStore();
    const incoming = normalizeAuthStore(payload);
    let changed = false;

    ['admins', 'cashiers'].forEach(bucket => {
        Object.entries(incoming[bucket] || {}).forEach(([id, account]) => {
            if (!current[bucket][id]?.passwordHash) {
                current[bucket][id] = account;
                changed = true;
            }
        });
    });

    return { ok: true, merged: changed, store: changed ? writeAuthStore(current) : current };
}

function upsertById(list, item) {
    const id = Number(item.id);
    return sortNewestFirst([item, ...list.filter(entry => Number(entry.id) !== id)]);
}

function hashFile(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function buildUpdateManifest() {
    const files = APP_UPDATE_FILES
        .map(fileName => {
            const filePath = path.join(folderPath, fileName);
            if (!fs.existsSync(filePath)) return null;
            const stat = fs.statSync(filePath);
            return {
                name: fileName,
                size: stat.size,
                mtimeMs: Math.round(stat.mtimeMs),
                hash: hashFile(filePath)
            };
        })
        .filter(Boolean);
    const fingerprint = crypto
        .createHash('sha256')
        .update(JSON.stringify(files.map(file => ({ name: file.name, hash: file.hash }))))
        .digest('hex');
    return {
        app: 'FX_App',
        version: APP_VERSION,
        fingerprint,
        files,
        generatedAt: new Date().toISOString()
    };
}

function compareAppVersions(a = '0.0.0', b = '0.0.0') {
    const left = String(a || '0.0.0').split('.').map(part => Number(part) || 0);
    const right = String(b || '0.0.0').split('.').map(part => Number(part) || 0);
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i += 1) {
        const diff = (left[i] || 0) - (right[i] || 0);
        if (diff > 0) return 1;
        if (diff < 0) return -1;
    }
    return 0;
}

function buildUpdateCheckResult(local, remote, sourceName) {
    const versionCompare = compareAppVersions(remote?.version, local?.version);
    if (versionCompare < 0) {
        return {
            ok: true,
            updateAvailable: false,
            local,
            remote,
            message: `У вас новая версия. В ${sourceName} лежит старая версия ${remote?.version || 'unknown'}`
        };
    }

    if (versionCompare > 0) {
        return {
            ok: true,
            updateAvailable: true,
            local,
            remote,
            message: `В ${sourceName} есть новая версия ${remote?.version || ''}`.trim()
        };
    }

    const updateAvailable = local.fingerprint !== remote.fingerprint;
    return {
        ok: true,
        updateAvailable,
        local,
        remote,
        message: updateAvailable
            ? `В ${sourceName} есть изменения в той же версии`
            : `Версия совпадает с ${sourceName}`
    };
}

function isSameAppManifest(manifest, reference = buildUpdateManifest()) {
    return Boolean(manifest)
        && manifest.app === reference.app
        && String(manifest.fingerprint || '') === String(reference.fingerprint || '');
}

function buildUpdatePackage() {
    const manifest = buildUpdateManifest();
    const files = manifest.files.map(file => ({
        ...file,
        data: fs.readFileSync(path.join(folderPath, file.name)).toString('base64')
    }));
    return { ok: true, manifest, files };
}

async function checkAppUpdateFromHost(configInput = readNetworkConfig()) {
    const config = normalizeNetworkConfig(configInput);
    const local = buildUpdateManifest();
    if (config.updateSource === 'github') {
        return checkAppUpdateFromGithub(config, local);
    }
    if (config.mode !== 'client' || !config.host) {
        return {
            ok: true,
            updateAvailable: false,
            message: 'Обновление проверяется на втором ПК после подключения к главному ПК',
            local
        };
    }

    const remote = await requestJson('GET', `${hostBaseUrl(config)}/fx/update-manifest`, undefined, 3000);
    if (!remote?.ok || !remote.manifest) {
        return { ok: false, message: remote?.error || 'Главный ПК не отдал версию приложения', local };
    }

    return buildUpdateCheckResult(local, remote.manifest, 'главном ПК');
}

function githubRawConfig(config = readNetworkConfig()) {
    const owner = String(config.githubOwner || '').trim();
    const repo = String(config.githubRepo || '').trim();
    const branch = String(config.githubBranch || 'main').trim() || 'main';
    if (!owner || !repo) {
        throw new Error('Укажите GitHub owner и repo в настройках подключения');
    }
    return { owner, repo, branch };
}

function githubRawFileUrl(config, fileName) {
    const github = githubRawConfig(config);
    return `https://raw.githubusercontent.com/${encodeURIComponent(github.owner)}/${encodeURIComponent(github.repo)}/${encodeURIComponent(github.branch)}/${encodeURIComponent(fileName)}?t=${Date.now()}`;
}

function requestBuffer(method, urlString, payload, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request({
            method,
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: `${url.pathname}${url.search}`,
            timeout: timeoutMs,
            headers: {
                'User-Agent': 'FX_App updater',
                ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {})
            }
        }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                requestBuffer(method, new URL(res.headers.location, urlString).toString(), payload, timeoutMs)
                    .then(resolve, reject);
                return;
            }

            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const bytes = Buffer.concat(chunks);
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(bytes);
                } else {
                    reject(new Error(`GitHub HTTP ${res.statusCode}: ${bytes.toString('utf8').slice(0, 140)}`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(new Error('Нет ответа от GitHub'));
        });
        if (body) req.write(body);
        req.end();
    });
}

function buildManifestFromDownloadedFiles(files) {
    const safeFiles = files.map(file => ({
        name: file.name,
        size: file.bytes.length,
        mtimeMs: 0,
        hash: crypto.createHash('sha256').update(file.bytes).digest('hex')
    }));
    let version = APP_VERSION;
    try {
        const packageFile = files.find(file => file.name === 'package.json');
        if (packageFile) version = JSON.parse(packageFile.bytes.toString('utf8')).version || version;
    } catch {}
    const fingerprint = crypto
        .createHash('sha256')
        .update(JSON.stringify(safeFiles.map(file => ({ name: file.name, hash: file.hash }))))
        .digest('hex');
    return {
        app: 'FX_App',
        version,
        fingerprint,
        files: safeFiles,
        generatedAt: new Date().toISOString()
    };
}

async function buildGithubUpdatePackage(config = readNetworkConfig()) {
    const downloaded = [];
    for (const fileName of APP_UPDATE_FILES) {
        const bytes = await requestBuffer('GET', githubRawFileUrl(config, fileName), undefined, 12000);
        downloaded.push({ name: fileName, bytes });
    }
    const manifest = buildManifestFromDownloadedFiles(downloaded);
    const fileMeta = new Map(manifest.files.map(file => [file.name, file]));
    return {
        ok: true,
        source: 'github',
        manifest,
        files: downloaded.map(file => ({
            ...fileMeta.get(file.name),
            data: file.bytes.toString('base64')
        }))
    };
}

async function checkAppUpdateFromGithub(config = readNetworkConfig(), local = buildUpdateManifest()) {
    const updatePackage = await buildGithubUpdatePackage(config);
    return {
        ...buildUpdateCheckResult(local, updatePackage.manifest, 'GitHub'),
        source: 'github'
    };
}

function backupCurrentAppFiles() {
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const backupDir = path.join(folderPath, `app_backup_${stamp}`);
    fs.mkdirSync(backupDir, { recursive: true });
    APP_UPDATE_FILES.forEach(fileName => {
        const source = path.join(folderPath, fileName);
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(backupDir, fileName));
    });
    return backupDir;
}

function installDownloadedUpdatePackage(updatePackage) {
    if (!updatePackage?.ok || !Array.isArray(updatePackage.files) || !updatePackage.manifest) {
        const sourceName = updatePackage?.source === 'github' ? 'GitHub' : 'Главный ПК';
        return { ok: false, error: updatePackage?.error || `${sourceName} не отдал файлы обновления` };
    }
    if (compareAppVersions(updatePackage.manifest.version, APP_VERSION) < 0) {
        return {
            ok: false,
            error: `У вас новая версия ${APP_VERSION}. Нельзя установить старую версию ${updatePackage.manifest.version || 'unknown'}`
        };
    }

    const allowed = new Set(APP_UPDATE_FILES);
    const backupDir = backupCurrentAppFiles();
    const written = [];

    updatePackage.files.forEach(file => {
        if (!allowed.has(file.name)) throw new Error(`Файл не разрешен для обновления: ${file.name}`);
        const target = path.join(folderPath, file.name);
        const temp = path.join(folderPath, `${file.name}.download`);
        const bytes = Buffer.from(file.data || '', 'base64');
        const receivedHash = crypto.createHash('sha256').update(bytes).digest('hex');
        if (receivedHash !== file.hash) throw new Error(`Проверка файла не прошла: ${file.name}`);
        fs.writeFileSync(temp, bytes);
        fs.copyFileSync(temp, target);
        fs.unlinkSync(temp);
        written.push(file.name);
    });

    return {
        ok: true,
        updatedFiles: written,
        backupDir,
        restartRequired: true,
        manifest: updatePackage.manifest
    };
}

async function installAppUpdateFromHost(configInput = readNetworkConfig()) {
    const config = normalizeNetworkConfig(configInput);
    if (config.updateSource === 'github') {
        return installDownloadedUpdatePackage(await buildGithubUpdatePackage(config));
    }
    if (config.mode !== 'client' || !config.host) {
        return { ok: false, error: 'Обновление доступно только на втором ПК, подключенном к главному ПК' };
    }

    const updatePackage = await requestJson('POST', `${hostBaseUrl(config)}/fx/update-package`, {}, 10000);
    return installDownloadedUpdatePackage(updatePackage);
}

function itemStatus(item) {
    return String(item?.status || '');
}

function dbTableFor(kind) {
    if (!['bills', 'tips', 'trash'].includes(kind)) throw new Error(`Unknown table: ${kind}`);
    return kind;
}

function dbItemFromRow(row) {
    if (!row?.data) return null;
    try {
        return JSON.parse(row.data);
    } catch {
        return null;
    }
}

function dbAllItems(kind) {
    if (!sqliteReady || !sqliteDb) return [];
    const table = dbTableFor(kind);
    return sqliteDb.prepare(`SELECT data FROM ${table} ORDER BY id DESC`)
        .all()
        .map(dbItemFromRow)
        .filter(Boolean);
}

function dbUpsertItem(kind, item) {
    if (!sqliteReady || !sqliteDb || !item) return;
    const table = dbTableFor(kind);
    const id = Number(item.id) || Date.now();
    const data = JSON.stringify({ ...item, id });
    sqliteDb.prepare(`
        INSERT INTO ${table} (id, user, status, date, time, billAmd, curr, amount, data, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            user=excluded.user,
            status=excluded.status,
            date=excluded.date,
            time=excluded.time,
            billAmd=excluded.billAmd,
            curr=excluded.curr,
            amount=excluded.amount,
            data=excluded.data,
            updatedAt=excluded.updatedAt
    `).run(
        id,
        String(item.user || ''),
        itemStatus(item),
        String(item.date || ''),
        String(item.time || ''),
        Number(item.billAmd) || 0,
        String(item.payCurr || item.curr || item.changeCurr || ''),
        Number(item.payVal || item.val || item.changeVal || 0),
        data,
        Date.now()
    );
}

function dbReplaceItems(kind, items) {
    if (!sqliteReady || !sqliteDb) return;
    const table = dbTableFor(kind);
    const rows = Array.isArray(items) ? items : [];
    try {
        sqliteDb.exec('BEGIN IMMEDIATE');
        sqliteDb.prepare(`DELETE FROM ${table}`).run();
        rows.forEach(item => dbUpsertItem(kind, item));
        sqliteDb.exec('COMMIT');
    } catch (err) {
        try { sqliteDb.exec('ROLLBACK'); } catch {}
        throw err;
    }
}

function dbDeleteItem(kind, id) {
    if (!sqliteReady || !sqliteDb) return;
    const table = dbTableFor(kind);
    sqliteDb.prepare(`DELETE FROM ${table} WHERE id = ?`).run(Number(id));
}

function dbActiveItems(kind, user = '') {
    return dbAllItems(kind).filter(item => {
        if (user && String(item.user || '') !== String(user)) return false;
        if (isDeletedOrClosed(item)) return false;
        return true;
    });
}

function dbUpsertShift(shift) {
    if (!sqliteReady || !sqliteDb || !shift) return;
    const id = Number(shift.id) || Date.now();
    const data = JSON.stringify({ ...shift, id });
    sqliteDb.prepare(`
        INSERT INTO shifts (id, title, users, date, time, weekKey, data, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            title=excluded.title,
            users=excluded.users,
            date=excluded.date,
            time=excluded.time,
            weekKey=excluded.weekKey,
            data=excluded.data,
            updatedAt=excluded.updatedAt
    `).run(
        id,
        String(shift.title || ''),
        String(shift.users || shift.operator || ''),
        String(shift.date || ''),
        String(shift.time || ''),
        String(shift.weekKey || ''),
        data,
        Date.now()
    );
}

function dbAllShifts() {
    if (!sqliteReady || !sqliteDb) return [];
    return sqliteDb.prepare('SELECT data FROM shifts ORDER BY id DESC')
        .all()
        .map(dbItemFromRow)
        .filter(Boolean);
}

function dbDeleteShiftsForWeek(weekKey) {
    if (!sqliteReady || !sqliteDb || !weekKey) return 0;
    const result = sqliteDb.prepare('DELETE FROM shifts WHERE weekKey = ?').run(String(weekKey));
    return Number(result.changes) || 0;
}

function dbReplaceShifts(shifts) {
    if (!sqliteReady || !sqliteDb) return;
    const rows = Array.isArray(shifts) ? shifts : [];
    try {
        sqliteDb.exec('BEGIN IMMEDIATE');
        sqliteDb.prepare('DELETE FROM shifts').run();
        rows.forEach(shift => dbUpsertShift(shift));
        sqliteDb.exec('COMMIT');
    } catch (err) {
        try { sqliteDb.exec('ROLLBACK'); } catch {}
        throw err;
    }
}

function readJsonFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return [];
        return sortNewestFirst(JSON.parse(fs.readFileSync(filePath, 'utf-8') || '[]'));
    } catch {
        return [];
    }
}

function initSqliteDatabase() {
    if (!DatabaseSync) return;
    try {
        sqliteDb = new DatabaseSync(sqlitePath);
        sqliteDb.exec(`
            CREATE TABLE IF NOT EXISTS bills (
                id INTEGER PRIMARY KEY,
                user TEXT,
                status TEXT,
                date TEXT,
                time TEXT,
                billAmd REAL,
                curr TEXT,
                amount REAL,
                data TEXT NOT NULL,
                updatedAt INTEGER
            );
            CREATE TABLE IF NOT EXISTS tips (
                id INTEGER PRIMARY KEY,
                user TEXT,
                status TEXT,
                date TEXT,
                time TEXT,
                billAmd REAL,
                curr TEXT,
                amount REAL,
                data TEXT NOT NULL,
                updatedAt INTEGER
            );
            CREATE TABLE IF NOT EXISTS trash (
                id INTEGER PRIMARY KEY,
                user TEXT,
                status TEXT,
                date TEXT,
                time TEXT,
                billAmd REAL,
                curr TEXT,
                amount REAL,
                data TEXT NOT NULL,
                updatedAt INTEGER
            );
            CREATE TABLE IF NOT EXISTS shifts (
                id INTEGER PRIMARY KEY,
                title TEXT,
                users TEXT,
                date TEXT,
                time TEXT,
                weekKey TEXT,
                data TEXT NOT NULL,
                updatedAt INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_bills_user ON bills(user);
            CREATE INDEX IF NOT EXISTS idx_bills_status ON bills(status);
            CREATE INDEX IF NOT EXISTS idx_tips_user ON tips(user);
            CREATE INDEX IF NOT EXISTS idx_trash_user ON trash(user);
            CREATE INDEX IF NOT EXISTS idx_shifts_week ON shifts(weekKey);
        `);
        sqliteReady = true;
        migrateJsonToSqlite();
    } catch (err) {
        sqliteReady = false;
        sqliteDb = null;
        console.error('[SQLITE] Cannot initialize database:', err);
    }
}

function migrateJsonToSqlite() {
    if (!sqliteReady) return;
    const billFiles = fs.readdirSync(folderPath).filter(fileName => fileName.endsWith('_bills.json'));
    const tipFiles = fs.readdirSync(folderPath).filter(fileName => fileName.endsWith('_tips.json'));

    readJsonFile(dbPath).forEach(item => dbUpsertItem('bills', item));
    readJsonFile(trashPath).forEach(item => dbUpsertItem('trash', item));
    readJsonFile(splitPath).forEach(item => dbUpsertItem('bills', { ...item, isSplit: true }));
    billFiles.forEach(fileName => readJsonFile(path.join(folderPath, fileName)).forEach(item => dbUpsertItem('bills', item)));
    tipFiles.forEach(fileName => readJsonFile(path.join(folderPath, fileName)).forEach(item => dbUpsertItem('tips', item)));
}

const DEFAULT_NETWORK_CONFIG = {
    mode: 'local',
    host: '',
    port: 9260,
    updateSource: 'lan',
    githubOwner: '',
    githubRepo: '',
    githubBranch: 'main'
};

let networkServer = null;
let networkServerPort = null;
let networkServerError = '';
const emergencyCloseSeen = new Set();

function normalizeNetworkConfig(config = {}) {
    const rawMode = String(config.mode || DEFAULT_NETWORK_CONFIG.mode);
    const mode = ['local', 'host', 'client'].includes(rawMode) ? rawMode : DEFAULT_NETWORK_CONFIG.mode;
    const rawUpdateSource = String(config.updateSource || DEFAULT_NETWORK_CONFIG.updateSource);
    const updateSource = ['lan', 'github'].includes(rawUpdateSource) ? rawUpdateSource : DEFAULT_NETWORK_CONFIG.updateSource;
    const host = String(config.host || '').trim();
    const rawPort = Number(config.port || DEFAULT_NETWORK_CONFIG.port);
    const port = Number.isFinite(rawPort) && rawPort > 0 && rawPort < 65536
        ? Math.round(rawPort)
        : DEFAULT_NETWORK_CONFIG.port;
    const githubOwner = String(config.githubOwner || '').trim();
    const githubRepo = String(config.githubRepo || '').trim();
    const githubBranch = String(config.githubBranch || DEFAULT_NETWORK_CONFIG.githubBranch).trim() || DEFAULT_NETWORK_CONFIG.githubBranch;
    return { mode, host, port, updateSource, githubOwner, githubRepo, githubBranch };
}

function readNetworkConfig() {
    const stored = readJson(networkConfigPath);
    return normalizeNetworkConfig(Array.isArray(stored) ? {} : stored);
}

function writeNetworkConfig(config) {
    const normalized = normalizeNetworkConfig(config);
    writeJson(networkConfigPath, normalized);
    return normalized;
}

function localIPv4Addresses() {
    return Object.values(os.networkInterfaces())
        .flat()
        .filter(info => info && info.family === 'IPv4' && !info.internal)
        .map(info => info.address);
}

function networkStatus(config = readNetworkConfig()) {
    const ips = localIPv4Addresses();
    return {
        config,
        serverRunning: Boolean(networkServer),
        serverError: networkServerError,
        ips,
        urls: ips.map(ip => `http://${ip}:${config.port}`)
    };
}

function hostBaseUrl(config = readNetworkConfig()) {
    const host = String(config.host || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return `http://${host}:${config.port}`;
}

function requestJson(method, urlString, payload, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const body = payload === undefined ? null : JSON.stringify(payload);
        const req = http.request({
            method,
            hostname: url.hostname,
            port: url.port,
            path: `${url.pathname}${url.search}`,
            timeout: timeoutMs,
            headers: {
                'Content-Type': 'application/json',
                ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
            }
        }, res => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = data ? JSON.parse(data) : {};
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsed);
                    } else {
                        reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
                    }
                } catch (err) {
                    reject(err);
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(new Error('Нет ответа от главного ПК'));
        });
        if (body) req.write(body);
        req.end();
    });
}

function shouldUseRemote(channel) {
    if (['get-network-config', 'save-network-config', 'test-network-connection', 'find-network-hosts', 'print-shift-report', 'check-app-update', 'install-app-update', 'restart-app', 'get-app-manifest'].includes(channel)) {
        return false;
    }
    const config = readNetworkConfig();
    return config.mode === 'client' && Boolean(config.host);
}

async function invokeRemote(channel, payload) {
    const config = readNetworkConfig();
    const response = await requestJson('POST', `${hostBaseUrl(config)}/fx/ipc`, {
        channel,
        payload,
        clientManifest: buildUpdateManifest()
    }, 5000);
    if (!response || response.ok === false) {
        throw new Error(response?.error || 'Главный ПК не ответил');
    }
    return response.result;
}

function sendJson(res, statusCode, data) {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    res.end(body);
}

function readRequestJson(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 1024 * 1024) req.destroy(new Error('Слишком большой запрос'));
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

async function handleNetworkRequest(req, res) {
    rememberPeerFromRequest(req);

    if (req.method === 'OPTIONS') {
        sendJson(res, 200, { ok: true });
        return;
    }

    if (req.method === 'GET' && req.url === '/fx/status') {
        const config = readNetworkConfig();
        sendJson(res, 200, {
            ok: true,
            name: 'FX_App',
            version: APP_VERSION,
            manifest: buildUpdateManifest(),
            role: config.mode,
            status: networkStatus()
        });
        return;
    }

    if (req.method === 'GET' && req.url === '/fx/update-manifest') {
        sendJson(res, 200, { ok: true, manifest: buildUpdateManifest() });
        return;
    }

    if (req.method === 'POST' && req.url === '/fx/register-peer') {
        try {
            const body = await readRequestJson(req);
            const host = remoteHostFromRequest(req) || String(body.host || '').trim();
            if (host) rememberNetworkPeer(host);
            sendJson(res, 200, { ok: true, host, peers: readNetworkPeers() });
        } catch (err) {
            sendJson(res, 500, { ok: false, error: err.message || String(err) });
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/fx/update-package') {
        try {
            if (readNetworkConfig().mode !== 'host') {
                sendJson(res, 403, { ok: false, error: 'Обновление можно скачать только с главного ПК' });
                return;
            }
            sendJson(res, 200, buildUpdatePackage());
        } catch (err) {
            sendJson(res, 500, { ok: false, error: err.message || String(err) });
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/fx/emergency-close') {
        try {
            const body = await readRequestJson(req);
            const result = await emergencyCloseAll(body);
            sendJson(res, 200, result);
        } catch (err) {
            sendJson(res, 500, { ok: false, error: err.message || String(err) });
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/fx/ipc') {
        try {
            if (readNetworkConfig().mode !== 'host') {
                sendJson(res, 403, { ok: false, error: 'Этот ПК не выбран как главный' });
                return;
            }
            const body = await readRequestJson(req);
            const hostManifest = buildUpdateManifest();
            if (!isSameAppManifest(body.clientManifest, hostManifest)) {
                sendJson(res, 426, {
                    ok: false,
                    updateRequired: true,
                    error: 'Версия второго ПК устарела. Обновите приложение с главного ПК.',
                    local: body.clientManifest || null,
                    remote: hostManifest
                });
                return;
            }
            const result = await handleLocalChannel(body.channel, body.payload);
            sendJson(res, 200, { ok: true, result });
        } catch (err) {
            sendJson(res, 500, { ok: false, error: err.message || String(err) });
        }
        return;
    }

    sendJson(res, 404, { ok: false, error: 'Маршрут не найден' });
}

function stopNetworkServer() {
    if (!networkServer) return;
    networkServer.close();
    networkServer = null;
    networkServerPort = null;
}

function ensureNetworkServer() {
    const config = readNetworkConfig();
    networkServerError = '';

    if (networkServer && networkServerPort === config.port) {
        return Promise.resolve(networkStatus(config));
    }

    stopNetworkServer();
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            handleNetworkRequest(req, res).catch(err => sendJson(res, 500, { ok: false, error: err.message || String(err) }));
        });

        server.on('error', err => {
            networkServerError = err.message || String(err);
            networkServer = null;
            networkServerPort = null;
            resolve(networkStatus(config));
        });

        server.listen(config.port, '0.0.0.0', () => {
            networkServer = server;
            networkServerPort = config.port;
            resolve(networkStatus(config));
        });
    });
}

async function testNetworkConnection(configInput) {
    const config = normalizeNetworkConfig(configInput);

    if (config.mode === 'local') {
        return { ok: true, message: 'Локальный режим', status: networkStatus(config) };
    }

    if (config.mode === 'host') {
        writeNetworkConfig(config);
        const status = await ensureNetworkServer();
        return {
            ok: Boolean(status.serverRunning),
            message: status.serverRunning ? 'Главный ПК запущен' : `Не удалось запустить: ${status.serverError}`,
            status
        };
    }

    if (!config.host) {
        return { ok: false, message: 'Введите IP главного ПК', status: networkStatus(config) };
    }

    try {
        const response = await requestJson('GET', `${hostBaseUrl(config)}/fx/status`, undefined, 2200);
        rememberNetworkPeer(config.host);
        await registerWithHost(config);
        return { ok: true, message: 'Связь есть', remote: response, status: networkStatus(config) };
    } catch (err) {
        return { ok: false, message: err.message || 'Нет связи', status: networkStatus(config) };
    }
}

async function registerWithHost(configInput = readNetworkConfig()) {
    const config = normalizeNetworkConfig(configInput);
    if (config.mode !== 'client' || !config.host) return { ok: false, skipped: true };
    try {
        const result = await requestJson('POST', `${hostBaseUrl(config)}/fx/register-peer`, {
            port: config.port,
            manifest: buildUpdateManifest()
        }, 900);
        rememberNetworkPeer(config.host);
        return result;
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
}

async function findNetworkHosts(searchInput = {}) {
    const port = normalizeNetworkConfig({ port: searchInput?.port || searchInput }).port;
    const directHost = String(searchInput?.host || '').trim();
    const ownIps = localIPv4Addresses();
    const candidates = new Set();
    if (directHost) candidates.add(directHost);

    ownIps.forEach(ip => {
        const parts = ip.split('.');
        if (parts.length !== 4) return;
        const prefix = parts.slice(0, 3).join('.');
        for (let last = 1; last <= 254; last += 1) {
            const candidate = `${prefix}.${last}`;
            if (!ownIps.includes(candidate)) candidates.add(candidate);
        }
    });

    const hosts = Array.from(candidates);
    const found = [];
    let cursor = 0;
    const workerCount = Math.min(32, hosts.length);

    async function worker() {
        while (cursor < hosts.length) {
            const host = hosts[cursor];
            cursor += 1;
            try {
                const response = await requestJson('GET', `http://${host}:${port}/fx/status`, undefined, 450);
                if (response?.ok && response?.name === 'FX_App') {
                    rememberNetworkPeer(host);
                    found.push({ host, port, name: response.name, role: response.role, status: response.status });
                }
            } catch {
                // молча пропускаем адреса без ответа
            }
        }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return found;
}

function scheduleEmergencyQuit() {
    setTimeout(() => {
        try {
            globalShortcut.unregisterAll();
            BrowserWindow.getAllWindows().forEach(window => window.destroy());
        } finally {
            app.quit();
        }
    }, 30);
}

async function sendEmergencyCloseToPeer(host, port, payload) {
    try {
        await requestJson('POST', `http://${host}:${port}/fx/emergency-close`, payload, 220);
        return true;
    } catch {
        return false;
    }
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function fastEmergencyHostCandidates(config) {
    const candidates = new Set();
    if (config.host) candidates.add(config.host);
    readNetworkPeers().hosts.forEach(host => candidates.add(host));
    localIPv4Addresses().forEach(ip => {
        const parts = ip.split('.');
        if (parts.length !== 4) return;
        const prefix = parts.slice(0, 3).join('.');
        ['2', '10', '20', '100', '101', '102', '150', '200'].forEach(last => {
            const candidate = `${prefix}.${last}`;
            if (candidate !== ip) candidates.add(candidate);
        });
    });
    return Array.from(candidates);
}

async function broadcastEmergencyClose(payload = {}) {
    const config = readNetworkConfig();
    const port = config.port;

    if (config.mode === 'client' && config.host) {
        await sendEmergencyCloseToPeer(config.host, port, payload);
        return;
    }

    if (config.mode === 'host') {
        await Promise.allSettled(
            fastEmergencyHostCandidates(config).map(host => sendEmergencyCloseToPeer(host, port, payload))
        );
    }
}

async function emergencyCloseAll(payload = {}) {
    const emergencyId = String(payload.emergencyId || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    if (emergencyCloseSeen.has(emergencyId)) {
        return { ok: true, duplicate: true, emergencyId };
    }
    emergencyCloseSeen.add(emergencyId);

    const nextPayload = {
        ...payload,
        emergencyId,
        requestedAt: payload.requestedAt || new Date().toISOString()
    };

    await Promise.race([
        broadcastEmergencyClose(nextPayload),
        wait(260)
    ]);
    scheduleEmergencyQuit();
    return { ok: true, emergencyId };
}

function historyClearBeforeId() {
    const marker = readJson(historyClearMarkerPath);
    return Number(marker.clearBeforeId) || 0;
}

function setHistoryClearBeforeId(clearBeforeId = Date.now()) {
    const value = Number(clearBeforeId) || Date.now();
    writeJson(historyClearMarkerPath, {
        clearedAt: new Date().toISOString(),
        clearBeforeId: value
    });
    return value;
}

function mergeOperatorBillsIntoHistory() {
    let history = readJson(dbPath);
    const clearBeforeId = historyClearBeforeId();
    try {
        const billFiles = fs.readdirSync(folderPath)
            .filter(fileName => fileName.endsWith('_bills.json'));

        billFiles.forEach(fileName => {
            readJson(path.join(folderPath, fileName)).forEach(item => {
                if (Number(item.id) <= clearBeforeId) return;
                history = upsertById(history, item);
            });
        });

        history = history.filter(item => Number(item.id) > clearBeforeId);
        writeJson(dbPath, history);
    } catch (err) {
        console.error('[HISTORY] Cannot merge operator bills:', err);
    }
    return history;
}

function markOperatorItem(user, type, id, status) {
    if (!user) return;
    const operatorPath = path.join(folderPath, `${user}_${type}.json`);
    const operatorItems = readJson(operatorPath);
    const index = operatorItems.findIndex(item => Number(item.id) === Number(id));
    if (index !== -1) {
        operatorItems[index].status = status;
        writeJson(operatorPath, operatorItems);
    }
}

function isDeletedOrClosed(item) {
    const status = String(item?.status || '').toLowerCase();
    return status.includes('удал')
        || status.includes('delete')
        || status.includes('закры')
        || status.includes('closed');
}

function weekKeyForDate(input = new Date()) {
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) return '';
    const yearStart = new Date(date.getFullYear(), 0, 1);
    const dayOffset = Math.floor((date - yearStart) / 86400000);
    const week = Math.ceil((dayOffset + yearStart.getDay() + 1) / 7);
    return `${date.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function activeTipsForUser(user) {
    let tips = readJson(operatorTipsPath(user));
    if (sqliteReady) {
        tips = dbAllItems('tips')
            .filter(tip => String(tip.user || '') === String(user || ''))
            .reduce((list, tip) => upsertById(list, tip), tips);
    }
    return sortNewestFirst(tips.filter(tip => !isDeletedOrClosed(tip)));
}

function shiftArchiveItems() {
    const fromFile = readJsonFile(shiftArchivePath);
    if (!sqliteReady) return fromFile;
    return dbAllShifts().reduce((list, shift) => upsertById(list, shift), fromFile);
}

function saveShiftArchiveItems(items) {
    const rows = Array.isArray(items) ? items : [];
    writeJsonFile(shiftArchivePath, rows);
    dbReplaceShifts(rows);
}

function upsertShiftArchive(shift) {
    const archive = upsertById(shiftArchiveItems(), shift);
    writeJsonFile(shiftArchivePath, archive);
    dbUpsertShift(shift);
    return archive;
}

function buildClosedShiftArchive(user, payload, bills, tips, trash) {
    const now = new Date();
    const date = now.toLocaleDateString('ru-RU');
    const time = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const operators = Array.from(new Set([
        user,
        ...bills.map(item => item.user),
        ...tips.map(item => item.user),
        ...trash.map(item => item.user)
    ].filter(Boolean)));
    const fallbackPeople = {
        closedBy: { name: user, role: payload?.role || '' },
        admins: payload?.role === 'admin' ? [user] : [],
        cashiers: payload?.role === 'cashier' ? [user] : operators.filter(name => name !== user),
        developers: payload?.role === 'developer' ? [user] : [],
        others: []
    };
    const people = payload?.people || fallbackPeople;
    const id = Date.now();

    return {
        id,
        title: `${date} ${operators.join(', ') || user}`,
        operator: user,
        users: operators.join(', '),
        people,
        date,
        time,
        weekKey: weekKeyForDate(now),
        summary: payload?.summary || null,
        bills,
        tips,
        trash,
        createdAt: now.toISOString()
    };
}

function clearWeekShiftArchive(payload = {}) {
    if (payload.role !== 'developer' && payload.role !== 'admin') {
        return { ok: false, error: 'Очистка недельного отчета доступна только администратору или разработчику' };
    }

    const weekKey = payload.weekKey || weekKeyForDate();
    const before = shiftArchiveItems();
    const after = before.filter(shift => String(shift.weekKey || '') !== String(weekKey));
    saveShiftArchiveItems(after);
    const deletedDb = dbDeleteShiftsForWeek(weekKey);
    return {
        ok: true,
        weekKey,
        removed: before.length - after.length || deletedDb
    };
}

function closeShiftForUser(user, payload = {}) {
    if (!user) return { ok: false, error: 'Не выбран сотрудник' };
    if (payload?.role === 'cashier') {
        return { ok: false, error: 'Кассир не может закрывать смену. Закрывает админ.' };
    }

    const closedAt = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    let closedCount = 0;
    const closeAll = payload?.role === 'admin' || payload?.role === 'developer' || payload?.closeAll === true;
    const belongsToShift = item => closeAll || String(item.user || '') === String(user);

    let history = mergeOperatorBillsIntoHistory();
    const shiftBills = history.filter(item => belongsToShift(item));
    const activeBills = shiftBills.filter(item => !isDeletedOrClosed(item));
    const activeTips = closeAll
        ? (sqliteReady
            ? dbAllItems('tips').filter(tip => !isDeletedOrClosed(tip))
            : fs.readdirSync(folderPath)
                .filter(fileName => fileName.endsWith('_tips.json'))
                .flatMap(fileName => readJson(path.join(folderPath, fileName)))
                .filter(tip => !isDeletedOrClosed(tip)))
        : activeTipsForUser(user);
    const trashBefore = readJson(trashPath);
    const userTrash = trashBefore.filter(item => belongsToShift(item));
    const shiftArchive = buildClosedShiftArchive(user, payload, activeBills, activeTips, userTrash);
    const affectedUsers = Array.from(new Set([
        user,
        ...shiftBills.map(item => item.user),
        ...activeBills.map(item => item.user),
        ...activeTips.map(item => item.user),
        ...userTrash.map(item => item.user)
    ].filter(Boolean)));
    upsertShiftArchive(shiftArchive);

    shiftBills.forEach(item => {
        if (!isDeletedOrClosed(item)) {
            closedCount += 1;
        }
    });
    history = history.filter(item => !belongsToShift(item));
    writeJson(dbPath, history);
    if (closeAll) {
        setHistoryClearBeforeId();
    }

    affectedUsers.forEach(name => {
        writeJson(path.join(folderPath, `${name}_bills.json`), []);
        writeJson(operatorTipsPath(name), []);
        writeJson(path.join(folderPath, `${name}_splits.json`), []);
    });
    if (sqliteReady) {
        dbReplaceItems('tips', dbAllItems('tips').filter(tip => !belongsToShift(tip)));
    }

    let splits = readJson(splitPath);
    splits = splits.filter(item => !belongsToShift(item));
    writeJson(splitPath, splits);

    const trashAfter = trashBefore.filter(item => !belongsToShift(item));
    writeJson(trashPath, trashAfter);

    const logEntry = `[SHIFT CLOSED] ${closedAt} - ${user}: closed ${closedCount}, cleared trash ${trashBefore.length - trashAfter.length}\n`;
    fs.appendFileSync(logPath, logEntry);

    return {
        ok: true,
        shift: shiftArchive,
        closedCount,
        clearedTrash: trashBefore.length - trashAfter.length
    };
}

function clearDeveloperHistory(user) {
    const developerName = user || 'Разработка';
    if (developerName !== 'Разработка') {
        return { ok: false, error: 'Очистка тестов доступна только входу Разработка' };
    }

    let history = mergeOperatorBillsIntoHistory();
    const beforeHistory = history.length;
    history = history.filter(item => String(item.user || '') !== developerName);
    writeJson(dbPath, history);

    const trashBefore = readJson(trashPath);
    const trashAfter = [];
    writeJson(trashPath, trashAfter);

    const splitsBefore = readJson(splitPath);
    const splitsAfter = splitsBefore.filter(item => String(item.user || '') !== developerName);
    writeJson(splitPath, splitsAfter);

    writeJson(path.join(folderPath, `${developerName}_bills.json`), []);
    writeJson(operatorTipsPath(developerName), []);
    writeJson(path.join(folderPath, `${developerName}_splits.json`), []);
    if (sqliteReady) {
        dbReplaceItems('tips', dbAllItems('tips').filter(item => String(item.user || '') !== developerName));
    }

    if (fs.existsSync(logPath)) {
        const keptLines = fs.readFileSync(logPath, 'utf-8')
            .split(/\r?\n/)
            .filter(line => line && !line.includes(developerName));
        fs.writeFileSync(logPath, keptLines.length ? `${keptLines.join('\n')}\n` : '');
    }

    return {
        ok: true,
        removedHistory: beforeHistory - history.length,
        removedTrash: trashBefore.length - trashAfter.length,
        removedSplits: splitsBefore.length - splitsAfter.length
    };
}

function clearCommonHistory(user) {
    if (user !== 'Разработка') {
        return { ok: false, error: 'Очистка общей истории доступна только входу Разработка' };
    }

    const beforeHistory = readJson(dbPath).length;
    const clearBeforeId = Date.now();
    writeJson(dbPath, []);
    writeJson(historyClearMarkerPath, {
        clearedAt: new Date().toISOString(),
        clearBeforeId
    });

    return {
        ok: true,
        removedHistory: beforeHistory,
        clearBeforeId
    };
}

function tipMatchesBill(tip, bill) {
    if (!tip || !bill) return false;
    const billId = Number(bill.id);
    return Number(tip.billId) === billId
        || Number(tip.sourceBillId) === billId
        || Number(tip.id) === Number(bill.tipId)
        || Number(tip.id) === billId + 1
        || (
            Number(tip.val) === Number(bill.tipAmount)
            && String(tip.curr || '') === String(bill.tipCurr || '')
            && String(tip.user || '') === String(bill.user || '')
            && String(tip.date || '') === String(bill.date || '')
            && String(tip.time || '') === String(bill.time || '')
        );
}

function operatorTipsPath(user) {
    return path.join(folderPath, `${user}_tips.json`);
}

function removeOperatorTipsForBill(bill) {
    if (!bill?.user || !(Number(bill.tipAmount) > 0)) return;
    const tipsPath = operatorTipsPath(bill.user);
    const tips = readJson(tipsPath);
    const filtered = tips.filter(tip => !tipMatchesBill(tip, bill));
    if (filtered.length !== tips.length) writeJson(tipsPath, filtered);
    if (sqliteReady) {
        dbAllItems('tips')
            .filter(tip => tipMatchesBill(tip, bill))
            .forEach(tip => dbUpsertItem('tips', { ...tip, status: 'удалено' }));
    }
}

function buildTipFromBill(bill, status = '') {
    if (!bill || !(Number(bill.tipAmount) > 0)) return null;
    return {
        id: Number(bill.tipId) || Number(bill.id) + 1,
        billId: Number(bill.id),
        sourceBillId: Number(bill.id),
        date: bill.date || new Date().toLocaleDateString('ru-RU'),
        time: bill.time || new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
        val: Number(bill.tipAmount) || 0,
        curr: bill.tipCurr || bill.changeCurr || 'AMD',
        amd: Number(bill.tipAMD) || 0,
        user: bill.user,
        status,
        restoredAt: bill.restoredAt || ''
    };
}

function restoreOperatorTipForBill(bill) {
    const tipEntry = buildTipFromBill(bill, "Восстановлено");
    if (!tipEntry?.user) return;
    const tipsPath = operatorTipsPath(tipEntry.user);
    const tips = upsertById(readJson(tipsPath), tipEntry);
    writeJson(tipsPath, tips);
    dbUpsertItem('tips', tipEntry);
}

function saveBill(transaction) {
    let history = readJson(dbPath);
    history = upsertById(history, transaction);
    writeJson(dbPath, history);

    const operatorPath = path.join(folderPath, `${transaction.user}_bills.json`);
    let operatorBills = readJson(operatorPath);
    operatorBills = upsertById(operatorBills, transaction);
    writeJson(operatorPath, operatorBills);

    const logEntry = `[${transaction.time}] ${transaction.user}: ${transaction.billAmd} AMD\n`;
    fs.appendFileSync(logPath, logEntry);
}

function deleteBillToTrash(id, fallbackItem) {
    const deleteId = Number(id);
    let history = readJson(dbPath);
    const fromDb = history.find(item => Number(item.id) === deleteId);
    const item = fromDb || fallbackItem;

    if (!item) {
        return { ok: false, error: 'Чек не найден в базе операций' };
    }

    const trashItem = {
        ...item,
        deletedAt: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
        status: "Удалено"
    };

    let trash = readJson(trashPath);
    trash = upsertById(trash, trashItem);
    writeJson(trashPath, trash);

    history = history.map(historyItem =>
        Number(historyItem.id) === deleteId
            ? { ...historyItem, status: "Удалено", deletedAt: trashItem.deletedAt }
            : historyItem
    );
    writeJson(dbPath, history);

    removeOperatorTipsForBill(item);
    markOperatorItem(item.user, 'bills', deleteId, "удалено");
    const logEntry = `[DELETED] ${new Date().toLocaleTimeString('ru-RU')} - Чек ${item.billAmd} AMD перемещен в корзину\n`;
    fs.appendFileSync(logPath, logEntry);

    return { ok: true, item: trashItem };
}

function saveTipEntry(tipEntry) {
    const operatorPath = operatorTipsPath(tipEntry.user);
    let operatorTips = readJson(operatorPath);
    operatorTips = upsertById(operatorTips, tipEntry);
    writeJson(operatorPath, operatorTips);
    dbUpsertItem('tips', tipEntry);
    return { ok: true };
}

function deleteTipEntry(tipEntry) {
    const operatorPath = path.join(folderPath, `${tipEntry.user}_tips.json`);
    let operatorTips = readJson(operatorPath);
    const tipIndex = operatorTips.findIndex(t => Number(t.id) === Number(tipEntry.id));
    if (tipIndex !== -1) {
        operatorTips[tipIndex].status = "удалено";
        writeJson(operatorPath, operatorTips);
    }
    if (sqliteReady && tipEntry?.id) {
        const stored = dbAllItems('tips').find(tip => Number(tip.id) === Number(tipEntry.id)) || tipEntry;
        dbUpsertItem('tips', { ...stored, status: 'удалено' });
    }
    return { ok: true };
}

function saveSplitPayment(splitEntry) {
    saveBill({ ...splitEntry, isSplit: true });
    return true;
}

function deleteSplitPayment(id) {
    const deleteId = Number(id);
    let splits = readJson(splitPath);
    const deleted = splits.find(item => Number(item.id) === deleteId);
    splits = splits.filter(item => Number(item.id) !== deleteId);
    writeJson(splitPath, splits);

    if (deleted) {
        markOperatorItem(deleted.user, 'splits', deleteId, "удалено");
    }
    return true;
}

function restoreFromTrashItem(item) {
    const restoreId = Number(item.id);
    let trash = readJson(trashPath);
    trash = trash.filter(i => Number(i.id) !== restoreId);
    writeJson(trashPath, trash);

    const restored = {
        ...item,
        status: "Восстановлено",
        restoredAt: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    };
    delete restored.deletedAt;

    let targetItems = readJson(dbPath);
    targetItems = upsertById(targetItems, restored);
    writeJson(dbPath, targetItems);

    const operatorPath = path.join(folderPath, `${item.user}_bills.json`);
    let operatorItems = readJson(operatorPath);
    operatorItems = upsertById(operatorItems, restored);
    writeJson(operatorPath, operatorItems);
    restoreOperatorTipForBill(restored);

    const logEntry = `[RESTORED] ${new Date().toLocaleTimeString('ru-RU')} - Чек ${item.billAmd} AMD восстановлен из корзины\n`;
    fs.appendFileSync(logPath, logEntry);
    console.log('[RESTORE] Чек восстановлен из корзины:', item.id);
    return true;
}

async function handleLocalChannel(channel, payload) {
    switch (channel) {
        case 'get-auth-store':
            return { ok: true, store: readAuthStore(), path: authAccountsPath };
        case 'save-auth-account':
            return saveAuthAccount(payload);
        case 'delete-auth-account':
            return deleteAuthAccount(payload);
        case 'merge-auth-store':
            return mergeAuthStore(payload);
        case 'get-rates':
            return { ok: true, rates: readRatesSettings(), path: ratesSettingsPath };
        case 'save-rates':
            return { ok: true, rates: writeRatesSettings(payload?.rates || payload), path: ratesSettingsPath };
        case 'save-bill':
            saveBill(payload);
            return { ok: true };
        case 'delete-bill':
            return deleteBillToTrash(payload?.id, payload?.item);
        case 'get-trash-data':
            return readJson(trashPath);
        case 'get-history-data':
            return mergeOperatorBillsIntoHistory();
        case 'get-user-tips': {
            const user = payload?.user;
            const role = payload?.role;
            let tips = sqliteReady ? dbAllItems('tips') : [];
            if (!tips.length && user) tips = readJson(operatorTipsPath(user));
            if (sqliteReady && user && role !== 'admin' && role !== 'developer') {
                tips = tips.filter(tip => String(tip.user || '') === String(user || ''));
            }
            if (!sqliteReady && (role === 'admin' || role === 'developer')) {
                const tipFiles = fs.readdirSync(folderPath).filter(fileName => fileName.endsWith('_tips.json'));
                tips = tipFiles.flatMap(fileName => readJson(path.join(folderPath, fileName)));
            }
            return sortNewestFirst(tips.filter(tip => !isDeletedOrClosed(tip)));
        }
        case 'save-split-payment':
            return saveSplitPayment(payload);
        case 'get-split-payments':
            return readJson(splitPath);
        case 'delete-split-payment':
            return deleteSplitPayment(payload);
        case 'restore-from-trash':
            return restoreFromTrashItem(payload);
        case 'save-tip':
            return saveTipEntry(payload);
        case 'delete-tip':
            return deleteTipEntry(payload);
        case 'close-shift':
            return closeShiftForUser(payload?.user, payload);
        case 'clear-developer-history':
            return clearDeveloperHistory(payload?.user);
        case 'clear-common-history':
            return clearCommonHistory(payload?.user);
        case 'get-shift-archive':
            return shiftArchiveItems();
        case 'clear-week-history':
            return clearWeekShiftArchive(payload);
        default:
            return [];
    }
}

async function handleIpcChannel(channel, payload) {
    if (shouldUseRemote(channel)) {
        return invokeRemote(channel, payload);
    }
    return handleLocalChannel(channel, payload);
}

let win;

function createWindow() {
    win = new BrowserWindow({
        width: 1200,
        height: 900,
        title: "Калькулятор (База: " + folderPath + ")",
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    win.loadFile(path.join(folderPath, 'index.html'));
}

function alwaysOnTopState() {
    return win ? Boolean(win.isAlwaysOnTop()) : false;
}

function toggleWindowVisibilityHotkey() {
    if (!win) return { ok: false, error: 'Окно приложения не найдено' };

    const isShown = win.isVisible() && !win.isMinimized();
    if (isShown && win.isFocused()) {
        win.setAlwaysOnTop(false);
        win.minimize();
        return { ok: true, visible: false, alwaysOnTop: false };
    }

    if (win.isMinimized()) win.restore();
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
    win.focus();
    return { ok: true, visible: true, alwaysOnTop: true };
}

function registerWindowHotkeys() {
    ['Plus', '=', 'numadd'].forEach(accelerator => {
        try {
            globalShortcut.register(accelerator, () => {
                toggleWindowVisibilityHotkey();
            });
        } catch (err) {
            console.error(`[HOTKEY] Cannot register ${accelerator}:`, err);
        }
    });
}

// --- ОБРАБОТЧИКИ (СТРОГО ПО ОДНОМУ РАЗУ) ---

// 1. Сохранение и логирование
ipcMain.on('save-to-db', (event, transaction) => {
    handleIpcChannel('save-bill', transaction).catch(err => console.error("Ошибка сохранения:", err));
});

ipcMain.handle('save-bill', async (event, transaction) => {
    try {
        return await handleIpcChannel('save-bill', transaction);
    } catch (err) {
        console.error("Ошибка сохранения:", err);
        return { ok: false, error: err.message };
    }
});

// 2. Обычное удаление из базы
ipcMain.on('delete-from-db', (event, id) => {
    handleIpcChannel('delete-bill', { id }).catch(err => console.error("Ошибка удаления:", err));
});

ipcMain.handle('delete-bill', async (event, payload) => {
    try {
        return await handleIpcChannel('delete-bill', payload);
    } catch (err) {
        console.error("Ошибка удаления:", err);
        return { ok: false, error: err.message };
    }
});

// 3. Перемещение в корзину
ipcMain.on('move-to-trash', (event, transaction) => {
    try {
        if (!transaction.deletedAt) {
            transaction.deletedAt = new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
        }
        if (!transaction.status) {
            transaction.status = "Удалено";
        }

        let trash = readJson(trashPath);
        trash = upsertById(trash, transaction);
        writeJson(trashPath, trash);
        console.log('[TRASH] Чек перемещен в корзину:', transaction.id);
    } catch (e) { console.error("Ошибка перемещения в корзину:", e); }
});

// 4. Получение данных корзины (ТОТ САМЫЙ HANDLE)
ipcMain.handle('get-trash-data', async () => {
    return handleIpcChannel('get-trash-data');
});

ipcMain.handle('get-history-data', async () => {
    return handleIpcChannel('get-history-data');
});

ipcMain.handle('get-user-tips', async (event, payload) => {
    return handleIpcChannel('get-user-tips', payload);
});

// 5. Сохранение разделённой оплаты
ipcMain.handle('save-split-payment', async (event, splitEntry) => {
    try {
        return await handleIpcChannel('save-split-payment', splitEntry);
    } catch (err) {
        console.error("Ошибка сохранения split:", err);
        return false;
    }
});

// 6. Получение разделённых оплат
ipcMain.handle('get-split-payments', async () => {
    return handleIpcChannel('get-split-payments');
});

// 7. Удаление разделённой оплаты
ipcMain.handle('delete-split-payment', async (event, id) => {
    try {
        return await handleIpcChannel('delete-split-payment', id);
    } catch (err) {
        console.error("Ошибка удаления split:", err);
        return false;
    }
});

// 8. Восстановление из корзины
ipcMain.handle('restore-from-trash', async (event, item) => {
    try {
        return await handleIpcChannel('restore-from-trash', item);
    } catch (e) { console.error("Ошибка восстановления:", e); }
    return false;
});

// 9. Сохранение TIP
ipcMain.on('save-tip', (event, tipEntry) => {
    handleIpcChannel('save-tip', tipEntry).catch(err => console.error("Ошибка сохранения TIP:", err));
});

// 10. Удаление TIP
ipcMain.on('delete-tip', (event, tipEntry) => {
    handleIpcChannel('delete-tip', tipEntry).catch(err => console.error("Ошибка удаления TIP:", err));
});

ipcMain.handle('get-auth-store', async () => {
    try {
        return await handleIpcChannel('get-auth-store');
    } catch (err) {
        return { ok: false, error: err.message || String(err), store: readAuthStore(), path: authAccountsPath };
    }
});

ipcMain.handle('save-auth-account', async (event, payload) => {
    try {
        return await handleIpcChannel('save-auth-account', payload);
    } catch (err) {
        return { ok: false, error: err.message || String(err), store: readAuthStore() };
    }
});

ipcMain.handle('delete-auth-account', async (event, payload) => {
    try {
        return await handleIpcChannel('delete-auth-account', payload);
    } catch (err) {
        return { ok: false, error: err.message || String(err), store: readAuthStore() };
    }
});

ipcMain.handle('merge-auth-store', async (event, payload) => {
    try {
        return await handleIpcChannel('merge-auth-store', payload);
    } catch (err) {
        return { ok: false, error: err.message || String(err), store: readAuthStore() };
    }
});

ipcMain.handle('get-rates', async () => {
    try {
        return await handleIpcChannel('get-rates');
    } catch (err) {
        return { ok: false, error: err.message || String(err), rates: readRatesSettings() };
    }
});

ipcMain.handle('save-rates', async (event, payload) => {
    try {
        return await handleIpcChannel('save-rates', payload);
    } catch (err) {
        return { ok: false, error: err.message || String(err), rates: readRatesSettings() };
    }
});

ipcMain.handle('get-network-config', async () => {
    const config = readNetworkConfig();
    return { ok: true, config, status: networkStatus(config) };
});

ipcMain.handle('save-network-config', async (event, configInput) => {
    try {
        const config = writeNetworkConfig(configInput);
        const status = await ensureNetworkServer();
        if (config.mode === 'client') registerWithHost(config);
        return { ok: !status.serverError, config, status };
    } catch (err) {
        console.error("Ошибка сохранения настроек сети:", err);
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('test-network-connection', async (event, configInput) => {
    try {
        return await testNetworkConnection(configInput);
    } catch (err) {
        return { ok: false, message: err.message || String(err), status: networkStatus(normalizeNetworkConfig(configInput)) };
    }
});

ipcMain.handle('find-network-hosts', async (event, payload) => {
    try {
        const found = await findNetworkHosts(payload);
        return { ok: true, found };
    } catch (err) {
        return { ok: false, error: err.message || String(err), found: [] };
    }
});

ipcMain.handle('print-shift-report', async () => {
    return new Promise(resolve => {
        if (!win) {
            resolve({ ok: false, error: 'Окно приложения не найдено' });
            return;
        }

        win.webContents.print({ silent: false, printBackground: true }, (success, failureReason) => {
            resolve(success ? { ok: true } : { ok: false, error: failureReason });
        });
    });
});

ipcMain.handle('close-shift', async (event, payload) => {
    try {
        return await handleIpcChannel('close-shift', payload);
    } catch (err) {
        console.error("Ошибка закрытия смены:", err);
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('clear-developer-history', async (event, payload) => {
    try {
        return await handleIpcChannel('clear-developer-history', payload);
    } catch (err) {
        console.error("Ошибка очистки тестовой истории:", err);
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('clear-common-history', async (event, payload) => {
    try {
        return await handleIpcChannel('clear-common-history', payload);
    } catch (err) {
        console.error("Ошибка очистки общей истории:", err);
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('get-shift-archive', async () => {
    try {
        return await handleIpcChannel('get-shift-archive');
    } catch (err) {
        console.error("Ошибка загрузки архива смен:", err);
        return [];
    }
});

ipcMain.handle('clear-week-history', async (event, payload) => {
    try {
        return await handleIpcChannel('clear-week-history', payload);
    } catch (err) {
        console.error("Ошибка очистки недельного отчета:", err);
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('check-app-update', async (event, configInput) => {
    try {
        return await checkAppUpdateFromHost(configInput || readNetworkConfig());
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
});

ipcMain.handle('get-app-manifest', async () => {
    try {
        return { ok: true, manifest: buildUpdateManifest() };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
});

ipcMain.handle('install-app-update', async (event, configInput) => {
    try {
        return await installAppUpdateFromHost(configInput || readNetworkConfig());
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
});

ipcMain.handle('emergency-close', async (event, payload) => {
    try {
        return await emergencyCloseAll(payload || {});
    } catch (err) {
        scheduleEmergencyQuit();
        return { ok: false, error: err.message || String(err) };
    }
});

ipcMain.handle('restart-app', async () => {
    app.relaunch();
    app.exit(0);
    return { ok: true };
});

ipcMain.handle('get-always-on-top', async () => {
    return { ok: true, value: alwaysOnTopState() };
});

ipcMain.handle('toggle-always-on-top', async () => {
    const result = toggleWindowVisibilityHotkey();
    return result.ok ? { ok: true, value: Boolean(result.alwaysOnTop) } : result;
});

app.whenReady().then(async () => {
    initSqliteDatabase();
    await ensureNetworkServer();
    registerWithHost();
    createWindow();
    registerWindowHotkeys();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
    globalShortcut.unregisterAll();
    if (process.platform !== 'darwin') app.quit();
});
