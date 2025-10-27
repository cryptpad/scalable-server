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
    userCache: {}, // WS associated to each user
    channelKeyCache: {}, // Validate key of each channel
    queueValidation: WriteQueue(),
    Sessions: {},
    intervals: {},
    allDecrees: []
};

const isWsCmd = id => {
    return /^websocket:/.test(id);
};
const isStorageCmd = id => {
    return /^storage:/.test(id);
};
const isValidChannel = str => {
    return /^[a-f0-9]?[a-f0-9]{32,33}$/.test(str);
};


let getWsId = function(userId) {
    return Env.userCache?.[userId]?.from || 'websocket:0';
};

let wsToStorage = function(command, validated, isEvent) {
    return function(args, cb, extra) {
        if (!validated) {
            let s = extra.from.split(':');
            if (s[0] !== 'websocket') {
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

let storageToWs = function(command) {
    return function(args, cb, extra) {
        let s = extra.from.split(':');
        if (s[0] !== 'storage') {
            console.error('Error:', command, 'received from unauthorized server:', args, extra);
            cb('UNAUTHORIZED_USER', void 0);
            return;
        }
        let userId = args.userId;

        let wsId = getWsId(userId);

        Env.interface.sendQuery(wsId, command, args, function(response) {
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
        Env.workers.send('VALIDATE_MESSAGE', args, e => {
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
        const wsId = getWsId(id);
        if (!wsId || sent.has(wsId)) { return; }
        sent.add(wsId);
        Env.interface.sendEvent(wsId, 'SEND_CHANNEL_MESSAGE', {
            users,
            message
        });
    });
};

// Event: when a user is disconnected, remove it from all its channels
const dropUser = (args, _cb, extra) => {
    if (!isWsCmd(extra.from)) { return; }

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
    if (!isWsCmd(extra.from)) { return void cb('UNAUTHORIZED'); }

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
    if (!isWsCmd(extra.from)) { return void cb('UNAUTHORIZED'); }

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
    if (!isWsCmd(extra.from)) { return void cb('UNAUTHORIZED'); }

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
            Env.workers.send('VALIDATE_MESSAGE', {
                channel,
                signedMsg: msg,
                validateKey: vKey
            }, (e) => {
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
    const wsId = getWsId(userId);
    Env.interface.sendQuery(wsId, 'SEND_USER_MESSAGE', args, res => {
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
            const wsId = getWsId(userId);
            Env.interface.sendQuery(wsId, 'SEND_USER_MESSAGE', {
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
    Env.interface.broadcast('websocket', 'SEND_USER_MESSAGE', args, values => {
        // If all responses return an error, message has failed
        if (values.every(obj => {
            return obj?.error;
        })) {
            return void cb('ERROR');
        }
        // Otherwise, success
        cb();
    });
};

const onAnonRpc = (args, cb, extra) => {
    if (!isWsCmd(extra.from)) { return void cb('UNAUTHORIZED'); }
    const {userId, /*txid, */data} = args;

    if (!Rpc.isUnauthenticateMessage(data)) {
        return void cb('INVALID_ANON_RPC_COMMAND');
    }

    Rpc.handleUnauthenticated(Env, data, userId, (err, msg) => {
        cb(err, msg);
    });
};
const onAuthRpc = (args, cb, extra) => {
    if (!isWsCmd(extra.from)) { return void cb('UNAUTHORIZED'); }
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

    //Env.plugins?.MONITORING?.increment(`rpc_${command}`); // XXX MONITORING

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
    Env.workers.send('VALIDATE_RPC', {
        msg: serialized,
        key: publicKey,
        sig
    }, err => {
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

        return Rpc.handleAuthenticated(Env, publicKey, data, cb);
    });
};

const onGetChannelList = (args, cb, extra) => {
    if (!isStorageCmd(extra.from)) { return void cb("UNAUTHORIZED"); }
    const { safeKey } = args;
    StorageCommands.getChannelList(Env, safeKey, cb);
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

const onGetRegisteredUsers = (args, cb, extra) => {
    if (!isStorageCmd(extra.from)) { return void cb("UNAUTHORIZED"); }
    StorageCommands.getRegisteredUsers(Env, cb);
};

const onBlockCheck = (args, cb, extra) => {
    if (!isStorageCmd(extra.from)) { return void cb("UNAUTHORIZED"); }
    StorageCommands.onBlockCheck(Env, args, cb);
};
const onGetMFA = (args, cb, extra) => {
    if (!isStorageCmd(extra.from)) { return void cb("UNAUTHORIZED"); }
    StorageCommands.onGetMFA(Env, args, cb);
};
const onSessionsCommand = (args, cb, extra) => {
    if (!isStorageCmd(extra.from)) { return void cb("UNAUTHORIZED"); }
    StorageCommands.onSessionsCommand(Env, args, cb);
};
const onUserRegistryCommand = (args, cb, extra) => {
    if (!isStorageCmd(extra.from)) { return void cb("UNAUTHORIZED"); }
    StorageCommands.onUserRegistryCommand(Env, args, cb);
};
const onInvitationCommand = (args, cb, extra) => {
    if (!isStorageCmd(extra.from)) { return void cb("UNAUTHORIZED"); }
    StorageCommands.onInvitationCommand(Env, args, cb);
};

const onHttpCommand = (args, cb, extra) => {
    if (!isWsCmd(extra.from)) { return void cb('UNAUTHORIZED'); }
    AuthCommands.handle(Env, args, cb);
};

const onWsCommand = command => {
    return (args, cb, extra) => {
        if (!isWsCmd(extra.from)) { return void cb('UNAUTHORIZED'); }
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
    Env.FRESH_KEY = args.freshKey;
    Env.curveKeys = args.curveKeys;
    Env.adminDecrees.loadRemote(Env, args.decrees);
    Array.prototype.push.apply(Env.allDecrees, args.decrees);
    // core:0 also has to broadcast to all the websocket and storage
    // nodes
    nThen(waitFor => {
        if (Env.myId !== 'core:0') { return; }
        Env.interface.broadcast('websocket', 'NEW_DECREES', {
            freshKey: args.freshKey,
            curveKeys: args.curveKeys,
            decrees: args.decrees
        }, waitFor(values => {
            values.forEach(obj => {
                if (!obj?.error) { return; }
                const { id, error } = obj;
                Env.Log.error("BCAST_DECREES_ERROR", { id, error });
            });
        }));
        const exclude = ['storage:0'];
        Env.interface.broadcast('storage', 'NEW_DECREES', {
            freshKey: args.freshKey,
            curveKeys: args.curveKeys,
            decrees: args.decrees
        }, waitFor(values => {
            values.forEach(obj => {
                if (!obj?.error) { return; }
                const { id, error } = obj;
                Env.Log.error("BCAST_DECREES_ERROR", { id, error });
            });
        }), exclude);
        Env.interface.sendQuery('http:0', 'NEW_DECREES', {
            decrees: args.decrees
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

let startServers = function(config) {
    let { myId, index, server, infra } = config;
    Environment.init(Env, config);

    const interfaceConfig = {
        connector: WSConnector,
        infra,
        server,
        myId,
        index
    };
    config.connector = WSConnector;

    const workerConfig = {
        Log: Env.Log,
        workerPath: './build/core.worker.js',
        maxWorkers: 1,
        maxJobs: 4,
        commandTimers: {}, // time spent on each command
        config: {
        },
        Env: { // Serialized Env (Environment.serialize)
        }
    };

    const { challengePath } = Core.getPaths(config);
    Env.challengePath = challengePath;
    Env.workers = WorkerModule(workerConfig);

    let queriesToStorage = [];
    let queriesToWs = [];
    let eventsToStorage = [];
    let COMMANDS = {
        // From WS
        'DROP_USER': dropUser,
        'JOIN_CHANNEL': joinChannel,
        'LEAVE_CHANNEL': leaveChannel,
        'CHANNEL_MESSAGE': onChannelMessage,
        'USER_MESSAGE': onUserMessage,
        'ANON_RPC': onAnonRpc,
        'AUTH_RPC': onAuthRpc,
        'HTTP_COMMAND': onHttpCommand,
        'GET_HISTORY': onWsCommand('GET_HISTORY'),
        'GET_FULL_HISTORY': onWsCommand('GET_FULL_HISTORY'),
        'GET_HISTORY_RANGE': onWsCommand('GET_HISTORY_RANGE'),
        // From Storage
        'VALIDATE_MESSAGE': validateMessageHandler,
        'DROP_CHANNEL': dropChannelHandler,
        'HISTORY_MESSAGE': onHistoryMessage,
        'HISTORY_CHANNEL_MESSAGE': onHistoryChannelMessage,
        'NEW_DECREES': onNewDecrees,
        'ACCOUNTS_LIMITS': onAccountsLimits,
        'SEND_CHANNEL_MESSAGE': onSendChannelMessage,
        'GET_AUTH_KEYS': onGetAuthKeys,

        'GET_CHANNEL_LIST': onGetChannelList,
        'GET_MULTIPLE_FILE_SIZE': onGetMultipleFileSize,
        'GET_TOTAL_SIZE': onGetTotalSize,
        'GET_CHANNELS_TOTAL_SIZE': onGetChannelsTotalSize,
        'GET_REGISTERED_USERS': onGetRegisteredUsers,

        'BLOCK_CHECK': onBlockCheck,
        'BLOCK_GET_MFA': onGetMFA,
        'SESSIONS_CMD': onSessionsCommand,
        'USER_REGISTRY_CMD': onUserRegistryCommand,
        'INVITATION_CMD': onInvitationCommand,
    };
    queriesToStorage.forEach(function(command) {
        COMMANDS[command] = wsToStorage(command);
    });
    queriesToWs.forEach(function(command) {
        COMMANDS[command] = storageToWs(command);
    });
    eventsToStorage.forEach(function(command) {
        COMMANDS[command] = wsToStorage(command, false, true);
    });

    initIntervals();

    Env.interface = Interface.init(interfaceConfig, err => {
        if (err) {
            console.error('E: interface initialisation error', err);
            return;
        }
        console.log("Core started", config.myId);
        if (process.send !== undefined) {
            process.send({ type: 'core', index: config.index, msg: 'READY' });
        }
    });
    Env.interface.handleCommands(COMMANDS);
    if (Env.myId !== 'core:0') { return; }
    Env.interface.onNewConnection(obj => {
        const id = `${obj.type}:${obj.index}`;
        if (!Env.allDecrees.length) { return; }
        Env.interface.sendEvent(id, 'ACCOUNTS_LIMITS', {
            limits: Env.accountsLimits
        });
        Env.interface.sendEvent(id, 'NEW_DECREES', {
            curveKeys: Env.curveKeys,
            freshKey: Env.FRESH_KEY,
            decrees: Env.allDecrees
        });
    });
};

module.exports = {
    start: startServers
};
