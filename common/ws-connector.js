// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const WebSocket = require("ws");
const Express = require("express");
const Http = require("http");
const Util = require("./common-util.js");

const socketToClient = function(ws) {
    let handlers = ws.__handlers = {
        messages: [],
        disconnect: []
    };

    ws.on('message', function(msg) {
        handlers.message.forEach(handler => {
            try {
                handler(msg);
            } catch (e) {
            }
        })
    });

    ws.on('close', function(code, reason) {
        handlers.disconnect.forEach(handler => {
            try {
                handler(code, reason);
            } catch (e) {
            }
        });
    });

    // XXX: maybe add an uid for connections?
    return {
        _ws: ws,
        send: function(msg) {
            ws.send(JSON.stringify(msg));
        },
        disconnect: function() {
            ws.close();
        },
        onMessage: function(handler) {
            handlers.messages.push(handler);
        },
        onDisconnect: function(handler) {
            handlers.disconnect.push(handler);
        }
    }
};

module.exports = {
    close: function() {
        // TODO: fill
    },
    initServer: function(ctx, config, onNewClient) {
        let app = Express();
        let httpServer = Http.createServer(app);
        httpServer.listen(config.port, config.host, function() {
            let server = new WebSocket.Server({ server: httpServer });
            server.on('connection', function(ws, req) {
                // TODO: get data from req to know who we are talking to and handle new connections
                onNewClient(ctx, socketToClient(ws));
            });
        });
    },
    initClient: function(ctx, config, onConnected) {
        config.infra.core.forEach(function(server, id) {
            let socket = WebSocket('ws://' + server.host + ':' + server.port);
            socket.on('error', function(error) {
                console.error('Websocket connection error on', server, ':', error);
            })
                .on('open', function() {
                    ctx.others.core[id] = socket;
                    let uid = Util.uid(); // XXX: replace with guid
                    socket.send([uid, 'IDENTITY', { type: ctx.myType, idx: ctx.myNumber }]);
                    onConnected(ctx, socketToClient(socket));
                })
        });
    }
}
