// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const WebSocket = require("ws");
const Http = require("http");

const socketToClient = (ctx, ws) => {
    let handlers = ws.__handlers = {
        messages: [],
        disconnect: []
    };

    ws.on('message', function(msg) {
        handlers.messages.forEach(handler => {
            try {
                handler(msg);
            } catch (e) {
                ctx.Log.error(e);
            }
        });
    });

    ws.on('close', function(code, reason) {
        handlers.disconnect.forEach(handler => {
            try {
                handler(code, reason);
            } catch (e) {
                ctx.Log.error(e);
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
        let httpServer = config.httpServer; // may be undefined
        let path = config.wsPath || '';
        const onServerReady = () => {
            let server = new WebSocket.Server({ server: httpServer, path });
            ctx.self = socketToClient(ctx, server);
            server.on('connection', ws => {
                // TODO: get data from req to know who we are talking to and handle new connections
                onNewClient(ctx, socketToClient(ctx, ws));
            });
            ctx.self.onDisconnect(() => { httpServer.close(err => { cb(err); }); });
            cb(void 0, ctx.self);
        };

        if (httpServer) { return onServerReady(); }

        httpServer = Http.createServer();
        if (!httpServer) {
            ctx.Log.error('Error: failed to create server');
            cb('E_INITHTTPSERVER');
        }

        httpServer.listen(config.port, config.host, onServerReady);
    },
    initClient: (ctx, config, id, onConnected, cb) => {
        const [type, number] = id.split(':');
        const serv = config?.infra?.[type]?.[+number];
        let wsURL = 'ws://' + serv.host + ':' + serv.port;
        if (type !== "core") { wsURL += '/websocket'; }

        let ready = false;
        // Try to connect until the remote server is ready
        const again = () => {
            if (ready) { return; }
            let socket = new WebSocket(wsURL);
            socket.on('error', () => {
                ctx.Log.error('Remote server not ready', id, 'trying again in 1000ms');
                setTimeout(again, 1000); // try again
            }).on('open', () => {
                ready = true;
                let client = socketToClient(ctx, socket);
                onConnected(ctx, client, +number);
                cb();
            });
        };

        again();
    }
};
