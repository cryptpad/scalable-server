const Express = require('express');
const Http = require('http');
const WebSocketServer = require('ws').Server;
const ChainpadServer = require('chainpad-server');

let config = {
    address: '::',
    port: '3000'
};

let app = Express();
let httpServer = Http.createServer(app);
httpServer.listen(config.port, config.address, function() {
    console.log('server started');
});

let hkId = "0123456789abcdef";

let onChannelClose = function(channelName) {

};
let onChannelMessage = function(Server, channel, msgStruct, cb) {

};
let onChannelOpen = function(Server, channelName, userId, wait) {

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
