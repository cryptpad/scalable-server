// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Util = require("./common-util.js");
const nThen = require("nthen");
const HKUtil = require("./hk-util.js");
const HistoryManager = require("./history-manager.js");

const {
    CHECKPOINT_PATTERN,
    EPHEMERAL_CHANNEL_LENGTH,
    ADMIN_CHANNEL_LENGTH
} = require("../common/constants.js");

const create = (Env) => {
    let CM = {};
    const store = Env.store;

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
                        index.cpIndex = HKUtil.sliceCpIndex(index.cpIndex, index.line || 0);
                        HKUtil.trimMapByOffset(index.offsetByHash, index.cpIndex[0]);
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
                        let offsetCount = HKUtil.checkOffsetMap(index.offsetByHash);
                        if (offsetCount < 0) {
                            Log.warn('OFFSET_TRIM_OOO', {
                                channel,
                                map: index.offsetByHash
                            });
                        } else if (offsetCount > 0) {
                            HKUtil.trimOffsetByOrder(index.offsetByHash, index.offsets);
                            index.offsets = HKUtil.checkOffsetMap(index.offsetByHash);
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

    CM.onChannelMessage = (args, cb) => {
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
                const coreId = Env.getCoreId(channel);
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

    CM.removeChannel = (Env, channel) => {
        if (!Env.store) { return; }
        Env.store.archiveChannel(channel, void 0, () => {});
        delete Env.metadata_cache[channel];
        delete Env.channel_cache[channel];
    };

    return CM;
};

module.exports = { create };
