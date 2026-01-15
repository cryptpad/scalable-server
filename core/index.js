// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Interface = require("../common/interface.js");
const WSConnector = require("../common/ws-connector.js");
const WorkerModule = require("../common/worker-module.js");
const WriteQueue = require("../common/write-queue.js");
const Constants = require("../common/constants.js");
const Core = require("../common/core.js");
const Util = require("../common/common-util.js");
const Logger = require("../common/logger.js");
const Rpc = require("./rpc.js");
const AuthCommands = require("./http-commands.js");
const nThen = require('nthen');

const StorageCommands = require('./commands/storage');

const Environment = require('../common/env.js');

const {
    CHECKPOINT_PATTERN
} = Constants;

let Env = {
    Log: Logger(),
    userCache: {}, // Front associated to each user
    channelKeyCache: {}, // Validate key of each channel
    queueValidation: WriteQueue(),
    Sessions: {},
    intervals: {},
};

const isFrontCmd = id => {
    return /^front:/.test(id);
};
const isStorageCmd = id => {
    return /^storage:/.test(id);
};
const isValidChannel = str => {
    return /^[a-f0-9]?[a-f0-9]{32,33}$/.test(str);
};


let getFrontId = function(userId) {
    return Env.userCache?.[userId]?.from || 'front:0';
};

let frontToStorage = function(command, validated, isEvent) {
    return function(args, cb, extra) {
        if (!validated) {
            let s = extra.from.split(':');
            if (s[0] !== 'front') {
                console.error('Error:', command, 'received from unauthorized server:', args, extra);
                cb('UNAUTHORIZED_USER', void 0);
                return;
            }
        }
        let channel = args.channel;

        let storageId = Env.getStorageId(channel);

        if (isEvent) {
            Env.interface.sendEvent(storageId, command, args);
        }
        else {
            Env.interface.sendQuery(storageId, command, args, function(response) {
                cb(response.error, response.data);
            });
        }
    };
};

let storageToFront = function(command) {
    return function(args, cb, extra) {
        let s = extra.from.split(':');
        if (s[0] !== 'storage') {
            console.error('Error:', command, 'received from unauthorized server:', args, extra);
            cb('UNAUTHORIZED_USER', void 0);
            return;
        }
        let userId = args.userId;

        let frontId = getFrontId(userId);

        Env.interface.sendQuery(frontId, command, args, function(response) {
            cb(response.error, response.data);
        });
    };
};

const authenticateUser = (userId, unsafeKey) => {
    const user = Env.userCache[userId] ||= {};
    const authKeys = user.authKeys ||= {};
    authKeys[unsafeKey] = +new Date();
};
const unauthenticateUser = (userId, unsafeKey) => {
    const user = Env.userCache[userId];
    if (user.authKeys) { return; }
    delete user.authKeys[unsafeKey];
};

const validateMessageHandler = (args, cb, extra) => {
    if (!isStorageCmd(extra.from)) {
        return void cb("UNAUTHORIZED");
    }

    const { channel, validateKey } = args;
    if (!channel || !validateKey) {
        return void cb('INVALID_ARGUMENTS');
    }

    // Store the validate key in memory to save a round-trip
    // to storage for future messages
    // See onChannelMessage
    Env.channelKeyCache[channel] = validateKey;

    Env.queueValidation(channel, next => {
        let avg = Env.plugins?.MONITORING?.average(`inlineValidation`);
        Env.workers.send('VALIDATE_MESSAGE', args, e => {
            avg?.time();
            next();
            cb(e);
        });
    });
};

const dropChannelHandler = (args, cb, extra) => {
    if (!isStorageCmd(extra.from)) { return; }

    const { channel } = args;
    if (!channel) { return; }
    delete Env.channelKeyCache[channel];
};

const sendChannelMessage = (users, message) => {
    const sent = new Set();
    (users || []).forEach(id => {
        const frontId = getFrontId(id);
        if (!frontId || sent.has(frontId)) { return; }
        sent.add(frontId);
        Env.interface.sendEvent(frontId, 'SEND_CHANNEL_MESSAGE', {
            users,
            message
        });
    });
};

