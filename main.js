const { app, BrowserWindow, ipcMain, shell, globalShortcut, screen, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
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

const appConfigPath = path.join(app.getPath('userData'), 'config.json');
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
const backupConfigPath = path.join(folderPath, 'backup_settings.json');
const userSettingsPath = path.join(folderPath, 'user_settings.json');
const APP_UPDATE_FILES = ['index.html', 'main.js', 'package.json', 'package-lock.json', 'start_fx.bat', 'publish_github.bat'];
const APP_VERSION = require('./package.json').version || '1.0.0';
const DEFAULT_RATES = { RUB: 3.7, USD: 320, EUR: 360 };
const DEFAULT_USER_SETTINGS = {
    enableF1Toggle: true,
    enableF3Import: true,
    minimizeAfterSave: true
};
const DEFAULT_BACKUP_CONFIG = {
    enabled: false,
    owner: 'antionn45-glitch',
    repo: 'FX_App_Backup',
    branch: 'main',
    slot: '',
    token: '',
    autoBackup: true,
    autoIntervalMinutes: 5
};
const BACKUP_DATA_FILE = 'latest_backup.json';
const backupStatePath = path.join(folderPath, 'backup_state.json');
const BACKUP_AUTO_DEBOUNCE_MS = 60000;
const BACKUP_MIN_AUTO_INTERVAL_MS = 5 * 60 * 1000;

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

function normalizePosOcrArea(area = null) {
    if (!area || typeof area !== 'object') return null;
    const x = Math.round(Number(area.x));
    const y = Math.round(Number(area.y));
    const width = Math.round(Number(area.width));
    const height = Math.round(Number(area.height));
    if (![x, y, width, height].every(Number.isFinite) || width < 8 || height < 8) return null;
    return { x, y, width, height };
}

function readAppConfig() {
    const exists = fs.existsSync(appConfigPath);
    const config = readJsonObjectFile(appConfigPath, {});
    return { exists, config };
}

function writeAppConfig(nextConfig = {}) {
    const config = nextConfig && typeof nextConfig === 'object' && !Array.isArray(nextConfig) ? nextConfig : {};
    writeJsonObjectFile(appConfigPath, config, {});
    return config;
}

function readPosOcrArea() {
    const { exists, config } = readAppConfig();
    return { exists, area: normalizePosOcrArea(config.posOcrArea), config };
}

function writePosOcrArea(area) {
    const normalized = normalizePosOcrArea(area);
    if (!normalized) throw new Error('Некорректная область POS. Укажите x, y, width и height.');
    const { config } = readAppConfig();
    const nextConfig = {
        ...config,
        posOcrArea: normalized,
        posOcrAreaUpdatedAt: new Date().toISOString()
    };
    writeAppConfig(nextConfig);
    return normalized;
}

function normalizeUserSettings(value = {}) {
    return {
        enableF1Toggle: value.enableF1Toggle === undefined ? DEFAULT_USER_SETTINGS.enableF1Toggle : Boolean(value.enableF1Toggle),
        enableF3Import: value.enableF3Import === undefined ? DEFAULT_USER_SETTINGS.enableF3Import : Boolean(value.enableF3Import),
        minimizeAfterSave: value.minimizeAfterSave === undefined ? DEFAULT_USER_SETTINGS.minimizeAfterSave : Boolean(value.minimizeAfterSave)
    };
}

function userSettingsKey(payload = {}) {
    const role = String(payload.role || '').trim() || 'user';
    const id = String(payload.id || payload.userId || '').trim();
    const name = String(payload.name || payload.user || '').trim();
    return `${role}:${id || name || 'default'}`;
}

function readUserSettingsStore() {
    return readJsonObjectFile(userSettingsPath, {});
}

function writeUserSettingsStore(store = {}) {
    writeJsonObjectFile(userSettingsPath, store, {});
    return store;
}

function readUserSettings(payload = {}) {
    const store = readUserSettingsStore();
    const key = userSettingsKey(payload);
    return normalizeUserSettings(store[key] || {});
}

function writeUserSettings(payload = {}) {
    const store = readUserSettingsStore();
    const key = userSettingsKey(payload);
    const settings = normalizeUserSettings(payload.settings || payload);
    store[key] = settings;
    writeUserSettingsStore(store);
    scheduleGithubBackup('user-settings', 5000);
    return { ok: true, key, settings };
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

function githubRawFileUrl(configOrGithub, fileName) {
    const github = configOrGithub?.owner ? configOrGithub : githubRawConfig(configOrGithub);
    const ref = github.ref || github.branch;
    return `https://raw.githubusercontent.com/${encodeURIComponent(github.owner)}/${encodeURIComponent(github.repo)}/${encodeURIComponent(ref)}/${encodeURIComponent(fileName)}?t=${Date.now()}`;
}

async function githubResolvedRawConfig(config = readNetworkConfig()) {
    const github = githubRawConfig(config);
    const apiUrl = `https://api.github.com/repos/${encodeURIComponent(github.owner)}/${encodeURIComponent(github.repo)}/commits/${encodeURIComponent(github.branch)}?t=${Date.now()}`;
    try {
        const bytes = await requestBuffer('GET', apiUrl, undefined, 10000);
        const data = JSON.parse(bytes.toString('utf8'));
        const ref = String(data?.sha || '').trim();
        return { ...github, ref: ref || github.branch };
    } catch (err) {
        console.warn('[GITHUB] Cannot resolve latest branch SHA, falling back to branch raw URL:', err.message || err);
        return { ...github, ref: github.branch };
    }
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
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
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

let githubBackupTimer = null;
let githubBackupRunning = false;
let githubBackupQueuedReason = '';
let githubBackupStatus = {
    state: 'idle',
    message: 'GitHub backup is not configured',
    lastAt: '',
    lastError: ''
};

function sanitizeBackupSlot(value = '') {
    return String(value || '')
        .trim()
        .replace(/[\\/:*?"<>|#%&{}$!`'@+=]+/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64);
}

function defaultBackupSlot() {
    return sanitizeBackupSlot(os.hostname()) || 'main-pc';
}

function backupSlot(config = {}) {
    return sanitizeBackupSlot(config.slot || '') || defaultBackupSlot();
}

function backupDataFileName(config = {}) {
    return `backups/${backupSlot(config)}/${BACKUP_DATA_FILE}`;
}

function normalizeBackupConfig(config = {}) {
    const enabled = Boolean(config.enabled);
    const owner = String(config.owner ?? DEFAULT_BACKUP_CONFIG.owner).trim();
    const repo = String(config.repo ?? DEFAULT_BACKUP_CONFIG.repo).trim();
    const branch = String(config.branch ?? DEFAULT_BACKUP_CONFIG.branch).trim() || DEFAULT_BACKUP_CONFIG.branch;
    const slot = backupSlot(config);
    const token = String(config.token || '').trim();
    const autoBackup = config.autoBackup === undefined ? DEFAULT_BACKUP_CONFIG.autoBackup : Boolean(config.autoBackup);
    const autoIntervalMinutes = Math.max(1, Math.min(60, Math.round(Number(config.autoIntervalMinutes) || DEFAULT_BACKUP_CONFIG.autoIntervalMinutes)));
    return { enabled, owner, repo, branch, slot, token, autoBackup, autoIntervalMinutes };
}

function readBackupConfig() {
    const stored = readJsonObjectFile(backupConfigPath, DEFAULT_BACKUP_CONFIG);
    return normalizeBackupConfig({ ...DEFAULT_BACKUP_CONFIG, ...stored });
}

function publicBackupConfig(config = readBackupConfig()) {
    const normalized = normalizeBackupConfig(config);
    return {
        enabled: normalized.enabled,
        owner: normalized.owner,
        repo: normalized.repo,
        branch: normalized.branch,
        slot: normalized.slot,
        backupPath: backupDataFileName(normalized),
        autoBackup: normalized.autoBackup,
        autoIntervalMinutes: normalized.autoIntervalMinutes,
        hasToken: Boolean(normalized.token)
    };
}

function writeBackupConfig(input = {}) {
    const current = readBackupConfig();
    const hasTokenInput = Object.prototype.hasOwnProperty.call(input, 'token') && String(input.token || '').trim();
    const token = input.clearToken ? '' : (hasTokenInput ? String(input.token || '').trim() : current.token);
    const normalized = normalizeBackupConfig({ ...current, ...input, token });
    writeJsonObjectFile(backupConfigPath, normalized, DEFAULT_BACKUP_CONFIG);
    return normalized;
}

function clearGithubBackupRepositoryFields() {
    const current = readBackupConfig();
    const cleared = normalizeBackupConfig({
        ...current,
        enabled: false,
        owner: '',
        repo: '',
        token: ''
    });
    writeJsonObjectFile(backupConfigPath, cleared, DEFAULT_BACKUP_CONFIG);
    githubBackupStatus = {
        state: 'ok',
        message: `Данные репозитория очищены. Папка бэкапа оставлена: ${cleared.slot || 'авто'}`,
        lastAt: new Date().toISOString(),
        lastError: ''
    };
    return { ok: true, config: publicBackupConfig(cleared), status: githubBackupStatus };
}

function readBackupState() {
    const state = readJsonObjectFile(backupStatePath, {});
    return {
        lastHash: String(state.lastHash || ''),
        lastAt: String(state.lastAt || ''),
        lastAtMs: Number(state.lastAtMs) || 0,
        backupPath: String(state.backupPath || ''),
        lastLocalChangeAt: String(state.lastLocalChangeAt || ''),
        lastLocalChangeAtMs: Number(state.lastLocalChangeAtMs) || 0,
        lastLocalChangeReason: String(state.lastLocalChangeReason || '')
    };
}

function writeBackupState(state = {}) {
    const normalized = {
        lastHash: String(state.lastHash || ''),
        lastAt: String(state.lastAt || ''),
        lastAtMs: Number(state.lastAtMs) || 0,
        backupPath: String(state.backupPath || ''),
        lastLocalChangeAt: String(state.lastLocalChangeAt || ''),
        lastLocalChangeAtMs: Number(state.lastLocalChangeAtMs) || 0,
        lastLocalChangeReason: String(state.lastLocalChangeReason || '')
    };
    writeJsonObjectFile(backupStatePath, normalized, {});
    return normalized;
}

function touchLocalBackupChange(reason = 'change') {
    const state = readBackupState();
    const nowMs = Date.now();
    writeBackupState({
        ...state,
        lastLocalChangeAt: new Date(nowMs).toISOString(),
        lastLocalChangeAtMs: nowMs,
        lastLocalChangeReason: reason
    });
}

function formatDateTimeForUser(value) {
    const ms = Number(value) || Date.parse(value || '');
    if (!Number.isFinite(ms) || ms <= 0) return 'нет даты';
    return new Date(ms).toLocaleString('ru-RU', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function fileMtimeMs(filePath) {
    try {
        return fs.existsSync(filePath) ? Math.round(fs.statSync(filePath).mtimeMs) : 0;
    } catch {
        return 0;
    }
}

function mergeItemsById(...lists) {
    let result = [];
    lists.flat().forEach(item => {
        if (item && typeof item === 'object') result = upsertById(result, item);
    });
    return sortNewestFirst(result);
}

function collectAllTipsForBackup() {
    const tipFiles = fs.existsSync(folderPath)
        ? fs.readdirSync(folderPath).filter(fileName => fileName.endsWith('_tips.json'))
        : [];
    const fromFiles = tipFiles.flatMap(fileName => readJson(path.join(folderPath, fileName)));
    const fromDb = sqliteReady ? dbAllItems('tips') : [];
    return mergeItemsById(fromDb, fromFiles);
}

function collectAllBillsForBackup() {
    const fromHistory = mergeOperatorBillsIntoHistory();
    const fromDb = sqliteReady ? dbAllItems('bills') : [];
    const billFiles = fs.existsSync(folderPath)
        ? fs.readdirSync(folderPath).filter(fileName => fileName.endsWith('_bills.json'))
        : [];
    const fromFiles = billFiles.flatMap(fileName => readJson(path.join(folderPath, fileName)));
    return mergeItemsById(fromHistory, fromDb, fromFiles);
}

function countAuthAccounts(auth = readAuthStore()) {
    return Object.keys(auth.admins || {}).length + Object.keys(auth.cashiers || {}).length;
}

function newestItemTime(items = []) {
    return items.reduce((max, item) => Math.max(max, newestSortValue(item)), 0);
}

function normalizeBackupDataForMeta(data = {}) {
    return {
        bills: Array.isArray(data.bills) ? data.bills : [],
        trash: Array.isArray(data.trash) ? data.trash : [],
        splits: Array.isArray(data.splits) ? data.splits : [],
        tips: Array.isArray(data.tips) ? data.tips : [],
        shifts: Array.isArray(data.shifts) ? data.shifts : [],
        auth: data.auth && typeof data.auth === 'object' ? data.auth : {}
    };
}

function newestBackupDataTime(data) {
    data = normalizeBackupDataForMeta(data);
    const authCount = countAuthAccounts(data.auth);
    const hasData = Boolean(
        data.bills.length ||
        data.trash.length ||
        data.splits.length ||
        data.tips.length ||
        data.shifts.length ||
        authCount
    );
    if (!hasData) return 0;

    return Math.max(
        newestItemTime(data.bills),
        newestItemTime(data.trash),
        newestItemTime(data.splits),
        newestItemTime(data.tips),
        newestItemTime(data.shifts)
    );
}

function readTextFileSafe(filePath) {
    try {
        return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    } catch {
        return '';
    }
}

function collectBackupData() {
    const bills = collectAllBillsForBackup();
    const trash = readJson(trashPath);
    const splitFileItems = readJson(splitPath);
    const splitBillItems = bills.filter(item => item?.isSplit);
    const splits = mergeItemsById(splitFileItems, splitBillItems);
    const tips = collectAllTipsForBackup();
    const shifts = shiftArchiveItems();
    return {
        bills,
        trash,
        splits,
        tips,
        shifts,
        auth: readAuthStore(),
        userSettings: readUserSettingsStore(),
        rates: readRatesSettings(),
        historyClearMarker: readJsonObjectFile(historyClearMarkerPath, {}),
        networkConfig: readNetworkConfig(),
        dailyLog: readTextFileSafe(logPath)
    };
}

function buildBackupPayload(reason = 'manual') {
    const data = collectBackupData();
    const backupConfig = readBackupConfig();
    const backupState = readBackupState();
    const authAccounts = countAuthAccounts(data.auth);
    const latestDataAtMs = newestBackupDataTime(data);
    const dataHash = backupDataHash(data);
    const localSavedAtMs = Number(backupState.lastLocalChangeAtMs) || latestDataAtMs;
    const shiftBills = data.shifts.reduce((sum, shift) => sum + (Array.isArray(shift?.bills) ? shift.bills.length : 0), 0);
    const shiftTips = data.shifts.reduce((sum, shift) => sum + (Array.isArray(shift?.tips) ? shift.tips.length : 0), 0);
    const shiftTrash = data.shifts.reduce((sum, shift) => sum + (Array.isArray(shift?.trash) ? shift.trash.length : 0), 0);
    const counts = {
        bills: data.bills.length,
        trash: data.trash.length,
        splits: data.splits.length,
        tips: data.tips.length,
        shifts: data.shifts.length,
        shiftBills,
        shiftTips,
        shiftTrash,
        authAccounts
    };
    const hasData = Object.values(counts).some(value => Number(value) > 0);
    const generatedAtMs = Date.now();
    const meta = {
        generatedAt: new Date(generatedAtMs).toISOString(),
        generatedAtMs,
        generatedAtText: formatDateTimeForUser(generatedAtMs),
        latestDataAtMs,
        latestDataAt: latestDataAtMs ? new Date(latestDataAtMs).toISOString() : '',
        latestDataAtText: latestDataAtMs ? formatDateTimeForUser(latestDataAtMs) : 'нет данных',
        localSavedAtMs,
        localSavedAt: localSavedAtMs ? new Date(localSavedAtMs).toISOString() : '',
        localSavedAtText: localSavedAtMs ? formatDateTimeForUser(localSavedAtMs) : 'нет данных',
        localSaveReason: backupState.lastLocalChangeReason || '',
        version: APP_VERSION,
        device: os.hostname(),
        backupSlot: backupSlot(backupConfig),
        backupPath: backupDataFileName(backupConfig),
        folderPath,
        reason,
        dataHash,
        counts,
        hasData
    };
    return {
        schema: 'fx-app-backup-v1',
        app: 'FX_App',
        version: APP_VERSION,
        meta,
        data
    };
}

function backupDataHash(data = {}) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(data || {}))
        .digest('hex');
}

function backupPayloadHash(payload) {
    return backupDataHash(payload?.data || {});
}

function backupMetaFromPayload(payload = {}) {
    const meta = { ...(payload.meta || {}) };
    const data = payload.data || {};
    const normalizedData = normalizeBackupDataForMeta(data);
    const counts = {
        bills: normalizedData.bills.length,
        trash: normalizedData.trash.length,
        splits: normalizedData.splits.length,
        tips: normalizedData.tips.length,
        shifts: normalizedData.shifts.length,
        authAccounts: countAuthAccounts(normalizedData.auth)
    };
    const hasSettingsData = Boolean(
        Object.keys(data.rates || {}).length ||
        Object.keys(data.userSettings || {}).length ||
        Object.keys(data.networkConfig || {}).length ||
        Object.keys(data.historyClearMarker || {}).length ||
        String(data.dailyLog || '').trim()
    );
    const latestDataAtMs = newestBackupDataTime(data);
    meta.counts = counts;
    meta.hasData = Boolean(meta.hasData || hasSettingsData || Object.values(counts).some(value => Number(value) > 0));
    meta.dataHash = meta.dataHash || backupPayloadHash(payload);
    meta.backupSlot = meta.backupSlot || backupSlot(readBackupConfig());
    meta.backupPath = meta.backupPath || backupDataFileName(readBackupConfig());
    if (latestDataAtMs) {
        meta.latestDataAtMs = latestDataAtMs;
        meta.latestDataAt = new Date(latestDataAtMs).toISOString();
        meta.latestDataAtText = formatDateTimeForUser(latestDataAtMs);
    }
    const localSavedAtMs = Number(meta.localSavedAtMs) || latestDataAtMs;
    if (localSavedAtMs) {
        meta.localSavedAtMs = localSavedAtMs;
        meta.localSavedAt = meta.localSavedAt || new Date(localSavedAtMs).toISOString();
        meta.localSavedAtText = meta.localSavedAtText || formatDateTimeForUser(localSavedAtMs);
    }
    return meta;
}

function githubBackupApiRequest(method, apiPath, token, payload, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
        const req = https.request({
            method,
            hostname: 'api.github.com',
            path: apiPath,
            timeout: timeoutMs,
            headers: {
                'User-Agent': 'FX_App backup',
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {})
            }
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let parsed = {};
                try {
                    parsed = text ? JSON.parse(text) : {};
                } catch {
                    parsed = { raw: text };
                }
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(parsed);
                    return;
                }
                const err = new Error(parsed.message || `GitHub HTTP ${res.statusCode}`);
                err.statusCode = res.statusCode;
                err.response = parsed;
                reject(err);
            });
        });

        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('Нет ответа от GitHub Backup')));
        if (body) req.write(body);
        req.end();
    });
}

