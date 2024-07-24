// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const WebSocket = require("ws");
const Express = require("express");
const Http = require("http");
const Util = require("./common-util.js");

const DEFAULT_QUERY_TIMEOUT = 5000;
const NOFUNC = function() { };

let createHandlers = function(ctx, other) {
    other.onMessage(function(message) {
        // TODO: check registration before
        handleMessage(ctx, message)
    });
    other.onDisconnect(function() {
        // TODO: manage disconnections
    });
};

let findDest = function(ctx, destId) {
    let destPath = destId.split(':');
    return Util.find(ctx.others, destPath);
};

let handleMessage = function(ctx, message) {
    let response = ctx.response;

    let parsed = Util.tryParse(message);
    if (!parsed) {
        return void console.log("JSON parse error", message);
    }

    // Message format: [txid, from, cmd, args, (extra)]
    const txid = parsed[0];
    if (response.expecter(txid)) {
        response.handle(txid, parsed[3]);
        return;
    }

    const fromId = parsed[1];
    let from = findDest(ctx, fromId);

    const args = parsed[3];
    const cmd = parsed[2];
    let cmdObj = ctx.commands[cmd];
    if (cmdObj) {
        cmdObj.handler(args, (error, data) => {
            from.send(JSON.stringify([txid]), { error, data })
        }, {
            from: fromId
        });
    }
};
    const timeout = DEFAULT_QUERY_TIMEOUT;
    let id = 0;
    let myId = ctx.myId;

    let response = Util.response(function(error) {
        console.log('Client Response Error:', error);
    });

    let sendEvent = function(dest, command, args) {
        let msg = { CMD: command, ARGS: args, FROM: myId };
        let wsDest = sockets[dest];
        if (!wsDest) {
            console.error('Server ', dest, ' unreachable');
            return false;
        }
        wsDest.send(JSON.stringify(msg));
        return true;
    };

    let sendQuery = function(dest, command, args, cb) {
        let msg = { CMD: command, ARGS: args, FROM: myId, IDX: id };
        let wsDest = sockets[dest];
        if (!wsDest) {
            console.error('Server ', dest, ' unreachable');
            return false;
        }
        response.expect(String(id++), cb, timeout);
        wsDest.send(JSON.stringify(msg));
    };

    let parseMessage = function(message) {
        let msg = {};
        try {
            msg = JSON.parse(message);
        } catch (err) {
            console.log("JSON parse error:", err)
            return;
        }

        let msgType = '';
        if (typeof (msg.IDX) !== 'undefined') {
            if (typeof (msg.CMD) === 'undefined') {
                /* No command and an idx given: it’s a Response */
                try {
                    msgType = 'response';
                    response.handle(msg.IDX, msg.ARGS);
                } catch (error) {
                    console.log('Error: handling message ', msg);
                    console.log('Error: ', error);
                }
            } else {
                /* A command is given and it has an idx: it’s a Query */
                msgType = 'query';
            }
        } else {
            /* No IDX: it’s an Event */
            msgType = 'event';
        }

        msg.TYPE = msgType;

        return msg;
    };

    let onMessage = function(type, action) {
        let onMessageCall = function(message) {
            let parsed = parseMessage(message);
            /* TODO: handling messages */
        };

        ws.forEach(wsConnection => {
            wsConnection.onmessage = onMessageCall;
        });
    };

    let disconnect = function() {
        ws.forEach(wsConnection => {
            if (wsConnection) {
                wsConnection.onclose = NOFUNC;
                wsConnection.close();
            }
        });
    };

    return { sendEvent, sendQuery, onMessage, disconnect };
}

/* This function initializes the different ws connections from the Ws and
    * Storage components
    * config contains:
    * - ../config.js
    * - whoami */
let connect = function(config) {
    let wsConnect = function(server) {
        let ws = WebSocket('ws://' + server.host + ':' + server.port)
            .on('error', function(err) {
                console.error("WebSocket Connection error:", err);
            })
            .on('close', function() {
                delete ws;
            });
        return ws;
    }

    let ws = [];
    let ctx = {};
    ctx.myId = config.myId;

    // Connect to each core
    // TODO: error handling
    config.infra.core.forEach((server, i) => {
        ws[i] = wsConnect(server);
    });

    ws.forEach((wsConnection, i) => {
        /* TODO: error handling */
        if (!wsConnection) {
            // XXX: setTimeout?
            console.log("Error while connecting with Core server ", i);
        }
    });

    let manager = communicationManager(ctx, ws);

    return manager;
};

/* This function initializes the different ws servers on the Core components */
let init = function(config) {
    let ctx = {
        others: {
            storage: [],
            ws: []
        },
        commands: {},
    };
    ctx.myId = config.myId;
    let parseId = ctx.myId.split(':');
    assert(parseId[0] === 'core');
    ctx.myType = parseId[0];
    ctx.myNumber = Number(parseId[1]);

    // Response manager
    ctx.response = Util.response(function(error) {
        console.error("Client response error:", error);
    });

    let myConfig = config.infra.core[ctx.myNumber];

    if (!myConfig) {
        throw new Error('INVALID_SERVER_ID');
    }

    let app = Express();
    let httpServer = Http.createServer(app);
    httpServer.listen(myConfig.port, myConfig.host, function() {
        let server = new WebSocket.Server({ server: httpServer });
        server.on('connection', function(ws, req) {
            // TODO: get data from req to know who we are talking to and handle new connections
            createHandlers(ctx, ws);
        });
    });

    let manager = communicationManager(ctx, myConfig);

    return manager;
};

module.exports = { connect, init };
