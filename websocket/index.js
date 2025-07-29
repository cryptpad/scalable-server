// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors

const Express = require('express');
const Http = require('http');
const WebSocketServer = require('ws').Server;
const Interface = require("../common/interface.js");
const WSConnector = require("../common/ws-connector.js");
const Crypto = require('crypto');
const Util = require("../common/common-util.js");
const { jumpConsistentHash } = require('../common/consistent-hash.js');
const cli_args = require("minimist")(process.argv.slice(2));


if (cli_args.h || cli_args.help) {
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
const getCoreId = (Env, channelName) => {
    let key = Buffer.from(channelName.slice(0, 8));
    let coreId = 'core:' + jumpConsistentHash(key, Env.numberCores);
    return coreId;
};


const now = () => {
    return +new Date();
};
const randName = () => {
    return Crypto.randomBytes(16).toString('hex');
};
const createUniqueName = (Env) => {
    const name = randName();
    if (typeof(Env.users[name]) === 'undefined') { return name; }
    return createUniqueName(Env);
};
const socketSendable = (socket) => {
    return socket && socket.readyState === 1;
};
const QUEUE_CHR = 1024 * 1024 * 4;

const createLogger = () => {
    return {
        info: console.log,
        verbose: console.info,
        error: console.error,
        warn: console.warn,
        debug: console.debug
    };
};


const dropUserChannels = (Env, userId) => {
    const user = Env.users[userId];
    if (!user) { return; }
    const sent = [];
    user.channels.forEach(channel => {
        const coreId = getCoreId(Env, channel);
        if (sent.includes(coreId)) { return; }
        sent.push(coreId);
        Env.interface?.sendEvent(coreId, 'DROP_USER', {
            channels: user.channels,
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
    dropUserChannels(Env, userId);
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
    Env.log.debug('Sending', msg);
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

    let coreId = getCoreId(Env, channelName);
    Env.interface.sendQuery(coreId, first, {
        seq, userId, parsed, channelName
    }, answer => {
        let toSend = answer.data.toSend;
        let error = answer.error;

        sendMsg(Env, user, [seq, 'ACK']);

        if (error) { return; }
        if (!toSend) { return; }

        // TODO: sanity check on toSend
        // TODO: to batch
        toSend.forEach(function(message) {
            sendMsg(Env, user, message);
        });
    });
};
const handleChannelMessage = (Env, channel, msgStruct, cb) => {
    if (typeof (cb) !== "function") { cb = function() { }; }

/*
    // XXX handle in storage module
    if (channelName.length === EPHEMERAL_CHANNEL_LENGTH) {
        return void cb();
    }
*/
    // XXX handle CP duplicate in storage module

    // Admin channel. We can only write to this one from private message (RPC)
    if (channel.length === ADMIN_CHANNEL_LENGTH
        && msgStruct[1] !== null) {
        return void cb('ERESTRICTED_ADMIN');
    }

    const coreId = getCoreId(Env, channel);

    Env.interface.sendQuery(coreId, 'CHANNEL_MESSAGE', {
        channelName: channel,
        msgStruct
    }, answer => {
        if (answer?.error) {
            cb(answer.error);
            return;
        }
        cb();
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

    const coreId = getCoreId(Env, obj);

    const onUserMessage = () => {
        json.unshift(user.id);
        json.unshift(0);
        Env.interface.sendQuery(coreId, 'USER_MESSAGE', {
            userId: user.id,
            message: json
        }, answer => {
            sendMsg(Env, user, [seq, 'ACK']);
        });
    };
    const onChannelMessage = () => {
        json.unshift(user.id);
        handleChannelMessage(Env, obj, json, err => {
            if (err) { return sendMsg(Env, user, [seq, 'ERROR']); }
            sendMsg(Env, user, [seq, 'ACK']);
        });
    };

    // XXX handle invalid "obj" format (channel or ephemeral)

    if (user.channels.includes(obj)) {
        return void onChannelMessage();
    }

    onUserMessage();
};
const handleJoin = (Env, args) => {
    let obj = args.obj;
    let user = args.user;
    let seq = args.seq;
    let channel = obj;
    const userId = user.id;

    const coreId = getCoreId(Env, channel);
    Env.interface.sendQuery(coreId, 'JOIN_CHANNEL', {
        userId: userId,
        channel
    }, answer => {
        let error = answer.error;
        let users = answer.data;
        if (error) {
            return sendMsg(Env, user, [seq, 'ERROR', error]);
        }

        // Add channel to our local list
        user.channels.push(channel);

        sendMsg(Env, user, [seq, 'JACK', channel]);

        // Send HK id XXX to remove
        sendMsg(Env, user, [0, hkId, 'JOIN', channel]);

        // No userlist for admin channels (broadcast to all users)
        if (channel.length === ADMIN_CHANNEL_LENGTH) {
            // Complete the userlist by sending your ID
            return sendMsg(Env, user, [0, userId, 'JOIN', channel]);
        }

        // Send other members' ID
        users.forEach(id => {
            if (id === userId) { return; }
            sendMsg(Env, user, [0, id, 'JOIN', channel]);
        });

        // Send your own JOIN message to know the userlist is complete
        sendMsg(Env, user, [0, userId, 'JOIN', channel]);
    });
};
const handleLeave = (Env, args) => {
    let obj = args.obj;
    let user = args.user;
    let seq = args.seq;

    const userId = user.id;

    const coreId = getCoreId(Env, channel);
    Env.interface.sendQuery(coreId, 'LEAVE_CHANNEL', {
        userId,
        channel
    }, answer => {
        let error = answer.error;
        if (error) {
            return sendMsg(Env, user, [seq, 'ERROR', error, obj]);
        }
        sendMsg(Env, user, [seq, 'ACK']);
    });
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

const onUserMessage = (Env, args, cb) => { // Query
    const { userId, message } = args;

    const user = Env.users[userId];
    if (!user) {
        return void cb('ENOENT');
    }

    sendMsg(Env, user, message).then(() => {
        cb();
    }).catch(() => {
        cb('UNSENDABLE');
    });
};
const onChannelMessage = (Env, args) => { // Event
    const { users, message } = args;

    message.unshift(0);

    users.forEach(id => {
        const user = Env.users[id];
        if (!user) { return; }
        if (message[1] === id) { return; } // don't send to yourself
        sendMsg(Env, user, message);
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
            id: createUniqueName(Env),
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


        socket.on('message', message => {
            Env.log.debug('Receiving', JSON.parse(message));
            try {
                handleMessage(Env, user, message);
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
            Env.log.error(err, 'NETFLUX_WEBSOCKET_ERROR');
            dropUser(Env, user, 'SOCKET_ERROR');
        });
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
                Env.log.info('ws:' + idx + ' started');
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
        active: true,
        users: {}
    };

    const callWithEnv = f => {
        return function () {
            [].unshift.call(arguments, Env);
            return f.apply(null, arguments);
        };
    };

    const COMMANDS = {
        'USER_MESSAGE': callWithEnv(onUserMessage),
        'CHANNEL_MESSAGE': callWithEnv(onChannelMessage)
    };

    const wsPromise = new Promise((resolve, reject) => {
        initServer(Env).then(resolve).catch(reject);
    });
    const configPromise = new Promise((resolve, reject) => {
        const config = require("../ws-config.js");
        config.myId = Env.myId;
        config.connector = WSConnector;
        Env.config = Util.clone(config);
        Env.numberCores = config.infra.core.length;
        resolve(config);
    });
    Promise.all([
        configPromise,
        wsPromise
    ]).then((values) => {
        const config = values[0];
        Interface.connect(config, (err, _interface) => {
            if (err) {
                Env.log.error(Config.myId, ' error:', err);
                return;
            }
            Env.log.info('WS started', Env.myId);
            Env.interface = _interface;
            _interface.handleCommands(COMMANDS);
        });
    });
};

module.exports = {
    start
};
