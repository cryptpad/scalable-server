// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const WebSocket = require("ws");
const Express = require("express");
const Http = require("http");
const Util = require("./common-util.js");

let createHandlers = function(ctx, other) {
    other.onMessage(function(message) {
        handleMessage(ctx, message, function(identity) {
            // TODO: verify if identity is in config.infra
            ctx.others[identity[0]][identity[1]] = other;
        });
    });
    other.onDisconnect(function() {
        // TODO: manage disconnections
    });
};

let findDest = function(ctx, destId) {
    let destPath = destId.split(':');
    return Util.find(ctx.others, destPath);
};

let handleMessage = function(ctx, message, cb) {
    let response = ctx.response;

    let parsed = Util.tryParse(message);
    if (!parsed) {
        return void console.log("JSON parse error", message);
    }

    // Message format: [txid, from, cmd, args, (extra)]
    const txid = parsed[0];
    const fromId = parsed[1];
    const cmd = parsed[2];
    const args = parsed[3];

    if (response.expected(txid)) {
        response.handle(txid, args);
        return;
    }

    let from = findDest(ctx, fromId);
    if(!from) {
        if (txid !== 'IDENT') {
            console.log('Unidentified message received', message);
            return;
        }
        cb(args);
        return;
    }

    let cmdObj = ctx.commands[cmd];
    if (cmdObj) {
        cmdObj.handler(args, (error, data) => {
            from.send(JSON.stringify([txid]), { error, data });
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
        let msg = ['event', myId, command, args];
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
        let msg = [txid, myId, command, args];
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

/* Creates a connection to another node.
 * - config: contains ../config.js and a string `myId` identifying the initiator
 * of the connection.
 */
let connect = function(config) {
    let ctx = {
        others: {
            core: []
        },
        commands: [],
    };
    ctx.myId = config.myId;
    let parsedId = ctx.myId.split(':');
    if (parsedId[0] === 'core') {
        console.log("Error: trying to create a connection from a core node");
        throw new Error('INVALID_CLIENT_ID');
    }
    ctx.myType = parsedId[0];
    ctx.myNumber = Number(parsedId[1]);

    ctx.response = Util.response(function(error) {
        console.log('Server response error:', error);
    });

    let myConfig = Util.find(ctx, parsedId);

    if (!myConfig) {
        console.log("Error: client not found in the network topology");
        throw new Error('INVALID_CLIENT_ID');
    }

    // Connection to the different core servers
    config.infra.core.forEach(function(server, id) {
        let socket = WebSocket('ws://' + server.host + ':' + server.port);
        socket.on('error', function(error) {
            console.error('Websocket connection error on', server, ':', error)
        })
        .on('open', function () {
            ctx.others.core[id] = socket;
            socket.send(['event', ctx.myId, 'IDENT', [ctx.myType, ctx.myNumber]]);
            createHandlers(ctx, socket);
        })
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
    let parsedId = ctx.myId.split(':');
    if (parsedId[0] !== 'core') {
        console.log("Error: trying to create a server from a non-core node");
        throw new Error('INVALID_SERVER_ID');
    }
    ctx.myType = parsedId[0];
    ctx.myNumber = Number(parsedId[1]);

    // Response manager
    ctx.response = Util.response(function(error) {
        console.error("Client response error:", error);
    });

    let myConfig = config.infra.core[ctx.myNumber];

    if (!myConfig) {
        console.log("Error: trying to create a non-existing server");
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