// Event: when a user is disconnected, remove it from all its channels
const dropUser = (args, _cb, extra) => {
    if (!isFrontCmd(extra.from)) { return; }

    const { channels, userId } = args;
    if (!userId || !Array.isArray(channels)) { return; }

    const done = new Set();
    const sent = new Set();
    channels.forEach(channel => {
        // And tell storages to clear their memory
        const storageId = Env.getStorageId(channel);
        if (sent.has(storageId)) { return; }
        sent.add(storageId);
        Env.interface.sendQuery(storageId, 'DROP_USER', args, res => {
            if (res.error) { return; }
            const lists = res.data;

            Object.keys(lists).forEach(channel => {
                if (done.has(channel)) { return; }
                const users = lists[channel];
                if (!users) { return; }

                // For each channel, send LEAVE message
                const message = [ 0, userId, 'LEAVE', channel ];
                sendChannelMessage(users, message);
                done.add(channel);
            });
        });
    });

    delete Env.userCache[userId];
};

const joinChannel = (args, cb, extra) => {
    if (!isFrontCmd(extra.from)) { return void cb('UNAUTHORIZED'); }

    const { channel, userId } = args;
    if (!userId || !isValidChannel(channel)) {
        return void cb('EINVAL');
    }

    const user = Env.userCache[userId] ||= {};
    if (!user.from) { user.from = extra.from; }

    const storageId = Env.getStorageId(channel);
    Env.interface.sendQuery(storageId, 'JOIN_CHANNEL', args, res => {
        if (res.error) { return void cb(res.error); }
        const users = res.data;

        const message = [ 0, userId, 'JOIN', channel ];
        sendChannelMessage(users, message);

        cb(void 0, users);
    });
};
const leaveChannel = (args, cb, extra) => {
    if (!isFrontCmd(extra.from)) { return void cb('UNAUTHORIZED'); }

    const { channel, userId } = args;
    if (!userId || !isValidChannel(channel)) {
        return void cb('EINVAL');
    }

    const storageId = Env.getStorageId(channel);
    Env.interface.sendQuery(storageId, 'LEAVE_CHANNEL', args, res => {
        if (res.error) { return void cb(res.error); }
        const users = res.data;

        const message = [ 0, userId, 'LEAVE', channel ];
        sendChannelMessage(users, message);

        cb();
    });
};

// Message from user to storage to channel members
const onChannelMessage = (args, cb, extra) => {
    if (!isFrontCmd(extra.from)) { return void cb('UNAUTHORIZED'); }

    const { channel, msgStruct } = args;
    if (!Array.isArray(msgStruct) || !isValidChannel(channel)) {
        return void cb('EINVAL');
    }

    const todo = (validated) => {
        const storageId = Env.getStorageId(channel);
        Env.interface.sendQuery(storageId, 'CHANNEL_MESSAGE', {
            channel, msgStruct, validated
        }, res => {
            if (res.error) {
                return void cb(res.error);
            }
            const { users, message } = res.data;

            if (!message) { return void cb(); }

            sendChannelMessage(users, message);
            cb();
        });
    };

    if (Env.channelKeyCache[channel]) {
        const msg = msgStruct[4].replace(CHECKPOINT_PATTERN, '');
        const vKey = Env.channelKeyCache[channel];
        Env.queueValidation(channel, next => {
            let avg = Env.plugins?.MONITORING?.average(`inlineValidation`);
            Env.workers.send('VALIDATE_MESSAGE', {
                channel,
                signedMsg: msg,
                validateKey: vKey
            }, (e) => {
                avg?.time();
                next();
                if (e === 'FAILED') {
                    Env.Log.error("HK_SIGNED_MESSAGE_REJECTED", {
                        channel,
                        validateKey: vKey,
                        message: msg,
                    });
                    return void cb('FAILED_VALIDATION');
                }
                if (e) { return void cb(e); }
                todo(true);
            });
        });
        return;
    }

    todo(false);
};

// Message from history keeper to user
const onHistoryMessage = (args, cb) => {
    const { userId } = args; // userId, message
    const frontId = getFrontId(userId);
    Env.interface.sendQuery(frontId, 'SEND_USER_MESSAGE', args, res => {
        cb(res?.error, res?.data);
    });
};
// Message from history keeper to all members
const onHistoryChannelMessage = (args, cb) => {
    const { users, message } = args;
    // For each user, change the "dest" to their user id
    nThen(w => {
        users.forEach(userId => {
            const msg = message.slice();
            msg[3] = userId;
            const frontId = getFrontId(userId);
            Env.interface.sendQuery(frontId, 'SEND_USER_MESSAGE', {
                userId, message: msg
            }, w());
        });
    }).nThen(() => {
        if (typeof(cb) !== "function") { return; }
        cb();
    });
};

