const Package = require("../package.json");
const Util = require('./common-util');
const Keys = require('./keys');
const Core = require('./core');
const Constants = require('./constants');
const Default = require('../http-server/defaults');
const DecreesCore = require('./decrees-core');
const AdminDecrees = require('./admin-decrees');
const { jumpConsistentHash } = require('./consistent-hash');

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
    const { server , infra } = mainConfig;
    const config = server?.options || {};
    const publicConfig = server?.public || {};

    Env.adminDecrees = DecreesCore.create(Constants.adminDecree,
                                          AdminDecrees);
    Env.myId = mainConfig.myId;

    Env.clientRoot = config?.clientRoot || '../cryptpad';

    Env.version = Package.version;
    Env.launchTime = +new Date();

    Env.numberStorages = infra.storage.length;
    Env.numberCores = infra.core.length;

    // TODO: implement storage migration later (in /storage/)
    Env.getStorageId = data => {
        // We need a 8 byte key
        // For public keys, make sure we always use the safe one
        // to avoid leading some commands to different nodes for
        // the same user
        data = Util.escapeKeyCharacters(data || '');
        const key = Buffer.from(data.slice(0, 8));
        const id = jumpConsistentHash(key, Env.numberStorages);
        return 'storage:' + id;
    };
    Env.getCoreId = data => {
        data = Util.escapeKeyCharacters(data);
        const key = Buffer.from(data.slice(0, 8));
        const id = jumpConsistentHash(key, Env.numberCores);
        return 'core:' + id;
    };

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
    Env.protocol = unsafe.protocol;

    // XXX improve config
    if (config.origin) { Env.httpUnsafeOrigin = config.origin; }
    if (config.sandboxOrigin) { Env.httpSafeOrigin = config.sandboxOrigin; }


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

    Env.disableIntegratedTasks = config.disableIntegratedTasks || false;
    Env.disableIntegratedEviction = typeof(config.disableIntegratedEviction) === 'undefined'? true: config.disableIntegratedEviction;
    Env.lastEviction = +new Date();
    Env.evictionReport = {};

    Env.installMethod = config.installMethod || undefined;

    Env.inactiveTime = config.inactiveTime;
    Env.accountRetentionTime = config.accountRetentionTime;
    Env.archiveRetentionTime = config.archiveRetentionTime;


    Env.defaultStorageLimit = typeof(config.defaultStorageLimit) === 'number' && config.defaultStorageLimit >= 0?
        config.defaultStorageLimit:
        Core.DEFAULT_LIMIT;

    Env.maxUploadSize = config.maxUploadSize || (20 * 1024 * 1024);
    Env.premiumUploadSize = Math.max(Env.maxUploadSize,
                                Number(config.premiumUploadSize) || 0);
    Env.removeDonateButton = config.removeDonateButton;
    Env.listMyInstance = false;
    Env.enforceMFA = config.enforceMFA;

    Env.consentToContact = false;
    Env.instanceName = {};
    Env.instanceDescription = {};
    Env.instanceJurisdiction = {};
    Env.instanceNotice = {};

    // Accounts
    Env.blockDailyCheck = config.blockDailyCheck === true;
    Env.provideAggregateStatistics = false;
    Env.updateAvailable = undefined;
    Env.accountsLimits = {}; // from accounts
    Env.customLimits = {}; // from decrees
    Env.limits = {}; // accounts & decrees merged

    // TOTP
    // Number of hours (default 7 days)
    Env.otpSessionExpiration = config.otpSessionExpiration;

    // XXX plugins
    // plugins can includes custom Env values

    // XXX ACCOUNTS
    Env.accounts_api = config.accounts_api; // XXX move to plugin
    let acc_domain = new URL(Env.httpUnsafeOrigin);
    Env.accounts_domain = acc_domain.host;

    // XXX curve keys for form deletion
    // XXX enforceMFA

    Env.onlyOffice = false; // XXX TODO OO

    Env.shouldUpdateNode = !isRecentVersion();

    Env.paths = Core.getPaths(mainConfig, true);

    return Env;
};

module.exports = { init };
