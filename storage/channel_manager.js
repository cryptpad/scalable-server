// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Util = require("./common-util.js");
const nThen = require("nthen");
const HK = require("./hk-util.js");

const create = (Env) => {
    let CM = {};
    const store = Env.store;

    CM.getHashOffset = function(channel, hash, cb) {
        if (typeof (hash) !== 'string') { return void cb("INVALID_HASH"); }

        var offset = -1;
        store.readMessagesBin(channel, 0, (msgObj, readMore, abort) => {
            // tryParse return a parsed message or undefined
            const msg = Util.tryParse(Env, msgObj.buff.toString('utf8'));
            // if it was undefined then go onto the next message
            if (typeof msg === "undefined") { return readMore(); }
            if (typeof (msg[4]) !== 'string' || hash !== HK.getHash(msg[4])) {
                return void readMore();
            }
            offset = msgObj.offset;
            abort();
        }, function(err, reason) {
            if (err) {
                return void cb({
                    error: err,
                    reason: reason
                });
            }
            cb(void 0, offset);
        });
    };

    CM.storeMessage = function(channel, msg, isCp, optionalMessageHash, time, cb) {
        // TODO: check why channel.id disappears in the middle
        const Log = Env.log;
        if (typeof (cb) !== "function") { cb = function() { }; }

        Env.queueStorage(channel, next => {
            const msgBin = Buffer.from(msg + '\n', 'utf8');
            // Store the message first, and update the index only once it's stored.
            // store.messageBin can be async so updating the index first may
            // result in a wrong cpIndex
            nThen(waitFor => {
                store.messageBin(channel, msgBin, waitFor(function(err) {
                    if (err) {
                        waitFor.abort();
                        Env.Log.error("HK_STORE_MESSAGE_ERROR", err.message);

                        // this error is critical, but there's not much we can do at the moment
                        // proceed with more messages, but they'll probably fail too
                        // at least you won't have a memory leak

                        // TODO make it possible to respond to clients with errors so they know
                        // their message wasn't stored
                        cb(err);
                        return void next();
                    }
                }));
            }).nThen(waitFor => {
                getIndex(Env, channel, waitFor((err, index) => {
                    if (err) {
                        Log.warn("HK_STORE_MESSAGE_INDEX", err.stack);
                        // non-critical, we'll be able to get the channel index later
                        // cb with no error so that the message is broadcast
                        cb();
                        return void next();
                    }

                    if (optionalMessageHash && typeof (index.offsetByHash[optionalMessageHash]) === 'number') {
                        cb();
                        return void next();
                    }

                    if (typeof (index.line) === "number") { index.line++; }
                    if (isCp) {
                        index.cpIndex = HK.sliceCpIndex(index.cpIndex, index.line || 0);
                        HK.trimMapByOffset(index.offsetByHash, index.cpIndex[0]);
                        index.cpIndex.push({
                            offset: index.size,
                            line: ((index.line || 0) + 1)
                        });
                    }
                    /*  This 'getIndex' call will construct a new index if one does not already exist.
                        If that is the case then our message will already be present and updating our offset map
                    can actually cause it to become incorrect, leading to incorrect behaviour when clients connect
                    with a lastKnownHash. We avoid this by only assigning new offsets to the map.
                        */
                    if (optionalMessageHash /* && typeof(index.offsetByHash[optionalMessageHash]) === 'undefined' */) {
                        index.offsetByHash[optionalMessageHash] = index.size;
                        index.offsets++;
                    }
                    if (index.offsets >= 100 && !index.cpIndex.length) {
                        let offsetCount = HK.checkOffsetMap(index.offsetByHash);
                        if (offsetCount < 0) {
                            Log.warn('OFFSET_TRIM_OOO', {
                                channel,
                                map: index.offsetByHash
                            });
                        } else if (offsetCount > 0) {
                            HK.trimOffsetByOrder(index.offsetByHash, index.offsets);
                            index.offsets = HK.checkOffsetMap(index.offsetByHash);
                        }
                    }

                    // Message stored, call back
                    cb(void 0, time);

                    var msgLength = msgBin.length;
                    index.size += msgLength;

                    // handle the next element in the queue
                    next();
                    // TODO: call Env.incrementBytesWritten for metrics
                }));
            });
        });
    };

    /*  getIndex
    calls back with an error if anything goes wrong
    or with a cached index for a channel if it exists
    (along with metadata)
    otherwise it calls back with the index computed by 'computeIndex'

    as an added bonus:
    if the channel exists but its index does not then it caches the index
    */
    let getIndex = CM.getIndex = (Env, channelName, cb) => {
        const channel_cache = Env.channel_cache;
        const chan = channel_cache[channelName];

        // if there is a channel in memory and it has an index cached, return it
        if (chan && chan.index) {
            // enforce async behaviour
            return void Util.mkAsync(cb)(undefined, chan.index);
        }

        Env.batchIndexReads(channelName, cb, function(done) {
            Env.worker.computeIndex(channelName, (err, ret) => {
                // this is most likely an unrecoverable filesystem error
                if (err) { return void done(err); }
                // cache the computed result if possible
                if (chan) { chan.index = ret; }
                // return
                done(void 0, ret);
            });
        });
    };

    return CM;
};

module.exports = { create };