// Private message to all members
const onSendChannelMessage = (args) => {
    const { users, message } = args;
    sendChannelMessage(users, message);
};

// Message from user to user
const onUserMessage = (args, cb) => {
    Env.interface.broadcast('front', 'SEND_USER_MESSAGE', args, (err, values) => {
        // If all responses return an error, message has failed
        if (!values.length) {
            return void cb('ERROR');
        }
        // Otherwise, success
        cb();
    });
};

const onAnonRpc = (args, cb, extra) => {
    if (!isFrontCmd(extra.from)) { return void cb('UNAUTHORIZED'); }
    const {userId, /*txid, */data} = args;

    if (!Rpc.isUnauthenticateMessage(data)) {
        return void cb('INVALID_ANON_RPC_COMMAND');
    }

    let avg = Env.plugins?.MONITORING?.average(`rpc_${data[0]}`);

    Rpc.handleUnauthenticated(Env, data, userId, (err, msg) => {
        avg?.time();
        cb(err, msg);
    });
};
const onAuthRpc = (args, cb, extra) => {
    if (!isFrontCmd(extra.from)) { return void cb('UNAUTHORIZED'); }
    const {userId, /*txid, */data} = args;


    const sig = data.shift();
    const publicKey = data.shift();
    const [cookie, command/*, data*/] = data;


    const safeKey = Util.escapeKeyCharacters(publicKey);
    const hadSession = Boolean(Env.Sessions[safeKey]);

    // make sure a user object is initialized in the cookie jar
    if (publicKey) {
        Core.getSession(Env.Sessions, publicKey);
    } else {
        Env.Log.debug("NO_PUBLIC_KEY_PROVIDED", publicKey);
    }

    if (!Core.isValidCookie(Env.Sessions, publicKey, cookie)) {
        // no cookie is fine if the RPC is to get a cookie
        if (command !== 'COOKIE') {
            return void cb('NO_COOKIE');
        }
    }

    let serialized = JSON.stringify(data);
    if (!(serialized && typeof(publicKey) === 'string')) {
        return void cb('INVALID_MESSAGE_OR_PUBLIC_KEY');
    }

    let avg = Env.plugins?.MONITORING?.average(`rpc_${command}`);

    if (command === 'UPLOAD') {
        // UPLOAD is a special case that skips signature validation
        // intentional fallthrough behaviour
        return void Rpc.handleAuthenticated(Env, publicKey, data, cb);
    }

    if (!Rpc.isAuthenticatedCall(command)) {
        Env.Log.warn('INVALID_RPC_CALL', command);
        return void cb("INVALID_RPC_CALL");
    }

    // check the signature on the message
    // refuse the command if it doesn't validate
    let avgVal = Env.plugins?.MONITORING?.average(`detachedValidation`);
    Env.workers.send('VALIDATE_RPC', {
        msg: serialized,
        key: publicKey,
        sig
    }, err => {
        avgVal?.time();
        if (err) {
            return void cb("INVALID_SIGNATURE_OR_PUBLIC_KEY");
        }
        if (command === 'COOKIE' && !hadSession && Env.logIP) {
            Env.Log.info('NEW_RPC_SESSION', {userId: userId, publicKey: publicKey});
        }
        if (command === "DESTROY") {
            unauthenticateUser(userId, publicKey);
            return; // No need to respond, user will close the session
        }

        // XXX COOKIE shouldn't add the key to the user session
        // --> risk of replay attacks
        // We should instead create a new AUTH command, which does
        // nothing but requires a recent cookie to work.
        // We can then update onRejected in async-store to call
        // this AUTH command before retrying to join a pad.
        authenticateUser(userId, publicKey);

        return Rpc.handleAuthenticated(Env, publicKey, data, Util.both(cb, avg?.time));
    });
};

