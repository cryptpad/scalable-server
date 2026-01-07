const Util = require('../../common/common-util.js');
const Keys = require("../../common/keys");

const StorageCommands = require('./storage');

const Core = require("../../common/core");

const Admin = {};

// CryptPad_AsyncStore.rpc.send('ADMIN', ['GET_WORKER_PROFILES'], console.log)
// To remove?
const getWorkerProfiles = function(Env, _publicKey, _data, cb) {
    cb(void 0, Env.commandTimers);
};


const getInvitations = (Env, _publicKey, _data, cb) => {
    Env.interface.broadcast('storage', 'ADMIN_CMD', { cmd: 'GET_INVITATIONS' }, (_err, data) => {
        // It’s necessary to add the arguments for Object.assign as reduce
        // provides extra arguments to its callback function that interfers with
        // extra arguments of Object.assign
        const invitations = data.reduce((acc, it) => Object.assign(acc, it), {});
        cb(void 0, invitations);
    });
};

var createInvitation = (_Env, _publicKey, _data, cb) => {
    return cb('E_NOT_IMPLEMENTED');
    // const args = Array.isArray(data) && data[1];
    // if (!args || typeof(args) !== 'object') { return void cb("EINVAL"); }
    // Invitation.create(Env, args.alias, args.email, cb, publicKey);
};

var deleteInvitation = (_Env, _publicKey, _data, cb) => {
    return cb('E_NOT_IMPLEMENTED');
    // var id = Array.isArray(data) && data[1];
    // Invitation.delete(Env, id, cb);
};


// CryptPad_AsyncStore.rpc.send('ADMIN', ['GET_ACTIVE_SESSIONS'], console.log)
var getActiveSessions = function(_Env, _publicKey, _data, cb) {
    return cb('E_NOT_IMPLEMENTED');
    // TODO: do the total (unique TBD)
    // XXX to check later

    // var stats = Server.getSessionStats();
    // cb(void 0, [
    //     stats.total,
    //     stats.unique
    // ]);
};

var getActiveChannelCount = (_Env, _publicKey, _data, cb) => {
    return cb('E_NOT_IMPLEMENTED');
    // cb(void 0, Server.getActiveChannelCount());
    // Env.channel_cache from storage
};

const flushCache = (Env, _publicKey, _data, cb) => {
    Env.interface.broadcast('websocket', 'ADMIN_CMD', {
        cmd: 'FLUSH_CACHE',
        data: { freshKey: +new Date() }
    }, () => { cb(void 0, true); });

    // To sync with core:0 as well
    // Send to websocket:0 (or storage:0, TBD) to be sent to core:0 to broadcast to every websocket
};

// To be removed (too costly)
const getDiskUsage = (Env, _publicKey, _data, cb) => {
    const sumDiskUsage = (acc, it) => {
        for (const key in it) {
            if (!acc[key]) { acc[key] = 0; }
            acc[key] += it[key];
        }
        return acc;
    };
    Env.interface.broadcast('storage', 'ADMIN_CMD', { cmd: 'GET_DISK_USAGE' }, (_err, data) => {
        const totalDiskUsage = data.reduce(sumDiskUsage, {});
        cb(void 0, totalDiskUsage);
    });
};

const getRegisteredUsers = (Env, _publicKey, _data, cb) => {
    Env.interface.broadcast('storage', 'GET_REGISTERED_USERS', {}, (_err, data) => {
        let users = data.reduce((acc, it) => acc + it?.users, 0);
        cb(void 0, { users });
    });
};

// XXX: To remove (not meaningful with multiple servers)
// To change format (not urgent)
const getFileDescriptorCount = (Env, _publicKey, _data, cb) => {
    Env.interface.broadcast('storage', 'ADMIN_CMD', { cmd: 'GET_FILE_DESCRIPTOR_COUNT' }, (_err, data) => {
        const fdCount = data.reduce((a, b) => a + b);
        cb(void 0, fdCount);
    });
};

// XXX: To remove (not meaningful if the above function doesn’t exist)
const getFileDescriptorLimit = (_Env, _publicKey, _data, cb) => {
    cb('E_NOT_IMPLEMENTED');
};

