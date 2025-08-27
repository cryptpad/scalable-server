// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Util = require("./common-util.js");
const Constants = require("../common/constants.js");
const Logger = require("../common/logger.js");

const nThen = require("nthen");
const Path = require("node:path");

const HistoryManager = require("./history-manager.js");
const ChannelManager = require("./channel-manager.js");

const Interface = require("../common/interface.js");
const WSConnector = require("../common/ws-connector.js");

const BatchRead = require("./batch-read.js");
const WriteQueue = require("../common/write-queue.js");
const WorkerModule = require("../common/worker-module.js");
const File = require("./storage/file.js");

const { jumpConsistentHash } = require('../common/consistent-hash.js');

const {
    TEMPORARY_CHANNEL_LIFETIME,
    hkId
} = Constants;

const Env = {
    id: Util.uid(),
    Log: Logger(),
    metadata_cache: {},
    channel_cache: {},
    cache_checks: {},
    intervals: {},
    queueStorage: WriteQueue(),
    queueValidation: WriteQueue(),
    batchIndexReads: BatchRead("HK_GET_INDEX"),
    batchMetadata: BatchRead("GET_METADATA"),
    selfDestructTo: {},
};

Env.getCoreId = (channel) => {
    let key = Buffer.from(channel.slice(0, 8));
    let coreId = 'core:' + jumpConsistentHash(key, Env.numberCores);
    return coreId;
};

Env.checkCache = channel => {
    let f = Env.cache_checks[channel] ||= Util.throttle(() => {
        delete Env.cache_checks[channel];
        if (Env.channel_cache[channel]) { return; }
        delete Env.metadata_cache[channel];
    }, 30000);
    f();
};

Env.channelContainsUser = (channel, userId) => {
    const cache = Env.channel_cache[channel];
    // Check if the channel exists in this storage
    if (!cache || !Array.isArray(cache.users)) { return false; }

    // Check if the user is a member of this channel
    return cache.users.includes(userId);
};

const onDropChannel = channel => {
    let meta = Env.metadata_cache[channel];
    delete Env.metadata_cache[channel];
    delete Env.channel_cache[channel];

    if (meta && meta.selfdestruct && Env.selfDestructTo) {
        Env.selfDestructTo[channel] = setTimeout(function() {
            Env.CM?.removeChannel(Env, channel);
        }, TEMPORARY_CHANNEL_LIFETIME);
    }
    if (Env.store) {
        Env.store.closeChannel(channel, function() { });
    }

    const coreId = Env.getCoreId(channel);
    Env.interface.sendEvent(coreId, 'DROP_CHANNEL', { channel });
};

Env.onExpiredChannel = channel => {
    const channelData = Env.channel_cache[channel];
    if (!channelData) { return; }
    const users = channelData.users.slice();

    const coreId = Env.getCoreId(channel);
    const message = [0, hkId, 'MSG', null, {
        error: 'EEXPIRED', channel
    }];
    Env.interface.sendEvent(coreId, 'HISTORY_CHANNEL_MESSAGE', {
        users, message
    });
    onDropChannel(channel);
};

// Handlers
const sendMessage = (userId, channel) => {
    return (message, cb) => {
        if (!userId) { return; }
        const coreId = Env.getCoreId(channel);
        const f = typeof(cb) === "function" ?
            Env.interface.sendQuery :
            Env.interface.sendEvent;
        f(coreId, 'HISTORY_MESSAGE', {
            userId, message
        }, () => {
            // No args for cb, this can be a "readMore" call
            // which will fail if we pass arguments
            cb();
        });
    };
};

const getHistoryHandler = f => {
    return (args, cb) => {
        const parsed = args?.parsed;
        const channel = parsed?.[1];
        const send = sendMessage(args?.userId, channel);
        f(Env, args, send, cb);
    };
};

const getMetaDataHandler = (args, cb) => {
    HistoryManager.getMetadata(Env, args.channel, cb);
};

const onChannelMessageHandler = (args, cb) => {
    Env.CM.onChannelMessage(args, cb);
};

const joinChannelHandler = (args, cb) => {
    const { channel, userId } = args;

    const channelData = Env.channel_cache[channel] ||= {
        users: []
    };
    const _users = channelData.users.slice();
    if (!channelData.users.includes(userId)) {
        channelData.users.push(userId);
    }
    HistoryManager.getMetadata(Env, channel, (err, metadata) => {
        // XXX handle allow list
        if (err) {
            console.error('HK_METADATA_ERR', {
                channel, error: err,
            });
        }

        if (metadata?.selfdestruct &&
            metadata.selfdestruct !== Env.id) {
            Env.CM.removeChannel(Env, channel);
            return void cb('ESELFDESTRUCT');
        }

        if (Env.selfDestructTo && Env.selfDestructTo[channel]) {
            clearTimeout(Env.selfDestructTo[channel]);
        }

        if (!metadata?.restricted) {
            // the channel doesn't have metadata, or it does and
            // it's not restricted: either way, let them join.
            return void cb(void 0, _users);
        }

        // XXX channel is restricted
        throw new Error('NOT IMPLEMENTED');
    });
};
const leaveChannelHandler = (args, cb) => {
    const { channel, userId } = args;

    const channelData = Env.channel_cache[channel];
    const users = channelData?.users;
    if (!Array.isArray(users)) {
        return void cb('ENOENT');
    }
    if (!users.includes(userId)) {
        return void cb('NOT_IN_CHAN');
    }
    users.splice(users.indexOf(userId), 1);

    if (!users.length) { onDropChannel(channel); }

    cb(void 0, users);
};