const onGetMultipleFileSize = (channels, cb, extra) => {
    if (!isStorageCmd(extra.from)) { return void cb("UNAUTHORIZED"); }
    StorageCommands.getMultipleFileSize(Env, channels, cb);
};
const onGetTotalSize = (args, cb, extra) => {
    if (!isStorageCmd(extra.from)) { return void cb("UNAUTHORIZED"); }
    const { safeKey } = args;
    StorageCommands.getTotalSize(Env, safeKey, cb);
};
const onGetChannelsTotalSize = (channels, cb, extra) => {
    if (!isStorageCmd(extra.from)) { return void cb("UNAUTHORIZED"); }
    StorageCommands.getChannelsTotalSize(Env, channels, cb);
};

const onStorageToFront = (args, cb, extra) => {
    if (!isStorageCmd(extra.from)) { return void cb("UNAUTHORIZED"); }
    const { cmd, data } = args;
    Env.interface.broadcast('front', cmd, data, (errors, data) => {
        if (errors && errors.length) { return void cb(errors, data); }
        cb(void 0, data);
    });
};

const onHttpCommand = (args, cb, extra) => {
    if (!isFrontCmd(extra.from)) { return void cb('UNAUTHORIZED'); }
    AuthCommands.handle(Env, args, cb);
};

const onFrontCommand = command => {
    return (args, cb, extra) => {
        if (!isFrontCmd(extra.from)) { return void cb('UNAUTHORIZED'); }
        const channel = args.channel;
        const storageId = Env.getStorageId(channel);

        Env.interface.sendQuery(storageId, command, args, function(response) {
            cb(response.error, response.data);
        });
    };
};


// When receiving new decrees from storage:0, update our env
// and broadcast to all the other nodes
const onNewDecrees = (args, cb, extra) => {
    if (!isStorageCmd(extra.from)) { return void cb("UNAUTHORIZED"); }
    const { type, decrees, freshKey, curveKeys } = args;

    Env.FRESH_KEY = freshKey;
    Env.curveKeys = curveKeys;

    Env.getDecree(type).loadRemote(Env, decrees);
    Env.cacheDecrees(type, decrees);

    // core:0 also has to broadcast to all the front and storage
    // nodes
    nThen(waitFor => {
        if (Env.myId !== 'core:0') { return; }
        Env.interface.broadcast('front', 'NEW_DECREES', {
            freshKey, curveKeys, type, decrees
        }, waitFor((errors) => {
            errors.forEach(obj => {
                const { id, error } = obj;
                Env.Log.error("BCAST_DECREES_ERROR", { id, error });
            });
        }));
        const exclude = ['storage:0'];
        Env.interface.broadcast('storage', 'NEW_DECREES', {
            freshKey, curveKeys, type, decrees
        }, waitFor((errors) => {
            errors.forEach(obj => {
                const { id, error } = obj;
                Env.Log.error("BCAST_DECREES_ERROR", { id, error });
            });
        }), exclude);
        Env.interface.sendQuery('http:0', 'NEW_DECREES', {
            freshKey, curveKeys, type, decrees
        }, waitFor());
    }).nThen(() => {
        cb();
    });
};

const onAccountsLimits = (args, cb, extra) => {
    if (!isStorageCmd(extra.from)) { return void cb("UNAUTHORIZED"); }
    const { limits } = args;

    Env.limits = limits;
    Env.accountsLimits = limits;
    Core.applyLimits(Env);

    if (Env.myId !== 'core:0') { return void cb(); }

    // Core:0 also has to broadcast to all other storages
    const exclude = ['storage:0'];
    Env.interface.broadcast('storage', 'ACCOUNTS_LIMITS', {
        limits
    }, () => { cb(); }, exclude);
};

const onGetAuthKeys = (args, cb, extra) => {
    if (!isStorageCmd(extra.from)) { return void cb("UNAUTHORIZED"); }
    const { userId } = args;

    const user = Env.userCache[userId] ||= {};
    const authKeys = user.authKeys || {};

    cb(void 0, authKeys);
};

const initIntervals = () => {
    // expire old sessions once per minute
    Env.intervals.sessionExpirationInterval = setInterval(() => {
        Core.expireSessions(Env.Sessions);
    }, Core.SESSION_EXPIRATION_TIME);
};

const onIsUserOnline = (safeKey, cb) => {
    if (!Core.isValidPublicKey(safeKey)) { return void cb("EINVAL"); }
    const unsafeKey = Util.unescapeKeyCharacters(safeKey);
    cb(void 0, Object.values(Env.userCache)
        .some(v => v.authKeys && Object.keys(v.authKeys).includes(unsafeKey)));
};

