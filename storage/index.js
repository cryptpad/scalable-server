// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const ChannelManager = require("./channel_manager.js");
const Util = require("./common-util.js");
const nThen = require("nthen");
const BatchRead = require("./batch-read.js");
const HK = require("./hk-util.js");
const HistoryKeeper = require("./historyKeeper.js");
const Interface = require("../common/interface.js");
const WriteQueue = require("./write-queue.js");
const WSConnector = require("../common/ws-connector.js");
const { jumpConsistentHash } = require('../common/consistent-hash.js');

const EPHEMERAL_CHANNEL_LENGTH = 34;
const ADMIN_CHANNEL_LENGTH = 33;

let Env = {};

const getCoreId = (channelName) => {
    let key = Buffer.from(channelName.slice(0, 8));
    let coreId = 'core:' + jumpConsistentHash(key, Env.numberCores);
    return coreId;
};

Env.checkCache = function(channel) {
    let f = Env.cache_checks[channel] = Env.cache_checks[channel] ||
        Util.throttle(function() {
            delete Env.cache_checks[channel];
            if (Env.channel_cache[channel]) { return; }
            delete Env.metadata_cache[channel];
        }, 30000);
    f();
};

let onGetHistory = function(seq, userId, parsed, cb) {
    let first = parsed[0];
    let channelName = parsed[1];
    let config = parsed[2];
    let metadata = {};
    let allowed = []; // List of authenticated keys for this user
    let toSend = []; // send the messages at then end

    if (first !== 'GET_HISTORY') {
        return;
    }

    // XXX: store the message to be send in a array before sending a batch

    // getMetaData(channelName, function(err, _metadata) {
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
    // TODO: check if we need to change it between each restart?
    const HISTORY_KEEPER_ID = Env.id;

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

    metadata.channel = channelName;
    metadata.created = +new Date();

    // if the user sends us an invalid key, we won't be able to validate their messages
    // so they'll never get written to the log anyway. Let's just drop their message
    // on the floor instead of doing a bunch of extra work
    // TODO: Send them an error message so they know something is wrong
    // TODO: add Log handling function
    if (metadata.validateKey && !HK.isValidValidateKeyString(Env, metadata.validateKey)) {
        return void console.error('HK_INVALID_KEY', metadata.validateKey);
    }

    nThen(function(w) {
        HistoryKeeper.getMetadata(Env, channelName, w(function(err, metadata) {
            if (err) {
                console.error('HK_GET_HISTORY_METADATA', {
                    channel: channelName,
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
            // if (checkExpired(Env, Server, channelName)) { return void w.abort(); }

            // always send metadata with GET_HISTORY requests
            toSend.push([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(metadata)]);
        }));
    }).nThen(function(w) {
        let msgCount = 0;

        // TODO compute lastKnownHash in a manner such that it will always skip past the metadata line?
        HistoryKeeper.getHistoryAsync(Env, channelName, lastKnownHash, false, (msg, readMore) => {
            msgCount++;
            // avoid sending the metadata message a second time
            if (HK.isMetadataMessage(msg) && metadata_cache[channelName]) { return readMore(); }
            if (txid) { msg[0] = txid; }
            toSend.push([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(msg)]);
            readMore();
        }, w((err, reason) => {
            // Any error but ENOENT: abort
            // ENOENT is allowed in case we want to create a new pad
            if (err && err.code !== 'ENOENT') {
                if (err.message === "EUNKNOWN") {
                    console.error("HK_GET_HISTORY", {
                        channel: channelName,
                        lastKnownHash: lastKnownHash,
                        userId: userId,
                        sessions: allowed,
                        err: err && err.message || err,
                    });
                } else if (err.message !== 'EINVAL') {
                    console.error("HK_GET_HISTORY", {
                        channel: channelName,
                        err: err && err.message || err,
                        stack: err && err.stack,
                    });
                }
                // FIXME err.message isn't useful for users
                const parsedMsg = { error: err.message, channel: channelName, txid: txid };
                toSend.push([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(parsedMsg)]);
                return;
            }
            // reason: from a .placeholder file
            if (err && err.code === 'ENOENT' && reason && !metadata.forcePlaceholder) {
                const parsedMsg2 = { error: 'EDELETED', message: reason, channel: channelName, txid: txid };
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
                const parsedMsg2 = { error: 'EDELETED', channel: channelName, txid: txid };
                toSend.push([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(parsedMsg2)]);
                return;
            }

            if (msgCount === 0 && !metadata_cache[channelName]) {
                Env.interface.sendQuery(getCoreId(channelName), 'CHANNEL_CONTAINS_USER', { channelName, userId }, function(answer) {
                    let err = answer.error;
                    if (err) {
                        console.error('Error: can’t check channelContainsUser:', err, '-', channelName, userId);
                        return;
                    }
                    if (answer.data.response) {
                        // TODO: this might be a good place to reject channel creation by anonymous users
                        HistoryKeeper.handleFirstMessage(Env, channelName, metadata);
                        toSend.push([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(metadata)]);
                    }
                });
            }

            // End of history message:
            let parsedMsg = { state: 1, channel: channelName, txid: txid };

            toSend.push([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(parsedMsg)]);
        }));
    }).nThen(() => {
        cb(void 0, { toSend });
    });
};

let onGetFullHistory = function(seq, userId, parsed, cb) {
    let channelName = parsed[1];
    let toSend = [];
    let error;
    const HISTORY_KEEPER_ID = Env.id;

    HistoryKeeper.getHistoryAsync(Env, channelName, -1, false, (msg, readMore) => {
        toSend.push([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(['FULL_HISTORY', msg])]);
        readMore();
    }, (err) => {
        let parsedMsg = ['FULL_HISTORY_END', channelName];
        if (err) {
            console.error('HK_GET_FULL_HISTORY', err.stack);
            error = err;
            parsedMsg = ['ERROR', parsed[1], err.message];
        }
        toSend.push([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(parsedMsg)]);
    });
    cb(error, toSend);
};

let onChannelMessage = function(channel, msgStruct, cb) {
    let userId = msgStruct[1];
    const isCp = /^cp\|/.test(msgStruct[4]);
    const CHECKPOINT_PATTERN = /^cp\|(([A-Za-z0-9+\/=]+)\|)?/;
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
            // TODO: expiry verification
        }));
    }).nThen(function(w) {
        // if there's no validateKey present, skip to the next block
        if (!(metadata && metadata.validateKey)) { return; }

        // trim the checkpoint indicator off the message
        const signedMsg = isCp ? msgStruct[4].replace(CHECKPOINT_PATTERN, '') : msgStruct[4];

        // Validate Message
        const coreId = getCoreId(channel);
        Env.interface.sendQuery(coreId, 'VALIDATE_MESSAGE', {
            signedMsg,
            validateKey: metadata.validateKey,
            channel
        }, w(answer => {
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

            cb('FAILED VALIDATION')
            return void w.abort();
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
        Env.CM.storeMessage(channel, JSON.stringify(msgStruct), isCp, HK.getHash(msgStruct[4], Env.Log), time, err => {
            if (err) { return void cb(err); }
            cb(void 0, {
                users: channelData.users,
                message: msgStruct
            });
        });
        //console.log(+new Date(), "Message stored");
    });
};

const onDropChannel = function(channelName, userId) {
    delete Env.metadata_cache[channelName];
    delete Env.channel_cache[channelName];
    // XXX selfdestruct integration
};

// Handlers
let getHistoryHandler = function(args, cb) {
    onGetHistory(args.seq, args.userId, args.parsed, cb);
}

let getFullHistoryHandler = function(args, cb) {
    onGetFullHistory(args.seq, args.userId, args.parsed, cb);
}

let getMetaDataHandler = function(args, cb) {
    HistoryKeeper.getMetadata(Env, args.channelName, cb);
}

let channelMessageHandler = function(args, cb) {
    onChannelMessage(args.channelName, args.msgStruct, cb);
}

const joinChannelHandler = (args, cb, extra) => {
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
const leaveChannelHandler = (args, cb, extra) => {
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
    'CHANNEL_MESSAGE': channelMessageHandler,
    'DROP_USER': dropUserHandler,
};

// Connect to core
let start = function(config) {
    const { myId, index, infra, server } = config;

    Env.id = "0123456789abcdef";
    Env.publicKeyLength = 32;
    Env.metadata_cache = {};
    Env.channel_cache = {};
    Env.cache_checks = {};
    Env.queueStorage = WriteQueue();
    Env.batchIndexReads = BatchRead("HK_GET_INDEX");
    Env.batchMetadata = BatchRead('GET_METADATA');

    Env.numberCores = infra?.core?.length;

    Env.Log = {
        info: console.log,
        error: console.error,
        warn: console.warn,
        verbose: () => { },
    };

    Env.CM = ChannelManager.create(Env, 'data/' + index);

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
};

module.exports = {
    start
};
