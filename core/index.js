// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Interface = require("../common/interface.js");
const WSConnector = require("../common/ws-connector.js");
const { jumpConsistentHash } = require('../common/consistent-hash.js');
const WorkerModule = require("../common/worker-module.js");
const WriteQueue = require("../common/write-queue.js");
const Constants = require("../common/constants.js");

const {
    CHECKPOINT_PATTERN
} = Constants;


const createLogger = () => {
    return {
        info: console.log,
        verbose: console.info,
        error: console.error,
        warn: console.warn,
        debug: console.debug
    };
};

let Env = {
    Log: createLogger(),
    wsCache: {}, // WS associated to each user
    channelKeyCache: {}, // Validate key of each channel
    channelQueue: WriteQueue()
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


// TODO: implement storage migration later (in /storage/)
let getStorageId = function(channel) {
    if (!channel) {
        console.error('getStorageId: No channel provided');
        return void 0;
    }
    if (typeof (Env.numberStorages) === 'undefined') {
        console.error('getStorageId: number of storages undefined')
        return void 0;
    }
    // We need a 8 byte key
    let key = Buffer.from(channel.slice(0, 8));
    let ret = 'storage:' + jumpConsistentHash(key, Env.numberStorages);
    return ret;
};

// TODO: to fix (probably in websocket nodes)
let getWsId = function(userId) {
    return Env.wsCache[userId] ? Env.wsCache[userId] : 'websocket:0';
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

        let storageId = getStorageId(channel);

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

    Env.workers.send('VALIDATE_MESSAGE', args, cb);
};

const dropChannelHandler = (args, cb, extra) => {
    const { channel } = args;
    if (!channel) { return; }
    delete Env.channelKeyCache[channel];
};

const sendChannelMessage = (users, message) => {
    const sent = [];
    users.forEach(id => {
        const wsId = getWsId(id);
        if (!wsId || sent.includes(wsId)) { return; }
        sent.push(wsId);
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

    const sent = [];
    channels.forEach(channel => {
        const storageId = getStorageId(channel);
        if (sent.includes(storageId)) { return; }
        sent.push(storageId);
        Env.interface.sendEvent(storageId, 'DROP_USER', args);
    });

    delete Env.wsCache[userId];
};

const joinChannel = (args, cb, extra) => {
    if (!isWsCmd(extra.from)) { return void cb('UNAUTHORIZED'); }

    const { channel, userId } = args;
    if (!userId || !isValidChannel(channel)) {
        return void cb('EINVAL');
    }

    Env.wsCache[userId] = extra.from;

    const storageId = getStorageId(channel);
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

    const storageId = getStorageId(channel);
    Env.interface.sendQuery(storageId, 'LEAVE_CHANNEL', args, res => {
        if (res.error) { return void cb(res.error); }
        const users = res.data;

        const message = [ 0, userId, 'LEAVE', channel ];
        sendChannelMessage(users, message);

        cb();
    });
};

const onChannelMessage = (args, cb, extra) => {
    if (!isWsCmd(extra.from)) { return void cb('UNAUTHORIZED'); }

    const { channel, msgStruct } = args;
    if (!Array.isArray(msgStruct) || !isValidChannel(channel)) {
        return void cb('EINVAL');
    }

    const todo = (validated) => {
        const storageId = getStorageId(channel);
        Env.interface.sendQuery(storageId, 'CHANNEL_MESSAGE', {
            channel, msgStruct, validated
        }, res => {
            if (res.error) {
                next();
                return void cb(res.error);
            }
            const { users, message } = res.data;

            sendChannelMessage(users, message);
            cb();
        });
    };

    if (Env.channelKeyCache[channel]) {
        const msg = msgStruct[4].replace(CHECKPOINT_PATTERN, '');
        const vKey = Env.channelKeyCache[channel];
        Env.channelQueue(channel, next => {
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

let startServers = function(config) {
    let { myId, index, server, infra } = config;
    Env.numberStorages = config.infra.storage.length;
    const interfaceConfig = {
        connector: WSConnector,
        infra,
        server,
        myId,
        index
    };
    config.connector = WSConnector;

    const workerConfig = {
        Log: createLogger(),
        workerPath: './core/worker.js',
        maxWorkers: 1,
        maxJobs: 4,
        commandTimers: {}, // time spent on each command
        config: {
        },
        Env: { // Serialized Env (Environment.serialize)
        }
    };

    Env.workers = WorkerModule(workerConfig);

    let queriesToStorage = ['GET_HISTORY', 'GET_METADATA'];
    let queriesToWs = ['CHANNEL_CONTAINS_USER'];
    let eventsToStorage = [];
    let COMMANDS = {
        // From WS
        'DROP_USER': dropUser,
        'JOIN_CHANNEL': joinChannel,
        'LEAVE_CHANNEL': leaveChannel,
        'CHANNEL_MESSAGE': onChannelMessage,
        'USER_MESSAGE': onUserMessage,
        // From Storage
        'VALIDATE_MESSAGE': validateMessageHandler,
        'DROP_CHANNEL': dropChannelHandler,
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

    Interface.init(interfaceConfig, (err, _interface) => {
        if (err) {
            console.error('E: interface initialisation error', err)
            return;
        }
        console.log("Core started", config.myId);
        Env.interface = _interface;

        _interface.handleCommands(COMMANDS)
        if (process.send !== undefined) {
            process.send({ type: 'core', index: config.index, msg: 'READY' });
        }
    });
};

module.exports = {
    start: startServers
};
