const Package = require("../package.json");
const Keys = require('./keys');
const Core = require('./core');
const Constants = require('./constants');
const Default = require('../http-server/defaults');
const DecreesCore = require('./decrees-core');
const AdminDecrees = require('./admin-decrees');

const isRecentVersion = function () {
    let R = Default.recommendedVersion;
    let V = process.version;
    if (typeof(V) !== 'string') { return false; }
    let parts = V.replace(/^v/, '').split('.').map(Number);
    if (parts.length < 3) { return false; }
    if (!parts.every(n => typeof(n) === 'number' && !isNaN(n))) {
        return false;
    }
    if (parts[0] < R[0]) { return false; }
    if (parts[0] > R[0]) { return true; }

    // v16
    if (parts[1] < R[1]) { return false; }
    if (parts[1] > R[1]) { return true; }
    if (parts[2] >= R[2]) { return true; }

    return false;
};

const init = (Env, mainConfig) => {
    const { server /*, infra*/ } = mainConfig;
    const config = server?.options || {};
    const publicConfig = server?.public || {};

    Env.adminDecrees = DecreesCore.create(Constants.adminDecree,
                                          AdminDecrees);
    Env.myId = mainConfig.myId;

    Env.version = Package.version;

    // Network
    Env.httpUnsafeOrigin = publicConfig?.main?.origin;
    Env.httpSafeOrigin = publicConfig?.main?.sandboxOrigin;
    const unsafe = new URL(Env.httpUnsafeOrigin);
    const safe = new URL(Env.httpSafeOrigin);
    Env.httpAddress = unsafe.hostname;
    Env.httpPort = unsafe.port;
    if (unsafe.port && unsafe.hostname === safe.hostname) {
        Env.httpSafePort = safe.port;
    }
    Env.websocketPath = config.externalWebsocketURL;
    Env.fileHost = config.fileHost || undefined;

    // Setup
    Env.DEV_MODE = Boolean(process.env.DEV);
    Env.FRESH_KEY = (process.env.DEV || process.env.PACKAGE) ? '' : +new Date();
    Env.OFFLINE_MODE = Boolean(process.env.OFFLINE);

    // Special users
    Env.admins = (config.adminKeys || []).map(k => {
        try {
            return Keys.canonicalize(k);
        } catch (err) {
            return;
        }
    }).filter(Boolean);
    Env.adminEmail = config.adminEmail;
    Env.adminsData = (config.adminKeys || []).slice();

    Env.moderators = []; // XXX moderators
    Env.supportMailbox = undefined;
    Env.supportMailboxKey = undefined;

    // Broadcast
    Env.lastBroadcastHash = '';
    Env.maintenance = undefined;
    Env.surveyURL = undefined;

    // Instance Config, may be overriden by decrees
    Env.logFeedback = Boolean(config.logFeedback);
    Env.enableEmbedding = false; // XXX decree...
    Env.permittedEmbedders = publicConfig?.main?.sandboxOrigin;
    Env.restrictRegistration = false; // XXX decree

    Env.inactiveTime = config.inactiveTime;
    Env.defaultStorageLimit = typeof(config.defaultStorageLimit) === 'number' && config.defaultStorageLimit >= 0?
        config.defaultStorageLimit:
        Core.DEFAULT_LIMIT;

    Env.maxUploadSize = config.maxUploadSize || (20 * 1024 * 1024);
    Env.premiumUploadSize = Math.max(Env.maxUploadSize,
                                Number(config.premiumUploadSize) || 0);
    Env.removeDonateButton = config.removeDonateButton;
    Env.listMyInstance = false;
    Env.enforceMFA = config.enforceMFA;

    Env.instanceName = {};
    Env.instanceDescription = {};
    Env.instanceJurisdiction = {};
    Env.instanceNotice = {};

    Env.limits = {};
    Env.customLimits = {};

    // XXX plugins
    // plugins can includes custom Env values

    Env.onlyOffice = false; // XXX TODO OO

    Env.shouldUpdateNode = !isRecentVersion();

    Env.paths = Core.getPaths(mainConfig, true);

    return Env;
};

module.exports = { init };
