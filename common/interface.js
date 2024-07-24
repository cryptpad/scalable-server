// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const WebSocket = require("ws");
const Express = require("express");
const Http = require("http");
const Util = require("./common-util.js");

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

let communicationManager = function(ctx) {
    let myId = ctx.myId;

    let guid = function() {
        let uid = Util.uid();
        return ctx.response.expected(uid) ? guid() : uid;
    };

    let sendEvent = function(destId, command, args) {
        let dest = findDest(ctx, destId);
        if (!dest) {
            // XXX: handle this more properly: timeout?
            console.log("Error: dest", destId, "not found in ctx.");
            return false;
        }

        // Message format: [txid, from, cmd, args, (extra)]
        // fixed uid for events
        let msg = ['event', myId, command, args]
        dest.send(JSON.stringify(msg));
        return true;
    };

    let sendQuery = function(destId, command, args, cb) {
        let dest = findDest(ctx, destId);
        if (!dest) {
            // XXX: handle this more properly: timeout?
            console.log("Error: dest", destId, "not found in ctx.");
            return false;
        }

        let txid = guid();

        // Message format: [txid, from, cmd, args, (extra)]
        let msg = [txid, myId, command, args]
        ctx.response.expect(txid, function() {
            // XXX: log, cleanup, etc
            cb();
        });

        dest.send(JSON.stringify(msg)); // XXX send message
        return true;
    };

    let handleCommands = function(COMMANDS) {
        Object.keys(COMMANDS).forEach(cmd => {
            let f = COMMANDS[cmd];
            if (typeof (f) !== 'function') { return; }
            ctx.commands[cmd] = {
                handler: f
            };
        });
    };

    let disconnect = function() {
        // XXX: TODO
    };

    return { sendEvent, sendQuery, handleCommands, disconnect };
};

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
            console.log("Error while connecting with Core server:", i);
        }
    });

    let manager = communicationManager(ctx);

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
    if (parseId[0] !== 'core') {
        console.log("Error: trying to create a server from a non-core node");
        throw new Error('INVALID_SERVER_ID');
    }
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

    let manager = communicationManager(ctx);

    return manager;
};

module.exports = { connect, init };
