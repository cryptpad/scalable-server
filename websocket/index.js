// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Express = require('express');
const Http = require('http');
const WebSocketServer = require('ws').Server;
const ChainpadServer = require('chainpad-server');
const Config = require("../ws-config.js");
const Interface = require("../common/interface.js");

let publicConfig = {
    host: '::',
    port: '3000'
};

let Env = {};

let app = Express();
let httpServer = Http.createServer(app);
httpServer.listen(publicConfig.port, publicConfig.host, function() {
    console.log('server started');
});

let hkId = "0123456789abcdef";

// XXX: to select automatically
let getCoreId = function(channelName) {
    return "core:0";
};

let onChannelClose = function(channelName) {

};
let onChannelMessage = function(Server, channel, msgStruct, cb) {

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

    Env.interface.sendQuery(coreId, 'GET_METADATA', {id: hkId, userId, channelName}, function(response) {
        cb(response.error, response.data);
    })
};
let onSessionClose = function(userId, reason) {

};
let onSessionOpen = function(userId, ip) {
    // TODO: log IPs if needed
};
let onDirectMessage = function() {

let onDirectMessage = function(Server, seq, userId, json) {
    console.log('onDirectMessage', json);
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

    let channelName = parsed[1];

    let coreId = getCoreId(channelName);
    Env.interface.sendQuery(coreId, 'GET_HISTORY', {seq, userId, parsed}, function(answer) {
        let toSend = answer.data.toSend;
        let error = answer.error;
        if(error) {
            return;
        }
        if(!toSend) {
            return;
        }

        // TODO: sanity check on toSend

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

Config.myId = 'ws:0';
Env.interface = Interface.connect(Config);

