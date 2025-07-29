// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Util = require("./common-util.js");

let createHandlers = function(ctx, other) {
    other.onMessage(function(message) {
        handleMessage(ctx, other, message);
    });
    other.onDisconnect(function(_code, _reason) { // XXX: to handle properly in the future
        if (ctx.self.isOpen()) {
            ctx.self.disconnect();
        }
    });
};

let findDestFromId = function(ctx, destId) {
    let destPath = destId.split(':');
    return Util.find(ctx.others, destPath);
};

let findIdFromDest = function(ctx, dest) {
    let found = void 0;
    Object.keys(ctx.others).forEach(type => {
        let idx = ctx.others[type].findIndex(function(socket) {
            return socket === dest;
        });
        if (idx != -1) {
            found = type + ':' + String(idx);
        }
    });
    return found;
};

let handleMessage = function(ctx, other, message) {
    let response = ctx.response;

    let parsed = Util.tryParse(message);
    if (!parsed) {
        return void console.log("JSON parse error", message);
    }

    // Message format: [txid, type, data, (extra)]
    // type: MESSAGE, IDENTITY, RESPONSE -- PING, ACK (on every single message?)
    const txid = parsed[0];
    const type = parsed[1];
    const data = parsed[2];

    if (type === 'RESPONSE') {
        if (response.expected(txid)) {
            response.handle(txid, data);
        }
        return;
    }

    let fromId = findIdFromDest(ctx, other);
    if (!fromId) {
        if (type !== 'IDENTITY') {
            // TODO: close the connection
            console.log("Unidentified message received", message);
            return;
        }
        // TODO: sanity checks
        ctx.others[data.type][data.idx] = other;
        return;
    }

    if (type !== 'MESSAGE') {
        console.log("Unexpected message type", message);
        return;
    }

    const cmd = data.cmd;
    const args = data.args;
    let cmdObj = ctx.commands[cmd];
    if (cmdObj) {
        cmdObj.handler(args, (error, data) => {
            other.send([txid, 'RESPONSE', { error, data }]);
        }, {
            from: fromId
        });
    }
};

let guid = function(ctx) {
    let uid = Util.uid();
    return ctx.response.expected(uid) ? guid(ctx) : uid;
};

let communicationManager = function(ctx) {
    let myId = ctx.myId;

    let sendEvent = function(destId, command, args) {
        let dest = findDestFromId(ctx, destId);
        if (!dest) {
            // XXX: handle this more properly: timeout?
            console.log("Error: dest", destId, "not found in ctx.");
            return false;
        }

        let txid = guid(ctx);

        // Message format: [txid, type, data, (extra)]
        let msg = [txid, 'MESSAGE', {
            cmd: command,
            args: args
        }];
        dest.send(msg);
        return true;
    };

    let sendQuery = function(destId, command, args, cb) {
        let dest = findDestFromId(ctx, destId);
        if (!dest) {
            // XXX: handle this more properly: timeout?
            console.log("Error: dest", destId, "not found in ctx.");
            return false;
        }

        let txid = guid(ctx);

        // Message format: [txid, type, data, (extra)]
        let msg = [txid, 'MESSAGE', {
            cmd: command,
            args: args
        }];
        ctx.response.expect(txid, function(data) {
            // XXX: log, cleanup, etc
            cb(data);
        });

        dest.send(msg);
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
        Object.keys(ctx.others).forEach(type => {
            ctx.others[type].forEach(_interface => {
                _interface.disconnect();
            });
        });
        ctx.self.disconnect();
    };

    const broadcast = (type, command, args, cb) => {
        const all = ctx.others[type] || {};
        const promises = [];
        Object.keys(all).forEach(idx => {
            const id = `${type}:${idx}`;
            const p = new Promise((resolve, reject) => {
                sendQuery(destId, command, args, answer => {
                    resolve(answer);
                });
            });
            promises.push(p);
        });
        Promises.all(promises).then(values => {
            cb(values);
        });
    };

    return { sendEvent, sendQuery, handleCommands, disconnect, broadcast };
};

/* Creates a connection to another node.
 * - config: contains ../ws-config.js and a string `myId` identifying the initiator
 * of the connection.
 */
let connect = function(config, cb) {
    if (!cb) { cb = () => { }; }

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

    let myConfig = Util.find(config.infra, parsedId);

    if (!myConfig) {
        console.log("Error: client not found in the network topology");
        throw new Error('INVALID_CLIENT_ID');
    }

    // Connection to the different core servers
    const { connector } = config;
    if (!connector) {
        return cb('E_MISSINGCONNECTOR');
    }
    connector.initClient(ctx, config, createHandlers, (err, selfClient) => {
        if (err) {
            return cb(err);
        }
        if (!selfClient) {
            return cb('E_INITWSCLIENT');
        }
        let manager = communicationManager(ctx);

        cb(void 0, manager)
    });
};

/* This function initializes the different ws servers on the Core components */
let init = function(config, cb) {
    if (!cb) { cb = () => { } };

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
        cb('E_CLIENT');
    });

    let myConfig = config.infra.core[ctx.myNumber];

    if (!myConfig) {
        console.log("Error: trying to create a non-existing server");
        throw new Error('INVALID_SERVER_ID');
    }

    const { connector } = config;
    if (!connector) {
        return cb('E_MISSINGCONNECTOR');
    }
    connector.initServer(ctx, myConfig, createHandlers, (err, selfClient) => {
        if (err) {
            return cb(err);
        }
        if (!selfClient) {
            return cb('E_INITWSSERVER');
        }
        let manager = communicationManager(ctx);

        return cb(void 0, manager)
    });
};

module.exports = { connect, init };
