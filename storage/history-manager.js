// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Util = require("./common-util.js");
const HKUtil = require("./hk-util.js");
const nThen = require("nthen");
const Meta = require("./commands/metadata.js");
const Constants = require("../common/constants");

const {
    STANDARD_CHANNEL_LENGTH,
    hkId
} = Constants;

const HISTORY_KEEPER_ID = hkId;
const ONE_DAY = 1000 * 60 * 60 * 24; // one day in milliseconds

const HistoryManager = {};

const getMetadata = HistoryManager.getMetadata = (Env, channel, _cb) => {
    let cb = Util.mkAsync(_cb);
    let metadata = Env.metadata_cache[channel];
    if (metadata && typeof (metadata) === 'object') {
        return cb(void 0, metadata)
    }

    Meta.getMetadataRaw(Env, channel, function(err, metadata) {
        if (err) { return cb(err); }
        if (!(metadata && typeof (metadata.channel) === 'string'
        && metadata.channel.length === STANDARD_CHANNEL_LENGTH)) {
            return cb();
        }

        // cache it
        Env.metadata_cache[channel] = metadata;
        cb(void 0, metadata);
    });
}

const getHistoryOffset = (Env, channel, lastKnownHash, _cb) => {
    const cb = Util.once(Util.mkAsync(_cb));

    // lastKnownhash === -1 means we want the complete history
    if (lastKnownHash === -1) { return void cb(null, 0); }

    let offset = -1;
    nThen((waitFor) => {
        Env.CM.getIndex(Env, channel, waitFor((err, index) => {
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
        Env.worker.getHashOffset(channel, lastKnownHash, w(function(err, _offset) {
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

const getHistoryAsync = HistoryManager.getHistoryAsync = (Env, channel, lastKnownHash, beforeHash, handler, cb) => {
    let offset = -1;
    //Env.plugins?.MONITORING?.increment(`getHistoryAsync`); // XXX MONITORING
    nThen((waitFor) => {
        getHistoryOffset(Env, channel, lastKnownHash, waitFor((err, os) => {
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
        Env.store.readMessagesBin(channel, start, (msgObj, readMore, abort) => {
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
const handleFirstMessage = (Env, channel, metadata) => {
    if (metadata.selfdestruct) {
        // Set the selfdestruct flag to history keeper ID to handle server crash.
        metadata.selfdestruct = Env.id;
    }
    delete metadata.forcePlaceholder;
    Env.store.writeMetadata(channel, JSON.stringify(metadata), function (err) {
        if (err) {
            // FIXME tell the user that there was a channel error?
            return void Env.Log.error('HK_WRITE_METADATA', {
                channel, error: err
            });
        }
    });

    // XXX: Not handling EXPIRE yet
    // write tasks
    // var maxExpire = new Date().setMonth(new Date().getMonth() + 100); // UI limit
    // if(metadata.expire && typeof(metadata.expire) === 'number' && metadata.expire < maxExpire) {
    //     // the fun part...
    //     // the user has said they want this pad to expire at some point
    //     Env.writeTask(metadata.expire, "EXPIRE", [ channel ], function (err) {
    //         if (err) {
    //             // if there is an error, we don't want to crash the whole server...
    //             // just log it, and if there's a problem you'll be able to fix it
    //             // at a later date with the provided information
    //             Env.Log.error('HK_CREATE_EXPIRE_TASK', err);
    //             Env.Log.info('HK_INVALID_EXPIRE_TASK', JSON.stringify([metadata.expire, 'EXPIRE', channel]));
    //         }
    //     });
    // }
};

const expireChannel = (Env, channel) => {
    return void Env.store.archiveChannel(channel, 'EXPIRED', err => {
        Env.Log.info("ARCHIVAL_CHANNEL_BY_HISTORY_KEEPER_EXPIRATION", {
            channel: channel,
            status: err? String(err): "SUCCESS",
        });
    });
};
const checkExpired = (Env, channel) => {
    const metadata_cache = Env.metadata_cache;

    if (!(channel && channel.length === STANDARD_CHANNEL_LENGTH)) {
        return false;
    }

    let metadata = metadata_cache[channel];
    if (!(metadata && typeof(metadata.expire) === 'number')) {
        return false;
    }

    // the number of milliseconds ago the channel should have expired
    let pastDue = (+new Date()) - metadata.expire;

    // less than zero means that it hasn't expired yet
    if (pastDue < 0) { return false; }

    // if it should have expired more than a day ago...
    // there may have been a problem with scheduling tasks
    // or the scheduled tasks may not be running
    // so trigger a removal from here
    if (pastDue >= ONE_DAY) { expireChannel(Env, channel); }

    // close the channel
    Env.store.closeChannel(channel, function () {
        Env.onExpiredChannel(channel);
    });

    // return true to indicate that it has expired
    return true;
};

HistoryManager.onGetHistory = (Env, args, sendMessage, _cb) => {
    const cb = Util.once(_cb);
    const { seq, userId, parsed } = args;
    const metadata_cache = Env.metadata_cache;
    const Log = Env.Log;

    let channel = parsed[1];
    let config = parsed[2];
    let metadata = {};
    let lastKnownHash;
    let txid;
    let priority;

    // Clients can optionally pass a map of attributes.
    // If the channel already exists this map will be ignored,
    // otherwise it will be stored as the initial metadata state
    if (config && typeof config === "object" && !Array.isArray(parsed[2])) {
        lastKnownHash = config.lastKnownHash;
        metadata = config.metadata || {};
        txid = config.txid;
        priority = config.priority;
        if (metadata.expire) {
            metadata.expire = +metadata.expire * 1000 + (+new Date());
        }
    }
    metadata.channel = channel;
    metadata.created = +new Date();

    // If the user sends us an invalid key, we won't be able to
    // validate their messages later on. We can abort here.
    if (metadata.validateKey && !HKUtil.isValidValidateKeyString(metadata.validateKey)) {
        cb(void 0, [seq, 'ERROR', 'HK_INVALID_KEY']);
        return void Log.error('HK_INVALID_KEY', metadata.validateKey);
    }
    cb(void 0, [seq, 'ACK']);

    nThen(function (waitFor) {
        /*  fetch the channel's metadata.
            use it to check if the channel has expired.
            send it to the client if it exists.
        */
        getMetadata(Env, channel, waitFor((err, metadata) => {
            if (err) {
                return void Log.error('HK_GET_HISTORY_METADATA', {
                    channel: channel,
                    error: err,
                });
            }

            // No metadata? no need to check if has expired
            // and nothing to send
            if (!metadata?.channel) { return; }

            // Expired? abort
            // NOTE: checkExpired has side effects (bcast, archive)
            if (checkExpired(Env, channel)) {
                return void waitFor.abort();
            }

            // Send metadata as first HISTORY message
            sendMessage([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(metadata), priority], waitFor());
        }));
    }).nThen(() => {
        let msgCount = 0;

        // Get history from lastKnownHash
        getHistoryAsync(Env, channel, lastKnownHash, false, (msg, readMore) => {
            msgCount++;
            // avoid sending the metadata message a second time
            if (HKUtil.isMetadataMessage(msg) && metadata_cache[channel]) {
                return readMore();
            }
            if (txid) { msg[0] = txid; }
            sendMessage([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(msg), priority], readMore);
        }, (err, reason) => {
            // Any error but ENOENT: abort
            // ENOENT is allowed in case we want to create a new pad
            if (err && err.error) { err = err.error; }
            if (err && err.code !== 'ENOENT') {
                if (err.message === "EUNKNOWN") {
                    Log.error("HK_GET_HISTORY", {
                        channel, lastKnownHash, userId,
                        err: err?.message || err,
                    });
                } else if (err.message !== 'EINVAL') {
                    Log.error("HK_GET_HISTORY", {
                        channel,
                        err: err?.message || err,
                        stack: err?.stack,
                    });
                }
                // FIXME err.message isn't useful for users
                const parsedMsg = {
                    error: err.message || 'ERROR', channel, txid
                };
                return sendMessage([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(parsedMsg), priority]);
            }
            // ENOENT and reason: file was deleted, prevent user
            // from creating a new file with the same id
            // NOTE: allowed if "forcePlaceholder" is true
            if (err?.code === 'ENOENT' && reason
            && !metadata.forcePlaceholder) {
                const parsedMsg2 = {
                    error:'EDELETED', message: reason, channel, txid
                };
                return sendMessage([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(parsedMsg2), priority]);
            }

            // If we're asking for a specific version (lastKnownHash)
            // but we receive an ENOENT, this is not a pad creation
            // so we need to abort.
            if (err && err.code === 'ENOENT' && lastKnownHash) {
                const parsedMsg2 = {
                    error:'EDELETED', channel, txid
                };
                return sendMessage([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(parsedMsg2), priority]);
            }

            // Channel is empty, no placeholder, no lastKnownHash.
            // This is a pad creation: write the metadata and send
            // them to the user
            if (msgCount === 0 && !metadata_cache[channel]
            && Env.channelContainsUser(channel, userId)) {
                handleFirstMessage(Env, channel, metadata);
                sendMessage([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(metadata), priority]);
            }

            // End of history message:
            const parsedMsg = {
                state: 1, channel, txid
            };

            sendMessage([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(parsedMsg), priority]);
        });
    });
};

HistoryManager.onGetHistoryRange = (Env, args, sendMessage, _cb) => {
    const cb = Util.once(_cb);
    const { seq, userId, parsed } = args;
    const Log = Env.Log;
    const store = Env.store;

    const channel = parsed[1];
    const map = parsed[2]

    if (!(map && typeof(map) === 'object')) {
        return void cb(void 0, [seq, 'ERROR', 'INVALID_ARGS', HISTORY_KEEPER_ID]);
    }

    const oldestKnownHash = map.from; // last known hash
    const untilHash = map.to; // oldest hash (unknown), start point if defined
    const desiredMessages = map.count; // nb messages before lkh
    const desiredCheckpoint = map.cpCount; // nb cp before lkh
    const txid = map.txid;

    if (typeof(desiredMessages) !== 'number'
    && typeof(desiredCheckpoint) !== 'number'
    && !untilHash) {
        return void cb(void 0, [seq, 'ERROR', 'UNSPECIFIED_COUNT', HISTORY_KEEPER_ID]);
    }

    if (!txid) {
        return void cb(void 0, [seq, 'ERROR', 'NO_TXID', HISTORY_KEEPER_ID]);
    }

    cb(void 0, [seq, 'ACK']);

    if (untilHash) {
        // Get all messages from untilHash (oldest but unknown)
        // to oldestKnownHash (or until the end if undefined)
        // Messages can be streamed since we instantly know the start point
        let found = false;
        store.readMessagesBin(channel, 0, (msgObj, readMore, abort) => {
            const parsed = Util.tryParse(msgObj.buff.toString('utf8'));
            if (!parsed) { return void readMore(); }
            if (HKUtil.isMetadataMessage(parsed)) {
                return void readMore();
            }

            const content = parsed[4];
            if (typeof(content) !== 'string') {
                return void readMore();
            }

            const hash = HKUtil.getHash(content);
            if (hash === untilHash || untilHash === 'NONE') {
                found = true;
            }
            let then = hash === oldestKnownHash ? abort : readMore;
            if (found) {
                sendMessage([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(['HISTORY_RANGE', txid, parsed])], then);
            } else {
                return void readMore();
            }
        }, function (err, reason) {
            if (err) {
                Log.error("HK_GET_OLDER_HISTORY", channel, err, reason);
                return sendMessage([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(['HISTORY_RANGE_ERROR', txid, err]) ]);
            }
            sendMessage([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(['HISTORY_RANGE_END', txid, channel]) ]);
        });
        return;
    }
    // If desiredCp or desiredMsg are defined, we can't stream and
    // must get a list of messages to send from a worker
    Env.worker.getOlderHistory(channel, oldestKnownHash, untilHash, desiredMessages, desiredCheckpoint, function (err, toSend) {
        if (err && err.code !== 'ENOENT') {
            Log.error("HK_GET_OLDER_HISTORY", err);
            return sendMessage([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(['HISTORY_RANGE_ERROR', txid, err]) ]);
        }

        if (Array.isArray(toSend)) {
            toSend.forEach(function (msg) {
                sendMessage([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(['HISTORY_RANGE', txid, msg])]); });
        }

        sendMessage([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(['HISTORY_RANGE_END', txid, channel]) ]);
    });
};

HistoryManager.onGetFullHistory = (Env, args, sendMessage, _cb) => {
    const cb = Util.once(_cb);
    const { seq, userId, parsed } = args;
    const Log = Env.Log;

    // parsed[1] is the channel id
    // parsed[2] is a validation key (optional)
    // parsed[3] is the last known hash (optional)
    const channel = parsed[1];
    cb(void 0, [seq, 'ACK']);

    getHistoryAsync(Env, channel, -1, false, (msg, readMore) => {
        sendMessage([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(['FULL_HISTORY', msg])], readMore);
    }, (err) => {
        let parsedMsg = ['FULL_HISTORY_END', channel];
        if (err) {
            Log.error('HK_GET_FULL_HISTORY', err.stack);
            parsedMsg = ['ERROR', channel, err.message];
        }
        sendMessage([0, HISTORY_KEEPER_ID, 'MSG', userId, JSON.stringify(parsedMsg)]);
    });
};

module.exports = HistoryManager;
