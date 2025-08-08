// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Util = require("./common-util.js");
const Constants = require("../common/constants.js");
const Logger = require("../common/logger.js");

const nThen = require("nthen");
const Path = require("node:path");

const HKUtil = require("./hk-util.js");
const HistoryKeeper = require("./historyKeeper.js");
const ChannelManager = require("./channel_manager.js");

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
    hkId
} = Constants;

const HISTORY_KEEPER_ID = hkId;
const Env = {
    Log: Logger(),
    metadata_cache: {},
    channel_cache: {},
    cache_checks: {},
    queueStorage: WriteQueue(),
    queueValidation: WriteQueue(),
    batchIndexReads: BatchRead("HK_GET_INDEX"),
    batchMetadata: BatchRead("GET_METADATA")
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

const channelContainsUser = (channel, userId) => {
    const cache = Env.channel_cache[channel];
    // Check if the channel exists in this storage
    if (!cache || !Array.isArray(cache.users)) { return false; }

    // Check if the user is a member of this channel
    return cache.users.includes(userId);
};

let onGetHistory = function(seq, userId, parsed, cb) {
    let first = parsed[0];
    let channel = parsed[1];
    let config = parsed[2];
    let metadata = {};
    let allowed = []; // List of authenticated keys for this user
    let toSend = []; // send the messages at then end

    if (first !== 'GET_HISTORY') {
        return;
    }

    // XXX: store the message to be send in a array before sending a batch

    // getMetaData(channel, function(err, _metadata) {
    //     if (err) {
    //         console.log('Error:', err);
    //         return;
    //     }
    //     if (!_metadata) {
    //         return;
    //     }
    //     metadata = _metadata;
    //     // XXX: check restrictions
    // });

    const metadata_cache = Env.metadata_cache;

    let lastKnownHash;
    let txid;

    if (config && typeof config === "object" && !Array.isArray(parsed[2])) {
        lastKnownHash = config.lastKnownHash;
        metadata = config.metadata || {};
        txid = config.txid;
        if (metadata.expire) {
            metadata.expire = +metadata.expire * 1000 + (+new Date());
        }
    }

    metadata.channel = channel;
    metadata.created = +new Date();

    // if the user sends us an invalid key, we won't be able to validate their messages
    // so they'll never get written to the log anyway. Let's just drop their message
    // on the floor instead of doing a bunch of extra work
    // TODO: Send them an error message so they know something is wrong
    // TODO: add Log handling function
    if (metadata.validateKey && !HKUtil.isValidValidateKeyString(metadata.validateKey)) {
        return void console.error('HK_INVALID_KEY', metadata.validateKey);
    }

    nThen(function(w) {
        HistoryKeeper.getMetadata(Env, channel, w(function(err, metadata) {
            if (err) {
                console.error('HK_GET_HISTORY_METADATA', {
                    channel: channel,
                    error: err,
                });
                return;
            }
            if (!metadata || !metadata.channel) { return; }
            // if there is already a metadata log then use it instead
            // of whatever the user supplied

            // And then check if the channel is expired. If it is, send the error and abort
            // FIXME: this is hard to read because 'checkExpired' has side effects
            // TODO: check later EXPIRE
            // TODO: check restricted/allow list
            // (this function should receive the list of authorized keys for
            //  this user)
            //
            // if (checkExpired(Env, Server, channel)) { return void w.abort(); }

            // always send metadata with GET_HISTORY requests
            toSend.push([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(metadata)]);
        }));
    }).nThen(function(w) {
        let msgCount = 0;

        // TODO compute lastKnownHash in a manner such that it will always skip past the metadata line?
        HistoryKeeper.getHistoryAsync(Env, channel, lastKnownHash, false, (msg, readMore) => {
            msgCount++;
            // avoid sending the metadata message a second time
            if (HKUtil.isMetadataMessage(msg) && metadata_cache[channel]) { return readMore(); }
            if (txid) { msg[0] = txid; }
            toSend.push([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(msg)]);
            readMore();
        }, w((err, reason) => {
            // Any error but ENOENT: abort
            // ENOENT is allowed in case we want to create a new pad
            if (err && err.error) { err = err.error; }
            if (err && err.code !== 'ENOENT') {
                if (err.message === "EUNKNOWN") {
                    console.error("HK_GET_HISTORY", {
                        channel: channel,
                        lastKnownHash: lastKnownHash,
                        userId: userId,
                        sessions: allowed,
                        err: err && err.message || err,
                    });
                } else if (err.message !== 'EINVAL') {
                    console.error("HK_GET_HISTORY", {
                        channel: channel,
                        err: err && err.message || err,
                        stack: err && err.stack,
                    });
                }
                // FIXME err.message isn't useful for users
                const parsedMsg = { error: err.message, channel: channel, txid: txid };
                toSend.push([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(parsedMsg)]);
                return;
            }
            // reason: from a .placeholder file
            if (err && err.code === 'ENOENT' && reason && !metadata.forcePlaceholder) {
                const parsedMsg2 = { error: 'EDELETED', message: reason, channel: channel, txid: txid };
                toSend.push(userId, [0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(parsedMsg2)]);
                return;
            }

            // If we're asking for a specific version (lastKnownHash) but we receive an
            // ENOENT, this is not a pad creation so we need to abort.
            if (err && err.code === 'ENOENT' && lastKnownHash) {
                /*
                    This informs clients that the pad they're trying to load was deleted by its owner.
                    The user in question might be reconnecting or might have loaded the document from their cache.
                    The owner that deleted it could be another user or the same user from a different device.
                    Either way, the respectful thing to do is display an error screen informing them that the content
                is no longer on the server so they don't abuse the data and so that they don't unintentionally continue
                to edit it in a broken state.
                    */
                const parsedMsg2 = { error: 'EDELETED', channel: channel, txid: txid };
                toSend.push([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(parsedMsg2)]);
                return;
            }

            if (msgCount === 0 && !metadata_cache[channel] && channelContainsUser(channel, userId)) {
                // TODO: this might be a good place to reject channel creation by anonymous users
                HistoryKeeper.handleFirstMessage(Env, channel, metadata);
                toSend.push([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(metadata)]);
            }

            // End of history message:
            let parsedMsg = { state: 1, channel: channel, txid: txid };

            toSend.push([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(parsedMsg)]);
        }));
    }).nThen(() => {
        cb(void 0, { toSend });
    });
};

let onGetFullHistory = function(seq, userId, parsed, cb) {
    let channel = parsed[1];
    let toSend = [];
    let error;

    HistoryKeeper.getHistoryAsync(Env, channel, -1, false, (msg, readMore) => {
        toSend.push([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(['FULL_HISTORY', msg])]);
        readMore();
    }, (err) => {
        let parsedMsg = ['FULL_HISTORY_END', channel];
        if (err) {
            console.error('HK_GET_FULL_HISTORY', err.stack);
            error = err;
            parsedMsg = ['ERROR', parsed[1], err.message];
        }
        toSend.push([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(parsedMsg)]);
    });
    cb(error, toSend);
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
        HistoryKeeper.getMetadata(Env, channel, w(function(err, _metadata) {
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
    delete Env.metadata_cache[channel];
    delete Env.channel_cache[channel];
    // XXX selfdestruct integration

    const coreId = getCoreId(channel);
    Env.interface.sendEvent(coreId, 'DROP_CHANNEL', { channel });
};

// Handlers
let getHistoryHandler = function(args, cb) {
    onGetHistory(args.seq, args.userId, args.parsed, cb);
}

let getFullHistoryHandler = function(args, cb) {
    onGetFullHistory(args.seq, args.userId, args.parsed, cb);
}

let getMetaDataHandler = function(args, cb) {
    HistoryKeeper.getMetadata(Env, args.channel, cb);
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
    HistoryKeeper.getMetadata(Env, channel, (err, metadata) => {
        // XXX handle allow list
        if (err) {
            console.error('HK_METADATA_ERR', {
                channel, error: err,
            });
        }

        if (metadata?.selfdestruct) {
            // XXX TODO
            throw new Error('NOT IMPLEMENTED');
        }
        // XXX selfDestructTo

        if (!metadata?.restricted) {
            // the channel doesn't have metadata, or it does and
            // it's not restricted: either way, let them join.
            return void cb(void 0, _users);
        }

        // channel is restricted
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
            }, (e, metadata) => {
                next();
                cb(e, metadata);
            });
        });
    };
    Env.worker.computeIndex = (channel, cb) => {
        Env.store.getWeakLock(channel, next => {
            Env.workers.send('COMPUTE_INDEX', {
                channel
            }, (e, index) => {
                next();
                cb(e, index);
            });
        });
    };
};

// Connect to core
let start = function(config) {
    const { myId, index, infra } = config;

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
            workerPath: './storage/worker.js',
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
