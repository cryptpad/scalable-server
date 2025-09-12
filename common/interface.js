// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Util = require("./common-util.js");
const Crypto = require("./crypto.js")("sodiumnative");
const NodeCrypto = require("node:crypto");

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
        if (idx !== -1) {
            found = type + ':' + String(idx);
        }
    });
    return found;
};

const onNewConnection = Util.mkEvent();

const newConnection = (ctx, other, txid, type, data) => {
    if (type === 'ACCEPT') {
        const coreId = ctx.pendingConnections?.[txid];
        const [acceptName, acceptIndex] = data.split(':'); // XXX: more robust code
        if (typeof (coreId) === 'undefined' || acceptName !== 'core' || Number(acceptIndex) !== coreId) {
            return console.error(ctx.myId, ': unknown connection accepted');
        }
        // Connection accepted, add to others and resolve the promise
        ctx.others.core[coreId] = other;
        ctx.pendingPromises?.[acceptIndex]?.();
        return;
    }
    if (type !== 'IDENTITY') {
        // TODO: Log error properly
        console.error("Unidentified message received");
        other.disconnect();
        return;
    }
    const { type: rcvType, idx, challenge: challengeBase64, nonce: nonceBase64 } = data;
    const challenge = new Uint8Array(Buffer.from(challengeBase64, 'base64'));
    const nonce = new Uint8Array(Buffer.from(nonceBase64, 'base64'));

    // Check for reused challenges
    if (ctx.ChallengesCache[challengeBase64]) {
        other.disconnect();
        return console.error("Reused challenge");
    }
    // Buffer.from is needed for compatibility with tweetnacl
    const msg = Buffer.from(Crypto.secretboxOpen(challenge, nonce, ctx.nodes_key));
    if (!msg) {
        other.disconnect();
        return console.error("Bad challenge answer");
    }
    let [challType, challIndex, challTimestamp] = String(msg).split(':');
    // This requires servers to be time-synchronised to avoid “Challenge in
    // the future” issue.
    let challengeLife = Number(Date.now()) - Number(challTimestamp);
    if (challengeLife < 0 || challengeLife > ctx.ChallengeLifetime ||
        rcvType !== challType || idx !== Number(challIndex)) {
        other.disconnect();
        return console.error("Bad challenge answer");
    }

    // Challenge caching once it’s validated
    // TODO: authenticate the answer
    ctx.ChallengesCache[challengeBase64] = true;
    setTimeout(() => { delete ctx.ChallengesCache[challengeBase64]; }, ctx.ChallengeLifetime);
    other.send([txid, 'ACCEPT', ctx.myId]);

    ctx.others[rcvType][idx] = other;
    onNewConnection.fire({
        type: rcvType,
        index: idx
    });
    return;
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
        return newConnection(ctx, other, txid, type, data);
    }

    if (type !== 'MESSAGE') {
        console.error(ctx.myId, "Unexpected message type", type, ', message:', data);
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

let createHandlers = function(ctx, other) {
    other.onMessage(function(message) {
        handleMessage(ctx, other, message);
    });
    other.onDisconnect(function(_code, _reason) { // XXX: to handle properly in the future
        console.log(`Interface disconnected: ${other} from ${ctx.myId}. ${_code}, ${_reason}`);
        if (ctx.self.isOpen()) {
            ctx.self.disconnect();
        }
    });
};

const onConnected = (ctx, other, coreId) => {
    let uid = Util.uid(); // XXX: replace with guid
    ctx.pendingConnections[uid] = coreId;

    // Identify with challenge
    const nonce = NodeCrypto.randomBytes(24);
    const msg = Buffer.from(`${ctx.myType}:${ctx.myNumber}:${String(Date.now())}`, 'utf-8');
    const challenge = Crypto.secretbox(msg, nonce, ctx.nodes_key).toString('base64');
    createHandlers(ctx, other);
    other.send([uid, 'IDENTITY', { type: ctx.myType, idx: ctx.myNumber, nonce: nonce.toString('base64'), challenge }]);
};


let guid = function(ctx) {
    let uid = Util.uid();
    return ctx.response.expected(uid) ? guid(ctx) : uid;
};

let communicationManager = function(ctx) {
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

    const broadcast = (type, command, args, cb, exclude) => {
        const all = ctx.others[type] || {};
        const promises = [];
        Object.keys(all).forEach(idx => {
            const id = `${type}:${idx}`;
            if (Array.isArray(exclude) && exclude.includes(id)) { return; }
            const p = new Promise((resolve) => {
                sendQuery(id, command, args, answer => {
                    if (answer) { answer.id = id; }
                    resolve(answer);
                });
            });
            promises.push(p);
        });
        Promise.all(promises).then(values => {
            cb(values);
        });
    };

    return {
        sendEvent, sendQuery,
        handleCommands, disconnect, broadcast,
        onNewConnection: onNewConnection.reg
    };
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
        nodes_key: Crypto.decodeBase64(config?.server?.private?.nodes_key),
        pendingConnections : {},
        pendingPromises : {}
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

    /*
    let myConfig = Util.find(config.infra, parsedId);

    if (!myConfig) {
        console.log("Error: client not found in the network topology");
        throw new Error('INVALID_CLIENT_ID');
    }
    */

    // Create promises
    const promises = [];
    config?.infra?.core?.forEach((server, id) => {
        const p = new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                reject();
            }, 30000);
            const accept = () => {
                clearTimeout(t);
                resolve();
            };
            ctx.pendingPromises[id] = accept;
        });
        promises.push(p);
    });

    // Connection to the different core servers
    const { connector } = config;
    if (!connector) {
        return cb('E_MISSINGCONNECTOR');
    }

    let manager = communicationManager(ctx);
    connector.initClient(ctx, config, onConnected, (err) => {
        if (err) {
            return cb(err);
        }

        Promise.all(promises).then(() => {
            return cb();
        }).catch(e => {
            throw new Error(e);
        });
    });
    return manager;
};

/* This function initializes the different ws servers on the Core components */
let init = function(config, cb) {
    if (!cb) { cb = () => { }; };

    let ctx = {
        others: {
            storage: [],
            http: [],
            websocket: []
        },
        commands: {},
        nodes_key: Crypto.decodeBase64(config?.server?.private?.nodes_key),
        ChallengesCache: {},
        ChallengeLifetime: 30 * 1000 // 30 seconds
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

    let manager = communicationManager(ctx);
    connector.initServer(ctx, myConfig, createHandlers, (err, selfClient) => {
        if (err) {
            return cb(err);
        }
        if (!selfClient) {
            return cb('E_INITWSSERVER');
        }

        return cb();
    });
    return manager;
};

module.exports = { connect, init };
