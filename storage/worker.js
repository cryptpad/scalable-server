// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Util = require("../common/common-util");
const Constants = require("../common/constants");
const Logger = require("../common/logger");
const Core = require("../common/core");
const File = require("./storage/file.js");
const Blob = require("./storage/blob.js");
const Tasks = require("./storage/tasks.js");
const Environment = require('../common/env');

const Nacl = require('tweetnacl/nacl-fast');

const nThen = require("nthen");
const Saferphore = require("saferphore");

const HKUtil = require("./hk-util.js");
const Meta = require('./metadata');
const Pins = require('./pin-manager');

const Env = {
    isWorker: true,
    Log: Logger()
};

const {
    BLOB_ID_LENGTH
} = Constants;

const init = (config, cb) => {
    Environment.init(Env, config);
    const {
        filePath, archivePath, pinPath, taskPath,
        blobPath, blobStagingPath
    } = Core.getPaths(config);
    nThen(waitFor => {
        File.create({
            filePath, archivePath,
            volumeId: 'channel'
        }, waitFor((err, store) => {
            if (err) {
                waitFor.abort();
                return void cb(err);
            }
            Env.store = store;
        }));
        Blob.create({
            blobPath,
            blobStagingPath,
            archivePath,
            getSession: () => {}
        }, waitFor((err, store) => {
            if (err) {
                waitFor.abort();
                return void cb(err);
            }
            Env.blobStore = store;
        }));
        File.create({
            filePath: pinPath,
            archivePath,
            // important to initialize the pinstore with its own
            // volume id otherwise archived pin logs will get mixed
            // in with channels
            volumeId: 'pins',
        }, waitFor((err, store) => {
            if (err) {
                waitFor.abort();
                return void cb(err);
            }
            Env.pinStore = store;
        }));
    }).nThen(waitFor => {
        Tasks.create({
            log: Env.Log,
            taskPath,
            store: Env.store,
        }, waitFor((err, tasks) => {
            if (err) {
                waitFor.abort();
                return void cb(err);
            }
            Env.tasks = tasks;
        }));
    }).nThen(() => {
        cb();
    });
};

const monitoringIncrement = () => {
    // XXX MONITORING
};

const DETAIL = 1000;
const round = (n) => {
    return Math.floor(n * DETAIL) / DETAIL;
};

const OPEN_CURLY_BRACE = Buffer.from('{');
const CHECKPOINT_PREFIX = Buffer.from('cp|');
const isValidOffsetNumber = function (n) {
    return typeof(n) === 'number' && n >= 0;
};

