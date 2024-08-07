// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Config = require("../ws-config.js");
const Interface = require("../common/interface.js");
const WriteQueue = require("../storage/write-queue.js");
const Crypto = require("./crypto.js")('sodiumnative');
const cli_args = require("minimist")(process.argv.slice(2));

let proceed = true;

if (cli_args.h || cli_args.help) {
    proceed = false;
    console.log(`Usage ${process.argv[1]}:`);
    console.log("\t--help, -h\tDisplay this help");
    console.log("\t--id\tSet the websocket node id (default: 0)");
}

if (!proceed) { return; }

let Env = {
    queueValidation: WriteQueue(),
    ws_id_cache: {},
};

// TODO: add consistent hash to know which storage to ask
let getStorageId = function(channelName) {
    return 'storage:0';
};

let getWsId = function(userId) {
    return 'ws:0';
};

let wsToStorage = function(command, validated) {
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

        Env.interface.sendQuery(storageId, command, args, function(response) {
            cb(response.error, response.data);
        });
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
    let idx = Number(cli_args.id) || 0;
    Config.myId = 'core:' + idx;
    let interface = Env.interface = Interface.init(Config);

    let queriesToStorage = ['GET_HISTORY', 'GET_METADATA', 'CHANNEL_MESSAGE'];
    let queriesToWs = ['CHANNEL_CONTAINS_USER'];
    let eventsToStorage = ['DROP_CHANNEL',];
    let COMMANDS = {
        'VALIDATE_MESSAGE': validateMessageHandler,
        'CHANNEL_OPEN': channelOpenHandler,
    };
    queriesToStorage.forEach(function(command) {
        COMMANDS[command] = wsToStorage(command, false);
    });
    queriesToWs.forEach(function(command) {
        COMMANDS[command] = storageToWs(command);
    });
    eventsToStorage.forEach(function(command) {
        COMMANDS[command] = EventToStorage(command);
    });

    interface.handleCommands(COMMANDS)
};

startServers();
