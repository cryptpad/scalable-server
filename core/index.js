// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Config = require("../ws-config.js");
const Interface = require("../common/interface.js");
const WriteQueue = require("../storage/write-queue.js");
const Crypto = require("./crypto.js")('sodiumnative');
const { jumpConsistentHash } = require('../common/consistent-hash.js');
const cli_args = require("minimist")(process.argv.slice(2));

if (cli_args.h || cli_args.help) {
    console.log(`Usage ${process.argv[1]}:`);
    console.log("\t--help, -h\tDisplay this help");
    console.log("\t--id\tSet the core node id (default: 0)");
    return;
}

let Env = {
    queueValidation: WriteQueue(),
    ws_id_cache: {},
};

const isWsCmd = id => {
    return /^ws:/.test(id);
};
const isStorageCmd = id => {
    return /^storage:/.test(id);
};
const isValidChannel = str => {
    return /^[a-f0-9]?[a-f0-9]{32,33}$/.test(str);
};


// TODO: implement storage migration later (in /storage/)
let getStorageId = function(channelName) {
    if (!channelName) {
        console.error('getStorageId: No channelName provided');
        return void 0;
    }
    if (typeof (Env.numberStorages) === 'undefined') {
        console.error('getStorageId: number of storages undefined')
        return void 0;
    }
    // We need a 8 byte key
    let key = Buffer.from(channelName.slice(0, 8));
    let ret = 'storage:' + jumpConsistentHash(key, Env.numberStorages);
    return ret;
};

// TODO: to fix (probably in websocket nodes)
let getWsId = function(userId) {
    return Env.ws_id_cache[userId] ? Env.ws_id_cache[userId] : 'ws:0';
};

let wsToStorage = function(command, validated, isEvent) {
    return function(args, cb, extra) {
        if (!validated) {
            let s = extra.from.split(':');
            if (s[0] !== 'ws') {
                console.error('Error:', command, 'received from unauthorized server:', args, extra);
                cb('UNAUTHORIZED_USER', void 0);
                return;
            }
        }
        let channelName = args.channelName;

        let storageId = getStorageId(channelName);

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


const onValidateMessage = (msg, vk, cb) => {
    let signedMsg;
    try {
        signedMsg = Crypto.decodeBase64(msg);
    } catch (e) {
        return void cb('E_BAD_MESSAGE');
    }

    let validateKey;
    try {
        validateKey = Crypto.decodeBase64(vk);
    } catch (e) {
        return void cb('E_BADKEY');
    }

    const validated = Crypto.sigVerify(signedMsg, validateKey);
    if (!validated) {
        return void cb('FAILED');
    }
    cb();
};

const validateMessageHandler = (args, cb) => {
    Env.queueValidation(args.channelName, next => {
        onValidateMessage(args.signedMsg, args.validateKey, err => {
            next();
            if (err) { return void cb(err); }
            cb();
        });
    });
};

const sendChannelMessage = (users, message) => {
    const sent = [];
    users.forEach(id => {
        const wsId = getWsId(id);
        if (!wsId || sent.includes(wsId)) { return; }
        sent.push(wsId);
        Env.interface.sendEvent(wsId, 'CHANNEL_MESSAGE', {
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

        const message = [ userId, 'JOIN', channel ];
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

        const message = [ userId, 'LEAVE', channel ];
        sendChannelMessage(users, message);

        cb();
    });
};

const onUserMessage = (args, cb) => {
    Env.interface.broadcast('ws', 'USER_MESSAGE', args, values => {
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

let startServers = function() {
    Env.numberStorages = Config.infra.storage.length;
    let idx = Number(cli_args.id) || 0;
    Config.myId = 'core:' + idx;
    let queriesToStorage = ['GET_HISTORY', 'GET_METADATA', 'CHANNEL_MESSAGE'];
    let queriesToWs = ['CHANNEL_CONTAINS_USER'];
    //let eventsToStorage = ['DROP_USER'];
    let eventsToStorage = [];
    let COMMANDS = {
        'DROP_USER': dropUser,
        'JOIN_CHANNEL': joinChannel,
        'LEAVE_CHANNEL': leaveChannel,
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

    Interface.init(Config, (err, _interface) => {
        if (err) {
            console.error('E: interface initialisation error', err)
            return;
        }
        console.log("Core started", Config.myId);
        Env.interface = _interface;

        _interface.handleCommands(COMMANDS)
        if (process.send !== undefined) {
            process.send({ type: 'core', idx, msg: 'READY' });
        }
    });
};

module.exports = {
    start: startServers
};
