// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const User = require('../storage/user');
const Util = require('../common-util');
const Users = require('./users');
const Invitation = require('./invitation');
const Pinning = require('./pin');
const MFA = require("../storage/mfa");
const Fs = require('node:fs');
const getFolderSize = require("get-folder-size");
const nThen = require('nthen');


// XXX: Find a way to detect if it’s called from the same virtual machine?
const onGetFileDescriptorCount = (Env, _args, cb) => {
    Fs.readdir('/proc/self/fd', function(err, list) {
        if (err) { return void cb(err); }
        cb(void 0, list.length);
    });
};

const onGetKnownUsers = (Env, _args, cb) => {
    User.getAll(Env, cb);
};

const onAddKnownUser = (Env, data, cb) => {
    const obj = Array.isArray(data) && data[1];
    const { edPublic, block, alias, unsafeKey, email, name } = obj;
    const userData = {
        edPublic,
        block,
        alias,
        email,
        name,
        type: 'manual'
    };
    Users.add(Env, edPublic, userData, unsafeKey, cb);
};

const onGetDiskUsage = (Env, _args, cb) => {
    Env.batchDiskUsage('', cb, function (done) {
        var data = {};
        nThen(function (waitFor) {
            getFolderSize('./', waitFor(function(_err, info) {
                data.total = info;
            }));
            getFolderSize(Env.paths.pin, waitFor(function(_err, info) {
                data.pin = info;
            }));
            getFolderSize(Env.paths.blob, waitFor(function(_err, info) {
                data.blob = info;
            }));
            getFolderSize(Env.paths.staging, waitFor(function(_err, info) {
                data.blobstage = info;
            }));
            getFolderSize(Env.paths.block, waitFor(function(_err, info) {
                data.block = info;
            }));
            getFolderSize(Env.paths.data, waitFor(function(_err, info) {
                data.datastore = info;
            }));
        }).nThen(function () {
            done(void 0, data);
        });
    });
};

const onGetUserQuota = (Env, args, cb) => {
    const { key } = args;
    Pinning.getLimit(Env, key, cb);
};

const onGetInvitations = (Env, _args, cb) => {
    Invitation.getAll(Env, cb);
};

const onGetPinActivity = (Env, data, cb) => {
    if (!data) { return void cb("INVALID_ARGS"); }
    if (typeof (data.key) !== 'string') { return void cb("INVALID_KEY"); }
    var safeKey = Util.escapeKeyCharacters(data.key);
    var first;
    var latest;
    Env.pinStore.readMessagesBin(safeKey, 0, (msgObj, readMore) => {
        var line = msgObj.buff.toString('utf8');
        if (!line || !line.trim()) { return readMore(); }
        try {
            var parsed = JSON.parse(line);
            var temp = parsed[parsed.length - 1];
            if (!temp || typeof (temp) !== 'number') { return readMore(); }
            latest = temp;
            if (first) { return readMore(); }
            first = latest;
            readMore();
        } catch (err) { readMore(); }
    }, function(err) {
        if (err) { return void cb(err); }
        cb(void 0, {
            first: first,
            latest: latest,
        });
    });
};

const onGetUserStorageStats = (Env, data, cb) => {
    // Have been previously validated
    const { key } = data;
    Env.getPinState(key, function (err, value) {
        if (err) { return void cb(err); }
        try {
            const res = {
                channels: 0,
                files: 0,
            };
            Object.keys(value).forEach(k => {
                switch (k.length) {
                    case 32: return void ((res.channels++));
                    case 48: return void ((res.files++));
                }
            });
            return void cb(void 0, res);
        } catch (err2) { }
        cb("UNEXPECTED_SERVER_ERROR");
    });
};

const onGetPinLogStatus = (Env, data, cb) => {
    const { key } = data;
    const safeKey = Util.escapeKeyCharacters(key);

    const response = {};
    nThen(function (w) {
        Env.pinStore.isChannelAvailable(safeKey, w(function (err, result) {
            if (err) {
                return void Env.Log.error('PIN_LOG_STATUS_AVAILABLE', err);
            }
            response.live = result;
        }));
        Env.pinStore.isChannelArchived(safeKey, w(function (err, result) {
            if (err) {
                return void Env.Log.error('PIN_LOG_STATUS_ARCHIVED', err);
            }
            response.archived = result;
        }));
    }).nThen(function () {
        cb(void 0, response);
    });
};

