// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Util = require("./common-util.js");
const Constants = require("../common/constants.js");
const Logger = require("../common/logger.js");

const nThen = require("nthen");
const Path = require("node:path");

const HKUtil = require("./hk-util.js");
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
    CHECKPOINT_PATTERN,
    EPHEMERAL_CHANNEL_LENGTH,
    ADMIN_CHANNEL_LENGTH,
    TEMPORARY_CHANNEL_LIFETIME,
    hkId
} = Constants;

const Env = {
    id: Util.uid(),
    Log: Logger(),
    metadata_cache: {},
    channel_cache: {},
    cache_checks: {},
    queueStorage: WriteQueue(),
    queueValidation: WriteQueue(),
    batchIndexReads: BatchRead("HK_GET_INDEX"),
    batchMetadata: BatchRead("GET_METADATA"),
    selfDestructTo: {}
};

const getCoreId = (channel) => {
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

const onChannelMessage = (args, cb) => {
    const { channel, msgStruct, validated } = args;
    const isCp = /^cp\|/.test(msgStruct[4]);
    const channelData = Env.channel_cache[channel] || {};

    if (channel.length === EPHEMERAL_CHANNEL_LENGTH) {
        // XXX
        return void cb(void 0, {
            users: channelData.users,
            message: msgStruct
        });
    }

    // Admin channel: we can only write from private message (RPC)
    if (channel.length === ADMIN_CHANNEL_LENGTH &&
        msgStruct[1] !== null) {
        return void cb('ERESTRICTED_ADMIN');
    }

    let cpId;
    if (isCp) {
        // id becomes either null or an array or results...
        cpId = CHECKPOINT_PATTERN.exec(msgStruct[4]);
        if (Array.isArray(cpId) && cpId[2] &&
            cpId[2] === channelData.lastSavedCp) {
            // Reject duplicate checkpoints: no error and message
            // not sent to others
            return void cb();
        }
    }

    let metadata;
    nThen(function(w) {
        HistoryManager.getMetadata(Env, channel, w(function(err, _metadata) {
            // if there's no channel metadata then it can't be an
            // expiring channel nor can we possibly validate it
            if (!_metadata) { return; }
            metadata = _metadata;
            // TODO: expiry verification // XXX
        }));
    }).nThen(function(w) {
        // Add a validation queue to make sure the messages are stored
        // in the correct order (the first message will be slower to
        // validate since we need a round-trip to Core)
        Env.queueValidation(channel, w(next => {
            // already validated by core?
            if (validated) { return void next(); }

            // if there's no validateKey present, skip to the next block
            if (!(metadata && metadata.validateKey)) { return void next(); }

            // trim the checkpoint indicator off the message
            const signedMsg = isCp ? msgStruct[4].replace(CHECKPOINT_PATTERN, '') : msgStruct[4];

            // Validate Message (and provide key to core)
            const coreId = getCoreId(channel);
            Env.interface.sendQuery(coreId, 'VALIDATE_MESSAGE', {
                signedMsg,
                validateKey: metadata.validateKey,
                channel
            }, w(answer => {
                next();
                let err = answer.error;
                if (!err) { return; }
                if (err === 'FAILED') {
                    // we log this case, but not others for some reason
                    Env.Log.error("HK_SIGNED_MESSAGE_REJECTED", {
                        channel,
                        validateKey: metadata.validayKey,
                        message: signedMsg,
                    });
                }

                cb('FAILED_VALIDATION')
                return void w.abort();
            }));
        }));

    }).nThen(function() {
        if (isCp) {
            // This cp is not a duplicate (already checked before).
            // Remember its ID to make sure we won't push duplicates
            // of this one later.
            if (Array.isArray(cpId) && cpId[2]) {
                // Store new checkpoint hash
                channelData.lastSavedCp = cpId[2];
            }
        }

        // add the time to the message
        let time = (new Date()).getTime();
        msgStruct.push(time);

        // storeMessage
        //console.log(+new Date(), "Storing message");
        Env.CM.storeMessage(channel, JSON.stringify(msgStruct), isCp, HKUtil.getHash(msgStruct[4], Env.Log), time, err => {
            if (err) { return void cb(err); }
            cb(void 0, {
                users: channelData.users,
                message: msgStruct
            });
        });
        //console.log(+new Date(), "Message stored");
    });
};

const onDropChannel = channel => {
    let meta = Env.metadata_cache[channel];
    delete Env.metadata_cache[channel];
    delete Env.channel_cache[channel];

    if (meta && meta.selfdestruct && Env.selfDestructTo) {
        Env.selfDestructTo[channel] = setTimeout(function () {
            Env.CM?.removeChannel(Env, channel);
        }, TEMPORARY_CHANNEL_LIFETIME);
    }
    if (Env.store) {
        Env.store.closeChannel(channel, function () {});
    }

    const coreId = getCoreId(channel);
    Env.interface.sendEvent(coreId, 'DROP_CHANNEL', { channel });
};

Env.onExpiredChannel = channel => {
    const channelData = Env.channel_cache[channel];
    if (!channelData) { return; }
    const users = channelData.users.slice();

    const coreId = getCoreId(channel);
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
        const coreId = getCoreId(channel);
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
const getHistoryHandler = (args, cb) => {
    const parsed = args?.parsed;
    const channel = parsed?.[1];
    const send = sendMessage(args?.userId, channel);
    HistoryManager.onGetHistory(Env, args, send, cb);
}

const getFullHistoryHandler = (args, cb) => {
    const parsed = args?.parsed;
    const channel = parsed?.[1];
    const send = sendMessage(args?.userId, channel);
    HistoryManager.onGetFullHistory(Env, args, send, cb);
}

let getMetaDataHandler = function(args, cb) {
    HistoryManager.getMetadata(Env, args.channel, cb);
}

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

/* Start of the node */

// List accepted commands
let COMMANDS = {
    'GET_HISTORY': getHistoryHandler,
    'JOIN_CHANNEL': joinChannelHandler,
    'LEAVE_CHANNEL': leaveChannelHandler,
    'GET_METADATA': getMetaDataHandler,
    'GET_FULL_HISTORY': getFullHistoryHandler,
    'CHANNEL_MESSAGE': onChannelMessage,
    'DROP_USER': dropUserHandler,
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