const dropUserHandler = (args) => {
    const { channels, userId } = args;
    channels.forEach(channel => {
        const cache = Env.channel_cache[channel];
        // Check if the channel exists in this storage
        if (!cache || !Array.isArray(cache.users)) { return; }

        // Check if the user is a member of this channel
        const idx = cache.users.indexOf(userId);
        if (idx === -1) { return; }

        // Remove the user
        cache.users.splice(idx, 1);

        // Clean the channel if no remaining members
        if (!cache.users.length) {
            onDropChannel(channel);
        }
    });
};

/* RPC commands */

const getFileSizeHandler = (channel, cb) => {
    Env.worker.getFileSize(channel, cb);
};

/* Start of the node */

// List accepted commands
let COMMANDS = {
    'JOIN_CHANNEL': joinChannelHandler,
    'LEAVE_CHANNEL': leaveChannelHandler,
    'GET_METADATA': getMetaDataHandler,
    'GET_HISTORY': getHistoryHandler(HistoryManager.onGetHistory),
    'GET_FULL_HISTORY': getHistoryHandler(HistoryManager.onGetFullHistory),
    'GET_HISTORY_RANGE': getHistoryHandler(HistoryManager.onGetHistoryRange),
    'CHANNEL_MESSAGE': onChannelMessageHandler,
    'DROP_USER': dropUserHandler,

    'RPC_GET_FILE_SIZE': getFileSizeHandler,
};

const initWorkerCommands = () => {
    Env.worker ||= {};
    Env.worker.computeMetadata = (channel, cb) => {
        Env.store.getWeakLock(channel, next => {
            Env.workers.send('COMPUTE_METADATA', {
                channel
            }, Util.both(next, cb));
        });
    };
    Env.worker.computeIndex = (channel, cb) => {
        Env.store.getWeakLock(channel, next => {
            Env.workers.send('COMPUTE_INDEX', {
                channel
            }, Util.both(next, cb));
        });
    };
    Env.worker.getHashOffset = (channel, hash, cb) => {
        Env.store.getWeakLock(channel, next => {
            Env.workers.send('GET_HASH_OFFSET', {
                channel, hash
            }, Util.both(next, cb));
        });
    };
    Env.worker.getOlderHistory = function (channel, oldestKnownHash, untilHash, desiredMessages, desiredCheckpoint, cb) {
        Env.store.getWeakLock(channel, function (next) {
            Env.workers.send('GET_OLDER_HISTORY', {
                channel, oldestKnownHash, untilHash, desiredMessages, desiredCheckpoint
            }, Util.both(next, cb));
        });
    };

    // RPC
    Env.worker.getFileSize = (channel, cb) => {
        Env.workers.send('GET_FILE_SIZE', {
            channel
        }, cb);
    };


    // Tasks
    Env.worker.runTasks = (cb) => {
        // time out after 10 minutes
        Env.workers.send('RUN_TASKS', {}, cb, 1000 * 60 * 10);
    };
    Env.worker.writeTask = (time, command, args, cb) => {
        Env.workers.send('WRITE_TASK', {
            time: time,
            task_command: command,
            args: args,
        }, cb);
    };
};

// Connect to core
let start = function(config) {
    const { myId, index, infra, server } = config;

    Env.numberCores = infra?.core?.length;

    const paths = Constants.paths;
    const idx = String(index);
    const filePath = Path.join(paths.base, idx, paths.channel);
    const archivePath = Path.join(paths.base, idx, paths.archive);
    nThen(waitFor => {
        File.create({
            filePath, archivePath,
            volume: 'channel'
        }, waitFor((err, store) => {
            if (err) { throw new Error(err); }
            Env.store = store;
        }));
    }).nThen(() => {
        let tasks_running;
        Env.intervals.taskExpiration = setInterval(() => {
            if (Env.disableIntegratedTasks) { return; }
            if (tasks_running) { return; }
            tasks_running = true;
            Env.worker.runTasks(err => {
                if (err) {
                    Env.Log.error('TASK_RUNNER_ERR', err);
                }
                tasks_running = false;
            });
        }, 1000 * 60 * 5); // run every five minutes

    }).nThen(() => {
        const workerConfig = {
            Log: Env.Log,
            workerPath: './build/storage.worker.js',
            maxWorkers: 1,
            maxJobs: 4,
            commandTimers: {}, // time spent on each command
            config: {
                index
            },
            Env: { // Serialized Env (Environment.serialize)
            }
        };
        Env.workers = WorkerModule(workerConfig);
        initWorkerCommands();

        Env.CM = ChannelManager.create(Env);

        const interfaceConfig = {
            connector: WSConnector,
            index,
            infra,
            server,
            myId
        };
        Interface.connect(interfaceConfig, (err, _interface) => {
            if (err) {
                console.error(interfaceConfig.myId, ' error:', err);
                return;
            }

            // List accepted commands

            _interface.handleCommands(COMMANDS);
            Env.interface = _interface;
            if (process.send !== undefined) {
                process.send({ type: 'storage', index: interfaceConfig.index, msg: 'READY' });
            } else {
                console.log(interfaceConfig.myId, 'started');
            }
        });
    });
};

module.exports = {
    start
};
