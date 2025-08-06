// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const File = require("./storage/file.js");
const Util = require("./common-util.js");
const nThen = require("nthen");
const HK = require("./hk-util.js");

const create = (Env, basedir) => {
    let CM = {};

    const OPEN_CURLY_BRACE = Buffer.from('{');
    const CHECKPOINT_PREFIX = Buffer.from('cp|');
    const isValidOffsetNumber = function(n) {
        return typeof (n) === 'number' && n >= 0;
    };

    File.create({
        filePath: basedir + '/channel',
        archivePath: basedir + '/archive',
        volumeId: 'channel'
    }, (err, store) => {
        if (err) { console.error('Error in channel creation:', err); }

        // Expose only necessary functions
        CM.readChannelMetadata = store.readChannelMetadata;
        CM.readMessagesBin = store.readMessagesBin;
        CM.writeMetadata = store.writeMetadata;

        let computeIndexFromOffset = function(channelName, offset, cb) {
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
                        startMB: Util.round(start / 1024 / 1024),
                        update: new_start,
                        updateMB: Util.round(new_start / 1024 / 1024),
                        diff: diff,
                        diffMB: Util.round(diff / 1024 / 1024),
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

        let computeIndex = function(channelName, cb) {
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
                            startMB: Util.round(start / 1024 / 1024),
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
                computeIndex(channelName, (err, ret) => {
                    // this is most likely an unrecoverable filesystem error
                    if (err) { return void done(err); }
                    // cache the computed result if possible
                    if (chan) { chan.index = ret; }
                    // return
                    done(void 0, ret);
                });
            });
        };
    });

    return CM;
};

module.exports = { create };
