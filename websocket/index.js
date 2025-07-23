// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Express = require('express');
const Http = require('http');
const WebSocketServer = require('ws').Server;
const ChainpadServer = require('chainpad-server');
const Config = require("../ws-config.js");
const Interface = require("../common/interface.js");
const WSConnector = require("../common/ws-connector.js");
const Util = require("../common/common-util.js");
const { jumpConsistentHash } = require('../common/consistent-hash.js');
const cli_args = require("minimist")(process.argv.slice(2));

let proceed = true;

if (cli_args.h || cli_args.help) {
    proceed = false;
    console.log(`Usage ${process.argv[1]}:`);
    console.log("\t--help, -h\tDisplay this help");
    console.log("\t--id\tSet the websocket node id (default: 0)");
    console.log("\t--host\tSet the websocket listening host (default: ::)");
    console.log("\t--port\tSet the websocket listening port (default: 3000)");
}

if (!proceed) { return; }
let idx = Number(cli_args.id) || 0;

let publicConfig = {
    host: cli_args.host || '::',
    port: cli_args.port || '3000'
};

let Env = {
    LogIp: true,
    openConnections: {},
    user_channel_cache: {},
};

let app = Express();
let httpServer = Http.createServer(app);
httpServer.listen(publicConfig.port, publicConfig.host, function() {
    if (process.send !== undefined) {
        process.send({type: 'ws', idx, msg: 'READY'});
    } else {
        console.log('ws:' + idx + ' started');
    }
});

let hkId = "0123456789abcdef";
const EPHEMERAL_CHANNEL_LENGTH = 34;
const ADMIN_CHANNEL_LENGTH = 33;
const CHECKPOINT_PATTERN = /^cp\|(([A-Za-z0-9+\/=]+)\|)?/;

// Use consistentHash for that
let getCoreId = function(channelName) {
    if (typeof (Env.numberCores) !== 'number') {
        console.error('getCoreId: invalid number of cores', Env.numberCores);
        return void 0;
    }
    let key = Buffer.from(channelName.slice(0, 8));
    let coreId = 'core:' + jumpConsistentHash(key, Env.numberCores);
    return coreId;
};

let onChannelClose = function(channelName) {
    let coreId = getCoreId(channelName);
    Object.keys(Env.user_channel_cache).forEach(userId => {
        let toRemove = Env.user_channel_cache[userId].findIndex(name => name === channelName)
        if (toRemove !== -1) {
            Env.interface.sendEvent(coreId, 'DROP_CHANNEL', { channelName, userId });
            delete Env.user_channel_cache[userId][toRemove];
        }
    });
    delete Env.openConnections[channelName];
};
let onChannelMessage = function(Server, channel, msgStruct, cb) {
    if (typeof (cb) !== "function") { cb = function() { }; }
    let channelName = channel.id;
    if (!channelName) {
        console.error('INVALID CHANNEL');
        return;
    }

    /// Sanitizing before sending to Storage
    // don't store messages if the channel id indicates that it's an ephemeral message
    if (channelName.length === EPHEMERAL_CHANNEL_LENGTH) {
        return void cb();
    }

    // Admin channel. We can only write to this one from private message (RPC)
    if (channel.id.length === ADMIN_CHANNEL_LENGTH && msgStruct[1] !== null) {
        return void cb('ERESTRICTED_ADMIN');
    }

    const isCp = /^cp\|/.test(msgStruct[4]);
    let id;
    if (isCp) {
        // id becomes either null or an array or results...
        id = CHECKPOINT_PATTERN.exec(msgStruct[4]);
        // FIXME: relying on this data to be stored on an in-memory structure
        // managed by a dependency is fragile. We should put this somewhere
        // more straightforward and reliable.
        if (Array.isArray(id) && id[2] && id[2] === channel.lastSavedCp) {
            // Reject duplicate checkpoints
            return void cb();
            // not an error? the checkpoint is already here so we can assume it's stored
            //return void cb('DUPLICATE');
        }
    }

    let coreId = getCoreId(channelName);

    Env.interface.sendQuery(coreId, 'CHANNEL_MESSAGE', { channelName, channel, msgStruct }, function(answer) {
        let error = answer.error;
        if (error) {
            cb(error);
            return;
        }
        cb();
    });
};

