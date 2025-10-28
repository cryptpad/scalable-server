const Util = require('../../common/common-util.js');
const Keys = require("../../common/keys");

const config = require("../../config/config.json");

const StorageCommands = require('./storage');

const Admin = {};

// CryptPad_AsyncStore.rpc.send('ADMIN', ['GET_WORKER_PROFILES'], console.log)
const getWorkerProfiles = function (Env, _publicKey, _data, cb) {
    cb(void 0, Env.commandTimers);
};


const getInvitations = (Env, _publicKey, _data, cb) => {
    Env.interface.broadcast('storage', 'GET_INVITATIONS', {}, res => {
        const invitations =
            res.map(obj => {
                if (obj.err) { return []; }
                return obj.data;
            }).reduce((acc, it) => Object.assign(acc, it), {});
        cb(void 0, invitations);
    });
};
var createInvitation = (Env, publicKey, data, cb) => {
    return cb('E_NOT_IMPLEMENTED');
    // const args = Array.isArray(data) && data[1];
    // if (!args || typeof(args) !== 'object') { return void cb("EINVAL"); }
    // Invitation.create(Env, args.alias, args.email, cb, publicKey);
};
var deleteInvitation = (Env, _publicKey, data, cb) => {
    return cb('E_NOT_IMPLEMENTED');
    // var id = Array.isArray(data) && data[1];
    // Invitation.delete(Env, id, cb);
};


// CryptPad_AsyncStore.rpc.send('ADMIN', ['GET_ACTIVE_SESSIONS'], console.log)
var getActiveSessions = function (_Env, _publicKey, _data, cb) {
    return cb('E_NOT_IMPLEMENTED');
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
};

const flushCache = (Env, _publicKey, _data, cb) => {
    Env.interface.broadcast('websocket', 'FLUSH_CACHE', { freshKey: +new Date() }, () => { cb(void 0, true); });
};

const getDiskUsage = (Env, _publicKey, _data, cb) => {
    const sumDiskUsage = (acc, it) => {
        for (const key in it) {
            if (!acc[key]) { acc[key] = 0; }
            acc[key] += it[key];
        }
        return acc;
    };
    let totalDiskUsage = {};
    Env.interface.broadcast('storage', 'GET_DISK_USAGE', {}, res => {
        totalDiskUsage = res.map(obj => {
            if (obj.error) { return; }
            return obj.data;
        }).reduce(sumDiskUsage, {});
        cb(void 0, totalDiskUsage);
    });
};

const getRegisteredUsers = (Env, _publicKey, _data, cb) => {
    let users = 0;
    Env.interface.broadcast('storage', 'GET_REGISTERED_USERS', { noRedirect: true }, res => {
        res.forEach(obj => {
            if (obj.error) { return; }
            users += obj.data?.users;
        });
        cb(void 0, { users });
    });
};

const getFileDescriptorCount = (Env, _publicKey, _data , cb) => {
    let fdCount = 0;
    Env.interface.broadcast('storage', 'GET_FILE_DESCRIPTOR_COUNT', {}, res => {
        res.forEach(obj => {
            if (obj.error) { return; }
            fdCount += obj.data;
        });
        cb(void 0, fdCount);
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
    if (!Env.installToken) { return void cb('EINVAL'); }
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
        const hardcoded = Array.isArray(config?.options?.adminKeys) &&
                config.options.adminKeys.some(key => {
                    return Keys.canonicalize(key) === edPublic;
                });
        if (str.length === 44) {
            return { edPublic, first: true, hardcoded };
        }
        let name;
        try {
            const parsed = Keys.parseUser(str);
            name = parsed.user;
        } catch (e) {}
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

const isValidKey = key => {
    return typeof(key) === 'string' && key.length === 44;
};

const getPinActivity = (Env, _publicKey, data, cb) => {
    const signingKey = Array.isArray(data) && data[1];
    if (!isValidKey(signingKey)) { return void cb('EINVAL'); }
    const safeKey = Util.escapeKeyCharacters(signingKey);
    StorageCommands.getTotalSize(Env, safeKey, cb);
};

const isUserOnlineHandle = (Env, safeKey, cb) => {
    const userCore = getCoreId(safeKey);
    if (Env.myId !== userCore) { return void cb('EINVAL'); }
    cb('E_NOT_IMPLEMENTED');
    // XXX: TODO
};

const isUserOnline = (Env, _publicKey, data, cb) => {
    console.log('Call IS_USER_ONLINE', data);
    let key = Array.isArray(data) && data[1];
    if (!isValidKey(key)) { return void cb("EINVAL"); }
    key = Util.unescapeKeyCharacters(key);
    const userCore = getCoreId(key);
    if (Env.myId === userCore) {
        return void isUserOnlineHandle(Env, safeKey, cb);
    }
};

const getKnownUsers = (Env, _publicKey, _data, cb) => {
    Env.interface.broadcast('storage', 'GET_USERS', {}, res => {
        const knownUsers = res.map(obj => {
            if (obj.error) { return ; }
            return obj.data;
        }).reduce((acc, it) => Object.assign(acc, it), {});
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

    GET_PIN_ACTIVITY: getPinActivity,
    IS_USER_ONLINE: isUserOnline,

    CHECK_TEST_DECREE: checkTestDecree,
    ADMIN_DECREE: Admin.sendDecree,
    INSTANCE_STATUS: instanceStatus,
    GET_LIMITS: getLimits,

    GET_WORKER_PROFILES: getWorkerProfiles,

    GET_ALL_INVITATIONS: getInvitations,
    CREATE_INVITATION: createInvitation,
    DELETE_INVITATION: deleteInvitation,

    GET_ALL_USERS: getKnownUsers,
    ADD_KNOWN_USER: addKnownUser,

    GET_MODERATORS: getModerators,
};

Admin.command = (Env, safeKey, data, _cb) => {
    const cb = Util.once(Util.mkAsync(_cb));

    const admins = Env.admins;
    const unsafeKey = Util.unescapeKeyCharacters(safeKey);

    if (admins.indexOf(unsafeKey) === -1) {
        return void cb("FORBIDDEN");
    }

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

    if (typeof(command) === 'function') {
        return void command(Env, unsafeKey, data, cb);
    }

    return void cb('UNHANDLED_ADMIN_COMMAND');


};

module.exports = Admin;
