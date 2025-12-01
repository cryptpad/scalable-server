// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors

const Express = require('express');
const Http = require('http');
const WebSocketServer = require('ws').Server;
const Interface = require("../common/interface.js");
const WSConnector = require("../common/ws-connector.js");
const Crypto = require('crypto');
const Util = require("../common/common-util.js");
const Constants = require("../common/constants.js");
const Logger = require("../common/logger.js");
const WorkerModule = require("../common/worker-module.js");
const Cluster = require("node:cluster");
const Environment = require('../common/env.js');

const {
    hkId,
    ADMIN_CHANNEL_LENGTH
} = Constants;

// Use consistentHash for that
const getCoreId = (Env, channel) => {
    return Env.getCoreId(channel);
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
    const rpcCore = getCoreId(Env, userId);
    if (sent.includes(rpcCore)) { return; }
    Env.interface?.sendEvent(rpcCore, 'DROP_USER', {
        channels: [],
        userId
    });
};

const onSessionOpen = function(Env, userId) {
    const user = Env.users[userId];
    if (!user) { return; }

    if (!Env.logIP || !user.ip) { return; }
    Env.Log.verbose('USER_CONNECTION', {
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
        return void Env.Log.info('USER_DISCONNECTED_ERROR', {
            userId: userId,
            reason: reason
        });
    }
    if (['BAD_MESSAGE', 'SEND_MESSAGE_FAIL_2'].includes(reason)) {
        return void Env.Log.error('SESSION_CLOSE_WITH_ERROR', {
            userId: userId,
            reason: reason,
        });
    }

    if (['SOCKET_CLOSED', 'SOCKET_ERROR'].includes(reason)) {
        return;
    }
    Env.Log.verbose('SESSION_CLOSE_ROUTINE', {
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
            Env.Log.error(e, 'FAIL_TO_DISCONNECT', { id: user.id, });
            try {
                user.socket.terminate();
            } catch (ee) {
                Env.Log.error(ee, 'FAIL_TO_TERMINATE', {
                    id: user.id
                });
            }
        }
    }
    onSessionClose(Env, user.id, reason);
};

const sendMsgPromise = (Env, user, msg) => {
    Env.Log.verbose('Sending', msg, 'to', user.id);
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
                Env.plugins?.MONITORING?.increment(`sent`);
                Env.plugins?.MONITORING?.increment(`sentSize`, strMsg.length);
                if (user.inQueue > QUEUE_CHR) { return; }
                const smcb = user.sendMsgCallbacks;
                user.sendMsgCallbacks = [];
                try {
                    smcb.forEach((cb)=>{cb();});
                } catch (e) {
                    Env.Log.error(e, 'SEND_MESSAGE_FAIL');
                }
            });
        } catch (e) {
            // call back any pending callbacks before you
            // drop the user
            reject(e);
            Env.Log.error(e, 'SEND_MESSAGE_FAIL_2');
            dropUser(Env, user, 'SEND_MESSAGE_FAIL_2');
        }
    });
};
const sendMsg = (Env, user, msg) => {
    sendMsgPromise(Env, user, msg).catch(e => {
        Env.Log.error(e, 'SEND_MESSAGE', {
            user: user.id,
            message: msg
        });
    });
};

const handleRPC = (Env, seq, message, user) => {
    const [txid, data] = message;
    const userId = user.id;

    sendMsg(Env, user, [seq, 'ACK']);

    const onError = (err) => {
        const msg = JSON.stringify([txid, 'ERROR', err]);
        sendMsg(Env, user, [0, hkId, 'MSG', user.id, msg]);
    };

    if (!Array.isArray(data)) {
        return void onError('INVALID_ARG_FORMAT');
    }

    if (!data.length) {
        return void onError("INSUFFICIENT_ARGS");
    }

    let query;
    if (data.length === 2) {
        // Anon RPC
        query = "ANON_RPC";
    } else if (data.length === 5) {
        // Authenticated RPC
        query = "AUTH_RPC";
    }


    if (!query) {
        return onError('INVALID_ARG_FORMAT');
    }

    let coreId = getCoreId(Env, userId);

    Env.interface.sendQuery(coreId, query, {
        userId, txid, data
    }, answer => {
        let message = answer?.data;
        let error = answer?.error;

        if (error) {
            return void onError(error);
        }

        const msg = JSON.stringify([txid].concat(message));
        sendMsg(Env, user, [0, hkId, 'MSG', user.id, msg]);
    });
};

