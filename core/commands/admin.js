const Util = require('../../common/common-util.js');
const Keys = require("../../common/keys");

const StorageCommands = require('./storage');

const Core = require("../../common/core");
const nThen = require('nthen');

const Admin = {};

// CryptPad_AsyncStore.rpc.send('ADMIN', ['GET_WORKER_PROFILES'], console.log)
// To remove?
const getWorkerProfiles = function(Env, _publicKey, _data, cb) {
    cb(void 0, { "Not Implemented": 1 });
};

const getUid = () => {
    return Util.uid() + Util.uid() + Util.uid();
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

const createInvitation = (Env, unsafeKey, _data, cb) => {
    const data = Array.isArray(_data) && _data[1];
    if (!data || typeof(data) !== 'object') { return void cb("EINVAL"); }
    data.id = getUid();
    data.unsafeKey = unsafeKey;
    Core.coreToStorage(Env, data.id, 'ADMIN_CMD', {cmd: 'CREATE_INVITATION', data}, cb);
};

const deleteInvitation = (Env, _publicKey, data, cb) => {
    const id = Array.isArray(data) && data[1];
    if (typeof (id) !== 'string') { return void cb('EINVAL'); }
    Core.coreToStorage(Env, id, 'ADMIN_CMD', { cmd: 'DELETE_INVITATION', data: id }, cb);
};

// CryptPad_AsyncStore.rpc.send('ADMIN', ['GET_ACTIVE_SESSIONS'], console.log)
var getActiveSessions = function(Env, _publicKey, _data, cb) {
    Env.interface.broadcast('front', 'ADMIN_CMD', { cmd: 'GET_ACTIVE_SESSIONS' }, (err, data) => {
        if (err.length) { cb(err); };
        let unique = new Set();
        const total = data.reduce((acc, it) => {
            it.unique.forEach(u => unique.add(u));
            return acc + it.total;
        }, 0);
        cb(void 0, [total, unique.size]);
    });
};

const getActiveChannelCount = (Env, _publicKey, _data, cb) => {
    Env.interface.broadcast('storage', 'ADMIN_CMD', {cmd: 'GET_ACTIVE_CHANNEL_COUNT'}, (err, data) => {
        if (err.length) { return void cb(err); }
        let activeChannelCount = data.reduce((acc, it) => acc + it, 0);
        return void cb(void 0, activeChannelCount);
    });
};

const flushCache = (Env, _publicKey, args, cb) => {
    if (Env.myId !== 'core:0') {
        return void Env.interface.sendQuery('core:0', 'FLUSH_CACHE', {}, res => {
            if (res.error) { return void cb(res.error); }
            cb(void 0, res.data);
        });
    }
    Env.flushCache(args, cb);
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
                    } else {
                        Env.Log.warn('Warning in GET_CACHE_STATS: mismatched data');
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

const isUserOnline = (Env, _publicKey, data, cb) => {
    const safeKey = Array.isArray(data) && data[1];
    if (!Core.isValidPublicKey(safeKey)) { return void cb("EINVAL"); }
    const unsafeKey = Util.unescapeKeyCharacters(safeKey);
    if (Object.values(Env.userCache)
        .some(v => v.authKeys && Object.keys(v.authKeys).includes(unsafeKey))) {
        return void cb(void 0, true);
    }
    Env.interface.broadcast('core', 'IS_USER_ONLINE', safeKey, (err, data) => {
        if (err.length !== 0) { return void cb(err); }
        cb(void 0, data.some(isOnline => isOnline));
    });
};

const getDocumentStatus = (Env, _key, data, cb) => {
    const id = Array.isArray(data) && data[1];
    if (typeof(id) !== 'string') { return void cb("EINVAL"); }
    Core.coreToStorage(Env, id, 'ADMIN_CMD', { cmd: 'GET_DOCUMENT_STATUS', data: { id } }, cb);
};

const getKnownUsers = (Env, _publicKey, _data, cb) => {
    Env.interface.broadcast('storage', 'ADMIN_CMD', { cmd: 'GET_USERS' }, (_err, data) => {
        const knownUsers = data.reduce((acc, it) => Object.assign(acc, it), {});
        cb(void 0, knownUsers);
    });
};

const addKnownUser = (Env, _key, _data, cb) => {
    const data = Array.isArray(_data) && _data[1];
    if (!data?.edPublic) { return void cb('EINVAL'); }
    Core.coreToStorage(Env, data.edPublic, 'ADMIN_CMD', { cmd: 'ADD_KNOWN_USER', data }, cb);
};

const deleteKnownUser = (Env, _key, data, cb) => {
    const id =  Array.isArray(data) && data[1];
    Core.coreToStorage(Env, id, 'ADMIN_CMD', { cmd: 'DELETE_KNOWN_USER', data: id }, cb);
};

const updateKnownUser = (Env, _key, _data, cb) => {
    const data = Array.isArray(_data) && _data[1];
    if (!data?.edPublic) { return void cb('EINVAL'); }
    Core.coreToStorage(Env, data.edPublic, 'ADMIN_CMD', { cmd: 'UPDATE_KNOWN_USER', data }, cb);
};

// Moderators are handled by storage:0
const getModerators = (Env, _publicKey, _data, cb) => {
    Env.interface.sendQuery('storage:0', 'ADMIN_CMD', { cmd: 'GET_MODERATORS' }, res => { cb(res.error, res.data); });
};

const addModerator = (Env, unsafeKey, data, cb) => {
    const obj = Array.isArray(data) && data[1];
    const { name, edPublic, curvePublic, mailbox, profile } = obj;
    const userData = {
        name,
        edPublic,
        curvePublic,
        mailbox,
        profile
    };
    Env.interface.sendQuery('storage:0', 'ADMIN_CMD',
        { cmd: 'ADD_MODERATOR', data: { userData, unsafeKey } },
        res => { cb(res.error, res.data); });
};

const removeModerator = (Env, _publicKey, data, cb) => {
    const id = Array.isArray(data) && data[1];
    Env.interface.sendQuery('storage:0', 'ADMIN_CMD',
        { cmd: 'REMOVE_MODERATOR', data: id },
        res => { cb(res.error, res.data); });
};

// Not implemented in CryptPad server
const getPinHistory = (Env, _key, data, cb) => {
    Env.Log.debug('GET_PIN_HISTORY', data);
    cb("NOT_IMPLEMENTED");
};

// Not implemented in CryptPad server
const archiveOwnedDocuments = (Env, _key, data, cb) => {
    Env.Log.debug('ARCHIVE_OWNED_DOCUMENTS', data);
    cb("NOT_IMPLEMENTED");
};

const archiveAccount = (Env, _key, data, _cb) => {
    const cb = Util.once(_cb);
    const args = Array.isArray(data) && data[1];
    if (!args || typeof(args) !== 'object') { return void cb("EINVAL"); }
    const { key, reason } = args;
    args.archiveReason = {
        code: 'MODERATION_ACCOUNT',
        txt: reason
    };

    Core.coreToStorage(Env, key, 'ADMIN_CMD', { cmd: 'GET_PIN_INFO', data: args }, (err, ref) => {
        if (err) { return void cb(err); }
        const routing = Core.getChannelsStorage(Env, Object.keys(ref.pins || {}));
        let archivalPromises = Object.keys(routing).map(storageId =>
            new Promise((resolve, reject) => {
                Env.interface.sendQuery(storageId, 'ADMIN_CMD', {
                    cmd: 'ACCOUNT_ARCHIVAL_START',
                    data: {
                        list: routing[storageId],
                        archiveReason: args.archiveReason,
                        key
                    }
                }, res => {
                    if (res.error) {
                        return void reject(res.error);
                    }
                    resolve(res.data);
                });
            })
        );
        Promise.all(archivalPromises).then((archived) => {
            const { deletedBlobs, deletedChannels } = archived.reduce((res, it) => {
                res.deletedBlobs.push(...(it.deletedBlobs || []));
                res.deletedChannels.push(...(it.deletedChannels || []));
                return res;
            }, { deletedBlobs: [], deletedChannels: [] });
            Core.coreToStorage(Env, key, 'ADMIN_CMD', {
                cmd: 'ACCOUNT_ARCHIVAL_END',
                data: {
                    key,
                    block: args.block || ref.block,
                    deletedBlobs,
                    deletedChannels,
                    archiveReason: args.archiveReason,
                    reason
                }
            }, (err) => {
                if (err) {
                    Env.Log.error('ARCHIVE_ACCOUNT_ERROR', err);
                };
                cb(void 0, { state: true });
            });
        }).catch(e => { Env.Log.error(e); return void cb(e); });
    });
};

const restoreAccount = (Env, _key, data, _cb) => {
    const cb = Util.once(_cb);
    const args = Array.isArray(data) && data[1];
    if (!args || typeof(args) !== 'object') { return void cb("EINVAL"); }
    const { key } = args;
    let pads, blobs, blockId;
    Core.coreToStorage(Env, key, 'ADMIN_CMD', { cmd: 'READ_REPORT', data: args }, (err, report) => {
        if (err) {
            if (err === 'ENOENT') {
                return cb(err);
            }
            throw new Error(err);
        }
        pads = report.channels;
        blobs = report.blobs;
        blockId = report.blockId;
        let errors = [];

        const routedPads = Core.getChannelsStorage(Env, pads);
        const routedBlobs = Core.getChannelsStorage(Env, blobs);
        const targets = Array.from(new Set(Object.keys(routedPads).concat(Object.keys(routedBlobs))));
        const restorePromises = targets.map(storageId =>
            new Promise((resolve, reject) => {
                const data = {
                    pads: routedPads[storageId] || [],
                    blobs: routedBlobs[storageId] || [],
                };
                Env.interface.sendQuery(storageId, 'ADMIN_CMD', {
                    cmd: 'ACCOUNT_RESTORE_START',
                    data
                }, res => {
                    if (res.error) { reject(res.error); }
                    resolve(res.data);
                });
            })
        );
        Promise.all(restorePromises).then((errs) => {
            errors.push(...errs);
            Core.coreToStorage(Env, key, 'ADMIN_CMD', {
                cmd: 'ACCOUNT_RESTORE_END',
                data: { key, blockId }
            }, (err) => {
                if (err) {
                    Env.Log.error('ARCHIVE_RESTORE_ERROR', err);
                };

                Env.Log.info('RESTORE_ACCOUNT_BY_ADMIN', {
                    safeKey: Util.escapeKeyCharacters(args.key),
                    reason: args.reason,
                });
                cb(void 0, {
                    state: true,
                    errors
                });
            });
        }).catch(e => { Env.Log.error(e); return void cb(e); });
    });
};

const getAccountArchiveStatus = (Env, _key, data, _cb) => {
    const cb = Util.once(_cb);
    const args = Array.isArray(data) && data[1];
    if (!args || typeof(args) !== 'object') { return void cb("EINVAL"); }
    const { key } = args;
    Core.coreToStorage(Env, key, 'ADMIN_CMD', {
        cmd: 'GET_ACCOUNT_ARCHIVE_STATUS',
        data: args
    }, cb);
};

const archiveDocument = (Env, _key, data, cb) => {
    const args = Array.isArray(data) && data[1];
    if (!args) { return void cb("EINVAL"); }
    let id, reason;
    if (typeof (args) === 'string') {
        id = args;
    } else if (args && typeof (args) === 'object') {
        id = args.id;
        reason = args.reason;
    }
    if (typeof (id) !== 'string' || id.length < 32) { return void cb("EINVAL"); }

    Core.coreToStorage(Env, id, 'ADMIN_CMD', {
        cmd: 'ARCHIVE_DOCUMENT',
        data: {
            id,
            reason
        }
    }, cb);
};

const archiveDocuments = (Env, _key, data, cb) => {
    if (!Array.isArray(data)) { return void cb("EINVAL"); }
    let args = data[1];
    const { list, reason } = args;
    if (!Array.isArray(list)) { return void cb('EINVAL'); }
    let n = nThen;
    let failed = [];
    let routing = Core.getChannelsStorage(Env, list);
    Object.keys(routing).forEach(target => {
        n = n((w) =>
            Env.interface.sendQuery(target, 'ADMIN_CMD', {
                cmd: 'ARCHIVE_DOCUMENTS',
                data: { reason, list: routing[target]}
            }, w(res => {
                if (res.error) {
                    res.error.filter(err => err.code !== 'ENOENT').forEach(err => {
                        Env.Log.error(err);
                        failed.push(err.id);
                    });
                }
            }))).nThen;
    });
    n(() => {
        cb(void 0, { state: true, failed });
    });
};

const restoreArchivedDocument = (Env, _key, data, cb) => {
    const args = Array.isArray(data) && data[1];
    if (!args) { return void cb("EINVAL"); }

    let id, reason;
    if (typeof(args) === 'string') {
        id = args;
    } else if (args && typeof(args) === 'object') {
        id = args.id;
        reason = args.reason;
    }

    if (typeof(id) !== 'string' || id.length < 32) { return void cb("EINVAL"); }
    Core.coreToStorage(Env, id, 'ADMIN_CMD', { cmd: 'RESTORE_ARCHIVED_DOCUMENT', data: { id, reason } }, cb);
};

// XXX: to optimize
const archiveSupport = (Env, _key, _data, cb) => {
    const supportPinKey = Env.supportPinKey;
    Core.coreToStorage(Env, supportPinKey, 'ADMIN_CMD',
        {
            cmd: 'GET_PIN_LIST',
            data: { key: supportPinKey }
        }, (err, list) => {
            if (err) { return void cb(err); }
            let n = nThen;
            list.forEach(id => {
                n = n(waitFor => {
                    archiveDocument(Env, _key, [null, { id, reason: 'DISABLE_SUPPORT' }], waitFor());
                }).nThen;
            });
            n(() => {
                cb();
            });
        });
    cb(void 0, true);
};

// The following commands send data to corresponding storage with specific data
// parsing and formats
// CoreToStorage with target = id, data = { id }, error = INVALID_CHAN
const channelCommand = (cmd) => (Env, _key, data, cb) => {
    const id = Array.isArray(data) && data[1];
    if (!Core.isValidId(id)) { return void cb('INVALID_CHAN'); }
    Core.coreToStorage(Env, id, 'ADMIN_CMD', { cmd, data: { id } }, cb);
};

// CoreToStorage with target = id, data = id, error = EINVAL
const channelIndexCommand = (cmd) => (Env, _key, data, cb) => {
    const id = Array.isArray(data) && data[1];
    if (typeof(id) !== 'string' || id.length < 32) { return void cb('EINVAL'); }
    Core.coreToStorage(Env, id, 'ADMIN_CMD', { cmd, data: id }, cb);
};

// CoreToStorage with target = key, data = { key }, error = EINVAL
const keyCommand = (cmd) => (Env, _key, data, cb) => {
    const key = Array.isArray(data) && data[1];
    if (!Core.isValidPublicKey(key)) { return void cb("EINVAL"); }
    Core.coreToStorage(Env, key, 'ADMIN_CMD', { cmd, data: { key } }, cb);
};

// CoreToStorage with target = args.key, data = args, error = INVALID_ARGS
const argsCommand = (cmd) => (Env, _key, data, cb) => {
    const args = Array.isArray(data) && data[1];
    if (!args) { return void cb("INVALID_ARGS"); }
    const { key } = args;
    if (!Core.isValidPublicKey(key)) { return void cb("EINVAL"); }
    Core.coreToStorage(Env, key, 'ADMIN_CMD', { cmd, data: args }, cb);
};

const changeColor = (Env, unsafeKey, data, cb) => {
    const args = Array.isArray(data) && data[1];
    if (!args || typeof(args) !== 'object') { return void cb("EINVAL"); }
    let color = args.color;
    Admin.sendDecree(Env, unsafeKey, ['CHANGE_COLOR', [
        'SET_ACCENT_COLOR',
        [color]
    ]], (err) => {
        if (err) { return void cb(err); }
        flushCache(Env, unsafeKey, {}, (err) => {
            if (err) {
                Env.log.error('ADMIN_CHANGE_COLOR_FLUSH_CACHE', err);
            }
        });
        cb(void 0, true);
    });
};

const MAX_LOGO_SIZE = 200*1024; // 200KB
const removeLogo = (Env, unsafeKey, data, cb) => {
    Env.interface.sendQuery('storage:0', 'ADMIN_CMD', {
        cmd: 'REMOVE_LOGO',
        data: { unsafeKey }
    }, res => {
        cb(res?.error);
    });
};
const uploadLogo = (Env, unsafeKey, data, cb) => {
    const args = Array.isArray(data) && data[1];
    if (!args || typeof(args) !== 'object') { return void cb("EINVAL"); }
    let dataURL = args.dataURL;

    // (size*4/3) + 24 ==> base64 and dataURL overhead
    if (!dataURL || dataURL.length > ((MAX_LOGO_SIZE*4/3)+24)) {
        return void cb('E_TOO_LARGE');
    }

    Env.interface.sendQuery('storage:0', 'ADMIN_CMD', {
        cmd: 'UPLOAD_LOGO',
        data: { file: dataURL, unsafeKey }
    }, res => {
        if (res?.error) { return void cb(res.error); }
        cb(void 0, true);
    });
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

    GET_PIN_ACTIVITY: keyCommand('GET_PIN_ACTIVITY'),
    IS_USER_ONLINE: isUserOnline,
    GET_USER_QUOTA: keyCommand('GET_USER_QUOTA'),
    GET_USER_STORAGE_STATS: keyCommand('GET_USER_STORAGE_STATS'),
    GET_PIN_LOG_STATUS: keyCommand('GET_PIN_LOG_STATUS'),

    GET_METADATA_HISTORY: channelCommand('GET_METADATA_HISTORY'),
    GET_STORED_METADATA: channelCommand('GET_STORED_METADATA'),
    GET_DOCUMENT_SIZE: channelCommand('GET_DOCUMENT_SIZE'),
    GET_LAST_CHANNEL_TIME: channelCommand('GET_LAST_CHANNEL_TIME'),
    GET_DOCUMENT_STATUS: getDocumentStatus,

    DISABLE_MFA: keyCommand('DISABLE_MFA'),

    GET_PIN_LIST: keyCommand('GET_PIN_LIST'),
    GET_PIN_HISTORY: getPinHistory,
    ARCHIVE_OWNED_DOCUMENTS: archiveOwnedDocuments,

    ARCHIVE_BLOCK: argsCommand('ARCHIVE_BLOCK'),
    RESTORE_ARCHIVED_BLOCK: argsCommand('RESTORE_ARCHIVED_BLOCK'),

    ARCHIVE_DOCUMENT: archiveDocument,
    ARCHIVE_DOCUMENTS: archiveDocuments,
    RESTORE_ARCHIVED_DOCUMENT: restoreArchivedDocument,

    ARCHIVE_ACCOUNT: archiveAccount,
    RESTORE_ACCOUNT: restoreAccount,
    GET_ACCOUNT_ARCHIVE_STATUS: getAccountArchiveStatus,

    CLEAR_CACHED_CHANNEL_INDEX: channelIndexCommand('CLEAR_CACHED_CHANNEL_INDEX'),
    GET_CACHED_CHANNEL_INDEX: channelIndexCommand('GET_CACHED_CHANNEL_INDEX'),

    CLEAR_CACHED_CHANNEL_METADATA: channelIndexCommand('CLEAR_CACHED_CHANNEL_METADATA'),
    GET_CACHED_CHANNEL_METADATA: channelIndexCommand('GET_CACHED_CHANNEL_METADATA'),

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
    DELETE_KNOWN_USER: deleteKnownUser,
    UPDATE_KNOWN_USER: updateKnownUser,

    ARCHIVE_SUPPORT: archiveSupport,
    GET_MODERATORS: getModerators,
    ADD_MODERATOR: addModerator,
    REMOVE_MODERATOR: removeModerator,

    UPLOAD_LOGO: uploadLogo,
    REMOVE_LOGO: removeLogo,
    CHANGE_COLOR: changeColor,
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
