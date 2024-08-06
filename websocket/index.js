// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Express = require('express');
const Http = require('http');
const WebSocketServer = require('ws').Server;
const ChainpadServer = require('chainpad-server');
const Config = require("../ws-config.js");
const Interface = require("../common/interface.js");
const Util = require("../common/common-util.js")
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

let publicConfig = {
    host: cli_args.host || '::',
    port: cli_args.port || '3000'
};

let Env = {
    LogIp: true,
    openConnections: {},
};

let app = Express();
let httpServer = Http.createServer(app);
httpServer.listen(publicConfig.port, publicConfig.host, function() {
    console.log('server started');
});

let hkId = "0123456789abcdef";
const EPHEMERAL_CHANNEL_LENGTH = 34;
const ADMIN_CHANNEL_LENGTH = 33;
const CHECKPOINT_PATTERN = /^cp\|(([A-Za-z0-9+\/=]+)\|)?/;

// XXX: to select automatically
let getCoreId = function(channelName) {
    return "core:0";
};

let onChannelClose = function(channelName) {
    let coreId = getCoreId(channelName);
    Env.interface.sendEvent(coreId, 'DROP_CHANNEL', channelName)
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

    Env.interface.sendQuery(coreId, 'GET_METADATA', { id: hkId, userId, channelName }, function(response) {
        cb(response.error, response.data);
    })
};

let onSessionClose = function(userId, reason) {

};

let onSessionOpen = function(userId, ip) {
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
    Env.interface.sendQuery(coreId, first, { seq, userId, parsed }, function(answer) {
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

let idx = Number(cli_args.id) || 0;
Config.myId = 'ws:' + idx;
Env.interface = Interface.connect(Config);

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

Env.interface.handleCommands(COMMANDS);
