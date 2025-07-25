// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors

const Express = require('express');
const Http = require('http');
const WebSocketServer = require('ws').Server;
//const ChainpadServer = require('chainpad-server');
const Interface = require("../common/interface.js");
const Crypto = require('crypto');
const Util = require("../common/common-util.js");
const { jumpConsistentHash } = require('../common/consistent-hash.js');
const cli_args = require("minimist")(process.argv.slice(2));


if (cli_args.h || cli_args.help) {
    proceed = false;
    console.log(`Usage ${process.argv[1]}:`);
    console.log("\t--help, -h\tDisplay this help");
    console.log("\t--id\tSet the websocket node id (default: 0)");
    console.log("\t--host\tSet the websocket listening host (default: ::)");
    console.log("\t--port\tSet the websocket listening port (default: 3000)");
    return;
}

const idx = Number(cli_args.id) || 0;

// XXX move to ws-config
const publicConfig = {
    host: cli_args.host || '::',
    port: cli_args.port || '3000'
};


const hkId = "0123456789abcdef";
const EPHEMERAL_CHANNEL_LENGTH = 34;
const ADMIN_CHANNEL_LENGTH = 33;
const CHECKPOINT_PATTERN = /^cp\|(([A-Za-z0-9+\/=]+)\|)?/;

// Use consistentHash for that
const getCoreId = (channelName) => {
    if (typeof (Env.numberCores) !== 'number') {
        console.error('getCoreId: invalid number of cores', Env.numberCores);
        return void 0;
    }
    let key = Buffer.from(channelName.slice(0, 8));
    let coreId = 'core:' + jumpConsistentHash(key, Env.numberCores);
    return coreId;
};




let onChannelClose = function(channelName) {
    let coreId = getCoreId(channelName);
    Object.keys(Env.user_channel_cache).forEach(userId => {
        let toRemove = Env.user_channel_cache[userId].findIndex(name => name === channelName)
        if (toRemove !== -1) {
            Env.interface.sendEvent(coreId, 'DROP_CHANNEL', { channelName, userId });
            delete Env.user_channel_cache[userId][toRemove];
        }
    });
    delete Env.openConnections[channelName];
};
let onChannelMessage = function(Server, channel, msgStruct, cb) {
    if (typeof (cb) !== "function") { cb = function() { }; }
    let channelName = channel.id;
    if (!channelName) {
        console.error('INVALID CHANNEL');
        return;
    }

    /// Sanitizing before sending to Storage
    // don't store messages if the channel id indicates that it's an ephemeral message
    if (channelName.length === EPHEMERAL_CHANNEL_LENGTH) {
        return void cb();
    }

    // Admin channel. We can only write to this one from private message (RPC)
    if (channel.id.length === ADMIN_CHANNEL_LENGTH && msgStruct[1] !== null) {
        return void cb('ERESTRICTED_ADMIN');
    }

    const isCp = /^cp\|/.test(msgStruct[4]);
    let id;
    if (isCp) {
        // id becomes either null or an array or results...
        id = CHECKPOINT_PATTERN.exec(msgStruct[4]);
        // FIXME: relying on this data to be stored on an in-memory structure
        // managed by a dependency is fragile. We should put this somewhere
        // more straightforward and reliable.
        if (Array.isArray(id) && id[2] && id[2] === channel.lastSavedCp) {
            // Reject duplicate checkpoints
            return void cb();
            // not an error? the checkpoint is already here so we can assume it's stored
            //return void cb('DUPLICATE');
        }
    }

    let coreId = getCoreId(channelName);

    Env.interface.sendQuery(coreId, 'CHANNEL_MESSAGE', { channelName, channel, msgStruct }, function(answer) {
        let error = answer.error;
        if (error) {
            cb(error);
            return;
        }
        cb();
    });
};

