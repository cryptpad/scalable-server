const Util = require("../common/common-util");
const Core = require('../common/core');
const Admin = require('./commands/admin');
const StorageCommands = require('./commands/storage');

const nThen = require('nthen');

const Rpc = {};

const getStorageId = (Env, contentId) => {
    return Env.getStorageId(contentId);
};

// Anon

const getFileSize = StorageCommands.getFileSize;

const getMultipleFileSize = StorageCommands.getMultipleFileSize;

const getDeletedPads = (Env, channels, _cb) => {
    const cb = Util.once(_cb);

    const result = [];
    const channelsByStorage = Core.getChannelsStorage(Env, channels);

    nThen(waitFor => {
        Object.keys(channelsByStorage).forEach(storageId => {
            const channels = channelsByStorage[storageId];
            Env.interface.sendQuery(storageId,
            'RPC_GET_DELETED_PADS', channels, waitFor(res => {
                if (res.error) {
                    waitFor.abort();
                    return void cb(res.error);
                }
                Array.prototype.push.apply(result, res.data);
            }));
        });
    }).nThen(() => {
        cb(void 0, result);
    });
};
const isNewChannel = (Env, channel, cb) => {
    const storageId = getStorageId(Env, channel);
    Env.interface.sendQuery(storageId, 'RPC_IS_NEW_CHANNEL',
        { channel }, res => { cb(res.error, res.data); });
};
const writePrivateMessage = (Env, args, cb, userId) => {
    if (!Array.isArray(args)) { return void cb('EINVAL'); }
    const channel = args[0];
    const storageId = getStorageId(Env, channel);

    Env.interface.sendQuery(storageId, 'RPC_WRITE_PRIVATE_MESSAGE',
        { userId, args }, res => { cb(res.error, res.data); });
};
const deleteMailboxMessage = (Env, args, cb) => {
    const channel = args.channel;
    const storageId = getStorageId(Env, channel);
    Env.interface.sendQuery(storageId, 'RPC_DELETE_CHANNEL_LINE',
        args, res => { cb(res.error, res.data); });
};
const getMetadata = (Env, channel, cb) => {
    const storageId = getStorageId(Env, channel);
    Env.interface.sendQuery(storageId, 'GET_METADATA',
        { channel }, res => { cb(res.error, res.data); });
};
const isPremium = (Env, userKey, cb) => {
    const limit = Env.limits[userKey];
    return void cb(void 0, !!limit?.plan);
};
const addFirstAdmin = Admin.addFirstAdmin;