const onFlushCache = Env.flushCache = (_args, cb) => {
    if (Env.myId !== 'core:0') { return void cb('EINVAL'); }

    Env.interface.broadcast('websocket', 'ADMIN_CMD', {
        cmd: 'FLUSH_CACHE',
        data: { freshKey: +new Date() }
    }, () => { cb(void 0, true); });
};

const startServers = (mainConfig) => {
    let { myId, index, config, infra } = mainConfig;
    Environment.init(Env, mainConfig);

    const interfaceConfig = {
        connector: WSConnector,
        infra,
        server: config,
        myId,
        index,
        Log: Env.Log
    };

    const workerConfig = {
        Log: Env.Log,
        workerPath: './build/core.worker.js',
        maxWorkers: 1,
        maxJobs: 15,
        commandTimers: {}, // time spent on each command
        config: {
        },
        Env: { // Serialized Env (Environment.serialize)
        }
    };

    const { challengePath } = Core.getPaths(mainConfig);
    Env.challengePath = challengePath;
    Env.workers = WorkerModule(workerConfig);

    let queriesToStorage = [];
    let queriesToFront = [];
    let eventsToStorage = [];
    let COMMANDS = {
        // From Front
        'DROP_USER': dropUser,
        'JOIN_CHANNEL': joinChannel,
        'LEAVE_CHANNEL': leaveChannel,
        'CHANNEL_MESSAGE': onChannelMessage,
        'USER_MESSAGE': onUserMessage,
        'ANON_RPC': onAnonRpc,
        'AUTH_RPC': onAuthRpc,
        'HTTP_COMMAND': onHttpCommand,
        'GET_HISTORY': onFrontCommand('GET_HISTORY'),
        'GET_FULL_HISTORY': onFrontCommand('GET_FULL_HISTORY'),
        'GET_HISTORY_RANGE': onFrontCommand('GET_HISTORY_RANGE'),
        // From Storage
        'VALIDATE_MESSAGE': validateMessageHandler,
        'DROP_CHANNEL': dropChannelHandler,
        'HISTORY_MESSAGE': onHistoryMessage,
        'HISTORY_CHANNEL_MESSAGE': onHistoryChannelMessage,
        'NEW_DECREES': onNewDecrees,
        'ACCOUNTS_LIMITS': onAccountsLimits,
        'SEND_CHANNEL_MESSAGE': onSendChannelMessage,
        'GET_AUTH_KEYS': onGetAuthKeys,
        // From Core
        'IS_USER_ONLINE': onIsUserOnline,
        'FLUSH_CACHE': onFlushCache,

        'GET_MULTIPLE_FILE_SIZE': onGetMultipleFileSize,
        'GET_TOTAL_SIZE': onGetTotalSize,
        'GET_CHANNELS_TOTAL_SIZE': onGetChannelsTotalSize,

        'STORAGE_FRONT': onStorageToFront,
    };
    queriesToStorage.forEach(function(command) {
        COMMANDS[command] = frontToStorage(command);
    });
    queriesToFront.forEach(function(command) {
        COMMANDS[command] = storageToFront(command);
    });
    eventsToStorage.forEach(function(command) {
        COMMANDS[command] = frontToStorage(command, false, true);
    });

    initIntervals();

    Env.interface = Interface.init(interfaceConfig, err => {
        if (err) {
            console.error('E: interface initialisation error', err);
            return;
        }
        if (process.send !== undefined) {
            process.send({ type: 'core', index, msg: 'READY' });
        }
    });
    Env.plugins.call('addCoreCommands')(Env, COMMANDS);
    Env.interface.handleCommands(COMMANDS);
    if (Env.myId !== 'core:0') { return; }
    Env.interface.onNewConnection(obj => {
        const id = `${obj.type}:${obj.index}`;
        Env.interface.sendEvent(id, 'ACCOUNTS_LIMITS', {
            limits: Env.accountsLimits
        });
        Object.keys(Env.allDecrees).forEach(type => {
            const decrees = Env.allDecrees[type];
            Env.interface.sendEvent(id, 'NEW_DECREES', {
                curveKeys: Env.curveKeys,
                freshKey: Env.FRESH_KEY,
                type, decrees
            });
        });
    });
};

module.exports = {
    start: startServers
};