let onChannelOpen = function(Server, channelName, userId, wait) {
    let next = wait();

    let sendHKJoinMessage = function() {
        Server.send(userId, [
            0,
            hkId,
            'JOIN',
            channelName
        ]);
    };

    let cb = function(err, info) {
        next(err, info, sendHKJoinMessage);
    };

    let coreId = getCoreId(channelName);

    Env.openConnections[channelName] = Server;
    if (Env.user_channel_cache[userId].findIndex(name => name === channelName) === -1) {
        Env.user_channel_cache[userId].push(channelName);
    }

    Env.interface.sendQuery(coreId, 'CHANNEL_OPEN', { id: hkId, userId, channelName }, function(response) {
        cb(response.error, response.data);
    })
};





const now = () => {
    return +new Date();
};
const randName = () => {
    return Crypto.randomBytes(16).toString('hex');
};
const createUniqueName = () => {
    const name = randName();
    if (typeof(Env.users[name]) === 'undefined') { return name; }
    return createUniqueName();
};
const socketSendable = (socket) => {
    return socket && socket.readyState === 1;
};
const QUEUE_CHR = 1024 * 1024 * 4;

const createLogger = () => {
    return {
        info: console.log,
        verbose: console.info,,
        error: console.error,
        warn: console.warn,
        debug: console.debug
    };
};


const dropUserChannels = (Env, userId) => {
    const user = Env.users[userId];
    if (!user) { return; }
    user.channels.forEach(channel => {
        const coreId = getCoreId(channel);
        Env.interface?.sendEvent(coreId, 'DROP_CHANNEL', {
            channelName,
            userId
        });
    });
};

const onSessionOpen = function(Env, userId) {
    const user = Env.users[userId];
    if (!user) { return; }

    if (!Env.logIP || !user.ip) { return; }
    Env.log.info('USER_CONNECTION', {
        userId: userId,
        ip: user.ip,
    });
};
const onSessionClose = (Env, userId, reason) => {
    // Cleanup leftover channels
    dropUserChannels();
    delete Env.users[userId];

    // Log unexpected errors
    if (Env.logIP &&
        !['SOCKET_CLOSED', 'INACTIVITY'].includes(reason)) {
        return void Env.log.info('USER_DISCONNECTED_ERROR', {
            userId: userId,
            reason: reason
        });
    }
    if (['BAD_MESSAGE', 'SEND_MESSAGE_FAIL_2'].includes(reason)) {
        return void Env.log.error('SESSION_CLOSE_WITH_ERROR', {
            userId: userId,
            reason: reason,
        });
    }

    if (['SOCKET_CLOSED', 'SOCKET_ERROR'].includes(reason)) {
        return;
    }
    Env.log.verbose('SESSION_CLOSE_ROUTINE', {
        userId: userId,
        reason: reason,
    });
};
const historyCommands = [
    'GET_HISTORY', 'GET_HISTORY_RANGE', 'GET_FULL_HISTORY'
];


const WEBSOCKET_CLOSING = 2;
const WEBSOCKET_CLOSED = 3;
const dropUser = (Env, user, reason) => {
    if (!user || !user.socket) { return; }
    if (user.socket.readyState !== WEBSOCKET_CLOSING
        && user.socket.readyState !== WEBSOCKET_CLOSED) {
        try {
            user.socket.close();
        } catch (e) {
            Env.log.error(e, 'FAIL_TO_DISCONNECT', { id: user.id, });
            try {
                user.socket.terminate();
            } catch (ee) {
                Env.log.error(ee, 'FAIL_TO_TERMINATE', {
                    id: user.id
                });
            }
        }
    }
    onSessionClose(Env, user.id, reason);
};

