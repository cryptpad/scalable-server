// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Config = require("../ws-config.js");
const Interface = require("../common/interface.js");
const WSConnector = require("../common/ws-connector.js");
const WriteQueue = require("../storage/write-queue.js");
const Crypto = require("./crypto.js")('sodiumnative');
const { jumpConsistentHash } = require('../common/consistent-hash.js');
const cli_args = require("minimist")(process.argv.slice(2));

let proceed = true;

if (cli_args.h || cli_args.help) {
    proceed = false;
    console.log(`Usage ${process.argv[1]}:`);
    console.log("\t--help, -h\tDisplay this help");
    console.log("\t--id\tSet the core node id (default: 0)");
}

if (!proceed) { return; }

let Env = {
    queueValidation: WriteQueue(),
    ws_id_cache: {},
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

let EventToStorage = function(command) {
    return function(args, _cb, extra) {
        let s = extra.from.split(':');
        if (s[0] !== 'ws') {
            console.error('Error:', command, 'received from unauthorized server:', args, extra);
            return;
        }
        let channelName = args.channelName;

        let storageId = getStorageId(channelName);

        Env.interface.sendEvent(storageId, command, args);
    };
};

let onValidateMessage = (msg, vk, cb) => {
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

let validateMessageHandler = (args, cb) => {
    Env.queueValidation(args.channelName, function(next) {
        next();
        onValidateMessage(args.signedMsg, args.validateKey, cb);
    });
};

let channelOpenHandler = function(args, cb, extra) {
    let s = extra.from.split(':');
    if (s[0] !== 'ws') {
        console.error('Error:', command, 'received from unauthorized server:', args, extra);
        cb('UNAUTHORIZED_USER', void 0);
        return;
    }
    // TODO: clear in somewhere
    Env.ws_id_cache[args.userId] = extra.from;

    wsToStorage('CHANNEL_OPEN', true)(args, cb, extra);
};

let startServers = function() {
    Env.numberStorages = Config.infra.storage.length;
    let idx = Number(cli_args.id) || 0;
    Config.myId = 'core:' + idx;
    let queriesToStorage = ['GET_HISTORY', 'GET_METADATA', 'CHANNEL_MESSAGE'];
    let queriesToWs = ['CHANNEL_CONTAINS_USER'];
    let eventsToStorage = ['DROP_CHANNEL',];
    let COMMANDS = {
        'VALIDATE_MESSAGE': validateMessageHandler,
        'CHANNEL_OPEN': channelOpenHandler,
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

    Interface.init(Config, WSConnector, (err, _interface) => {
        if (err) {
            console.error('E: interface initialisation error', err)
            return;
        }
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