// Compute the total amount of use and store the result in a map indexed by
// storage names plus a total
const getCacheStats = (Env, _publicKey, _data, cb) => {
    Env.interface.broadcast('storage', 'ADMIN_CMD', { cmd: 'GET_CACHE_STATS' }, (err, data) => {
        if (err.length !== 0) {
            return cb(err);
        }
        let total = {};
        let result = {};
        for (let i = 0; i < data.length; i++) {
            const el = data[i];
            result[`storage:${i}`] = el;
            for (const x in el) {
                if (Object.prototype.hasOwnProperty.call(el, x)) {
                    if (typeof(el[x]) === 'number') {
                        total[x] = (total[x] ? total[x] : 0) + el[x];
                    } else if (typeof(el[x]) === 'object') {
                        total[x] = total[x] ? total[x] : {};
                        for (const y in el[x]) {
                            total[x][y] = (total[x][y] ? total[x][y] : 0) + el[x][y];
                        }
                    } else {
                        console.error('Warning in GET_CACHE_STATS: mismatched data');
                    }
                }
            }
        }
        result['total'] = total;
        cb(void 0, result);
    });
};

// CryptPad_AsyncStore.rpc.send('ADMIN', [ 'ADMIN_DECREE', ['RESTRICT_REGISTRATION', [true]]], console.log)
Admin.sendDecree = (Env, publicKey, data, cb) => {
    const value = data[1];
    if (!Array.isArray(value)) { return void cb('INVALID_DECREE'); }

    const command = value[0];
    const args = value[1];

    /*
    
    The admin should have sent a command to be run:
    
    the server adds two pieces of information to the supplied decree:
    
    * the unsafeKey of the admin who uploaded it
    * the current time
    
    1. test the command to see if it's valid and will result in a change
    2. if so, apply it and write it to the log for persistence
    3. respond to the admin with an error or nothing
    
    */

    const decree = [command, args, publicKey, +new Date()];

    // Send to storage:0
    Env.interface.sendQuery('storage:0', 'ADMIN_DECREE', decree, response => {
        cb(response.error, response.data);
    });
};

// addFirstAdmin is an anon_rpc command
Admin.addFirstAdmin = (Env, data, cb) => {
    if (!Env.installToken) { return void cb('EINVAL'); }
    const token = data.token;
    if (!token || !data.edPublic) { return void cb('MISSING_ARGS'); }
    if (token.length !== 64 || data.edPublic.length !== 44) { return void cb('INVALID_ARGS'); }
    if (token !== Env.installToken) { return void cb('FORBIDDEN'); }
    if (Array.isArray(Env.admins) && Env.admins.length) { return void cb('EEXISTS'); }

    const key = data.edPublic;

    Admin.sendDecree(Env, "", ['ADD_FIRST_ADMIN', [
        'ADD_ADMIN_KEY',
        [key]
    ]], (err) => {
        if (err) { return void cb(err); }
        cb();
    });
};

const checkTestDecree = (Env, publicKey, data, cb) => {
    cb(void 0, Env.testDecreeValue);
};

// CryptPad_AsyncStore.rpc.send('ADMIN', ['INSTANCE_STATUS'], console.log)
const getAdminsData = (Env) => {
    return Env.adminsData?.map(str => {
        // str is either a full public key or just the ed part
        const edPublic = Keys.canonicalize(str);
        const hardcoded = Array.isArray(Env.config.adminKeys) &&
            Env.config.adminKeys.some(key => {
                return Keys.canonicalize(key) === edPublic;
            });
        if (str.length === 44) {
            return { edPublic, first: true, hardcoded };
        }
        let name;
        try {
            const parsed = Keys.parseUser(str);
            name = parsed.user;
        } catch (e) { }
        return {
            edPublic, hardcoded, name
        };
    });
};

