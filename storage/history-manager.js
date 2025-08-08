// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Util = require("./common-util.js");
const nThen = require("nthen");
const Meta = require("./commands/metadata.js");
const Constants = require("../common/constants");

const {
    STANDARD_CHANNEL_LENGTH
} = Constants;
let HistoryManager = {};

HistoryManager.getMetadata = function(Env, channel, _cb) {
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

HistoryManager.getHistoryAsync = (Env, channel, lastKnownHash, beforeHash, handler, cb) => {
    let offset = -1;
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
HistoryManager.handleFirstMessage = function(Env, channel, metadata) {
    if (metadata.selfdestruct) {
        // Set the selfdestruct flag to history keeper ID to handle server crash.
        metadata.selfdestruct = Env.id;
    }
    delete metadata.forcePlaceholder;
    Env.store.writeMetadata(channel, JSON.stringify(metadata), function(err) {
        if (err) {
            // FIXME tell the user that there was a channel error?
            return void console.error('HK_WRITE_METADATA', {
                channel: channel,
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

module.exports = HistoryManager;