function githubBackupFilePath(config, fileName) {
    const owner = encodeURIComponent(config.owner);
    const repo = encodeURIComponent(config.repo);
    const encodedPath = String(fileName || '')
        .split('/')
        .map(part => encodeURIComponent(part))
        .join('/');
    return `/repos/${owner}/${repo}/contents/${encodedPath}`;
}

function ensureBackupConfigReady(config = readBackupConfig()) {
    if (!config.enabled) throw new Error('Включите GitHub Backup в настройках');
    if (!config.owner || !config.repo) throw new Error('Укажите owner и repo для GitHub Backup');
    if (!config.token) throw new Error('Вставьте GitHub token для приватного бэкапа');
    return config;
}

async function readGithubBackupFile(config, fileName) {
    try {
        const data = await githubBackupApiRequest(
            'GET',
            `${githubBackupFilePath(config, fileName)}?ref=${encodeURIComponent(config.branch)}&t=${Date.now()}`,
            config.token,
            undefined,
            15000
        );
        const content = Buffer.from(String(data.content || '').replace(/\s/g, ''), 'base64').toString('utf8');
        let json = null;
        try {
            json = content ? JSON.parse(content) : null;
        } catch {}
        return { exists: true, sha: data.sha || '', content, json };
    } catch (err) {
        if (err.statusCode === 404) return { exists: false, sha: '', content: '', json: null };
        throw err;
    }
}

