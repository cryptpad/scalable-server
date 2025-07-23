// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const ChannelManager = require("./channel_manager.js");
const Util = require("./common-util.js");
const nThen = require("nthen");
const BatchRead = require("./batch-read.js");
const HK = require("./hk-util.js");
const HistoryKeeper = require("./historyKeeper.js");
const Config = require("../ws-config.js");
const Interface = require("../common/interface.js");
const WriteQueue = require("./write-queue.js");
const WSConnector = require("../common/ws-connector.js");
const cli_args = require("minimist")(process.argv.slice(2));

let proceed = true;

if (cli_args.h || cli_args.help) {
    proceed = false;
    console.log(`Usage ${process.argv[1]}:`);
    console.log("\t--help, -h\tDisplay this help");
    console.log("\t--id\tSet the storage node id (default: 0)");
}

if (!proceed) { return; }

let Env = {
    id: "0123456789abcdef",
    publicKeyLength: 32,

    metadata_cache: {},
    channel_cache: {},
    cache_checks: {},
    core_cache: {},

    queueStorage: WriteQueue(),

    batchIndexReads: BatchRead("HK_GET_INDEX"),
    batchMetadata: BatchRead('GET_METADATA'),

    Log: {
        info: console.log,
        error: console.error,
        warn: console.warn,
        verbose: () => { },
    },
};

// TODO: to fix
let getCoreId = function(userId) {
    return Env.core_cache[userId] ? Env.core_cache[userId] : 'core:0';
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
                Env.interface.sendQuery(getCoreId(userId), 'CHANNEL_CONTAINS_USER', { channelName, userId }, function(answer) {
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

let onChannelMessage = function(channelName, channel, msgStruct, cb) {
    channel.id = channelName;
    let userId = msgStruct[1];
    const isCp = /^cp\|/.test(msgStruct[4]);
    const CHECKPOINT_PATTERN = /^cp\|(([A-Za-z0-9+\/=]+)\|)?/;
    let metadata;
    nThen(function(w) {
        HistoryKeeper.getMetadata(Env, channelName, w(function(err, _metadata) {
            // if there's no channel metadata then it can't be an expiring channel
            // nor can we possibly validate it
            if (!_metadata) { return; }
            metadata = _metadata;
            // TODO: expiry verification
        }));
    }).nThen(function(w) {
        // if there's no validateKey present, skip to the next block
        if (!(metadata && metadata.validateKey)) { return; }

        // trim the checkpoint indicator off the message if it's present
        let signedMsg = (isCp) ? msgStruct[4].replace(CHECKPOINT_PATTERN, '') : msgStruct[4];

        // Validate Message
        let coreId = getCoreId(userId);
        Env.interface.sendQuery(coreId, 'VALIDATE_MESSAGE', { signedMsg, validateKey: metadata.validateKey, channelName }, function(answer) {
            let err = answer.error;
            if (!err) {
                return w();
            }
            else {
                if (err === 'FAILED') {
                    // we log this case, but not others for some reason
                    console.error("HK_SIGNED_MESSAGE_REJECTED", {
                        channel: channel.id,
                        validateKey: metadata.validayKey,
                        message: signedMsg,
                    });
                }

                cb('FAILED VALIDATION')
                return void w.abort();
            }
        });
    }).nThen(function() {
        // do checkpoint stuff...

        // 1. get the checkpoint id
        // 2. reject duplicate checkpoints

        if (isCp) {
            // if the message is a checkpoint we will have already validated
            // that it isn't a duplicate. remember its id so that we can
            // repeat this process for the next incoming checkpoint
            // WARNING: the fact that we only check the most recent checkpoints
            // is a potential source of bugs if one editor has high latency and
            // pushes a duplicate of an earlier checkpoint than the latest which
            // has been pushed by editors with low latency
            //
            // FIXME
            let id = CHECKPOINT_PATTERN.exec(msgStruct[4]);
            if (Array.isArray(id) && id[2]) {
                // Store new checkpoint hash
                // there's a FIXME above which concerns a reference to `lastSavedCp`
                // this is a hacky place to store important data.
                channel.lastSavedCp = id[2];
            }
        }

        // add the time to the message
        let time = (new Date()).getTime();
        msgStruct.push(time);

        // storeMessage
        //console.log(+new Date(), "Storing message");
        Env.CM.storeMessage(channel, JSON.stringify(msgStruct), isCp, HK.getHash(msgStruct[4], Env.Log), time, cb);
        //console.log(+new Date(), "Message stored");
    });
};

let onDropChannel = function(channelName, userId) {
    delete Env.metadata_cache[channelName];
    delete Env.channel_cache[channelName];
    // delete Env.core_cache[userId];
}

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

let channelOpenHandler = function(args, cb, extra) {
    Env.channel_cache[args.channelName] = Env.channel_cache[args.channelName] || {};
    Env.core_cache[args.userId] = extra.from;
    HistoryKeeper.getMetadata(Env, args.channelName, cb);
}

let channelMessageHandler = function(args, cb) {
    onChannelMessage(args.channelName, args.channel, args.msgStruct, cb);
}

let dropChannelHandler = function(args) {
    onDropChannel(args.channelName, args.userId);
}

/* Start of the node */

// Create a store
let idx = Number(cli_args.id) || 0;
Env.CM = ChannelManager.create(Env, 'data/' + idx)

// List accepted commands
let COMMANDS = {
    'GET_HISTORY': getHistoryHandler,
    'CHANNEL_OPEN': channelOpenHandler,
    'GET_METADATA': getMetaDataHandler,
    'GET_FULL_HISTORY': getFullHistoryHandler,
    'CHANNEL_MESSAGE': channelMessageHandler,
    'DROP_CHANNEL': dropChannelHandler,
};

// Connect to core
let start = function() {
    Config.myId = 'storage:' + idx;
    Interface.connect(Config, WSConnector, (err, _interface) => {
        if (err) {
            console.error(Config.myId, ' error:', err);
            return;
        }
        _interface.handleCommands(COMMANDS);
        Env.interface = _interface;
        if (process.send !== undefined) {
            process.send({ type: 'storage', idx, msg: 'READY' });
        } else {
            console.log(Config.myId, 'started');
        }
    });
};

module.exports = {
    start
};