const computeIndexFromOffset = (channel, offset, cb) => {
    let cpIndex = [];
    let messageBuf = [];
    let i = 0;

    const CB = Util.once(cb);

    const offsetByHash = {};
    let offsetCount = 0;
    let size = offset || 0;
    var start = offset || 0;
    let unconventional = false;

    nThen(function (w) {
        // iterate over all messages in the channel log
        // old channels can contain metadata as the first message of the log
        // skip over metadata as that is handled elsewhere
        // otherwise index important messages in the log
        Env.store.readMessagesBin(channel, start, (msgObj, readMore, abort) => {
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
                if (HKUtil.isMetadataMessage(msg)) {
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
                if (msg[0] === 0 && msg[2] === 'MSG' && typeof(msg[4]) === 'string') {
                    // msgObj.offset is API guaranteed by our storage module
                    // it should always be a valid positive integer
                    offsetByHash[HKUtil.getHash(msg[4])] = msgObj.offset;
                    offsetCount++;
                }
                // There is a trailing \n at the end of the file
                size = msgObj.offset + msgObj.buff.length + 1;
            });
        }));
    }).nThen(function (w) {
        cpIndex = HKUtil.sliceCpIndex(cpIndex, i);

        var new_start;
        if (cpIndex.length) {
            new_start = cpIndex[0].offset;
        } else if (unconventional && messageBuf.length && isValidOffsetNumber(messageBuf[0].offset)) {
            new_start = messageBuf[0].offset;
        }

        if (new_start === start) { return; }
        if (!isValidOffsetNumber(new_start)) { return; }

        // store the offset of the earliest relevant line so that you can start from there next time...
        Env.store.writeOffset(channel, {
            start: new_start,
            created: +new Date(),
        }, w(function () {
            var diff = new_start - start;
            Env.Log.info('WORKER_OFFSET_UPDATE', {
                channel: channel,
                start: start,
                startMB: round(start / 1024 / 1024),
                update: new_start,
                updateMB: round(new_start / 1024 / 1024),
                diff: diff,
                diffMB: round(diff / 1024 / 1024),
            });
        }));
    }).nThen(function () {
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

const computeIndex = (data, cb) => {
    if (!data || !data.channel) {
        return void cb('E_NO_CHANNEL');
    }

    const channel = data.channel;
    const CB = Util.once(cb);

    monitoringIncrement('computeIndex');

    let start = 0;
    nThen(function (w) {
        Env.store.getOffset(channel, w(function (err, obj) {
            if (err) { return; }
            if (obj && typeof(obj.start) === 'number' && obj.start > 0) {
                start = obj.start;
                Env.Log.verbose('WORKER_OFFSET_RECOVERY', {
                    channel: channel,
                    start: start,
                    startMB: round(start / 1024 / 1024),
                });
            }
        }));
    }).nThen(function (w) {
        computeIndexFromOffset(channel, start, w(function (err, index) {
            if (err === 'OFFSET_ERROR') {
                return Env.Log.error("WORKER_OFFSET_ERROR", {
                    channel: channel,
                });
            }
            w.abort();
            monitoringIncrement('computeIndexFromOffset');
            CB(err, index);
        }));
    }).nThen(function (w) {
        // if you're here there was an OFFSET_ERROR..
        // first remove the offset that caused the problem to begin with
        Env.store.clearOffset(channel, w());
    }).nThen(function () {
        // now get the history as though it were the first time
        monitoringIncrement('computeIndexFromStart');
        computeIndexFromOffset(channel, 0, CB);
    });
};

const computeMetadata = (args, cb) => {
    const { channel } = args;

    monitoringIncrement('computeIndex');

    const ref = {};
    const lineHandler = Meta.createLineHandler(ref, Env.Log.error);

    let f = Env.store.readChannelMetadata;
    if (channel.length === BLOB_ID_LENGTH) {
        f = Env?.blobStore?.readMetadata;
    }

    return void f(channel, lineHandler, (err) => {
        if (err) {
            return void cb(err);
        }
        cb(void 0, ref.meta);
    });
};

// Get the offset of the provided hash in the file
const getHashOffset = (args, cb) => {
    const { channel, hash } = args;
    if (typeof (hash) !== 'string') {
        return void cb("INVALID_HASH");
    }

    monitoringIncrement('getHashOffset');
    let offset = -1;
    Env.store.readMessagesBin(channel, 0, (msgObj, readMore, abort) => {
        // tryParse return a parsed message or undefined
        const msg = Util.tryParse(Env, msgObj.buff.toString('utf8'));
        // if it was undefined then go onto the next message
        if (typeof msg === "undefined") { return readMore(); }
        if (typeof (msg[4]) !== 'string' || hash !== HKUtil.getHash(msg[4])) {
            return void readMore();
        }
        offset = msgObj.offset;
        abort();
    }, (err, reason) => {
        if (err) {
            return void cb({
                error: err,
                reason: reason
            });
        }
        cb(void 0, offset);
    });
};

/*  getOlderHistory
    * allows clients to query for all messages until a known hash is read
    * stores all messages in history as they are read
      * can therefore be very expensive for memory
      * should probably be converted to a streaming interface

    Used by:
    * GET_HISTORY_RANGE
*/

const getOlderHistory = function (data, cb) {
    const { oldestKnownHash, channel, desiredMessages, desiredCheckpoint } = data;

    let messages = [];
    Env.store.readMessagesBin(channel, 0, (msgObj, readMore, abort) => {
        const parsed = Util.tryParse(msgObj.buff.toString('utf8'));
        if (!parsed) { return void readMore(); }
        if (HKUtil.isMetadataMessage(parsed)) { return void readMore(); }
        const content = parsed[4];
        if (typeof(content) !== 'string') { return void readMore(); }
        const hash = HKUtil.getHash(content);

        messages.push(parsed);

        // "X" messages before oldestKnownHash
        if (typeof (desiredMessages) === "number") {
            messages = messages.slice(-desiredMessages);
            if (hash === oldestKnownHash) { return void abort(); }
            return void readMore();
        }

        // "X" checkpoints before oldestKnownHash
        if (hash === oldestKnownHash) { return void abort(); }
        if (/^cp\|/.test(content)) { // clean whenever we push a cp
            let foundCp = 0;
            const idx = messages.findLastIndex(parsed => {
                let isCp = /^cp\|/.test(parsed[4]);
                if (!isCp) { return; }
                foundCp++;
                return foundCp >= desiredCheckpoint;
            });
            if (idx > 0) {
                messages = messages.slice(idx);
            }
        }
        readMore();
    }, function (err, reason) {
        if (err) { return void cb(err, reason); }
        cb(void 0, messages);
    });
};

const getPinState = (data, cb) => {
    if (typeof(data.key) !== 'string') {
        return void cb('INVALID_KEY');
    }
    const safeKey = Util.escapeKeyCharacters(data.key);
    const ref = {};
    // XXX Pins
    const lineHandler = Pins.createLineHandler(ref, Env.Log.error);

    // if channels aren't in memory. load them from disk
    monitoringIncrement('getPin');
    Env.pinStore.readMessagesBin(safeKey, 0, (msgObj, readMore) => {
        lineHandler(msgObj.buff.toString('utf8'));
        readMore();
    }, () => {
        cb(void 0, ref.pins);
    });
};

const _iterateFiles = (channels, handler, cb) => {
    if (!Array.isArray(channels)) { return cb('INVALID_LIST'); }
    const L = channels.length;
    const sem = Saferphore.create(10);

    const job = (channel, wait) => {
        return (give) => {
            handler(channel, wait(give()));
        };
    };

    nThen(function (w) {
        for (var i = 0; i < L; i++) {
            sem.take(job(channels[i], w));
        }
    }).nThen(function () {
        cb();
    });
};

const getFileSize = (data, cb) => {
    const { channel } = data;
    if (!Core.isValidId(channel)) { return void cb('INVALID_CHAN'); }
    if (channel.length === Constants.STANDARD_CHANNEL_LENGTH ||
        channel.length === Constants.ADMIN_CHANNEL_LENGTH) {
        return Env.store.getChannelSize(channel, (e, size) => {
            if (e) {
                if (e.code === 'ENOENT') {
                    return void cb(void 0, 0);
                }
                return void cb(e.code);
            }
            cb(void 0, size);
        });
    }

    Env.blobStore.size(channel, (e, size) => {
        if (typeof(size) === 'undefined') { return void cb(e); }
        cb(void 0, size);
    });
};

const getMultipleFileSize = (data, cb) => {
    const counts = {};
    monitoringIncrement('getMultipleFileSize');
    _iterateFiles(data.channels, (channel, next) => {
        getFileSize({ channel }, (err, size) => {
            counts[channel] = err? 0: size;
            next();
        });
    }, (err) => {
        if (err) {
            return void cb(err);
        }
        cb(void 0, counts);
    });
};

const getTotalSize = (data, cb) => {
    let bytes = 0;
    monitoringIncrement('getTotalSize');
    _iterateFiles(data.channels, (channel, next) => {
        getFileSize({ channel }, (err, size) => {
            if (!err) { bytes += size; }
            next();
        });
    }, (err) => {
        if (err) { return cb(err); }
        cb(void 0, bytes);
    });
};

const getDeletedPads = (data, cb) => {
    const absentees = [];
    _iterateFiles(data.channels, (channel, next) => {
        getFileSize({ channel }, (err, size) => {
            if (err) { return next(); }
            if (size === 0) { absentees.push(channel); }
            next();
        });
    }, (err) => {
        if (err) { return void cb(err); }
        cb(void 0, absentees);
    });
};

const hashChannelList = (data, cb) => {
    const channels = data.channels;
    if (!Array.isArray(channels)) {
        return void cb('INVALID_CHANNEL_LIST');
    }
    const uniques = [];

    channels.forEach(a => {
        if (!uniques.includes(a)) { uniques.push(a); }
    });
    uniques.sort();

    // XXX Nacl.hash?
    const hash = Util.encodeBase64(Nacl.hash(Util.decodeUTF8(JSON.stringify(uniques))));

    cb(void 0, hash);
};

const removeOwnedBlob = (data, cb) => {
    if (typeof(data.safeKey) !== 'string') { return cb("INVALID_KEY"); }
    const blobId = data.blobId;
    const safeKey = Util.escapeKeyCharacters(data.safeKey);
    const unsafeKey = Util.unescapeKeyCharacters(data.safeKey);

    const reason = data.reason || 'ARCHIVE_OWNED';

    nThen((w) => {
        // check if you have permissions
        computeMetadata({channel: blobId}, w((err, meta) => {
            if (err || !meta) {
                w.abort();
                return void cb("INSUFFICIENT_PERMISSIONS");
            }
            let owners = meta.owners;
            // XXX remove proof mogration?
            if (!owners && !Env.proofsMigrated) {
                // Check old proofs during migration
                Env.blobStore.isOwnedBy(safeKey, blobId, w((e, owned) => {
                    if (e || !owned) {
                        w.abort();
                        return void cb("INSUFFICIENT_PERMISSIONS");
                    }
                }));
                return;
            }
            if (!owners || !owners.includes(unsafeKey)) {
                w.abort();
                return void cb("INSUFFICIENT_PERMISSIONS");
            }
            // Owned, continue
        }));
    }).nThen((w) => {
        // remove the blob
        Env.blobStore.archive.blob(blobId, reason, w((err) => {
            Env.Log.info('ARCHIVAL_OWNED_FILE_BY_OWNER_RPC', {
                safeKey: safeKey,
                blobId: blobId,
                status: err? String(err): 'SUCCESS',
            });
            if (err) {
                w.abort();
                return void cb(err);
            }
            cb(void 0, 'OK');
        }));
    });
};

const reportStatus = (Env, label, safeKey, err, id, size) => {
    const data = {
        safeKey, id, size,
        err: err?.message || err,
        sizeMB: round((size || 0) / 1024 / 1024),
    };
    const method = err? 'error': 'info';
    Env.Log[method](label, data);
};
const completeUpload = (data, cb) => {
    const { owned, arg, size } = data;

    if (!data) { return void cb('INVALID_ARGS'); }
    if (typeof(data.safeKey) !== 'string') {
        return void cb("INVALID_KEY");
    }
    const safeKey = Util.escapeKeyCharacters(data.safeKey);

    monitoringIncrement('uploadedBlob');

    let method;
    let label;
    if (owned) {
        method = 'completeOwned';
        label = 'UPLOAD_COMPLETE_OWNED';
    } else {
        method = 'complete';
        label = 'UPLOAD_COMPLETE';
    }

    Env.blobStore[method](safeKey, arg, (err, id) => {
        reportStatus(Env, label, safeKey, err, id, size);
        cb(err, id);
    });
};

const runTasks = (data, cb) => {
    Env.tasks.runAll(cb);
};

const writeTask = (data, cb) => {
    Env.tasks.write(data.time, data.task_command, data.args, cb);
};

const onNewDecrees = (data, cb) => {
    Env.adminDecrees.loadRemote(Env, data);
    cb();
};

const COMMANDS = {
    NEW_DECREES: onNewDecrees,

    COMPUTE_INDEX: computeIndex,
    COMPUTE_METADATA: computeMetadata,
    GET_HASH_OFFSET: getHashOffset,
    GET_OLDER_HISTORY: getOlderHistory,

    GET_FILE_SIZE: getFileSize,
    GET_MULTIPLE_FILE_SIZE: getMultipleFileSize,
    GET_TOTAL_SIZE: getTotalSize,
    GET_PIN_STATE: getPinState,
    GET_DELETED_PADS: getDeletedPads,
    HASH_CHANNEL_LIST: hashChannelList,

    REMOVE_OWNED_BLOB: removeOwnedBlob,

    COMPLETE_UPLOAD: completeUpload,

    RUN_TASKS: runTasks,
    WRITE_TASK: writeTask
};

let ready = false;
process.on('message', obj => {
    if (!obj || !obj.txid || !obj.pid) {
        return void process.send({
            error: 'E_INVAL',
            data: obj
        });
    }

    const command = COMMANDS[obj.command];
    const data = obj.data;

    const cb = (err, value) => {
        process.send({
            error: Util.serializeError(err),
            txid: obj.txid,
            pid: obj.pid,
            value: value,
        });
    };

    if (!ready) {
        /*
        if (obj.env) {
            Env = Util.tryParse(obj.env);
        }
        */
        return void init(obj.config, err => {
            if (err) { return void cb(Util.serializeError(err)); }
            ready = true;
            cb();
        });
    }

    if (typeof (command) !== 'function') {
        return void cb("E_BAD_COMMAND");
    }
    command(data, cb);
});

process.on('uncaughtException', function(err) {
    console.error('[%s] UNCAUGHT EXCEPTION IN DB WORKER', new Date());
    console.error(err);
    console.error("TERMINATING");
    process.exit(1);
});