async function writeGithubBackupFile(config, fileName, content, message) {
    const existing = await readGithubBackupFile(config, fileName);
    const buildPayload = includeBranch => ({
        message,
        ...(includeBranch ? { branch: config.branch } : {}),
        content: Buffer.from(String(content || ''), 'utf8').toString('base64'),
        ...(existing.sha ? { sha: existing.sha } : {})
    });
    try {
        return await githubBackupApiRequest('PUT', githubBackupFilePath(config, fileName), config.token, buildPayload(true), 25000);
    } catch (err) {
        if (!existing.sha && (err.statusCode === 404 || err.statusCode === 422)) {
            return githubBackupApiRequest('PUT', githubBackupFilePath(config, fileName), config.token, buildPayload(false), 25000);
        }
        throw err;
    }
}

function backupComparisonMessage(comparison, remoteMeta = {}, localMeta = {}) {
    const remoteBackup = remoteMeta.generatedAtText || formatDateTimeForUser(remoteMeta.generatedAtMs || remoteMeta.generatedAt);
    const localSaved = localMeta.localSavedAtText || formatDateTimeForUser(localMeta.localSavedAtMs || localMeta.localSavedAt || localMeta.latestDataAtMs || localMeta.latestDataAt);
    const slot = remoteMeta.backupSlot || localMeta.backupSlot || backupSlot(readBackupConfig());
    const details = `\nПоследний бэкап в GitHub: ${remoteBackup}\nПоследнее сохранение локально: ${localSaved}\nПапка бэкапа: ${slot}`;
    if (comparison.status === 'local-empty') {
        return `На этом ПК данных нет. В GitHub есть бэкап.${details}`;
    }
    if (comparison.status === 'local-newer') {
        return `На этом ПК есть локальное сохранение после последнего бэкапа. Без подтверждения восстановление не выполнено.${details}`;
    }
    if (comparison.status === 'remote-newer') {
        return `В GitHub есть более свежий бэкап.${details}`;
    }
    if (comparison.status === 'remote-empty') {
        return `В GitHub бэкап пустой.${details}`;
    }
    if (comparison.status === 'different') {
        return `Данные отличаются. Сверьте бэкап перед восстановлением.${details}`;
    }
    return `Бэкап и локальные данные совпадают.${details}`;
}

function compareBackupMeta(remoteMeta = {}, localMeta = {}) {
    const remoteHasData = Boolean(remoteMeta.hasData);
    const localHasData = Boolean(localMeta.hasData);
    const remoteHash = String(remoteMeta.dataHash || '');
    const localHash = String(localMeta.dataHash || '');
    const remoteMs = Number(remoteMeta.latestDataAtMs) || 0;
    const localMs = Number(localMeta.latestDataAtMs) || 0;
    if (!remoteHasData) return { status: 'remote-empty', remoteMs, localMs };
    if (!localHasData) return { status: 'local-empty', remoteMs, localMs };
    if (remoteHash && localHash && remoteHash === localHash) {
        return { status: 'same', remoteMs, localMs, remoteHash, localHash };
    }
    if (localMs > remoteMs + 1000) return { status: 'local-newer', remoteMs, localMs };
    if (remoteMs > localMs + 1000) return { status: 'remote-newer', remoteMs, localMs };
    if (remoteHash && localHash && remoteHash !== localHash) {
        return { status: 'different', remoteMs, localMs, remoteHash, localHash };
    }
    return { status: 'same', remoteMs, localMs, remoteHash, localHash };
}

async function fetchGithubBackupPayload(config = readBackupConfig()) {
    const ready = ensureBackupConfigReady(config);
    const fileName = backupDataFileName(ready);
    let file = await readGithubBackupFile(ready, fileName);
    let sourcePath = fileName;
    if (!file.exists && fileName !== BACKUP_DATA_FILE) {
        const legacyFile = await readGithubBackupFile(ready, BACKUP_DATA_FILE);
        if (legacyFile.exists) {
            file = legacyFile;
            sourcePath = BACKUP_DATA_FILE;
        }
    }
    if (!file.exists || !file.json) return { exists: false, payload: null };
    return { exists: true, payload: file.json, backupPath: sourcePath };
}