const sendMsg = (Env, user, msg) => {
    return new Promise((resolve, reject) => {
        // don't bother trying to send if the user doesn't
        // exist anymore
        if (!user) { return void reject("NO_USER"); }
        // or if you determine that it's unsendable
        if (!socketSendable(user.socket)) {
            return void reject("UNSENDABLE");
        }

        try {
            const strMsg = JSON.stringify(msg);
            user.inQueue += strMsg.length;
            user.sendMsgCallbacks.push(resolve);
            user.socket.send(strMsg, () => {
                user.inQueue -= strMsg.length;
                if (user.inQueue > QUEUE_CHR) { return; }
                const smcb = user.sendMsgCallbacks;
                user.sendMsgCallbacks = [];
                try {
                    smcb.forEach((cb)=>{cb();});
                } catch (e) {
                    Env.log.error(e, 'SEND_MESSAGE_FAIL');
                }
            });
        } catch (e) {
            // call back any pending callbacks before you
            // drop the user
            reject(e);
            Env.log.error(e, 'SEND_MESSAGE_FAIL_2');
            dropUser(Env, user, 'SEND_MESSAGE_FAIL_2');
        }
    });
};

const onHKMessage = (Env, seq, user, json) => {
    let parsed = Util.tryParse(json[2]);
    if (!parsed) {
        Env.log.error("HK_PARSE_CLIENT_MESSAGE", json);
        return;
    }

    const first = parsed[0];

    if (!historyCommands.includes(first)) {
        // it's either an unsupported command or an RPC call
        // TODO: to handle
        Env.log.error('NOT_IMPLEMENTED', first);
        throw new Error("TODO RPC");
    }

    const channelName = parsed[1];
    const userId = user.id;

    let coreId = getCoreId(channelName);
    Env.interface.sendQuery(coreId, first, {
        seq, userId, parsed, channelName
    }, answer => {
        let toSend = answer.data.toSend;
        let error = answer.error;

        Server.send(userId, [seq, 'ACK']);

        if (error) { return; }
        if (!toSend) { return; }

        // TODO: sanity check on toSend
        // TODO: to batch
        toSend.forEach(function(message) {
            sendMsg(Env, user, message);
        });
    });
};
const handleMsg = (Env, args) => {
    let obj = args.obj;
    let seq = args.seq;
    let user = args.user;
    let json = args.json;

    if (obj === hkId) {
        return void onHKMessage(Env, seq, user, json);
    }

    /* XXX TODO
     *  - obj can be a user or a channel
     *  - we can only send "MSG" to channels we have already joined
     *  - if obj is not in our user.channels
     *      - ask the selected CORE to send the message to a user
     *        with "obj" as ID
     *          - if this user doesn't exist, just ignore
     *          - if this user exist, send from CORE to correct WS
     *  - if obj is one of our user.channels, treat as a channel msg
     *      - we still need to send ti to the core but in a
     *        different way
     */

    

    /*
    if (obj && !ctx.channels[obj] && !ctx.users[obj]) {
        ctx.emit.error(new Error('NF_ENOENT'), 'NF_ENOENT', {
            user: isDefined(user && user.id)? user.id: 'MISSING',
            json: json || 'MISSING',
        });
        return void sendMsg(ctx, user, [seq, 'ERROR', 'enoent', obj]);
    }

    let target;
    json.unshift(user.id);
    if ((target = ctx.channels[obj])) {
        return void sendChannelMessage(ctx, target, json, function (err) {
            if (err) { return void sendMsg(ctx, user, [seq, 'ERROR']); }
            sendMsg(ctx, user, [seq, 'ACK']);
        });
    }

    sendMsg(ctx, user, [seq, 'ACK']);

    if ((target = ctx.users[obj])) {
        json.unshift(0);
        return void sendMsg(ctx, target, json);
    }
    */
};
const handlePing = (Env, args) => {
    sendMsg(Env, args.user, [args.seq, 'ACK']);
};
const commands = {
    JOIN: handleJoin,
    MSG: handleMsg,
    LEAVE: handleLeave,
    PING: handlePing,
};
const handleMessage = (Env, user, msg) => {
    // this parse is safe because handleMessage
    // is only ever called in a try-catch
    let json = JSON.parse(msg);
    let seq = json.shift();
    let cmd = json[0];

    user.timeOfLastMessage = now();
    user.pingOutstanding = false;

    if (typeof(commands[cmd]) !== 'function') { return; }
    commands[cmd](Env, {
        user, json, seq,
        obj: json[1],
    });
};

