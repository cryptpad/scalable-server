// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors

const Interface = require("../common/interface.js");
const WSConnector = require("../common/ws-connector.js");
const Crypto = require('crypto');
const Util = require("../common/common-util.js");
const Constants = require("../common/constants.js");
const Logger = require("../common/logger.js");
const WorkerModule = require("../common/worker-module.js");
const Cluster = require("node:cluster");
const Environment = require('../common/env.js');
const Admin = require('./commands/admin');
const nThen = require('nthen');

const {
    hkId,
    ADMIN_CHANNEL_LENGTH
} = Constants;

// Use consistentHash for that
const getCoreId = (Env, channel) => {
    return Env.getCoreId(channel);
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
const onSessionClose = (Env, userId) => {
    // Cleanup leftover channels
    dropUserChannels(Env, userId);
    delete Env.users[userId];
};
const historyCommands = [
    'GET_HISTORY', 'GET_HISTORY_RANGE', 'GET_FULL_HISTORY'
];

const sendMsgPromise = (Env, user, msg) => {
    return new Promise((resolve, reject) => {
        const state = user.state;
        Env.workers.sendTo(state, 'WS_SEND_MESSAGE', {
            id: user.id,
            msg
        }, (err, res) => {
            if (err) {
                return reject(err);
            }
            const length = res?.length || msg.length;
            Env.plugins?.MONITORING?.increment(`sent`);
            Env.plugins?.MONITORING?.increment(`sentSize`, length);
            resolve();
        });
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

const onWsMessage = (Env, args, cb) => {
    const { userId, cmd, seq, json, length } = args;
    if (typeof(commands[cmd]) !== 'function') { return void cb(); }
    const user = Env.users[userId];
    Env.plugins?.MONITORING?.increment(`received`);
    Env.plugins?.MONITORING?.increment(`receivedSize`, length);
    if (!user) { return void cb(); }
    commands[cmd](Env, {
        user, json, seq,
        obj: json[1],
    });
    cb();
};

const onWsUser = (Env, args, cb, state) => {
    const { id, ip } = args;
    Env.users[id] = {
        state,
        id, ip,
        channels: []
    };
    onSessionOpen(Env, id, ip);
    cb();
};

const onWsDropUser = (Env, args, cb) => {
    const { id, reason } = args;
    onSessionClose(Env, id, reason);
    cb();
};

const onWsPing = (Env, args, cb) => {
    Env.plugins?.MONITORING?.increment(`pingSent`);
    cb();
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
    Env.curveKeys ||= curveKeys;
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
    Env.workers.broadcast('WS_SHUTDOWN', {}, () => {});
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

const initHttpCluster = (Env, mainConfig) => {
    return new Promise((resolve) => {
        Cluster.setupPrimary({
            exec: './build/front.worker.js',
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
            config: mainConfig,
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
            Env.workers.sendTo(state, 'SET_MODERATORS', Env.moderators, () => {
                Env.Log.verbose('UPDATE_MODERATORS_FRONT_WORKER');
            });
        });
    });
};

const start = (mainConfig) => {
    const {myId, index, config, infra} = mainConfig;
    const Env = {
        openConnections: {},
        user_channel_cache: {},
        Log: Logger(),
        active: true,
        users: {},
        public: infra?.front?.[index],
    };
    Environment.init(Env, mainConfig);

    const interfaceConfig = {
        connector: WSConnector,
        index,
        infra,
        server: config,
        myId,
        Log: Env.Log
    };

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
        'SHUTDOWN': callWithEnv(shutdown),
        'ADMIN_CMD': callWithEnv(Admin.command)
    };

    const WORKER_COMMANDS = {
        'HTTP_COMMAND': callWithEnv(onHttpCommand),
        'WS_MESSAGE': callWithEnv(onWsMessage),
        'WS_NEW_USER': callWithEnv(onWsUser),
        'WS_DROP_USER': callWithEnv(onWsDropUser),
        'WS_SEND_PING': callWithEnv(onWsPing),
    };

    nThen(w => {
        initHttpCluster(Env, mainConfig).then(w());
    }).nThen(w => {
        try {
            Object.keys(WORKER_COMMANDS).forEach(cmd => {
                let handler = WORKER_COMMANDS[cmd];
                Env.workers.on(cmd, handler);
            });
        } catch (e) {
            console.error(e);
        }

        Env.interface = Interface.init(interfaceConfig, w(err => {
            if (err) {
                w.abort();
                Env.Log.error(interfaceConfig.myId, ' error:', err);
                return;
            }
        }));
        Env.plugins.call('addFrontCommands')(Env, CORE_COMMANDS);
        Env.interface.handleCommands(CORE_COMMANDS);
    }).nThen(() => {
        Env.Log.info('WS started', Env.myId);

        if (process.send !== undefined) {
            process.send({type: 'front', index, msg: 'READY'});
        } else {
            Env.Log.info('front:' + index + ' started');
        }
    });
};

module.exports = {
    start
};