async function checkGithubBackup() {
    const config = ensureBackupConfigReady(readBackupConfig());
    const remote = await fetchGithubBackupPayload(config);
    if (!remote.exists) {
        return { ok: true, exists: false, message: 'Бэкап в GitHub пока не найден' };
    }
    const local = buildBackupPayload('local-check');
    const remoteMeta = backupMetaFromPayload(remote.payload);
    const localMeta = backupMetaFromPayload(local);
    remoteMeta.backupPath = remote.backupPath || remoteMeta.backupPath;
    const comparison = compareBackupMeta(remoteMeta, localMeta);
    return {
        ok: true,
        exists: true,
        remoteMeta,
        localMeta,
        comparison,
        message: backupComparisonMessage(comparison, remoteMeta, localMeta)
    };
}

function clearOperatorJsonFiles(suffix) {
    try {
        fs.readdirSync(folderPath)
            .filter(fileName => fileName.endsWith(suffix))
            .forEach(fileName => writeJson(path.join(folderPath, fileName), []));
    } catch (err) {
        console.warn('[BACKUP] Cannot clear operator files:', err.message || err);
    }
}

function writeItemsByUserToFiles(items, suffix) {
    clearOperatorJsonFiles(suffix);
    const groups = new Map();
    (Array.isArray(items) ? items : []).forEach(item => {
        const user = String(item?.user || '').trim();
        if (!user) return;
        groups.set(user, [...(groups.get(user) || []), item]);
    });
    groups.forEach((rows, user) => {
        writeJson(path.join(folderPath, `${user}${suffix}`), rows);
    });
}

function applyBackupPayload(payload) {
    if (!payload || payload.schema !== 'fx-app-backup-v1' || !payload.data) {
        throw new Error('Файл бэкапа имеет неизвестный формат');
    }
    const data = payload.data;
    const bills = Array.isArray(data.bills) ? data.bills : [];
    const trash = Array.isArray(data.trash) ? data.trash : [];
    const splits = Array.isArray(data.splits) ? data.splits : bills.filter(item => item?.isSplit);
    const restoredBills = mergeItemsById(bills, splits.map(item => ({ ...item, isSplit: true })));
    const tips = Array.isArray(data.tips) ? data.tips : [];
    const shifts = Array.isArray(data.shifts) ? data.shifts : [];

    writeJson(dbPath, restoredBills);
    writeJson(trashPath, trash);
    writeJson(splitPath, splits);
    writeItemsByUserToFiles(restoredBills, '_bills.json');
    writeItemsByUserToFiles(splits, '_splits.json');
    writeItemsByUserToFiles(tips, '_tips.json');
    if (sqliteReady) dbReplaceItems('tips', tips);
    saveShiftArchiveItems(shifts);
    if (data.auth) writeAuthStore(data.auth);
    if (data.userSettings) writeUserSettingsStore(data.userSettings);
    if (data.rates) writeRatesSettings(data.rates);
    writeJsonObjectFile(historyClearMarkerPath, data.historyClearMarker || {}, {});
    if (typeof data.dailyLog === 'string') fs.writeFileSync(logPath, data.dailyLog);

    return {
        ok: true,
        counts: {
            bills: restoredBills.length,
            trash: trash.length,
            splits: splits.length,
            tips: tips.length,
            shifts: shifts.length,
            shiftBills: shifts.reduce((sum, shift) => sum + (Array.isArray(shift?.bills) ? shift.bills.length : 0), 0),
            shiftTips: shifts.reduce((sum, shift) => sum + (Array.isArray(shift?.tips) ? shift.tips.length : 0), 0),
            shiftTrash: shifts.reduce((sum, shift) => sum + (Array.isArray(shift?.trash) ? shift.trash.length : 0), 0),
            authAccounts: data.auth ? countAuthAccounts(data.auth) : 0
        }
    };
}

async function restoreGithubBackup(options = {}) {
    const config = ensureBackupConfigReady(readBackupConfig());
    const remote = await fetchGithubBackupPayload(config);
    if (!remote.exists) return { ok: false, error: 'Бэкап в GitHub пока не найден' };
    const local = buildBackupPayload('restore-check');
    const remoteMeta = backupMetaFromPayload(remote.payload);
    const localMeta = backupMetaFromPayload(local);
    remoteMeta.backupPath = remote.backupPath || remoteMeta.backupPath;
    const comparison = compareBackupMeta(remoteMeta, localMeta);
    const message = backupComparisonMessage(comparison, remoteMeta, localMeta);
    if (comparison.status === 'local-newer' && !options.force) {
        return { ok: false, needsConfirm: true, comparison, remoteMeta, localMeta, message };
    }
    if (comparison.status === 'remote-empty' && !options.force) {
        return { ok: false, needsConfirm: true, comparison, remoteMeta, localMeta, message };
    }
    if (comparison.status === 'different' && !options.force) {
        return { ok: false, needsConfirm: true, comparison, remoteMeta, localMeta, message };
    }
    const result = applyBackupPayload(remote.payload);
    githubBackupStatus = {
        state: 'ok',
        message: `Данные восстановлены из GitHub. ${message}`,
        lastAt: new Date().toISOString(),
        lastError: ''
    };
    return { ...result, comparison, remoteMeta, localMeta, message: githubBackupStatus.message };
}

async function performGithubBackup(reason = 'manual') {
    const config = readBackupConfig();
    if (!config.enabled) return { ok: false, skipped: true, message: 'GitHub Backup выключен' };
    if (readNetworkConfig().mode === 'client') {
        return { ok: true, skipped: true, message: 'На втором ПК бэкап не отправляется. Его делает главный ПК.' };
    }
    ensureBackupConfigReady(config);

    if (githubBackupRunning) {
        githubBackupQueuedReason = reason;
        return { ok: true, queued: true, message: 'Бэкап уже идет, следующий запуск поставлен в очередь' };
    }

    githubBackupRunning = true;
    githubBackupStatus = {
        state: 'running',
        message: 'Отправляю бэкап данных в GitHub...',
        lastAt: githubBackupStatus.lastAt || '',
        lastError: ''
    };

    try {
        const payload = buildBackupPayload(reason);
        const payloadHash = backupPayloadHash(payload);
        const previousState = readBackupState();
        const backupPath = backupDataFileName(config);
        const isManualBackup = String(reason || '').startsWith('manual');
        if (!isManualBackup && previousState.lastHash === payloadHash && previousState.backupPath === backupPath) {
            githubBackupStatus = {
                state: 'ok',
                message: 'Бэкап не отправлен: данные не менялись',
                lastAt: previousState.lastAt || githubBackupStatus.lastAt || '',
                lastError: ''
            };
            return { ok: true, skipped: true, status: githubBackupStatus, meta: payload.meta };
        }
        const content = JSON.stringify(payload, null, 2);
        const stamp = payload.meta.generatedAtText || formatDateTimeForUser(Date.now());
        await writeGithubBackupFile(config, backupPath, content, `FX data backup ${backupSlot(config)} ${stamp}`);
        writeBackupState({
            ...previousState,
            lastHash: payloadHash,
            lastAt: payload.meta.generatedAt,
            lastAtMs: payload.meta.generatedAtMs,
            backupPath
        });
        githubBackupStatus = {
            state: 'ok',
            message: `Бэкап сохранен в GitHub: ${stamp} (${backupSlot(config)})`,
            lastAt: payload.meta.generatedAt,
            lastError: ''
        };
        return { ok: true, status: githubBackupStatus, meta: payload.meta };
    } catch (err) {
        githubBackupStatus = {
            state: 'error',
            message: 'Ошибка GitHub Backup: ' + (err.message || err),
            lastAt: githubBackupStatus.lastAt || '',
            lastError: err.message || String(err)
        };
        return { ok: false, error: err.message || String(err), status: githubBackupStatus };
    } finally {
        githubBackupRunning = false;
        if (githubBackupQueuedReason) {
            const queuedReason = githubBackupQueuedReason;
            githubBackupQueuedReason = '';
            scheduleGithubBackup(queuedReason, 5000);
        }
    }
}