let onChannelOpen = function(Server, channelName, userId, wait) {
    let next = wait();

    let sendHKJoinMessage = function() {
        Server.send(userId, [
            0,
            hkId,
            'JOIN',
            channelName
        ]);
    };

    let cb = function(err, info) {
        next(err, info, sendHKJoinMessage);
    };

    let coreId = getCoreId(channelName);

    Env.openConnections[channelName] = Server;
    if (Env.user_channel_cache[userId].findIndex(name => name === channelName) === -1) {
        Env.user_channel_cache[userId].push(channelName);
    }

    Env.interface.sendQuery(coreId, 'CHANNEL_OPEN', { id: hkId, userId, channelName }, function(response) {
        cb(response.error, response.data);
    })
};

let onSessionClose = function(userId, reason) {
    // Log unexpected errors
    if (Env.logIP && !['SOCKET_CLOSED', 'INACTIVITY'].includes(reason)) {
        return void console.info('USER_DISCONNECTED_ERROR', {
            userId: userId,
            reason: reason
        });
    }
    if (['BAD_MESSAGE', 'SEND_MESSAGE_FAIL_2'].indexOf(reason) !== -1) {
        if (reason && reason.code === 'ECONNRESET') { return; }
        return void console.error('SESSION_CLOSE_WITH_ERROR', {
            userId: userId,
            reason: reason,
        });
    }

    if (['SOCKET_CLOSED', 'SOCKET_ERROR'].includes(reason)) { return; }
    console.verbose('SESSION_CLOSE_ROUTINE', {
        userId: userId,
        reason: reason,
    });

    // cleanup leftover channels
    Env.user_channel_cache[userId].forEach(channelName => {
        Env.interface.sendEvent(getCoreId(channelName), 'DROP_CHANNEL', { channelName, userId });
    });
    delete Env.user_channel_cache[userId];
};

let onSessionOpen = function(userId, ip) {
    Env.user_channel_cache[userId] = [];

    // TODO: log IPs if needed
    if (!Env.logIP) { return; }
    console.log('USER_CONNECTION', {
        userId: userId,
        ip: ip,
    });
};

let onDirectMessage = function(Server, seq, userId, json) {
    let parsed = Util.tryParse(json[2]);
    if (!parsed) {
        console.error("HK_PARSE_CLIENT_MESSAGE", json);
        return;
    }

    // if (typeof(directMessageCommands[first]) !== 'function') {
    // it's either an unsupported command or an RPC call
    // TODO: to handle
    // console.error('NOT_IMPLEMENTED', first);
    // }

    let first = parsed[0];
    let channelName = parsed[1];

    let coreId = getCoreId(channelName);
    Env.interface.sendQuery(coreId, first, { seq, userId, parsed, channelName }, function(answer) {
        let toSend = answer.data.toSend;
        let error = answer.error;
        if (error) {
            return;
        }
        if (!toSend) {
            return;
        }

        // TODO: sanity check on toSend

        // TODO: to batch
        Server.send(userId, [seq, 'ACK']);
        toSend.forEach(function(message) {
            Server.send(userId, message);
        });
    });
};

const start = () => {
    let Server = ChainpadServer.create(new WebSocketServer({ server: httpServer }))
        .on('channelClose', onChannelClose)
        .on('channelMessage', onChannelMessage)
        .on('channelOpen', onChannelOpen)
        .on('sessionClose', onSessionClose)
        .on('sessionOpen', onSessionOpen)
        .on('error', function(error, label, info) {
            console.error('ERROR', error);
        })
        .register(hkId, onDirectMessage);

    Config.myId = 'ws:' + idx;
    Config.connector = WSConnector;
    Env.numberCores = Config.infra.core.length;

    let channelContainsUserHandle = function(args, cb) {
        let channelName = args.channelName;
        let userId = args.userId;

        let Server = Env.openConnections[channelName];
        if (!Server) {
            console.error('Error: Server for', channelName, 'not found.');
            cb('SERVER_NOT_FOUND', void 0);
        }

        cb(void 0, { response: Server.channelContainsUser(channelName, userId) });
    };

    let COMMANDS = {
        'CHANNEL_CONTAINS_USER': channelContainsUserHandle,
    };

    Interface.connect(Config, (err, _interface) => {
        if (err) {
            console.error(Config.myId, ' error:', err);
            return;
        }
        Env.interface = _interface;
        _interface.handleCommands(COMMANDS);
    });
};

module.exports = {
    start
};
