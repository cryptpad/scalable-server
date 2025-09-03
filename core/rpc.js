const { jumpConsistentHash } = require('../common/consistent-hash.js');
const Util = require("../common/common-util");
const Core = require('../common/core');
const Rpc = {};

// XXX deduplicate with index
const getStorageId = (Env, channel) => {
    // We need a 8 byte key
    const key = Buffer.from(channel.slice(0, 8));
    return 'storage:' + jumpConsistentHash(key, Env.numberStorages);
};

// Anon

const getFileSize = (Env, channel, cb) => {
    const storageId = getStorageId(Env, channel);
    Env.interface.sendQuery(storageId, 'RPC_GET_FILE_SIZE', channel, res => {
        if (res.error) { return void cb(res.error); }
        cb(void 0, res.data);
    });
};

const getMultipleFileSize = () => {
};
const getDeletedPads = () => {
};
const isNewChannel = () => {
};
const writePrivateMessage = () => {
};
const deleteMailboxMessage = () => {
};
const getMetadata = () => {
};
const isPremium = () => {
};
const addFirstAdmin = () => {
};

// Auth
const resetUserPins = () => { };
const pinChannel = () => { };
const unpinChannel = () => { };
const clearOwnedChannel = () => { };
const removeOwnedChannel = () => { };
const trimHistory = () => { };
const uploadStatus = () => { };
const upload = () => { };
const uploadComplete = () => { };
const uploadCancel = () => { };
const uploadCompleteOwned = () => { };
const adminCommand = () => { };
const setMetadata = () => { };

const getHash = () => { };
const getTotalSize = () => { };
const getUpdatedLimit = () => { };
const getLimit = () => { };
const expireSessionAsync = () => { };
const removePins = () => { };
const trimPins = () => { };
const haveACookie = (Env, key, cb) => {
    cb();
};
const destroy = () => { };

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
    UPDATE_LIMITS: getUpdatedLimit,
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
            Env.Log.warn(err, content);
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
            Env.Log.warn(e, value);
            return void Respond(e, value);
        });
    }

    if (typeof(AUTHENTICATED_USER_SCOPED[TYPE]) === 'function') {
        return void AUTHENTICATED_USER_SCOPED[TYPE](Env, safeKey, (e, value) => {
            if (e) {
                Env.Log.warn(e, safeKey);
                return void Respond(e);
            }
            Respond(e, value);
        });
    }

    return void Respond('UNSUPPORTED_RPC_CALL', data);
};

module.exports = Rpc;