function scheduleGithubBackup(reason = 'change', delayMs = 20000) {
    touchLocalBackupChange(reason);
    let config;
    try {
        config = readBackupConfig();
    } catch {
        return;
    }
    if (!config.enabled || !config.autoBackup || !config.token || !config.owner || !config.repo) return;
    if (readNetworkConfig().mode === 'client') return;
    if (githubBackupTimer) clearTimeout(githubBackupTimer);
    const state = readBackupState();
    const autoIntervalMs = Math.max(1, Number(config.autoIntervalMinutes) || DEFAULT_BACKUP_CONFIG.autoIntervalMinutes) * 60 * 1000;
    const remainingInterval = state.lastAtMs
        ? Math.max(0, autoIntervalMs - (Date.now() - state.lastAtMs))
        : 0;
    const waitMs = Math.max(BACKUP_AUTO_DEBOUNCE_MS, Number(delayMs) || BACKUP_AUTO_DEBOUNCE_MS, remainingInterval);
    githubBackupStatus = {
        ...githubBackupStatus,
        state: 'pending',
        message: `Бэкап будет отправлен в GitHub через ${Math.ceil(waitMs / 1000)} сек.`,
        lastError: ''
    };
    githubBackupTimer = setTimeout(() => {
        githubBackupTimer = null;
        performGithubBackup(reason).catch(err => {
            githubBackupStatus = {
                state: 'error',
                message: 'Ошибка GitHub Backup: ' + (err.message || err),
                lastAt: githubBackupStatus.lastAt || '',
                lastError: err.message || String(err)
            };
        });
    }, waitMs);
}

