// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const WebSocket = require("ws");
const Express = require("express");
const Http = require("http");

const socketToClient = function(ws) {
    let handlers = ws.__handlers = {
        messages: [],
        disconnect: []
    };

    ws.on('message', function(msg) {
        handlers.messages.forEach(handler => {
            try {
                handler(msg);
            } catch (e) {
                console.error(e);
            }
        });
    });

    ws.on('close', function(code, reason) {
        handlers.disconnect.forEach(handler => {
            try {
                handler(code, reason);
            } catch (e) {
                console.error(e);
            }
        });
    });

    let isOpen = () => {
        return ws.readyState !== WebSocket.CLOSED;
    };

    // XXX: maybe add an uid for connections?
    // add onAuthenticated
    return {
        _ws: ws,
        send: (msg) => {
            ws.send(JSON.stringify(msg));
        },
        isOpen,
        disconnect: () => {
            if (isOpen()) {
                ws.close();
            }
        },
        onMessage: (handler) => {
            handlers.messages.push(handler);
        },
        onDisconnect: (handler) => {
            handlers.disconnect.push(handler);
        }
    };
};

module.exports = {
    close: function() {
    },
    initServer: function(ctx, config, onNewClient, cb) {
        if (!cb) { cb = () => { }; };
        let app = Express();
        let httpServer = Http.createServer(app);
        if (!httpServer) {
            console.error('Error: failed to create server');
            cb('E_INITHTTPSERVER');
        }

        httpServer.listen(config.port, config.host, function() {
            let server = new WebSocket.Server({ server: httpServer });
            ctx.self = socketToClient(server);
            server.on('connection', ws => {
                // TODO: get data from req to know who we are talking to and handle new connections
                onNewClient(ctx, socketToClient(ws));
            });
            ctx.self.onDisconnect(() => { httpServer.close(err => { cb(err); }); });
            cb(void 0, ctx.self);
        });
    },
    initClient: function(ctx, config, onConnected, cb) {
        let toStart = config?.infra?.core?.map((server, id) => new Promise((resolve, reject) => {

            // XXX wss protocol and domain without port?
            let socket = new WebSocket('ws://' + server.host + ':' + server.port);
            socket
                .on('error', function(error) {
                    console.error('Websocket connection error on', server, ':', error);
                    reject(error);
                })
                .on('open', function() {
                    let client = socketToClient(socket);
                    ctx.self = client;
                    onConnected(ctx, client, id);
                    resolve();
                });
        }));

        Promise.all(toStart)
            .then(() => {
                return cb(void 0);
            })
            .catch((err) => {
                // In case of error, close opened websockets
                ctx.others.forEach(client => {
                    client.disconnect();
                });
                return cb(err);
            });
    }
};