const onHKMessage = (Env, seq, user, json) => {
    let parsed = Util.tryParse(json[2]);
    if (!parsed) {
        Env.Log.error("HK_PARSE_CLIENT_MESSAGE", json);
        return;
    }

    const first = parsed[0];

    const userId = user.id;

    if (!historyCommands.includes(first)) {
        // it's either an unsupported command or an RPC call
        // TODO: to handle
        return void handleRPC(Env, seq, parsed, user);
    }

    const channel = parsed[1];

    let coreId = getCoreId(Env, channel);
    Env.interface.sendQuery(coreId, first, {
        seq, userId, parsed, channel
    }, answer => {
        let message = answer.data?.message || answer?.data;
        let error = answer.error;

        if (error || !Array.isArray(message)) { return; }
        sendMsg(Env, user, message);
    });
};
const handleChannelMessage = (Env, channel, msgStruct, cb) => {
    if (typeof (cb) !== "function") { cb = function() { }; }

    // Admin channel. We can only write to this one from private message (RPC)
    if (channel.length === ADMIN_CHANNEL_LENGTH
        && msgStruct[1] !== null) {
        return void cb('ERESTRICTED_ADMIN');
    }

    const coreId = getCoreId(Env, channel);

    msgStruct.unshift(0);

    Env.interface.sendQuery(coreId, 'CHANNEL_MESSAGE', {
        channel: channel,
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
        }, () => {
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
    let channel = args.obj;
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
            return sendMsg(Env, user, [seq, 'ERROR', error, channel]);
        }
        sendMsg(Env, user, [seq, 'ACK']);
    });
};
const handlePing = (Env, args) => {
    Env.plugins?.MONITORING?.increment(`pingReceived`);
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

// Respond to CORE commands

const sendUserMessage = (Env, args, cb) => { // Query
    const { userId, message } = args;
    cb ||= () => {};

    const user = Env.users[userId];
    if (!user) {
        return void cb('ENOENT');
    }

    sendMsgPromise(Env, user, message).then(() => {
        cb();
    }).catch(() => {
        cb('UNSENDABLE');
    });
};
const sendChannelMessage = (Env, args) => { // Event
    const { users, message } = args;

    users.forEach(id => {
        const user = Env.users[id];
        if (!user) { return; }
        if (message[1] === id) { return; } // don't send to yourself
        sendMsg(Env, user, message);
    });
};

const onNewDecrees = (Env, args, cb) => {
    const { type, decrees, curveKeys, freshKey } = args;
    Env.cacheDecrees(type, decrees);
    Env.FRESH_KEY = freshKey;
    Env.curveKeys = curveKeys;
    Env.getDecree(type).loadRemote(Env, decrees);
    Env.workers.broadcast('NEW_DECREES', {
        curveKeys: Env.curveKeys,
        freshKey: Env.FRESH_KEY,
        type, decrees
    }, () => {
        Env.Log.verbose('UPDATE_DECREE_WS_WORKER');
    });
    cb();
};

const shutdown = (Env) => {
    if (!Env.wss) { return; }
    Env.active = false;
    Env.wss.close();
    delete Env.wss;
};

const flushCache = (Env, args, cb) => {
    Env.FRESH_KEY = args.freshKey;
    Env.workers.broadcast('FLUSH_CACHE', args, () => {cb();});
};

// Respond to WORKER commands

const onHttpCommand = (Env, data, cb) => {
    // Add a txid on the initial command. This will be re-used in
    // the client response with the signature, allowing us to send
    // the command and the signature to the same core
    if (!data.txid) {
        data._txid = Crypto.randomBytes(24).toString('base64')
                                          .replace(/\//g, '-');
    }
    const coreId = getCoreId(Env, data._txid || data.txid);
    Env.interface.sendQuery(coreId, 'HTTP_COMMAND', data, answer => {
        let response = answer?.data;
        let error = answer?.error;
        cb(error, response);
    });
};

// Initialisation

const LAG_MAX_BEFORE_DISCONNECT = 60000;
const LAG_MAX_BEFORE_PING = 15000;
const checkUserActivity = (Env) => {
    const time = now();
    Object.keys(Env.users).forEach((userId) => {
        const u = Env.users[userId];
        try {
            if (time - u.timeOfLastMessage > LAG_MAX_BEFORE_DISCONNECT) {
                dropUser(Env, u, 'BAD_MESSAGE');
            }
            if (!u.pingOutstanding && time - u.timeOfLastMessage > LAG_MAX_BEFORE_PING) {
                sendMsg(Env, u, [0, '', 'PING', now()]);
                u.pingOutstanding = true;
                Env.plugins?.MONITORING?.increment(`pingSent`);
            }
        } catch (err) {
            Env.Log.error(err, 'USER_ACTIVITY_CHECK');
        }
    });
};

const initServerHandlers = (Env) => {
    if (!Env.wss) { throw new Error('No WebSocket Server'); }

    setInterval(() => {
        checkUserActivity(Env);
    }, 5000);


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
            Env.Log.verbose('Receiving', JSON.parse(message), 'from', user.id);
            try {
                handleMessage(Env, user, message);
                Env.plugins?.MONITORING?.increment(`received`);
                Env.plugins?.MONITORING?.increment(`receivedSize`, message.length);
            } catch (e) {
                Env.Log.error(e, 'NETFLUX_BAD_MESSAGE', {
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
            Env.Log.error(err, 'NETFLUX_WEBSOCKET_ERROR');
            dropUser(Env, user, 'SOCKET_ERROR');
        });
    });

};

const initServer = (Env) => {
    return new Promise((resolve) => {
        const app = Express();
        const httpServer = Http.createServer(app);
        httpServer.listen(Env.public.port, Env.public.host,() => {
            Env.wss = new WebSocketServer({ server: httpServer });
            initServerHandlers(Env);
            resolve();
        });
    });
};

const initHttpCluster = (Env, config) => {
    return new Promise((resolve) => {
        Cluster.setupPrimary({
            exec: './build/ws.worker.js',
            args: [],
        });

        const WORKERS = 2;
        const workerConfig = {
            Log: Env.Log,
            noTaskLimit: true,
            customFork: () => {
                return Cluster.fork({});
            },
            maxWorkers: WORKERS, // XXX
            maxJobs: 10,
            commandTimers: {}, // time spent on each command
            config: config,
            Env: { // Serialized Env (Environment.serialize)
            }
        };

        let ready = 0;
        Cluster.on('online', () => {
            ready++;
            if (ready === WORKERS) {
                resolve();
            }
        });

        Env.workers = WorkerModule(workerConfig);
        Env.workers.onNewWorker(state => {
            Object.keys(Env.allDecrees).forEach(type => {
                const decrees = Env.allDecrees[type];
                Env.workers.sendTo(state, 'NEW_DECREES', {
                    curveKeys: Env.curveKeys,
                    freshKey: Env.FRESH_KEY,
                    decrees, type
                }, () => {
                    Env.Log.verbose('UPDATE_DECREE_WS_WORKER');
                });
            });
        });
    });
};

const start = (config) => {
    const {myId, index, server, infra} = config;
    const interfaceConfig = {
        connector: WSConnector,
        index,
        infra,
        server,
        myId,
        public: server?.public
    };
    const Env = {
        myId: interfaceConfig.myId,
        logIP: true,
        openConnections: {},
        user_channel_cache: {},
        Log: Logger(),
        active: true,
        users: {},
        config: interfaceConfig,
        public: server?.public?.websocket?.[index],
    };

    Environment.init(Env, config);

    const callWithEnv = f => {
        return function () {
            [].unshift.call(arguments, Env);
            return f.apply(null, arguments);
        };
    };

    const CORE_COMMANDS = {
        'SEND_USER_MESSAGE': callWithEnv(sendUserMessage),
        'SEND_CHANNEL_MESSAGE': callWithEnv(sendChannelMessage),
        'NEW_DECREES': callWithEnv(onNewDecrees),
        'FLUSH_CACHE': callWithEnv(flushCache) ,
        'SHUTDOWN': callWithEnv(shutdown)
    };

    const WORKER_COMMANDS = {
        'HTTP_COMMAND': callWithEnv(onHttpCommand)
    };

    initServer(Env)
    .then(() => {
        return initHttpCluster(Env, config);
    }).then(() => {
        try {
            Object.keys(WORKER_COMMANDS).forEach(cmd => {
                let handler = WORKER_COMMANDS[cmd];
                Env.workers.on(cmd, handler);
            });
        } catch (e) {
            console.error(e);
        }

        Env.interface = Interface.connect(interfaceConfig, err => {
            if (err) {
                Env.Log.error(interfaceConfig.myId, ' error:', err);
                return;
            }
            Env.Log.info('WS started', Env.myId);

            if (process.send !== undefined) {
                process.send({type: 'websocket', index: Env.config.index, msg: 'READY'});
            } else {
                Env.Log.info('websocket:' + Env.config.index + ' started');
            }
        });
        Env.plugins.call('addWebsocketCommands')(Env, CORE_COMMANDS);
        Env.interface.handleCommands(CORE_COMMANDS);
    }).catch((e) => { return Env.Log.error('Error:', e); });
};

module.exports = {
    start
};