// Auth
const resetUserPins = (Env, safeKey, channels, cb) => {
    const storageId = getStorageId(Env, safeKey);
    Env.interface.sendQuery(storageId, 'RPC_PINNING_RESET',
        { channels, safeKey }, res => { cb(res.error, res.data); });
};
const pinChannel = (Env, safeKey, channels, cb) => {
    const storageId = getStorageId(Env, safeKey);
    Env.interface.sendQuery(storageId, 'RPC_PINNING_PIN', 
        { channels, safeKey }, res => { cb(res.error, res.data); });
};
const unpinChannel = (Env, safeKey, channels, cb) => {
    const storageId = getStorageId(Env, safeKey);
    Env.interface.sendQuery(storageId, 'RPC_PINNING_UNPIN',
        { channels, safeKey }, res => { cb(res.error, res.data); });
};
const clearOwnedChannel = (Env, safeKey, channel, cb) => {
    const storageId = getStorageId(Env, channel);
    Env.interface.sendQuery(storageId, 'RPC_CLEAR_OWNED_CHANNEL',
        { safeKey, channel }, res => { cb(res.error, res.data); });
};
const removeOwnedChannel = (Env, safeKey, data, cb) => {
    const storageId = getStorageId(Env, data.channel);
    data.safeKey = safeKey;
    Env.interface.sendQuery(storageId, 'RPC_REMOVE_OWNED_CHANNEL',
        data , res => { cb(res.error, res.data); });
};
const trimHistory = (Env, safeKey, data, cb) => {
    const storageId = getStorageId(Env, data.channel);
    data.safeKey = safeKey;
    Env.interface.sendQuery(storageId, 'RPC_TRIM_HISTORY',
        data , res => { cb(res.error, res.data); });
};
const uploadStatus = (Env, safeKey, data, cb) => {
    const { size, id } = data;
    const storageId = getStorageId(Env, id);
    Env.interface.sendQuery(storageId, 'RPC_UPLOAD_STATUS',
        { safeKey, size }, res => { cb(res.error, res.data); });
};
const uploadCancel = (Env, safeKey, data, cb) => {
    const { size, id } = data;
    const storageId = getStorageId(Env, id);
    Env.interface.sendQuery(storageId, 'RPC_UPLOAD_CANCEL',
        { safeKey, size }, res => { cb(res.error, res.data); });
};
const upload = (Env, safeKey, data, cb) => {
    const { chunk, id } = data;
    const storageId = getStorageId(Env, id);
    Env.interface.sendQuery(storageId, 'RPC_UPLOAD_CHUNK',
        { safeKey, chunk }, res => { cb(res.error, res.data); });
};
const uploadComplete = (Env, safeKey, id, cb) => {
    const storageId = getStorageId(Env, id);
    Env.interface.sendQuery(storageId, 'RPC_UPLOAD_COMPLETE',
        { safeKey, id }, res => { cb(res.error, res.data); });
};
const uploadCompleteOwned = (Env, safeKey, id, cb) => {
    const storageId = getStorageId(Env, id);
    Env.interface.sendQuery(storageId, 'RPC_UPLOAD_COMPLETE_OWNED',
        { safeKey, id }, res => { cb(res.error, res.data); });
};
const adminCommand = Admin.command;
const setMetadata = (Env, safeKey, args, cb) => {
    const storageId = getStorageId(Env, args.channel);
    args.safeKey = safeKey;
    Env.interface.sendQuery(storageId, 'RPC_SET_METADATA',
        args, res => { cb(res.error, res.data); });
};

const getHash = (Env, safeKey, cb) => {
    const storageId = getStorageId(Env, safeKey);
    Env.interface.sendQuery(storageId, 'RPC_GET_HASH',
        { safeKey }, res => { cb(res.error, res.data); });
};
const getTotalSize = (Env, safeKey, cb) => {
    const unsafeKey = Util.unescapeKeyCharacters(safeKey);
    const limit = Env.limits[unsafeKey];
    const batchKey = (limit && Array.isArray(limit.users)) ?
                        limit.users.join('') : safeKey;

    StorageCommands.getTotalSize(Env, batchKey, cb);
};
const getLimit = StorageCommands.getLimit;

const expireSessionAsync = () => { };
const removePins = (Env, safeKey, cb) => {
    const storageId = getStorageId(Env, safeKey);
    Env.interface.sendQuery(storageId, 'RPC_ARCHIVE_PIN_LOG',
        { safeKey }, res => {
            cb(res.error, res.data);
            if (res.error) { return; }
            Core.expireSession(Env.Sessions, safeKey);
        });
};
const trimPins = (Env, safeKey, cb) => {
    const storageId = getStorageId(Env, safeKey);
    Env.interface.sendQuery(storageId, 'RPC_TRIM_PIN_LOG',
        { safeKey }, res => { cb(res.error, res.data); });
};
const haveACookie = (Env, key, cb) => {
    cb();
};
const destroy = () => {
    console.error("DESTROY_RPC");
    throw new Error('NOT_IMPLEMENTED');
};

const UNAUTHENTICATED_CALLS = {
    GET_FILE_SIZE: getFileSize,
    GET_MULTIPLE_FILE_SIZE: getMultipleFileSize,
    GET_DELETED_PADS: getDeletedPads,
    IS_NEW_CHANNEL: isNewChannel,
    WRITE_PRIVATE_MESSAGE: writePrivateMessage,
    DELETE_MAILBOX_MESSAGE: deleteMailboxMessage,
    GET_METADATA: getMetadata,
    IS_PREMIUM: isPremium,
    ADD_FIRST_ADMIN: addFirstAdmin
};

