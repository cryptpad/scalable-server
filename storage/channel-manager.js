// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Util = require("./common-util.js");
const nThen = require("nthen");
const HKUtil = require("./hk-util.js");
const HistoryManager = require("./history-manager.js");
const Core = require("../common/core.js");
const Meta = require("./commands/metadata.js");
const Nacl = require("tweetnacl/nacl-fast");

const {
    hkId,
    CHECKPOINT_PATTERN,
    EPHEMERAL_CHANNEL_LENGTH,
    STANDARD_CHANNEL_LENGTH,
    ADMIN_CHANNEL_LENGTH
} = require("../common/constants.js");

const create = (Env) => {
    let CM = {};
    const store = Env.store;

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

    const storeMessage = function(channel, msg, isCp, optionalMessageHash, time, cb) {
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

    CM.onChannelMessage = (args, cb) => {
        const { channel, msgStruct, validated } = args;
        const isCp = /^cp\|/.test(msgStruct[4]);
        const channelData = Env.channel_cache[channel] || {};

        if (channel.length === EPHEMERAL_CHANNEL_LENGTH) {
            // XXX
            return void cb(void 0, {
                users: channelData.users || [],
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

                if (HistoryManager.checkExpired(Env, channel)) {
                    cb('EEXPIRED');
                    return void w.abort();
                }
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

                    cb('FAILED_VALIDATION');
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
            storeMessage(channel, JSON.stringify(msgStruct), isCp, HKUtil.getHash(msgStruct[4], Env.Log), time, err => {
                if (err) { return void cb(err); }
                cb(void 0, {
                    users: channelData.users || [],
                    message: msgStruct
                });
            });
        });
    };

    CM.removeChannel = (Env, channel) => {
        if (!Env.store) { return; }
        Env.store.archiveChannel(channel, void 0, () => {});
        delete Env.metadata_cache[channel];
        delete Env.channel_cache[channel];
    };

    const ARRAY_LINE = /^\[/;
    CM.isNewChannel = (Env, channel, _cb) => {
        const cb = Util.once(_cb);
        if (!Core.isValidId(channel)) { return void cb('INVALID_CHAN'); }
        if (channel.length !== STANDARD_CHANNEL_LENGTH &&
            channel.length !== ADMIN_CHANNEL_LENGTH) { return void cb('INVALID_CHAN'); }

        Env.store.readMessagesBin(channel, 0,
                                    (msgObj, readMore, abort) => {
            try {
                let msg = msgObj.buff.toString('utf8');
                if (typeof(msg) === 'string' && ARRAY_LINE.test(msg)){
                    abort();
                    return void cb(void 0, {isNew: false});
                }
            } catch (e) {
                Env.Log.warn('invalid message read from store', e);
            }
            readMore();
        }, (err, reason) => {
            // no more messages...
            cb(void 0, {
                isNew: true,
                reason: reason
            });
        });
    };

    /*  writePrivateMessage
        allows users to anonymously send a message to the channel
        prevents their netflux-id from being stored in history
        and from being broadcast to anyone that might currently
        be in the channel

        Otherwise behaves the same as sending to a channel
    */
    CM.writePrivateMessage = (Env, data, _cb) => {
        const cb = Util.once(Util.mkAsync(_cb));

        const { args, userId } = data;
        const channel = args[0];
        const msg = args[1];

        // don't bother handling empty messages
        if (!msg) { return void cb("INVALID_MESSAGE"); }

        // don't support anything except regular channels
        if (!Core.isValidId(channel) ||
            (channel.length !== STANDARD_CHANNEL_LENGTH
                && channel.length !== ADMIN_CHANNEL_LENGTH)) {
            return void cb("INVALID_CHAN");
        }

        nThen(w => {
            Meta.getMetadataRaw(Env, channel, w((err, metadata) => {
                if (err) {
                    w.abort();
                    Env.Log.error('HK_WRITE_PRIVATE_MESSAGE', err);
                    return void cb('METADATA_ERR');
                }

                // treat the broadcast channel as write-protected
                if (channel.length === ADMIN_CHANNEL_LENGTH) {
                    metadata.restricted = true;
                }

                if (!metadata || !metadata.restricted) {
                    return;
                }

                const allowed = HKUtil.listAllowedUsers(metadata);

                const check = (authKeys) => {
                    if (HKUtil.isUserSessionAllowed(allowed, authKeys)) {
                        return;
                    }

                    w.abort();
                    cb('INSUFFICIENT_PERMISSIONS');
                };

                const coreRpc = Env.getCoreId(userId);
                Env.interface.sendQuery(coreRpc, 'GET_AUTH_KEYS', {
                    userId
                }, w(res => {
                    check(res?.data || {});
                }));
            }));
        }).nThen(() => {
            // construct a message to store and broadcast
            const fullMessage = [
                0, // idk
                null, // normally the netflux id, null isn't rejected, and it distinguishes messages written in this way
                "MSG", // indicate that this is a MSG
                channel, // channel id
                msg // the actual message content. Generally a string
            ];


            // historyKeeper already knows how to handle metadata and message validation, so we just pass it off here
            // if the message isn't valid it won't be stored.
            CM.onChannelMessage({
                channel,
                msgStruct: fullMessage
            }, (err, res) => {
                if (err) {
                    // Message not stored...
                    return void cb(err);
                }

                if (!res) {
                    // Duplicate checkpoint: callback without sending new messages to others
                    return void cb(void 0, +new Date());
                }

                const { /*users,*/ message } = res;
                const time = message[message.length - 1];

                const coreId = Env.getCoreId(channel);
                Env.interface.sendEvent(coreId, 'SEND_CHANNEL_MESSAGE', res);

                cb(void 0, time);
            });


        });
    };

    // Delete a signed mailbox message. This is used when users want
    // to delete their form reponses.
    CM.deleteMailboxMessage = (Env, data, cb) => {
        const channel = data.channel;
        const hash = data.hash;
        const proof = data.proof;
        let nonce, proofBytes;
        try {
            nonce = Util.decodeBase64(proof.split('|')[0]);
            proofBytes = Util.decodeBase64(proof.split('|')[1]);
        } catch (e) {
            return void cb('EINVAL');
        }

        const mySecret64 = Env?.curveKeys?.curvePrivate;
        if (!mySecret64) { return void cb('E_NO_KEY'); }
        const mySecret = Util.decodeBase64(mySecret64);

        Env.store.deleteChannelLine(channel, hash, (msg) => {
            // Check if you're allowed to delete this hash
            try {
                const msgBytes = Util.decodeBase64(msg).subarray(64); // Remove signature
                const theirPublic = msgBytes.subarray(24,56); // 0-24 = nonce; 24-56=publickey (32 bytes)
                const hashBytes = Nacl.box.open(proofBytes, nonce, theirPublic, mySecret);
                return Util.encodeUTF8(hashBytes) === hash;
            } catch (e) {
                Env.Log.error('ERROR_DELETE_MAILBOX_MSG', e);
                return false;
            }
        }, err => {
            if (err) { return void cb(err); }
            Env.store.closeChannel(channel, function() { });
            cb();
            delete Env.channel_cache[channel];
            delete Env.metadata_cache[channel];
        });
    };

    CM.clearOwnedChannel = (Env, data, cb) => {
        const { channel, safeKey } = data;
        if (typeof(channel) !== 'string' || channel.length !== STANDARD_CHANNEL_LENGTH) {
            return cb('INVALID_ARGUMENTS');
        }
        const unsafeKey = Util.unescapeKeyCharacters(safeKey);

        HistoryManager.getMetadata(Env, channel, (err, metadata) => {
            if (err) { return void cb(err); }
            // Check ownership
            if (!Core.hasOwners(metadata)) {
                return void cb('E_NO_OWNERS');
            }
            if (!Core.isOwner(metadata, unsafeKey)) {
                return void cb('INSUFFICIENT_PERMISSIONS');
            }
            return void store.clearChannel(channel, (e) => {
                if (e) { return void cb(e); }
                cb();

                const channel_cache = Env.channel_cache || {};

                const clear = function () {
                    // delete the channel cache (invalidated)
                    if (!channel_cache[channel]?.index) { return; }
                    delete channel_cache[channel].index;
                };

                // Warn members about cleared status
                const channelData = channel_cache[channel] || {};
                const users = channelData.users || [];
                const message = [
                    0,
                    hkId,
                    'MSG',
                    null,
                    JSON.stringify({
                        error: 'ECLEARED',
                        channel
                    })
                ];

                nThen(w => {
                    const coreId = Env.getCoreId(channel);
                    Env.interface.sendQuery(coreId,
                        'HISTORY_CHANNEL_MESSAGE', {
                        users,
                        message
                    }, w());
                }).nThen(() => {
                    clear();
                }).orTimeout(() => {
                    Env.Log.warn("CHANNEL_CLEARED_TIMEOUT", channel);
                    clear();
                }, 30000);
            });
        });
    };

    CM.disconnectChannelMembers = (Env, channel, code, reason, cb) => {
        const done = Util.once(Util.mkAsync(cb));
        if (!Core.isValidId(channel)) { return done('INVALID_ID'); }

        const channel_cache = Env.channel_cache;
        const metadata_cache = Env.metadata_cache;

        const coreId = Env.getCoreId(channel);
        const clear = () => {
            delete channel_cache[channel];
            Env.interface.sendEvent(coreId, 'DROP_CHANNEL', { channel });
            delete metadata_cache[channel];
        };


        // an owner of a channel deleted it
        nThen(function (w) {
            // close the channel in the store
            store.closeChannel(channel, w());
        }).nThen((w) => {
            const channelData = channel_cache[channel] || {};
            const users = channelData.users || [];
            const message = [
                0,
                hkId,
                'MSG',
                null,
                JSON.stringify({
                    error: code, //'EDELETED',
                    message: reason,
                    channel
                })
            ];
            Env.interface.sendQuery(coreId,
                'HISTORY_CHANNEL_MESSAGE', {
                users,
                message
            }, w());
        }).nThen(function () {
            // clear the channel's data from memory
            // once you've sent everyone a notice that the channel has been deleted
            clear();
            done();
        }).orTimeout(function () {
            Env.Log.warn('DISCONNECT_CHANNEL_MEMBERS_TIMEOUT', {
                channel,
                code,
                reason
            });
            clear();
            done();
        }, 30000);
    };

    const archiveOwnedChannel = (Env, safeKey, channel, reason, __cb) => {
        const _cb = Util.once(Util.mkAsync(__cb));
        const unsafeKey = Util.unescapeKeyCharacters(safeKey);
        reason = reason || 'ARCHIVE_OWNED';
        nThen((w) => {
            // confirm that the channel exists before worrying about whether
            // we have permission to delete it.
            const cb = _cb;
            store.getChannelSize(channel, w((err, bytes) => {
                if (!bytes) {
                    w.abort();
                    return cb(err || "ENOENT");
                }
            }));
        }).nThen((w) => {
            const cb = Util.both(w.abort, _cb);
            HistoryManager.getMetadata(Env, channel, w((err, metadata) => {
                if (err) { return void cb(err); }
                if (!Core.hasOwners(metadata)) { return void cb('E_NO_OWNERS'); }
                if (!Core.isOwner(metadata, unsafeKey)) {
                    return void cb('INSUFFICIENT_PERMISSIONS');
                }
            }));
        }).nThen(function () {
            const cb = _cb;
            // temporarily archive the file
            return void store.archiveChannel(channel, reason, (e) => {
                Env.Log.info('ARCHIVAL_CHANNEL_BY_OWNER_RPC', {
                    unsafeKey,
                    channel,
                    status: e? String(e): 'SUCCESS'
                });
                if (e) { return void cb(e); }
                cb(void 0, 'OK');

                CM.disconnectChannelMembers(Env, channel, 'EDELETED', reason, () => {});
            });
        });
    };

    CM.removeOwnedChannel = (Env, data, __cb) => {
        const { channel, safeKey, reason } = data;
        const _cb = Util.once(Util.mkAsync(__cb));

        if (typeof(channel) !== 'string' || !Core.isValidId(channel)){
            return _cb('INVALID_ARGUMENTS');
        }

        // Archiving large channels or files can be expensive,
        // so do it one at a time
        // For any given user to ensure that nobody can use too much
        // of the server's resources
        Env.queueDeletes(safeKey, (next) => {
            const cb = Util.both(_cb, next);
            if (Env.blobStore.isFileId(channel)) {
                return Env.worker.removeOwnedBlob(channel, safeKey, reason, cb);
            }
            // TODO move to worker too?
            archiveOwnedChannel(Env, safeKey, channel, reason, cb);
        });
    };

    CM.trimHistory = (Env, data, cb) => {
        const { channel, hash, safeKey } = data;
        if (!(typeof(channel) === 'string' && typeof(hash) === 'string' && hash.length === 64)) {
            return void cb('INVALID_ARGS');
        }

        const unsafeKey = Util.unescapeKeyCharacters(safeKey);

        nThen((w) => {
            HistoryManager.getMetadata(Env, channel, w((err, metadata) => {
                if (err) {
                    w.abort();
                    return void cb(err);
                }
                if (!Core.hasOwners(metadata)) {
                    w.abort();
                    return void cb('E_NO_OWNERS');
                }
                if (!Core.isOwner(metadata, unsafeKey)) {
                    w.abort();
                    return void cb("INSUFFICIENT_PERMISSIONS");
                }
                // else fall through to the next block
            }));
        }).nThen(function () {
            store.trimChannel(channel, hash, (err) => {
                Env.Log.info('HK_TRIM_HISTORY', {
                    unsafeKey: unsafeKey,
                    channel: channel,
                    status: err? String(err): 'SUCCESS',
                });
                if (err) { return void cb(err); }
                // clear historyKeeper's cache for this channel
                cb(void 0, 'OK');
                delete (Env.channel_cache[channel] || {}).index;
            });
        });
    };

    return CM;
};

module.exports = { create };