function markDataChangedForBackup(result, reason = 'change', delayMs = 20000) {
    if (result !== false && result?.ok !== false) scheduleGithubBackup(reason, delayMs);
    return result;
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
    const github = await githubResolvedRawConfig(config);
    for (const fileName of APP_UPDATE_FILES) {
        const bytes = await requestBuffer('GET', githubRawFileUrl(github, fileName), undefined, 12000);
        downloaded.push({ name: fileName, bytes });
    }
    const manifest = buildManifestFromDownloadedFiles(downloaded);
    const fileMeta = new Map(manifest.files.map(file => [file.name, file]));
    return {
        ok: true,
        source: 'github',
        githubRef: github.ref,
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
    updateSource: 'github',
    githubOwner: 'LevBali',
    githubRepo: 'FX_App',
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
    const githubOwner = String(config.githubOwner || DEFAULT_NETWORK_CONFIG.githubOwner).trim();
    const githubRepo = String(config.githubRepo || DEFAULT_NETWORK_CONFIG.githubRepo).trim();
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
    if (['get-network-config', 'save-network-config', 'test-network-connection', 'find-network-hosts', 'print-shift-report', 'check-app-update', 'install-app-update', 'restart-app', 'get-app-manifest', 'get-github-backup-config', 'save-github-backup-config', 'get-github-backup-status', 'run-github-backup', 'check-github-backup', 'restore-github-backup', 'clear-github-backup-repository-fields', 'get-user-settings', 'save-user-settings'].includes(channel)) {
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

function clearShiftArchive(payload = {}) {
    if (payload.role !== 'developer' && payload.role !== 'admin') {
        return { ok: false, error: 'Очистка смен доступна только администратору или разработчику' };
    }

    const before = shiftArchiveItems();
    saveShiftArchiveItems([]);
    return {
        ok: true,
        removed: before.length
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
            return markDataChangedForBackup(saveAuthAccount(payload), 'auth-account', 5000);
        case 'delete-auth-account':
            return markDataChangedForBackup(deleteAuthAccount(payload), 'auth-account-delete', 5000);
        case 'merge-auth-store':
            return markDataChangedForBackup(mergeAuthStore(payload), 'auth-account-merge', 5000);
        case 'get-rates':
            return { ok: true, rates: readRatesSettings(), path: ratesSettingsPath };
        case 'save-rates':
            return markDataChangedForBackup({ ok: true, rates: writeRatesSettings(payload?.rates || payload), path: ratesSettingsPath }, 'rates', 5000);
        case 'save-bill':
            saveBill(payload);
            scheduleGithubBackup('save-bill', 5000);
            return { ok: true };
        case 'delete-bill':
            return markDataChangedForBackup(deleteBillToTrash(payload?.id, payload?.item), 'delete-bill', 5000);
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
            return markDataChangedForBackup(saveSplitPayment(payload), 'save-split-payment', 5000);
        case 'get-split-payments':
            return readJson(splitPath);
        case 'delete-split-payment':
            return markDataChangedForBackup(deleteSplitPayment(payload), 'delete-split-payment', 5000);
        case 'restore-from-trash':
            return markDataChangedForBackup(restoreFromTrashItem(payload), 'restore-from-trash', 5000);
        case 'save-tip':
            return markDataChangedForBackup(saveTipEntry(payload), 'save-tip', 5000);
        case 'delete-tip':
            return markDataChangedForBackup(deleteTipEntry(payload), 'delete-tip', 5000);
        case 'close-shift':
            return markDataChangedForBackup(closeShiftForUser(payload?.user, payload), 'close-shift', 1000);
        case 'clear-developer-history':
            return markDataChangedForBackup(clearDeveloperHistory(payload?.user), 'clear-developer-history', 1000);
        case 'clear-common-history':
            return markDataChangedForBackup(clearCommonHistory(payload?.user), 'clear-common-history', 1000);
        case 'get-shift-archive':
            return shiftArchiveItems();
        case 'clear-week-history':
            return markDataChangedForBackup(clearWeekShiftArchive(payload), 'clear-week-history', 1000);
        case 'clear-shift-archive':
            return markDataChangedForBackup(clearShiftArchive(payload), 'clear-shift-archive', 1000);
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
let suppressMainFocusUntil = 0;

function preferredWindowBounds() {
    const workArea = screen.getPrimaryDisplay()?.workAreaSize || { width: 1200, height: 900 };
    const width = Math.max(720, Math.min(1200, workArea.width - 32));
    const height = Math.max(560, Math.min(900, workArea.height - 32));
    return { width, height };
}

function createWindow() {
    const windowBounds = preferredWindowBounds();
    win = new BrowserWindow({
        width: windowBounds.width,
        height: windowBounds.height,
        minWidth: 720,
        minHeight: 560,
        title: "Калькулятор (База: " + folderPath + ")",
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    win.loadFile(path.join(folderPath, 'index.html'));

    const focusAmountAfterRestore = () => {
        if (Date.now() < suppressMainFocusUntil) {
            return;
        }
        setTimeout(focusMainAmountInput, 80);
    };
    win.on('restore', focusAmountAfterRestore);
    win.on('show', focusAmountAfterRestore);
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
    setTimeout(focusMainAmountInput, 80);
    return { ok: true, visible: true, alwaysOnTop: true };
}

function focusMainAmountInput() {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('focus-main-amount');
}

function showWindowForHotkey({ suppressAutoFocus = false } = {}) {
    if (!win || win.isDestroyed()) return;
    if (suppressAutoFocus) suppressMainFocusUntil = Date.now() + 700;
    if (win.isMinimized()) win.restore();
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
    win.focus();
}

function minimizeAppWindow() {
    if (!win || win.isDestroyed()) return { ok: false, error: 'Окно приложения не найдено' };
    win.setAlwaysOnTop(false);
    win.minimize();
    return { ok: true };
}

function parsePosAmountFromOcr(text = '') {
    const normalized = String(text || '')
        .replace(/[OoОо]/g, '0')
        .replace(/[ІӀl]/g, '1')
        .replace(/[٫]/g, '.')
        .replace(/(\d)[,.][ \t]+(\d{3})(?=[,.])/g, '$1,$2');
    const matches = [];
    const pushAmount = (integerPart, raw) => {
        const digits = String(integerPart || '').replace(/\D/g, '');
        const value = Number.parseInt(digits, 10);
        if (Number.isFinite(value) && value > 0 && value < 100000000) {
            matches.push({ value, raw: String(raw || '').trim(), digits });
        }
    };

    const amountPattern = /(^|[^\d,.'`’])(?:[$֏]\s*)?([0-9]{1,3}(?:[ ,.'`’][0-9]{3})+|[0-9]{2,})([.,][0-9]{1,2})/g;
    let match;
    while ((match = amountPattern.exec(normalized)) !== null) {
        pushAmount(match[2], match[0]);
    }

    if (!matches.length) {
        const currencyIntegerPattern = /(^|[^\d,.'`’])(?:[$֏]\s*)?([0-9]{1,3}(?:[ ,.'`’][0-9]{3})+|[0-9]{3,})\s*(?:[$֏]|AMD|֏)/gi;
        while ((match = currencyIntegerPattern.exec(normalized)) !== null) {
            pushAmount(match[2], match[0]);
        }
    }

    if (!matches.length) return null;
    const withoutKeypadGlue = matches.filter(candidate => !matches.some(other =>
        other !== candidate
        && candidate.digits.length === other.digits.length + 1
        && candidate.digits.startsWith('5')
        && candidate.digits.endsWith(other.digits)
    ));
    const usableMatches = withoutKeypadGlue.length ? withoutKeypadGlue : matches;
    return usableMatches[usableMatches.length - 1];
}

function windowsOcrImage(imagePath) {
    return new Promise(resolve => {
        const safePath = String(imagePath || '').replace(/'/g, "''");
        const script = `
$ImagePath = '${safePath}'
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] > $null
[Windows.Storage.FileAccessMode, Windows.Storage, ContentType=WindowsRuntime] > $null
[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime] > $null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] > $null
[Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime] > $null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] > $null
function Await($Operation, [Type]$ResultType) {
    $method = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 })[0]
    $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.Wait()
    $task.Result
}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { exit 2 }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
Write-Output $result.Text
`;
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        execFile(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
            windowsHide: true,
            timeout: 9000,
            maxBuffer: 1024 * 1024
        }, (error, stdout) => {
            if (error) {
                console.error('[POS OCR] OCR failed:', error.message || error);
                resolve('');
                return;
            }
            resolve(String(stdout || ''));
        });
    });
}

const posAmountMinReliableAmount = 400;
const posCaptureHideWaitMs = 75;
const posOcrScale = 1.7;
const posOcrDebugDir = path.join(electronProfilePath, 'ocr_debug');
let posOcrDebugWindow = null;
let mainCurrentRole = '';
let mainCurrentSettings = { ...DEFAULT_USER_SETTINGS };

function escapeDebugHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function resetPosOcrDebugDir() {
    fs.mkdirSync(posOcrDebugDir, { recursive: true });
    fs.readdirSync(posOcrDebugDir).forEach(fileName => {
        const fullPath = path.join(posOcrDebugDir, fileName);
        try {
            if (fs.statSync(fullPath).isFile()) fs.unlinkSync(fullPath);
        } catch {}
    });
}

function copyCaptureForDebug(capturePath, sourceLabel) {
    try {
        fs.mkdirSync(posOcrDebugDir, { recursive: true });
        const cleanSource = String(sourceLabel || 'capture').replace(/[^\w.-]+/g, '_').slice(0, 42);
        const debugPath = path.join(posOcrDebugDir, `pos_ocr_${Date.now()}_${cleanSource}_${path.basename(capturePath)}`);
        fs.copyFileSync(capturePath, debugPath);
        return debugPath;
    } catch {
        return '';
    }
}

function showPosOcrDebugWindow(report = {}) {
    fs.mkdirSync(posOcrDebugDir, { recursive: true });
    const items = Array.isArray(report.debugItems) ? report.debugItems : [];
    const rows = items.map((item, index) => `
        <section class="card ${item.accepted ? 'accepted' : ''}">
            <div class="meta">
                <b>#${index + 1} ${escapeDebugHtml(item.source || '')}</b>
                <span>${escapeDebugHtml(item.file || '')}</span>
            </div>
            <div class="choice ${item.accepted ? 'ok' : ''}">
                OCR сумма: <b>${item.amount ? escapeDebugHtml(item.amount) : '-'}</b>
                ${item.raw ? `<span>raw: ${escapeDebugHtml(item.raw)}</span>` : ''}
                ${item.reason ? `<em>${escapeDebugHtml(item.reason)}</em>` : ''}
            </div>
            ${item.imagePath ? `<img src="${pathToFileURL(item.imagePath).href}" alt="capture">` : ''}
            <pre>${escapeDebugHtml(item.text || '')}</pre>
        </section>
    `).join('');
    const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>F3 OCR тест</title>
<style>
body { margin: 0; padding: 18px; font-family: Arial, sans-serif; background: #111820; color: #eef5f6; }
h1 { margin: 0 0 8px; font-size: 20px; }
.summary { padding: 12px; border-radius: 10px; background: ${report.ok ? '#143f34' : '#4a2020'}; margin-bottom: 14px; font-weight: 800; }
.summary small { display: block; margin-top: 4px; opacity: .8; font-weight: 600; }
.card { background: #202b2f; border: 2px solid #34454b; border-radius: 12px; padding: 12px; margin-bottom: 14px; }
.card.accepted { border-color: #00e6c3; }
.meta { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; color: #b9c8cc; margin-bottom: 8px; }
.choice { color: #ff7675; font-weight: 800; margin-bottom: 8px; }
.choice.ok { color: #55efc4; }
.choice span, .choice em { margin-left: 10px; color: #dfe6e9; font-style: normal; }
img { display: block; max-width: 100%; border: 1px solid #4b6067; border-radius: 8px; background: #000; margin-bottom: 8px; }
pre { white-space: pre-wrap; word-break: break-word; background: #0d1418; border-radius: 8px; padding: 10px; color: #dfe6e9; font-size: 12px; max-height: 220px; overflow: auto; }
</style>
</head>
<body>
<h1>F3 OCR тест</h1>
<div class="summary">
${report.ok ? `Выбрано: ${escapeDebugHtml(report.amount)} AMD` : escapeDebugHtml(report.error || 'Сумма не найдена')}
<small>Версия FX_App: ${escapeDebugHtml(APP_VERSION)}</small>
<small>Эта диагностика открывается только в режиме Разработка через F4.</small>
</div>
${rows || '<div class="card">Скриншотов для OCR нет. Возможно, окно POS не найдено и экран не удалось снять.</div>'}
</body>
</html>`;
    const htmlPath = path.join(posOcrDebugDir, 'last_ocr_debug.html');
    fs.writeFileSync(htmlPath, html, 'utf8');

    if (!posOcrDebugWindow || posOcrDebugWindow.isDestroyed()) {
        posOcrDebugWindow = new BrowserWindow({
            width: 1120,
            height: 860,
            title: 'F3 OCR тест',
            alwaysOnTop: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true
            }
        });
        posOcrDebugWindow.on('closed', () => { posOcrDebugWindow = null; });
    }
    posOcrDebugWindow.loadFile(htmlPath).catch(err => console.error('[POS OCR] Debug window failed:', err));
    posOcrDebugWindow.show();
    posOcrDebugWindow.focus();
}

async function readPosAmountFromCapturePaths(capturePaths = [], sourceLabel = '', options = {}) {
    const debugItems = [];
    let bestSmallResult = null;
    const minReliableAmount = Math.max(1, Number(options.minReliableAmount) || posAmountMinReliableAmount);
    try {
        for (const capturePath of capturePaths) {
            const debugItem = options.debug ? {
                source: sourceLabel,
                file: path.basename(capturePath),
                imagePath: copyCaptureForDebug(capturePath, sourceLabel),
                text: '',
                amount: null,
                raw: '',
                accepted: false,
                reason: ''
            } : null;
            const text = await windowsOcrImage(capturePath);
            const amount = parsePosAmountFromOcr(text);
            if (debugItem) {
                debugItem.text = text;
                debugItem.amount = amount?.value || null;
                debugItem.raw = amount?.raw || '';
                debugItems.push(debugItem);
            }
            if (!amount) {
                if (debugItem) debugItem.reason = 'сумма не найдена';
                continue;
            }
            const result = { ok: true, amount: amount.value, raw: amount.raw, text, source: sourceLabel };
            if (amount.value >= minReliableAmount) {
                if (debugItem) {
                    debugItem.accepted = true;
                    debugItem.reason = 'выбрано';
                }
                return { result, debugItems };
            }
            if (debugItem) debugItem.reason = `меньше ${minReliableAmount}`;
            if (!bestSmallResult || amount.value > bestSmallResult.amount) {
                bestSmallResult = result;
            }
        }
        if (bestSmallResult) {
            console.warn('[POS OCR] Ignored suspicious small amount:', bestSmallResult.amount, bestSmallResult.raw);
        }
    } finally {
        capturePaths.forEach(capturePath => fs.promises.unlink(capturePath).catch(() => {}));
    }
    return { result: null, debugItems };
}

function areaIntersection(a, b) {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    return { x: left, y: top, width, height, area: width * height };
}

function displayForPosOcrArea(area) {
    const displays = screen.getAllDisplays();
    let best = null;
    let bestArea = 0;
    displays.forEach(display => {
        const hit = areaIntersection(area, display.bounds);
        if (hit.area > bestArea) {
            bestArea = hit.area;
            best = display;
        }
    });
    if (best) return best;
    return screen.getDisplayNearestPoint({
        x: Math.round(area.x + area.width / 2),
        y: Math.round(area.y + area.height / 2)
    });
}

async function captureConfiguredPosArea(area, options = {}) {
    if (!desktopCapturer) throw new Error('Захват экрана недоступен');
    const normalized = normalizePosOcrArea(area);
    if (!normalized) throw new Error('Область POS не выбрана');

    const display = displayForPosOcrArea(normalized);
    if (!display) throw new Error('Не найден экран для выбранной области POS');

    const scaleFactor = Number(display.scaleFactor) || 1;
    const width = Math.max(1, Math.round((display.size?.width || display.bounds.width) * scaleFactor));
    const height = Math.max(1, Math.round((display.size?.height || display.bounds.height) * scaleFactor));
    const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height }
    });
    const source = sources.find(item => String(item.display_id || '') === String(display.id || '')) || sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error('Не удалось сделать скрин выбранного экрана');

    const image = source.thumbnail;
    const size = image.getSize();
    const cropRect = {
        x: Math.max(0, Math.round((normalized.x - display.bounds.x) * scaleFactor)),
        y: Math.max(0, Math.round((normalized.y - display.bounds.y) * scaleFactor)),
        width: Math.max(1, Math.round(normalized.width * scaleFactor)),
        height: Math.max(1, Math.round(normalized.height * scaleFactor))
    };
    cropRect.width = Math.min(cropRect.width, size.width - cropRect.x);
    cropRect.height = Math.min(cropRect.height, size.height - cropRect.y);
    if (cropRect.width <= 1 || cropRect.height <= 1) {
        throw new Error('Выбранная область POS вышла за пределы экрана');
    }

    const crop = image.crop(cropRect);
    const enlarged = crop.resize({
        width: Math.min(1800, Math.max(cropRect.width, Math.round(cropRect.width * posOcrScale))),
        height: Math.min(900, Math.max(cropRect.height, Math.round(cropRect.height * posOcrScale))),
        quality: 'best'
    });
    const stamp = Date.now();
    const capturePath = path.join(electronProfilePath, `pos_configured_area_${stamp}.png`);
    fs.writeFileSync(capturePath, enlarged.toPNG());
    return capturePath;
}

async function readPosAmountFromScreen(options = {}) {
    if (options.debug) resetPosOcrDebugDir();
    const { exists, area } = readPosOcrArea();
    if (!exists) {
        return { ok: false, error: 'config.json отсутствует. Выберите область POS в настройках.', debugItems: [] };
    }
    if (!area) {
        return { ok: false, error: 'Область POS не выбрана. Откройте настройки и нажмите "Выбрать область".', debugItems: [] };
    }

    let capturePath = '';
    try {
        capturePath = await captureConfiguredPosArea(area, options);
        const read = await readPosAmountFromCapturePaths([capturePath], 'saved POS area', {
            ...options,
            minReliableAmount: 1
        });
        if (read.result) return { ...read.result, area, debugItems: read.debugItems || [] };
        return { ok: false, error: 'OCR ничего не распознал в выбранной области POS', area, debugItems: read.debugItems || [] };
    } catch (err) {
        if (capturePath) fs.promises.unlink(capturePath).catch(() => {});
        return { ok: false, error: err.message || String(err), area, debugItems: [] };
    }
}

function virtualScreenBounds() {
    const displays = screen.getAllDisplays();
    if (!displays.length) {
        const primary = screen.getPrimaryDisplay();
        return primary.bounds;
    }
    const left = Math.min(...displays.map(display => display.bounds.x));
    const top = Math.min(...displays.map(display => display.bounds.y));
    const right = Math.max(...displays.map(display => display.bounds.x + display.bounds.width));
    const bottom = Math.max(...displays.map(display => display.bounds.y + display.bounds.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
}

let posAreaSelectionWindow = null;
let posAreaSelectionResolver = null;

function closePosAreaSelection(result) {
    if (posAreaSelectionResolver) {
        const resolve = posAreaSelectionResolver;
        posAreaSelectionResolver = null;
        resolve(result);
    }
    if (posAreaSelectionWindow && !posAreaSelectionWindow.isDestroyed()) {
        posAreaSelectionWindow.close();
    }
    posAreaSelectionWindow = null;
}

function selectPosOcrAreaOverlay() {
    if (posAreaSelectionWindow && !posAreaSelectionWindow.isDestroyed()) {
        posAreaSelectionWindow.focus();
        return Promise.resolve({ ok: false, error: 'Выбор области уже открыт' });
    }

    const wasVisible = win && !win.isDestroyed() && win.isVisible();
    const wasMinimized = win && !win.isDestroyed() && win.isMinimized();
    if (win && !win.isDestroyed()) {
        win.hide();
    }

    const bounds = virtualScreenBounds();
    return new Promise(resolve => {
        posAreaSelectionResolver = result => {
            if (wasVisible && win && !win.isDestroyed()) {
                if (wasMinimized) win.minimize();
                else showWindowForHotkey();
            }
            resolve(result);
        };

        posAreaSelectionWindow = new BrowserWindow({
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            frame: false,
            transparent: true,
            fullscreenable: false,
            alwaysOnTop: true,
            skipTaskbar: true,
            resizable: false,
            movable: false,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            }
        });
        posAreaSelectionWindow.setAlwaysOnTop(true, 'screen-saver');
        posAreaSelectionWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        posAreaSelectionWindow.on('closed', () => {
            if (posAreaSelectionResolver) closePosAreaSelection({ ok: false, error: 'Выбор области отменен' });
        });

        const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; cursor: crosshair; background: rgba(0,0,0,0.10); user-select: none; }
#hint { position: fixed; left: 50%; top: 18px; transform: translateX(-50%); padding: 10px 14px; border-radius: 10px; background: rgba(17,24,32,.94); color: #fff; font: 800 14px Arial, sans-serif; box-shadow: 0 8px 22px rgba(0,0,0,.35); pointer-events: none; }
#rect { position: fixed; display: none; border: 3px solid #00e6c3; background: rgba(0,230,195,.14); box-shadow: 0 0 0 9999px rgba(0,0,0,.18); }
#size { position: fixed; display: none; padding: 5px 8px; border-radius: 7px; background: #111820; color: #55efc4; font: 800 12px Arial, sans-serif; pointer-events: none; }
</style>
</head>
<body>
<div id="hint">Выделите мышкой область суммы POS. ESC - отмена.</div>
<div id="rect"></div>
<div id="size"></div>
<script>
const { ipcRenderer } = require('electron');
const offset = ${JSON.stringify({ x: bounds.x, y: bounds.y })};
let start = null;
let current = null;
const rect = document.getElementById('rect');
const size = document.getElementById('size');
function draw() {
  if (!start || !current) return;
  const x = Math.min(start.x, current.x);
  const y = Math.min(start.y, current.y);
  const width = Math.abs(current.x - start.x);
  const height = Math.abs(current.y - start.y);
  rect.style.display = 'block';
  rect.style.left = x + 'px';
  rect.style.top = y + 'px';
  rect.style.width = width + 'px';
  rect.style.height = height + 'px';
  size.style.display = 'block';
  size.style.left = (x + width + 8) + 'px';
  size.style.top = y + 'px';
  size.textContent = Math.round(width) + ' x ' + Math.round(height);
}
window.addEventListener('mousedown', event => {
  start = { x: event.clientX, y: event.clientY };
  current = { ...start };
  draw();
});
window.addEventListener('mousemove', event => {
  if (!start) return;
  current = { x: event.clientX, y: event.clientY };
  draw();
});
window.addEventListener('mouseup', event => {
  if (!start) return;
  current = { x: event.clientX, y: event.clientY };
  const x = Math.min(start.x, current.x);
  const y = Math.min(start.y, current.y);
  const width = Math.abs(current.x - start.x);
  const height = Math.abs(current.y - start.y);
  if (width < 8 || height < 8) {
    ipcRenderer.send('pos-ocr-area-cancelled');
    return;
  }
  ipcRenderer.send('pos-ocr-area-selected', {
    x: Math.round(x + offset.x),
    y: Math.round(y + offset.y),
    width: Math.round(width),
    height: Math.round(height)
  });
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') ipcRenderer.send('pos-ocr-area-cancelled');
});
</script>
</body>
</html>`;
        posAreaSelectionWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        posAreaSelectionWindow.show();
        posAreaSelectionWindow.focus();
    });
}

let posAmountHotkeyBusy = false;

async function importPosAmountHotkey() {
    if (posAmountHotkeyBusy) return;
    posAmountHotkeyBusy = true;
    try {
        const shouldHideForCapture = win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
        if (shouldHideForCapture) {
            win.setAlwaysOnTop(false);
            win.hide();
            await wait(posCaptureHideWaitMs);
        }
        const result = await readPosAmountFromScreen();
        showWindowForHotkey({ suppressAutoFocus: Boolean(result?.ok) });
        if (result?.ok) {
            win.webContents.send('pos-amount-detected', {
                amount: result.amount,
                raw: result.raw
            });
        } else {
            win.webContents.send('pos-amount-error', {
                error: result?.error || 'OCR ничего не распознал'
            });
            focusMainAmountInput();
        }
    } catch (err) {
        console.error('[HOTKEY] F3 import failed:', err);
        showWindowForHotkey();
        focusMainAmountInput();
    } finally {
        posAmountHotkeyBusy = false;
    }
}

async function importPosAmountRequest(options = {}) {
    const shouldHideForCapture = win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
    if (shouldHideForCapture) {
        win.setAlwaysOnTop(false);
        win.hide();
        await wait(posCaptureHideWaitMs);
    }
    const result = await readPosAmountFromScreen(options);
    showWindowForHotkey({ suppressAutoFocus: Boolean(result?.ok) });
    return result;
}

async function debugPosAmountHotkey() {
    if (mainCurrentRole !== 'developer') return;
    if (posAmountHotkeyBusy) return;
    posAmountHotkeyBusy = true;
    try {
        const shouldHideForCapture = win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
        if (shouldHideForCapture) {
            win.setAlwaysOnTop(false);
            win.hide();
            await wait(posCaptureHideWaitMs);
        }
        const result = await readPosAmountFromScreen({ debug: true });
        showWindowForHotkey();
        showPosOcrDebugWindow(result);
        focusMainAmountInput();
    } catch (err) {
        console.error('[HOTKEY] F4 debug failed:', err);
        showWindowForHotkey();
        focusMainAmountInput();
    } finally {
        posAmountHotkeyBusy = false;
    }
}

function registerWindowHotkeys() {
    ['F1'].forEach(accelerator => {
        try {
            globalShortcut.register(accelerator, () => {
                if (!mainCurrentSettings.enableF1Toggle) return;
                toggleWindowVisibilityHotkey();
            });
        } catch (err) {
            console.error(`[HOTKEY] Cannot register ${accelerator}:`, err);
        }
    });
    try {
        globalShortcut.register('F3', () => {
            if (!mainCurrentSettings.enableF3Import) return;
            importPosAmountHotkey().catch(err => console.error('[HOTKEY] F3 import failed:', err));
        });
    } catch (err) {
        console.error('[HOTKEY] Cannot register F3:', err);
    }
    try {
        globalShortcut.register('F4', () => {
            debugPosAmountHotkey().catch(err => console.error('[HOTKEY] F4 debug failed:', err));
        });
    } catch (err) {
        console.error('[HOTKEY] Cannot register F4:', err);
    }
}

// --- ОБРАБОТЧИКИ (СТРОГО ПО ОДНОМУ РАЗУ) ---

ipcMain.on('set-current-session-role', (event, payload = {}) => {
    mainCurrentRole = String(payload.role || '').trim();
    mainCurrentSettings = normalizeUserSettings(payload.settings || {});
});

ipcMain.on('pos-ocr-area-selected', (event, area) => {
    try {
        const savedArea = writePosOcrArea(area);
        closePosAreaSelection({ ok: true, area: savedArea, path: appConfigPath });
    } catch (err) {
        closePosAreaSelection({ ok: false, error: err.message || String(err), path: appConfigPath });
    }
});

ipcMain.on('pos-ocr-area-cancelled', () => {
    closePosAreaSelection({ ok: false, error: 'Выбор области отменен', path: appConfigPath });
});

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
        scheduleGithubBackup('move-to-trash', 5000);
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

ipcMain.handle('get-user-settings', async (event, payload) => {
    try {
        return { ok: true, settings: readUserSettings(payload || {}) };
    } catch (err) {
        return { ok: false, error: err.message || String(err), settings: normalizeUserSettings({}) };
    }
});

ipcMain.handle('save-user-settings', async (event, payload) => {
    try {
        const result = writeUserSettings(payload || {});
        mainCurrentSettings = normalizeUserSettings(result.settings);
        return result;
    } catch (err) {
        return { ok: false, error: err.message || String(err), settings: normalizeUserSettings({}) };
    }
});

ipcMain.handle('get-pos-ocr-config', async () => {
    const { exists, area } = readPosOcrArea();
    return { ok: true, exists, area, path: appConfigPath };
});

ipcMain.handle('save-pos-ocr-area', async (event, payload) => {
    try {
        const area = writePosOcrArea(payload?.area || payload);
        return { ok: true, area, path: appConfigPath };
    } catch (err) {
        return { ok: false, error: err.message || String(err), path: appConfigPath };
    }
});

ipcMain.handle('select-pos-ocr-area', async () => {
    try {
        return await selectPosOcrAreaOverlay();
    } catch (err) {
        return { ok: false, error: err.message || String(err), path: appConfigPath };
    }
});

ipcMain.handle('test-pos-ocr-area', async () => {
    try {
        return await importPosAmountRequest({ debug: true, minReliableAmount: 1 });
    } catch (err) {
        showWindowForHotkey();
        return { ok: false, error: err.message || String(err) };
    }
});

ipcMain.handle('import-pos-amount', async () => {
    try {
        return await importPosAmountRequest({ minReliableAmount: 1 });
    } catch (err) {
        showWindowForHotkey();
        return { ok: false, error: err.message || String(err) };
    }
});

ipcMain.handle('get-github-backup-config', async () => {
    try {
        return { ok: true, config: publicBackupConfig(), status: githubBackupStatus };
    } catch (err) {
        return { ok: false, error: err.message || String(err), config: publicBackupConfig(DEFAULT_BACKUP_CONFIG), status: githubBackupStatus };
    }
});

ipcMain.handle('save-github-backup-config', async (event, payload) => {
    try {
        const config = writeBackupConfig(payload || {});
        return { ok: true, config: publicBackupConfig(config), status: githubBackupStatus };
    } catch (err) {
        return { ok: false, error: err.message || String(err), config: publicBackupConfig(), status: githubBackupStatus };
    }
});

ipcMain.handle('get-github-backup-status', async () => {
    return { ok: true, status: githubBackupStatus, config: publicBackupConfig() };
});

ipcMain.handle('run-github-backup', async (event, payload) => {
    try {
        return await performGithubBackup(payload?.reason || 'manual');
    } catch (err) {
        return { ok: false, error: err.message || String(err), status: githubBackupStatus };
    }
});

ipcMain.handle('check-github-backup', async () => {
    try {
        return await checkGithubBackup();
    } catch (err) {
        return { ok: false, error: err.message || String(err), status: githubBackupStatus };
    }
});

ipcMain.handle('restore-github-backup', async (event, payload) => {
    try {
        return await restoreGithubBackup(payload || {});
    } catch (err) {
        return { ok: false, error: err.message || String(err), status: githubBackupStatus };
    }
});

ipcMain.handle('clear-github-backup-repository-fields', async () => {
    try {
        return clearGithubBackupRepositoryFields();
    } catch (err) {
        return { ok: false, error: err.message || String(err), config: publicBackupConfig(), status: githubBackupStatus };
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

ipcMain.handle('clear-shift-archive', async (event, payload) => {
    try {
        return await handleIpcChannel('clear-shift-archive', payload);
    } catch (err) {
        console.error("Ошибка очистки смен:", err);
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

ipcMain.handle('minimize-app-window', async () => {
    return minimizeAppWindow();
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