const initServerHandlers = (Env) => {
    if (!Env.wss) { throw new Error('No WebSocket Server'); }
    Env.wss.on('connection', (socket, req) => {
        // refuse new connections if the server is shutting down
        if (!Env.active) { return; }
        if (!socket.upgradeReq) { socket.upgradeReq = req; }

        const ip = (req.headers && req.headers['x-real-ip'])
                      || req.socket.remoteAddress || '';
        const user = {
            socket: socket,
            id: createUniqueName(),
            timeOfLastMessage: now(),
            pingOutstanding: false,
            inQueue: 0,
            ip: ip.replace(/^::ffff:/, ''),
            sendMsgCallbacks: [],
            channels: []
        };
        Env.users[user.id] = user;
        sendMsg(Env, user, [0, '', 'IDENT', user.id]);

        onSessionOpen(Env, user.id, user.ip);

        /*
        XXX TODO
        socket.on('message', message => {
            try {
                handleMessage(ctx, user, message);
            } catch (e) {
                Env.log.error(e, 'NETFLUX_BAD_MESSAGE', {
                    user: user.id,
                    message: message,
                });
                dropUser(Env, user, 'BAD_MESSAGE');
            }
        });
        socket.on('close', function () {
            dropUser(Env, user, 'SOCKET_CLOSED');
        });
        socket.on('error', function (err) {
            emit.error(err, 'NETFLUX_WEBSOCKET_ERROR');
            dropUser(Env, user, 'SOCKET_ERROR');
        });
        */
    });

};

const initServer = (Env) => {
    return new Promise((resolve, reject) => {
        const app = Express();
        const httpServer = Http.createServer(app);
        httpServer.listen(publicConfig.port, publicConfig.host,() => {
            if (process.send !== undefined) {
                process.send({type: 'ws', idx, msg: 'READY'});
            } else {
                console.log('ws:' + idx + ' started');
            }
        });
        Env.wss = new WebSocketServer({ server: httpServer });
        initServerHandlers(Env);
        resolve();
    });
};

const shutdown = (Env) => {
    if (!Env.wss) { return; }
    Env.active = false;
    Env.wss.close();
    delete Env.wss;
};

const start = () => {
    const Env = {
        myId: `ws:${idx}`,
        LogIp: true,
        openConnections: {},
        user_channel_cache: {},
        log: createLogger(),
        users: {}
    };

    const wsPromise = new Promise((resolve, reject) => {
        initServer(Env).then(resolve).catch(reject);
    });
    const configPromise = new Promise((resolve, reject) => {
        const config = require("../ws-config.js");
        config.myId = Env.myId;
        Env.config = config;
        Env.numberCores = config.infra.core.length;
        resolve(config);
    });
    Promise.all([
        wsPromise,
        configPromise
    ]).then((values) => {
        const config = values[0];
        Interface.connect(config, (err, _interface) => {
            if (err) {
                console.error(Config.myId, ' error:', err);
                return;
            }
            Env.interface = _interface;
            _interface.handleCommands(COMMANDS);
        });
    });

/*

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

    let channelContainsUserHandle = function(args, cb) {
        let channelName = args.channelName;
        let userId = args.userId;

        let Server = Env.openConnections[channelName];
        if (!Server) {
            console.error('Error: Server for', channelName, 'not found.');
            cb('SERVER_NOT_FOUND', void 0);
        }

        cb(void 0, { response: Server.channelContainsUser(channelName, userId) });
    };

    let COMMANDS = {
        'CHANNEL_CONTAINS_USER': channelContainsUserHandle,
    };
*/
};

module.exports = {
    start
};
