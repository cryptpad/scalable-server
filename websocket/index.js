// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Express = require('express');
const Http = require('http');
const WebSocketServer = require('ws').Server;
const ChainpadServer = require('chainpad-server');
const Config = require("../ws-config.js");
const Interface = require("../common/interface.js");

let config = {
    host: '::',
    port: '3000'
};

let app = Express();
let httpServer = Http.createServer(app);
httpServer.listen(config.port, config.host, function() {
    console.log('server started');
});

let hkId = "0123456789abcdef";

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

    // XXX: to select automatically
    let coreId = 'core:0';

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
let interface = Interface.connect(Config);