const instanceStatus = (Env, _publicKey, _data, cb) => {

    cb(void 0, {

        appsToDisable: Env.appsToDisable,
        restrictRegistration: Env.restrictRegistration,
        restrictSsoRegistration: Env.restrictSsoRegistration,
        dontStoreSSOUsers: Env.dontStoreSSOUsers,
        dontStoreInvitedUsers: Env.dontStoreInvitedUsers,

        enableEmbedding: Env.enableEmbedding,
        launchTime: Env.launchTime,
        currentTime: +new Date(),

        inactiveTime: Env.inactiveTime,
        accountRetentionTime: Env.accountRetentionTime,
        archiveRetentionTime: Env.archiveRetentionTime,

        defaultStorageLimit: Env.defaultStorageLimit,

        lastEviction: Env.lastEviction,
        evictionReport: Env.evictionReport,

        disableIntegratedEviction: Env.disableIntegratedEviction,
        disableIntegratedTasks: Env.disableIntegratedTasks,

        enableProfiling: Env.enableProfiling,
        profilingWindow: Env.profilingWindow,

        maxUploadSize: Env.maxUploadSize,
        premiumUploadSize: Env.premiumUploadSize,

        consentToContact: Env.consentToContact,
        listMyInstance: Env.listMyInstance,
        provideAggregateStatistics: Env.provideAggregateStatistics,

        removeDonateButton: Env.removeDonateButton,
        blockDailyCheck: Env.blockDailyCheck,

        updateAvailable: Env.updateAvailable,
        instancePurpose: Env.instancePurpose,

        instanceDescription: Env.instanceDescription,
        instanceJurisdiction: Env.instanceJurisdiction,
        instanceName: Env.instanceName,
        instanceNotice: Env.instanceNotice,
        enforceMFA: Env.enforceMFA,

        admins: getAdminsData(Env)
    });
};

// CryptPad_AsyncStore.rpc.send('ADMIN', ['GET_LIMITS'], console.log)
const getLimits = (Env, _publicKey, _data, cb) => {
    cb(void 0, Env.limits);
};

const getUserTotalSize = (Env, _publicKey, data, cb) => {
    const signingKey = Array.isArray(data) && data[1];
    if (!Core.isValidPublicKey(signingKey)) { return void cb('EINVAL'); }
    const safeKey = Util.escapeKeyCharacters(signingKey);
    StorageCommands.getTotalSize(Env, safeKey, cb);
};

const getPinActivity = (Env, _publicKey, data, cb) => {
    const key = Array.isArray(data) && data[1];
    if (!Core.isValidPublicKey(key)) { return void cb("EINVAL"); }
    // the db-worker ensures the signing key is of the appropriate form
    Core.coreToStorage(Env, key, 'ADMIN_CMD', { cmd: 'GET_PIN_ACTIVITY', data: { key } }, cb);
};

const isUserOnlineHandle = (_Env, _safeKey, cb) => {
    // const userCore = Env.getCoreId(safeKey);
    // if (Env.myId !== userCore) { return void cb('EINVAL'); }
    cb(void 0, true);
    //cb('E_NOT_IMPLEMENTED');
    // XXX: TODO
};

const isUserOnline = (Env, _publicKey, data, cb) => {
    console.log('Call IS_USER_ONLINE', data);
    const safeKey = Array.isArray(data) && data[1];
    if (!Core.isValidPublicKey(safeKey)) { return void cb("EINVAL"); }
    // const unsafeKey = Util.unescapeKeyCharacters(safeKey);
    // const userCore = Env.getCoreId(unsafeKey);
    // TODO: send to the right websocket
    // if (Env.myId === userCore) {
    return void isUserOnlineHandle(Env, safeKey, cb);
    // }
};

const getUserQuota = (Env, _publicKey, data, cb) => {
    const key = Array.isArray(data) && data[1];
    if (!Core.isValidPublicKey(key)) { return void cb("EINVAL"); }
    Core.coreToStorage(Env, key, 'ADMIN_CMD', { cmd: 'GET_USER_QUOTA', data }, cb);
};

const getUserStorageStats = (Env, _key, data, cb) => {
    const unsafeKey = Array.isArray(data) && data[1];
    if (!Core.isValidPublicKey(unsafeKey)) { return void cb("EINVAL"); }
    Core.coreToStorage(Env, unsafeKey, 'ADMIN_CMD', { cmd: 'GET_USER_STORAGE_STATS', data }, cb);
};

const getPinLogStatus = (Env, _key, _data, cb) => {
    const data = { key: Array.isArray(_data) && _data[1] };
    if (!Core.isValidPublicKey(data.key)) { return void cb("EINVAL"); }
    Core.coreToStorage(Env, data.key, 'ADMIN_CMD', { cmd: 'GET_PIN_LOG_STATUS', data }, cb);
};

