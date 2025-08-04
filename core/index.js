// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Interface = require("../common/interface.js");
const WSConnector = require("../common/ws-connector.js");
const { jumpConsistentHash } = require('../common/consistent-hash.js');
const WorkerModule = require("../common/worker-module.js");
const WriteQueue = require("../common/write-queue.js");

let Env = {
    ws_id_cache: {},
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
    return Env.ws_id_cache[userId] ? Env.ws_id_cache[userId] : 'websocket:0';
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
    Env.workers.send('VALIDATE_MESSAGE', args, cb);
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

    delete Env.ws_id_cache[userId];
};

const joinChannel = (args, cb, extra) => {
    if (!isWsCmd(extra.from)) { return void cb('UNAUTHORIZED'); }

    const { channel, userId } = args;
    if (!userId || !isValidChannel(channel)) {
        return void cb('EINVAL');
    }

    Env.ws_id_cache[userId] = extra.from;

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

    // XXX: this may be a risky queue if we receive messages more
    // frequently than the time needed to validate a message
    // (one round trip between core and storage + CPU time)
    Env.channelQueue(channel, next => {
        const storageId = getStorageId(channel);
        Env.interface.sendQuery(storageId, 'CHANNEL_MESSAGE', args, res => {
            if (res.error) {
                next();
                return void cb(res.error);
            }
            const { users, message } = res.data;

            sendChannelMessage(users, message);
            cb();
            next();
        });
    });
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

const createLogger = () => {
    return {
        info: console.log,
        verbose: console.info,
        error: console.error,
        warn: console.warn,
        debug: console.debug
    };
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
        'DROP_USER': dropUser,
        'JOIN_CHANNEL': joinChannel,
        'LEAVE_CHANNEL': leaveChannel,
        'CHANNEL_MESSAGE': onChannelMessage,
        'USER_MESSAGE': onUserMessage,
        'VALIDATE_MESSAGE': validateMessageHandler,
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
