// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Store = require("./storage/file.js");
const Util = require("./common-util.js");
const nThen = require("nthen");
const BatchRead = require("./batch-read.js");
const Meta = require("./commands/metadata.js");
const HK = require("./hk-util.js");
const Config = require("../ws-config.js");
const Interface = require("../common/interface.js");

let Env = {
    id: "0123456789abcdef",
    publicKeyLength: 32,

    metadata_cache: {},
    channel_cache: {},
    cache_checks: {},

    batchIndexReads: BatchRead("HK_GET_INDEX"),
    batchMetadata: BatchRead('GET_METADATA'),

    Log: {
        info: console.log,
        error: console.error,
        verbose: console.log,
    },
};

// TODO: make that automatic
let getCoreId = function(channelname) {
    return 'core:0';
};

Env.coreId = getCoreId('XXX');

const DETAIL = 1000;
let round = function(n) {
    return Math.floor(n * DETAIL) / DETAIL;
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

let init = store => {
    const OPEN_CURLY_BRACE = Buffer.from('{');
    const CHECKPOINT_PREFIX = Buffer.from('cp|');
    const isValidOffsetNumber = function(n) {
        return typeof (n) === 'number' && n >= 0;
    };

    const computeIndexFromOffset = function(channelName, offset, cb) {
        let cpIndex = [];
        let messageBuf = [];
        let i = 0;

        const CB = Util.once(cb);

        const offsetByHash = {};
        let offsetCount = 0;
        let size = offset || 0;
        let start = offset || 0;
        let unconventional = false;

        nThen(function(w) {
            // iterate over all messages in the channel log
            // old channels can contain metadata as the first message of the log
            // skip over metadata as that is handled elsewhere
            // otherwise index important messages in the log
            store.readMessagesBin(channelName, start, (msgObj, readMore, abort) => {
                let msg;
                // keep an eye out for the metadata line if you haven't already seen it
                // but only check for metadata on the first line
                if (i) {
                    // fall through intentionally because the following blocks are invalid
                    // for all but the first message
                } else if (msgObj.buff.includes(OPEN_CURLY_BRACE)) {
                    msg = Util.tryParse(msgObj.buff.toString('utf8'));
                    if (typeof msg === "undefined") {
                        i++; // always increment the message counter
                        return readMore();
                    }

                    // validate that the current line really is metadata before storing it as such
                    // skip this, as you already have metadata...
                    if (HK.isMetadataMessage(msg)) {
                        i++; // always increment the message counter
                        return readMore();
                    }
                } else if (!(msg = Util.tryParse(msgObj.buff.toString('utf8')))) {
                    w.abort();
                    abort();
                    return CB("OFFSET_ERROR");
                }
                i++;
                if (msgObj.buff.includes(CHECKPOINT_PREFIX)) {
                    msg = msg || Util.tryParse(msgObj.buff.toString('utf8'));
                    if (typeof msg === "undefined") { return readMore(); }
                    // cache the offsets of checkpoints if they can be parsed
                    if (msg[2] === 'MSG' && msg[4].indexOf('cp|') === 0) {
                        cpIndex.push({
                            offset: msgObj.offset,
                            line: i
                        });
                        // we only want to store messages since the latest checkpoint
                        // so clear the buffer every time you see a new one
                        messageBuf = [];
                    }
                } else if (messageBuf.length > 100 && cpIndex.length === 0) {
                    // take the last 50 messages
                    unconventional = true;
                    messageBuf = messageBuf.slice(-50);
                }
                // if it's not metadata or a checkpoint then it should be a regular message
                // store it in the buffer
                messageBuf.push(msgObj);
                return readMore();
            }, w((err) => {
                if (err && err.code !== 'ENOENT') {
                    w.abort();
                    return void CB(err);
                }

                // once indexing is complete you should have a buffer of messages since the latest checkpoint
                // or the 50-100 latest messages if the channel is of a type without checkpoints.
                // map the 'hash' of each message to its byte offset in the log, to be used for reconnecting clients
                messageBuf.forEach((msgObj) => {
                    const msg = Util.tryParse(msgObj.buff.toString('utf8'));
                    if (typeof msg === "undefined") { return; }
                    if (msg[0] === 0 && msg[2] === 'MSG' && typeof (msg[4]) === 'string') {
                        // msgObj.offset is API guaranteed by our storage module
                        // it should always be a valid positive integer
                        offsetByHash[HK.getHash(msg[4])] = msgObj.offset;
                        offsetCount++;
                    }
                    // There is a trailing \n at the end of the file
                    size = msgObj.offset + msgObj.buff.length + 1;
                });
            }));
        }).nThen(function(w) {
            cpIndex = HK.sliceCpIndex(cpIndex, i);

            var new_start;
            if (cpIndex.length) {
                new_start = cpIndex[0].offset;
            } else if (unconventional && messageBuf.length && isValidOffsetNumber(messageBuf[0].offset)) {
                new_start = messageBuf[0].offset;
            }

            if (new_start === start) { return; }
            if (!isValidOffsetNumber(new_start)) { return; }

            // store the offset of the earliest relevant line so that you can start from there next time...
            store.writeOffset(channelName, {
                start: new_start,
                created: +new Date(),
            }, w(function() {
                var diff = new_start - start;
                Env.Log.info('WORKER_OFFSET_UPDATE', {
                    channel: channelName,
                    start: start,
                    startMB: round(start / 1024 / 1024),
                    update: new_start,
                    updateMB: round(new_start / 1024 / 1024),
                    diff: diff,
                    diffMB: round(diff / 1024 / 1024),
                });
            }));
        }).nThen(function() {
            // return the computed index
            CB(null, {
                // Only keep the checkpoints included in the last 100 messages
                cpIndex: cpIndex,
                offsetByHash: offsetByHash,
                offsets: offsetCount,
                size: size,
                //metadata: metadata,
                line: i
            });
        });
    };

    const computeIndex = Env.computeIndex = function(channelName, cb) {
        const CB = Util.once(cb);

        var start = 0;
        nThen(function(w) {
            store.getOffset(channelName, w(function(err, obj) {
                if (err) { return; }
                if (obj && typeof (obj.start) === 'number' && obj.start > 0) {
                    start = obj.start;
                    Env.Log.verbose('WORKER_OFFSET_RECOVERY', {
                        channel: channelName,
                        start: start,
                        startMB: round(start / 1024 / 1024),
                    });
                }
            }));
        }).nThen(function(w) {
            computeIndexFromOffset(channelName, start, w(function(err, index) {
                if (err === 'OFFSET_ERROR') {
                    return Env.Log.error("WORKER_OFFSET_ERROR", {
                        channel: channelName,
                    });
                }
                w.abort();
                CB(err, index);
            }));
        }).nThen(function(w) {
            // if you're here there was an OFFSET_ERROR..
            // first remove the offset that caused the problem to begin with
            store.clearOffset(channelName, w());
        }).nThen(function() {
            // now get the history as though it were the first time
            computeIndexFromOffset(channelName, 0, CB);
        });
    };
};

const getMetadata = function(channelName, _cb) {
    let cb = Util.mkAsync(_cb);
    let metadata = Env.metadata_cache[channelName];
    if (metadata && typeof (metadata) === 'object') {
        return cb(void 0, metadata)
    }

    Meta.getMetadataRaw(Env, channelName, function(err, metadata) {
        if (err) { return cb(err); }
        if (!(metadata && typeof (metadata.channel) === 'string' && metadata.channel.length === HK.STANDARD_CHANNEL_LENGTH)) {
            return cb();
        }

        // cache it
        Env.metadata_cache[channelName] = metadata;
        cb(void 0, metadata);
    });
}

/*  getIndex
calls back with an error if anything goes wrong
or with a cached index for a channel if it exists
(along with metadata)
otherwise it calls back with the index computed by 'computeIndex'

as an added bonus:
if the channel exists but its index does not then it caches the index
*/
const getIndex = (channelName, cb) => {
    const channel_cache = Env.channel_cache;

    const chan = channel_cache[channelName];

    // if there is a channel in memory and it has an index cached, return it
    if (chan && chan.index) {
        // enforce async behaviour
        return void Util.mkAsync(cb)(undefined, chan.index);
    }

    Env.batchIndexReads(channelName, cb, function(done) {
        Env.computeIndex(channelName, (err, ret) => {
            // this is most likely an unrecoverable filesystem error
            if (err) { return void done(err); }
            // cache the computed result if possible
            if (chan) { chan.index = ret; }
            // return
            done(void 0, ret);
        });
    });
};

const getHistoryOffset = (channelName, lastKnownHash, _cb) => {
    const cb = Util.once(Util.mkAsync(_cb));

    // lastKnownhash === -1 means we want the complete history
    if (lastKnownHash === -1) { return void cb(null, 0); }

    let offset = -1;
    nThen((waitFor) => {
        getIndex(channelName, waitFor((err, index) => {
            if (err) { waitFor.abort(); return void cb(err); }

            // check if the "hash" the client is requesting exists in the index
            const lkh = index.offsetByHash[lastKnownHash];

            // lastKnownHash requested but not found in the index
            if (lastKnownHash && typeof (lkh) !== "number") {
                // No checkpoint: may be a non-chainpad channel
                if (!index.cpIndex.length) {
                    return;
                }
                // Hash too old or no longer exists, empty cache
                waitFor.abort();
                return void cb(new Error('EUNKNOWN'));
            }

            // If we have a lastKnownHash or we didn't ask for one, we don't need the next blocks
            waitFor.abort();

            // Since last 2 checkpoints
            if (!lastKnownHash) {
                // Less than 2 checkpoints in the history: return everything
                if (index.cpIndex.length < 2) { return void cb(null, 0); }
                // Otherwise return the second last checkpoint's index
                return void cb(null, index.cpIndex[0].offset);
                /* LATER...
                    in practice, two checkpoints can be very close together
                we have measures to avoid duplicate checkpoints, but editors
                can produce nearby checkpoints which are slightly different,
                    and slip past these protections. To be really careful, we can
                seek past nearby checkpoints by some number of patches so as
                to ensure that all editors have sufficient knowledge of history
                to reconcile their differences. */
            }

            // If our lastKnownHash is older than the 2nd to last checkpoint, send
            // EUNKNOWN to tell the user to empty their cache
            if (lkh && index.cpIndex.length >= 2 && lkh < index.cpIndex[0].offset) {
                waitFor.abort();
                return void cb(new Error('EUNKNOWN'));
            }

            // Otherwise use our lastKnownHash
            cb(null, lkh);
        }));
    }).nThen((w) => {
        // If we're here it means we asked for a lastKnownHash but it is old (not in the index)
        // and this is not a "chainpad" channel so we can't recover from a checkpoint.

        // skip past this block if the offset is anything other than -1
        // this basically makes these first two nThen blocks behave like if-else
        if (offset !== -1) { return; }

        // either the message exists in history but is not in the cached index
        // or it does not exist at all. In either case 'getHashOffset' is expected
        // to return a number: -1 if not present, positive interger otherwise
        Env.getHashOffset(channelName, lastKnownHash, w(function(err, _offset) {
            if (err) {
                w.abort();
                return void cb(err);
            }
            offset = _offset;
        }));
    }).nThen(() => {
        cb(null, offset);
    });
};

const getHistoryAsync = (channelName, lastKnownHash, beforeHash, handler, cb) => {
    const store = Env.store;

    let offset = -1;
    nThen((waitFor) => {
        getHistoryOffset(channelName, lastKnownHash, waitFor((err, os) => {
            if (err) {
                waitFor.abort();
                var reason;
                if (err && err.reason) {
                    reason = err.reason;
                    err = err.error;
                }
                return void cb(err, reason);
            }
            offset = os;
        }));
    }).nThen((waitFor) => {
        if (offset === -1) {
            return void cb(new Error('EUNKNOWN'));
        }
        const start = (beforeHash) ? 0 : offset;
        store.readMessagesBin(channelName, start, (msgObj, readMore, abort) => {
            if (beforeHash && msgObj.offset >= offset) { return void abort(); }
            const parsed = Util.tryParse(msgObj.buff.toString('utf8'));
            if (!parsed) { return void readMore(); }
            handler(parsed, readMore);
        }, waitFor(function(err, reason) {
            return void cb(err, reason);
        }));
    });
};

/*
    This is called when a user tries to connect to a channel that doesn't exist.
    we initialize that channel by writing the metadata supplied by the user to its log.
    if the provided metadata has an expire time then we also create a task to expire it.
    */
const handleFirstMessage = function(Env, channelName, metadata) {
    if (metadata.selfdestruct) {
        // Set the selfdestruct flag to history keeper ID to handle server crash.
        metadata.selfdestruct = Env.id;
    }
    delete metadata.forcePlaceholder;
    Env.store.writeMetadata(channelName, JSON.stringify(metadata), function(err) {
        if (err) {
            // FIXME tell the user that there was a channel error?
            return void console.error('HK_WRITE_METADATA', {
                channel: channelName,
                error: err,
            });
        }
    });

    // XXX: Not handling EXPIRE yet
    // write tasks
    // var maxExpire = new Date().setMonth(new Date().getMonth() + 100); // UI limit
    // if(metadata.expire && typeof(metadata.expire) === 'number' && metadata.expire < maxExpire) {
    //     // the fun part...
    //     // the user has said they want this pad to expire at some point
    //     Env.writeTask(metadata.expire, "EXPIRE", [ channelName ], function (err) {
    //         if (err) {
    //             // if there is an error, we don't want to crash the whole server...
    //             // just log it, and if there's a problem you'll be able to fix it
    //             // at a later date with the provided information
    //             Env.Log.error('HK_CREATE_EXPIRE_TASK', err);
    //             Env.Log.info('HK_INVALID_EXPIRE_TASK', JSON.stringify([metadata.expire, 'EXPIRE', channelName]));
    //         }
    //     });
    // }
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
        getMetadata(channelName, w(function(err, metadata) {
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
        getHistoryAsync(channelName, lastKnownHash, false, (msg, readMore) => {
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
                        handleFirstMessage(Env, channelName, metadata);
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

let getHistoryHandler = function(args, cb) {
    onGetHistory(args.seq, args.userId, args.parsed, cb);
}

let getMetaDataHandler = function(args, cb) {
    getMetadata(args.channelName, cb);
}

/* Start of the node */

// Create a store
Store.create({
    filePath: './data/channel',
    archivePath: './data/archive',
    volumeId: 'channel'
}, function(err, _store) {
    if (err) { console.error('Error:', err); }
    Env.store = _store;
    init(_store);
});

// List accepted commands
let COMMANDS = {
    'GET_HISTORY': getHistoryHandler,
    'GET_METADATA': getMetaDataHandler,
};

// Connect to core
let start = function() {
    Config.myId = 'storage:0';
    let interface = Env.interface = Interface.connect(Config);
    interface.handleCommands(COMMANDS);
};

start();