const channelCommand = (cmd) => (Env, _key, data, cb) => {
    const id = Array.isArray(data) && data[1];
    if (!Core.isValidId(id)) { return void cb('INVALID_CHAN'); }
    Core.coreToStorage(Env, id, 'ADMIN_CMD', { cmd, data: { id } }, cb);
};

const getKnownUsers = (Env, _publicKey, _data, cb) => {
    Env.interface.broadcast('storage', 'ADMIN_CMD', { cmd: 'GET_USERS' }, (_err, data) => {
        const knownUsers = data.reduce((acc, it) => Object.assign(acc, it), {});
        cb(void 0, knownUsers);
    });
};

const addKnownUser = (_Env, _unsafeKey, _data, cb) => {
    cb('E_NOT_IMPLEMENTED');
};

const getModerators = (Env, _publicKey, _data, cb) => {
    cb(void 0, Env.moderators);
};

const commands = {
    ACTIVE_SESSIONS: getActiveSessions,
    ACTIVE_PADS: getActiveChannelCount,
    REGISTERED_USERS: getRegisteredUsers,
    DISK_USAGE: getDiskUsage,
    FLUSH_CACHE: flushCache,
    GET_FILE_DESCRIPTOR_COUNT: getFileDescriptorCount,
    GET_FILE_DESCRIPTOR_LIMIT: getFileDescriptorLimit,
    GET_CACHE_STATS: getCacheStats,

    GET_PIN_ACTIVITY: getPinActivity,
    IS_USER_ONLINE: isUserOnline,
    GET_USER_QUOTA: getUserQuota,
    GET_USER_STORAGE_STATS: getUserStorageStats,
    GET_PIN_LOG_STATUS: getPinLogStatus,

    GET_METADATA_HISTORY: channelCommand('GET_METADATA_HISTORY'),
    GET_STORED_METADATA: channelCommand('GET_STORED_METADATA'),
    GET_DOCUMENT_SIZE: channelCommand('GET_DOCUMENT_SIZE'),
    GET_LAST_CHANNEL_TIME: channelCommand('GET_LAST_CHANNEL_TIME'),
    GET_DOCUMENT_STATUS: channelCommand('GET_DOCUMENT_STATUS'),

    CHECK_TEST_DECREE: checkTestDecree,
    ADMIN_DECREE: Admin.sendDecree,
    INSTANCE_STATUS: instanceStatus,
    GET_LIMITS: getLimits,

    GET_WORKER_PROFILES: getWorkerProfiles,

    GET_USER_TOTAL_SIZE: getUserTotalSize,

    GET_ALL_INVITATIONS: getInvitations,
    CREATE_INVITATION: createInvitation,
    DELETE_INVITATION: deleteInvitation,

    GET_ALL_USERS: getKnownUsers,
    ADD_KNOWN_USER: addKnownUser,

    GET_MODERATORS: getModerators,
};

let pluginsInitialized = false;
const initPlugins = Env => {
    if (pluginsInitialized) { return; }
    pluginsInitialized = true;
    Env.plugins.call('addAdminCommands')(Env, commands);
};

Admin.command = (Env, safeKey, data, _cb) => {
    const cb = Util.once(Util.mkAsync(_cb));

    const admins = Env.admins;
    const unsafeKey = Util.unescapeKeyCharacters(safeKey);

    if (admins.indexOf(unsafeKey) === -1) {
        return void cb("FORBIDDEN");
    }

    initPlugins(Env);

    const command = commands[data[0]];

    /*
    // XXX plugins
    Object.keys(Env.plugins || {}).forEach(name => {
        let plugin = Env.plugins[name];
        if (!plugin.addAdminCommands) { return; }
        try {
            let c = plugin.addAdminCommands(Env);
            Object.keys(c || {}).forEach(cmd => {
                if (typeof(c[cmd]) !== "function") { return; }
                if (commands[cmd]) { return; }
                commands[cmd] = c[cmd];
            });
        } catch (e) {}
    });
    */

    if (typeof (command) === 'function') {
        return void command(Env, unsafeKey, data, cb);
    }

    return void cb('UNHANDLED_ADMIN_COMMAND');
};

module.exports = Admin;