const onGetPinList = (Env, data, cb) => {
    const { key } = data;
    const safeKey = Util.escapeKeyCharacters(key);

    Env.getPinState(safeKey, function (err, value) {
        if (err) { return void cb(err); }
        try {
            return void cb(void 0, Object.keys(value).filter(k => value[k]));
        } catch (err2) { }
        cb("UNEXPECTED_SERVER_ERROR");
    });
};

const onGetCacheStats = (Env, _data, cb) => {
    let metaSize = 0;
    let channelSize = 0;
    let metaCount = 0;
    let channelCount = 0;

    try {
        const meta = Env.metadata_cache;
        for (let x in meta) {
            if (Object.prototype.hasOwnProperty.call(meta, x)) {
                metaCount++;
                metaSize += JSON.stringify(meta[x]).length;
            }
        }

        const channels = Env.channel_cache;
        for (let y in channels) {
            if (Object.prototype.hasOwnProperty.call(channels, y)) {
                channelCount++;
                channelSize += JSON.stringify(channels[y]).length;
            }
        }
    } catch (err) {
        return void cb(err && err.message);
    }

    cb(void 0, {
        metadata: metaCount,
        metaSize: metaSize,
        channel: channelCount,
        channelSize: channelSize,
        memoryUsage: process.memoryUsage(),
    });
};

const onGetMetadataHistory = (Env, data, cb) => {
    const { id } = data;
    let lines = [];
    Env.store.readChannelMetadata(id, (err, line) => {
        if (err) { return; }
        lines.push(line);
    }, err => {
        if (err) {
            Env.Log.error('ADMIN_GET_METADATA_HISTORY', {
                error: err,
                id: id,
            });
            return void cb(err);
        }
        cb(void 0, lines);
    });
    
};

const onGetStoredMetadata = (Env, data, cb) => {
    const { id } = data;
    Env.worker.computeMetadata(id, (err, data) => {
        cb(err, data);
    });
};

const onGetDocumentSize = (Env, data, cb) => {
    const { id } = data;
    Env.worker.getFileSize(id, (err, size) => {
        if (err) { return void cb(err); }
        cb(err, size);
    });
};

const onGetLastChannelTime = (Env, data, cb) => {
    const { id } = data;
    Env.worker.getLastChannelTime(id, function (err, time) {
        if (err) { return void cb(err && err.code); }
        cb(err, time);
    });
};

const onGetDocumentStatus = (Env, data, cb) => {
    const { id } = data;
    let response = {};
    if (id.length === 44) {
        return void nThen(function (w) {
            Env.modules.BlockStore.isAvailable(Env, id, w(function (err, result) {
                if (err) {
                    return void Env.Log.error('BLOCK_STATUS_AVAILABLE', err);
                }
                response.live = result;
            }));
            Env.modules.BlockStore.isArchived(Env, id, w(function (err, result) {
                if (err) {
                    return void Env.Log.error('BLOCK_STATUS_ARCHIVED', err);
                }
                response.archived = result;
            }));
            Env.modules.BlockStore.readPlaceholder(Env, id, w((result) => {
                if (!result) { return; }
                response.placeholder = result;
            }));
            MFA.read(Env, id, w(function (err, v) {
                if (err === 'ENOENT') {
                    response.totp = 'DISABLED';
                } else if (v) {
                    const parsed = Util.tryParse(v);
                    response.totp = {
                        enabled: true,
                        recovery: parsed.contact && parsed.contact.split(':')[0]
                    };
                } else {
                    response.totp = err;
                }
            }));
        }).nThen(function () {
            cb(void 0, response);
        });
    }
    if (id.length === 48) {
        return void nThen(function (w) {
            Env.blobStore.isBlobAvailable(id, w(function (err, result) {
                if (err) {
                    return void Env.Log.error('BLOB_STATUS_AVAILABLE', err);
                }
                response.live = result;
            }));
            Env.blobStore.isBlobArchived(id, w(function (err, result) {
                if (err) {
                    return void Env.Log.error('BLOB_STATUS_ARCHIVED', err);
                }
                response.archived = result;
            }));
            Env.blobStore.getPlaceholder(id, w((result) => {
                if (!result) { return; }
                response.placeholder = result;
            }));
        }).nThen(function () {
            cb(void 0, response);
        });
    }
    if (id.length !== 32) { return void cb("EINVAL"); }
    nThen(function (w) {
        Env.store.isChannelAvailable(id, w(function (err, result) {
            if (err) {
                return void Env.Log.error('CHANNEL_STATUS_AVAILABLE', err);
            }
            response.live = result;
        }));
        Env.store.isChannelArchived(id, w(function (err, result) {
            if (err) {
                return void Env.Log.error('CHANNEL_STATUS_ARCHIVED', err);
            }
            response.archived = result;
        }));
        Env.store.getPlaceholder(id, w((result) => {
            if (!result) { return; }
            response.placeholder = result;
        }));
    }).nThen(function () {
        cb(void 0, response);
    });
};

