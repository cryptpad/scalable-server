// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const WebSocket = require("ws");
const Express = require("express");
const Http = require("http");
const Util = require("./common-util.js");

const DEFAULT_QUERY_TIMEOUT = 5000;
const NOFUNC = function() { };

let communicationManager = function(ctx, sockets) {
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
    let ws = [];
    let ctx = {};
    ctx.myId = config.myId;

    let wsCreate = function(server, i) {
        let app = Express();
        let httpServer = Http.createServer(app);
        httpServer.listen(server.port, server.host, function() {
            ws[i] = new WebSocket.Server({ server: httpServer });
        });
    };

    config.infra.core.forEach(wsCreate);

    ws.forEach((wsConnection, i) => {
        /* TODO: error handling */
        if (!wsConnection) {
            // XXX: setTimeout?
            console.log("Error while creating the Core server ", i);
        }
    });

    let disconnect = function() {
    };

    let manager = communicationManager(ctx, ws);

    return manager;
};

module.exports = { connect, init };
