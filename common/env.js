const { existsSync, readdirSync } = require('node:fs');
const Path = require('node:path');
const OS = require('node:os');
const Package = require("../package.json");
const Util = require('./common-util');
const Keys = require('./keys');
const Core = require('./core');
const Constants = require('./constants');
const Default = require('../http-server/defaults');
const DecreesCore = require('./decrees-core');
const AdminDecrees = require('./admin-decrees');
const { jumpConsistentHash } = require('./consistent-hash');
const plugins = require('./plugin-manager');

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

const getInstalledOOVersions = (Env) => {
    const path = Path.join(Env.clientRoot, 'www/common/onlyoffice/dist');
    if (!existsSync(path)) {
        return [];
    }

    return readdirSync(path);
};

const init = (Env, mainConfig, pluginModules) => {
    const { config, infra } = mainConfig;
    const publicConfig = infra?.public || {};

    Env.config = config; // XXX
    Env.adminDecrees = DecreesCore.create(Constants.adminDecree,
                                          AdminDecrees);

    Env.modules = {
        Core, Util, Constants, DecreesCore
    };
    Object.assign(Env.modules, pluginModules || {});

    Env.myId = mainConfig.myId;

    Env.clientRoot = config?.clientRoot || '../cryptpad';

    Env.version = Package.version;
    Env.launchTime = +new Date();

    Env.numberStorages = infra.storage.length;
    Env.numberCores = infra.core.length;

    // TODO: implement storage migration later (in /storage/)
    Env.Util = Util;
    Env.Core = Core;
    Env.getStorageId = data => {
        // We need a 8 byte key
        // For public keys, make sure we always use the safe one
        // to avoid leading some commands to different nodes for
        // the same user
        data = Util.escapeKeyCharacters(data || '') + '00000000';
        const key = Buffer.from(data.slice(0, 8));
        const id = jumpConsistentHash(key, Env.numberStorages);
        return 'storage:' + id;
    };
    Env.getCoreId = data => {
        data = Util.escapeKeyCharacters(data) + '00000000';
        const key = Buffer.from(data.slice(0, 8));
        const id = jumpConsistentHash(key, Env.numberCores);
        return 'core:' + id;
    };

    (() => {
        const nodeTypes = ['front', 'core', 'storage', 'http'];
        const maxCpus = Object.keys(OS.cpus()).length;
        const maxWorkersPerNode = Math.floor(maxCpus / nodeTypes.length) || 1;

        Env.maxWorkers = typeof(config.maxWorkers) === 'object' ? config.maxWorkers : {};
        nodeTypes.forEach((type) => {
            if (typeof (Env.maxWorkers[type]) !== 'number' || Env.maxWorkers[type] <= 0) {
                Env.maxWorkers[type] = maxWorkersPerNode;
            }
        });
    })();

    Env.getDecree = type => {
        return Env.plugins[type]?.getDecree(Env) || Env.adminDecrees;
    };

    Env.allDecrees = {};
    Env.cacheDecrees = (type, decrees) => {
        type ||= 'admin';
        const cache = Env.allDecrees[type] ||= [];
        Array.prototype.push.apply(cache, decrees);
    };
    Env.getCachedDecrees = () => {
        return Env.allDecrees;
    };

    // Network
    Env.httpUnsafeOrigin = publicConfig?.origin;
    Env.httpSafeOrigin = publicConfig?.sandboxOrigin;
    const unsafe = new URL(Env.httpUnsafeOrigin);
    const safe = new URL(Env.httpSafeOrigin);
    Env.httpAddress = publicConfig?.httpHost || unsafe.hostname;
    Env.httpPort = publicConfig?.httpPort || unsafe.port;
    // XXX check these port values before release
    if (unsafe.port && unsafe.hostname === safe.hostname && safe.port) {
        Env.httpSafePort = safe.port;
    }
    if (publicConfig?.httpSafePort) {
        Env.httpSafePort = publicConfig.httpSafePort;
    }

    Env.protocol = unsafe.protocol;

    Env.websocketPath = publicConfig.externalWebsocketURL;
    Env.fileHost = publicConfig.fileHost || undefined;

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
    Env.enableEmbedding = false;
    Env.permittedEmbedders = publicConfig?.sandboxOrigin;
    Env.restrictRegistration = false;

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

    Env.logIP = config.logIP;

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

    let ooVersions = getInstalledOOVersions(Env);
    Env.onlyOffice = config.onlyOffice || (ooVersions.length ? {
          availableVersions: ooVersions,
    } : false);

    Env.shouldUpdateNode = !isRecentVersion();

    Env.paths = Core.getPaths(mainConfig, true);

    Env.plugins = plugins;
    plugins.call('customizeEnv')(Env);

    return Env;
};

module.exports = { init };