const onDisableMFA = (Env, data, cb) => {
    const { key } = data;
    MFA.revoke(Env, key, cb);
};

const onArchiveBlock = (Env, data, cb) => {
    const { key, reason } = data;
    const archiveReason = {
        code: 'MODERATION_BLOCK',
        txt: reason
    };
    Env.modules.BlockStore.archive(Env, key, archiveReason, err => {
        Env.Log.info("ARCHIVE_BLOCK_BY_ADMIN", {
            error: err,
            key: key,
            reason: reason || '',
        });
        cb(err);
    });
    let SSOUtils = Env.plugins && Env.plugins.SSO && Env.plugins.SSO.utils;
    if (SSOUtils) { SSOUtils.deleteAccount(Env, key, () => {}); }
};

const onRestoreArchivedBlock = (Env, data, cb) => {
    const { key, reason } = data;
    Env.modules.BlockStore.restore(Env, key, err => {
        Env.Log.info("RESTORE_ARCHIVED_BLOCK_BY_ADMIN", {
            error: err,
            key: key,
            reason: reason || '',
        });

        // Also restore SSO data
        let SSOUtils = Env.plugins && Env.plugins.SSO && Env.plugins.SSO.utils;
        if (SSOUtils) { SSOUtils.restoreAccount(Env, key, () => {}); }

        cb(err);
    });
};

const commands = {
    'GET_FILE_DESCRIPTOR_COUNT': onGetFileDescriptorCount,
    'GET_INVITATIONS': onGetInvitations,
    'GET_USERS': onGetKnownUsers,
    'ADD_KNOWN_USER': onAddKnownUser,
    'GET_DISK_USAGE': onGetDiskUsage,
    'GET_USER_QUOTA': onGetUserQuota,
    'GET_PIN_ACTIVITY': onGetPinActivity,
    'GET_USER_STORAGE_STATS': onGetUserStorageStats,
    'GET_PIN_LOG_STATUS': onGetPinLogStatus,
    'GET_CACHE_STATS': onGetCacheStats,
    'GET_METADATA_HISTORY': onGetMetadataHistory,
    'GET_STORED_METADATA': onGetStoredMetadata,
    'GET_DOCUMENT_SIZE': onGetDocumentSize,
    'GET_LAST_CHANNEL_TIME': onGetLastChannelTime,
    'GET_DOCUMENT_STATUS': onGetDocumentStatus,
    'DISABLE_MFA': onDisableMFA,
    'GET_PIN_LIST': onGetPinList,
    'ARCHIVE_BLOCK': onArchiveBlock,
    'RESTORE_ARCHIVED_BLOCK': onRestoreArchivedBlock,
};

module.exports = {
    command: (Env, args, cb) => {
        const {cmd, data} = args;
        const command = commands[cmd];

        if (typeof(command) === 'function') {
            return void command(Env, data, cb);
        }

        return void cb('UNHANDLED_ADMIN_COMMAND');
    }
};