const AUTHENTICATED_USER_TARGETED = {
    RESET: resetUserPins,
    PIN: pinChannel,
    UNPIN: unpinChannel,
    CLEAR_OWNED_CHANNEL: clearOwnedChannel,
    REMOVE_OWNED_CHANNEL: removeOwnedChannel,
    TRIM_HISTORY: trimHistory,
    UPLOAD_STATUS: uploadStatus,
    UPLOAD: upload,
    UPLOAD_COMPLETE: uploadComplete,
    UPLOAD_CANCEL: uploadCancel,
    OWNED_UPLOAD_COMPLETE: uploadCompleteOwned,
    ADMIN: adminCommand,
    SET_METADATA: setMetadata,
};
const AUTHENTICATED_USER_SCOPED = {
    GET_HASH: getHash,
    GET_TOTAL_SIZE: getTotalSize,
    GET_LIMIT: getLimit,
    EXPIRE_SESSION: expireSessionAsync,
    REMOVE_PINS: removePins,
    TRIM_PINS: trimPins,
    COOKIE: haveACookie,
    DESTROY: destroy
};

Rpc.isUnauthenticateMessage = (msg) => {
    return msg && msg.length === 2 && typeof(UNAUTHENTICATED_CALLS[msg[0]]) === 'function';
};

Rpc.isAuthenticatedCall = (call) => {
    if (call === 'UPLOAD') { return false; }
    return typeof(AUTHENTICATED_USER_TARGETED[call] || AUTHENTICATED_USER_SCOPED[call]) === 'function';
};

Rpc.handleUnauthenticated = (Env, data, userId, cb) => {
    const [command, content] = data;

    Env.Log.verbose('LOG_RPC', command);

    //Env.plugins?.MONITORING?.increment(`rpc_${command}`); // XXX MONITORING

    const method = UNAUTHENTICATED_CALLS[command];
    method(Env, content, (err, value) => {
        if (err) {
            Env.Log.warn('ANON_RPC_ERROR', err, content);
            return void cb(err);
        }
        cb(void 0, [null, value, null]);
    }, userId);
};

Rpc.handleAuthenticated = (Env, publicKey, data, cb) => {
    /*  If you have gotten this far, you have signed the message
        with the public key which you provided.
    */

    const safeKey = Util.escapeKeyCharacters(publicKey);

    const Respond = (e, value) => {
        const session = Env.Sessions[safeKey];
        const token = session? session.tokens.slice(-1)[0]: '';
        const cookie = Core.makeCookie(token).join('|');
        cb(e ? String(e): e, [cookie].concat(typeof(value) !== 'undefined' ?value: []));
    };

    data.shift();
    // discard validated cookie from message
    if (!data.length) {
        return void Respond('INVALID_MSG');
    }

    const TYPE = data[0];

    Env.Log.verbose('LOG_RPC', TYPE);

    if (typeof(AUTHENTICATED_USER_TARGETED[TYPE]) === 'function') {
        return void AUTHENTICATED_USER_TARGETED[TYPE](Env, safeKey, data[1], (e, value) => {
            if (e) {
                Env.Log.warn('RPC_ERROR', e, safeKey);
                return void Respond(e);
            }
            Respond(e, value);
        });
    }

    if (typeof(AUTHENTICATED_USER_SCOPED[TYPE]) === 'function') {
        return void AUTHENTICATED_USER_SCOPED[TYPE](Env, safeKey, (e, value) => {
            if (e) {
                Env.Log.warn('RPC_ERROR', e, safeKey);
                return void Respond(e);
            }
            Respond(e, value);
        });
    }

    return void Respond('UNSUPPORTED_RPC_CALL', data);
};

module.exports = Rpc;
