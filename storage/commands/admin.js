// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const User = require('../storage/user');
const Util = require('../common-util');
const Users = require('./users');
const Invitation = require('./invitation');
const Pinning = require('./pin');
const BlockStore = require("../storage/block");
const Moderators = require("./moderators");
const MFA = require("../storage/mfa");
const Core = require("../../common/core");
const Fs = require('node:fs');
const Fse = require('fs-extra');
const Path = require('node:path');
const getFolderSize = require("get-folder-size");
const nThen = require('nthen');
const Decrees = require('./decrees.js');


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
    const { edPublic, block, alias, unsafeKey, email, name } = data;
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

const onDeleteKnownUser = (Env, id, cb) => {
    Users.delete(Env, id, cb);
};

const onUpdateKnownUser = (Env, args, cb) => {
    const {edPublic, changes} = args;
    Users.update(Env, edPublic, changes, cb);
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

const onCreateInvitation = (Env, args, cb) => {
    Invitation.create(Env, args, cb);
};

const onDeleteInvitation = (Env, id, cb) => {
    Invitation.delete(Env, id, cb);
};

const onGetPinActivity = (Env, data, cb) => {
    if (!data) { return void cb('INVALID_ARGS'); }
    if (typeof (data.key) !== 'string') { return void cb('INVALID_KEY'); }
    let safeKey = Util.escapeKeyCharacters(data.key);
    Env.worker.getPinActivity(safeKey, cb);
};

const onGetUserStorageStats = (Env, data, cb) => {
    // Have been previously validated
    const { key } = data;
    Env.worker.getPinState(key, function (err, value) {
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
        cb('UNEXPECTED_SERVER_ERROR');
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

    Env.worker.getPinState(safeKey, function (err, value) {
        if (err) { return void cb(err); }
        try {
            return void cb(void 0, Object.keys(value).filter(k => value[k]));
        } catch (err2) { }
        cb('UNEXPECTED_SERVER_ERROR');
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
            BlockStore.isAvailable(Env, id, w(function (err, result) {
                if (err) {
                    return void Env.Log.error('BLOCK_STATUS_AVAILABLE', err);
                }
                response.live = result;
            }));
            BlockStore.isArchived(Env, id, w(function (err, result) {
                if (err) {
                    return void Env.Log.error('BLOCK_STATUS_ARCHIVED', err);
                }
                response.archived = result;
            }));
            BlockStore.readPlaceholder(Env, id, w((result) => {
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
    if (id.length !== 32) { return void cb('EINVAL'); }
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
    BlockStore.archive(Env, key, archiveReason, err => {
        Env.Log.info("ARCHIVE_BLOCK_BY_ADMIN", {
            error: err,
            key: key,
            reason: reason || '',
        });
        cb(err);
    });
    let SSOUtils = Env.plugins?.SSO?.utils;
    if (SSOUtils) { SSOUtils.deleteAccount(Env, key, () => {}); }
};

const onRestoreArchivedBlock = (Env, data, cb) => {
    const { key, reason } = data;
    BlockStore.restore(Env, key, err => {
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

const onArchiveDocument = (Env, data, _cb) => {
    const cb = Util.mkAsync(_cb);
    const { id, reason } = data;
    const archiveReason = {
        code: 'MODERATION_PAD',
        txt: reason
    };
    const reasonStr = `MODERATION_PAD:${reason}`;

    switch (id.length) {
        case 32:
            return void Env.store.archiveChannel(id, archiveReason, Util.both(cb, function(err) {
                Env.Log.info("ARCHIVAL_CHANNEL_BY_ADMIN_RPC", {
                    channelId: id,
                    reason: reason,
                    status: err ? String(err) : "SUCCESS",
                });
                Env.CM.disconnectChannelMembers(Env, id, 'EDELETED', reasonStr, err => {
                    if (err) { } // TODO
                });
            }));
        case 48:
            return void Env.blobStore.archive.blob(id, archiveReason, Util.both(cb, function(err) {
                Env.Log.info("ARCHIVAL_BLOB_BY_ADMIN_RPC", {
                    id: id,
                    reason: reason,
                    status: err ? String(err) : "SUCCESS",
                });
            }));
        default:
            return void cb('INVALID_ID_LENGTH');
    }

    // archival for blob proofs isn't automated, but evict-inactive.js will
    // clean up orpaned blob proofs
    // Env.blobStore.archive.proof(userSafeKey, blobId, cb)

};

const onArchiveDocuments = (Env, data, cb) => {
    const { reason, list } = data;
    let failed = [];
    list.forEach(id => {
        onArchiveDocument(Env, { id, reason }, (err) => {
            if (err) { failed.push({ code: err, id }); }
        });
    });
    cb(failed);
};

const onRestoreArchivedDocument = (Env, data, cb) => {
    const { id, reason } = data;

    switch (id.length) {
        case 32:
            return void Env.store.restoreArchivedChannel(id, Util.both(cb, function(err) {
                Env.Log.info("RESTORATION_CHANNEL_BY_ADMIN_RPC", {
                    id: id,
                    reason: reason,
                    status: err ? String(err) : 'SUCCESS',
                });
            }));
        case 48:
            // FIXME this does not yet restore blob ownership
            // Env.blobStore.restore.proof(userSafekey, id, cb)
            return void Env.blobStore.restore.blob(id, Util.both(cb, function(err) {
                Env.Log.info("RESTORATION_BLOB_BY_ADMIN_RPC", {
                    id: id,
                    reason: reason,
                    status: err ? String(err) : 'SUCCESS',
                });
            }));
        default:
            return void cb('INVALID_ID_LENGTH');
    }
};

const onGetPinInfo = (Env, args, cb) => {
    Env.worker.getPinInfo(args.key, cb);
};

const onReadReport = (Env, args, cb) => {
    const safeKey = Util.escapeKeyCharacters(args.key);
    Env.pinStore.isChannelArchived(safeKey, (err, exists) => {
        if (err) { return cb(err); }
        if (!exists) { return cb('ENOENT'); }
        Env.worker.readReport(safeKey, cb);
    });
};

/* Account Archive and Restore */
const mkReportPath = function (Env, safeKey) {
    return Path.join(Env.paths.archive, 'accounts', safeKey);
};

const storeReport = (Env, report, cb) => {
    let path = mkReportPath(Env, report.key);
    let s_data;
    try {
        s_data = JSON.stringify(report);
        Fse.outputFile(path, s_data, cb);
    } catch (err) {
        return void cb(err);
    }
};

const deleteReport = (Env, key, cb) => {
    let path = mkReportPath(Env, key);
    Fse.remove(path, cb);
};
const onAccountArchivalStart = (Env, args, cb) => {
    Env.worker.accountArchivalStart(args, cb);
};

const onAccountArchivalBlock = (Env, args, cb) => {
    let { block } = args;
    const { archiveReason, safeKey } = args;

    nThen((waitFor) => {
        BlockStore.archive(Env, block, archiveReason, waitFor((err) => {
            if (err) {
                block = undefined;
                return Env.Log.error('MODERATION_ACCOUNT_BLOCK', err, waitFor());
            }
            Env.Log.info('MODERATION_ACCOUNT_BLOCK', safeKey, waitFor());
        }));
        MFA.delete(Env, block, waitFor());
        const SSOUtils = Env.plugins?.SSO?.utils;
        if (!SSOUtils) { return; }
        SSOUtils.deleteAccount(Env, block, waitFor((err) => {
            if (err) {
                return Env.Log.error('MODERATION_ACCOUNT_BLOCK_SSO', err, waitFor());
            }
        }));
    }).nThen(() => { cb(void 0, block); });
};

const onDisconnectChannelMembers = (Env, args) => {
    const {list, kickReason} = args;
    let n = nThen;
    list.forEach((chanId) => {
        n = n((w) => {
            setTimeout(w(() => {
                Env.CM.disconnectChannelMembers(Env, chanId, 'EDELETED', kickReason, () => { });
            }), 10);
        }).nThen;
    });
};

const onAccountArchivalEnd = (Env, args, cb) => {
    const { key, deletedBlobs, deletedChannels, archiveReason, reason } = args;
    let { block } = args;
    const safeKey = Util.escapeKeyCharacters(key);
    nThen((waitFor) => {
        // Archive the pin log
        Env.pinStore.archiveChannel(safeKey, undefined, waitFor((err) => {
            if (err) {
                return Env.Log.error('MODERATION_ACCOUNT_PIN_LOG', err, waitFor());
            }
            Env.Log.info('MODERATION_ACCOUNT_LOG', safeKey, waitFor());
        }));
        if (!block) { return; }

        const blockData = { block, safeKey, archiveReason };
        if (Env.getStorageId(block) !== Env.myId) {
            Core.storageToStorage(Env, block, 'ADMIN_CMD', { cmd: 'ACCOUNT_ARCHIVAL_BLOCK', data: blockData }, waitFor((err, res) => {
                if (err) {
                    return Env.Log.error('MODERATION_ACCOUNT_BLOCK', err, waitFor());
                }
                block = res;
                Env.Log.info('MODERATION_ACCOUNT_BLOCK', safeKey, waitFor());
            }));
        } else {
            onAccountArchivalBlock(Env, blockData, waitFor((err, res) => {
                if (err) {
                    return Env.Log.error('MODERATION_ACCOUNT_BLOCK', err, waitFor());
                }
                block = res;
                Env.Log.info('MODERATION_ACCOUNT_BLOCK', safeKey, waitFor());
            }));
        }
    }).nThen((waitFor) => {
        const report = {
            key: safeKey,
            channels: deletedChannels,
            blobs: deletedBlobs,
            blockId: block,
            reason: reason
        };
        storeReport(Env, report, waitFor((err) => {
            if (err) {
                return Env.Log.error('MODERATION_ACCOUNT_REPORT', report, waitFor());
            }
        }));
    }).nThen(() => {
        const kickReason = `MODERATION_ACCOUNT:${reason}`;
        const routing = Core.getChannelsStorage(Env, deletedChannels);
        Object.keys(routing).forEach((storageId) => {
            if (storageId === Env.myId) {
                onDisconnectChannelMembers(Env, {
                    list: routing[storageId],
                    kickReason
                });
            } else {
                Env.interface.sendEvent(storageId, 'ADMIN_CMD', {
                    cmd: 'DISCONNECT_CHANNEL_MEMBERS',
                    data: {
                        list: routing[storageId],
                        kickReason
                    }
                });
            }
        });
        cb();
    });
};

const onAccountRestoreStart = (Env, args, cb) => {
    Env.worker.accountRestoreStart(args, cb);
};

const onAccountRestoreBlock = (Env, args, cb) => {
    const { safeKey } = args;
    let { blockId } = args;

    nThen((waitFor) => {
        BlockStore.restore(Env, blockId, waitFor(function(err) {
            if (err) {
                blockId = undefined;
                return Env.Log.error('MODERATION_ACCOUNT_BLOCK_RESTORE', err, waitFor());
            }
            Env.Log.info('MODERATION_ACCOUNT_BLOCK_RESTORE', safeKey, waitFor());
        }));
        const SSOUtils = Env.plugins?.SSO?.utils;
        if (!SSOUtils) { return; }
        SSOUtils.restoreAccount(Env, blockId, waitFor(function(err) {
            if (err) {
                return Env.Log.error('MODERATION_ACCOUNT_BLOCK_RESTORE_SSO', err, waitFor());
            }
        }
        ));
    }).nThen(() => { cb(void 0, blockId); });
};

const onAccountRestoreEnd = (Env, args, cb) => {
    const { key } = args;
    let { blockId } = args;
    const safeKey = Util.escapeKeyCharacters(key);

    nThen((waitFor) => {
        Env.pinStore.restoreArchivedChannel(safeKey, waitFor(function(err) {
            if (err) {
                return Env.Log.error('MODERATION_ACCOUNT_PIN_LOG_RESTORE', err, waitFor());
            }
            Env.Log.info('MODERATION_ACCOUNT_LOG_RESTORE', safeKey, waitFor());
        }));
        if (!blockId) { return; }
        if (Env.getStorageId(blockId) !== Env.myId) {
            Core.storageToStorage(Env, blockId, 'ADMIN_CMD', { cmd: 'ACCOUNT_RESTORE_BLOCK', data: { blockId, safeKey } }, waitFor((err, block) => {
                if (err) {
                    Env.Log.error('MODERATION_ACCOUNT_BLOCK_RESTORE', err, waitFor());
                }
                blockId = block;
            }));
        } else {
            onAccountRestoreBlock(Env, { blockId, safeKey }, waitFor((err, block) => {
                if (err) {
                    Env.Log.error('MODERATION_ACCOUNT_BLOCK_RESTORE', err, waitFor());
                }
                blockId = block;
            }));
        }
    }).nThen((waitFor) => {
        deleteReport(Env, safeKey, waitFor((err) => {
            if (err) {
                return Env.Log.error('MODERATION_ACCOUNT_REPORT_DELETE', safeKey, waitFor());
            }
        }));
    }).nThen(() => cb());;
};

const onGetAccountArchiveStatus = (Env, args, cb) => {
    const safeKey = Util.escapeKeyCharacters(args.key);
    Env.worker.readReport(safeKey, (err, report) => {
        if (err) { return void cb(err); }
        cb(void 0, report);
    });
};

const onClearCachedChannelIndex = (Env, id, cb) => {
    delete Env.channel_cache?.[id];
    cb();
};

const onGetCachedChannelIndex = (Env, id, cb) => {
    const index = Env.channel_cache?.[id];
    if (!index) { return void cb('ENOENT'); }
    cb(void 0, index);
};

const onGetCachedChannelMetadata = (Env, id, cb) => {
    const index = Env.metadata_cache?.[id];
    if (!index) { return void cb('ENOENT'); }
    cb(void 0, index);
};

const onClearCachedChannelMetadata = (Env, id, cb) => {
    delete Env.metadata_cache[id];
    cb();
};

const onGetActiveChannelCount = (Env, _id, cb) => {
    if (!Env.channel_cache) { return void cb('ENOENT'); }
    cb(void 0, Object.keys(Env.channel_cache).length);
};

// Moderator commands are handled by storage:0
const onGetModerators = (Env, _data, cb) => {
    if (Env.myId !== 'storage:0') { return void cb('INVALID_STORAGE'); }
    Moderators.getAll(Env, cb);
};

const onAddModerator = (Env, data, cb) => {
    if (Env.myId !== 'storage:0') { return void cb('INVALID_STORAGE'); }
    const { userData, unsafeKey } = data;
    Moderators.add(Env, userData.edPublic, userData, unsafeKey, cb);
};

const onRemoveModerator = (Env, id, cb) => {
    if (Env.myId !== 'storage:0') { return void cb('INVALID_STORAGE'); }
    Moderators.delete(Env, id, cb);
};

const _removeLogo = (Env) => {
    Env.apiLogoCache = undefined;
    const path = Env.paths.logo;
    const list = Fs.readdirSync(path);
    list.forEach(file => {
        if (!/^logo/.test(file)) { return; }
        try {
            Fs.rmSync(Path.join(path, file), { force: true });
        } catch (err) {
            Env.Log.error('REMOVE_LOGO', err);
        }
    });
};

// Logo commands (storage:0 only)
const onUploadLogo = (Env, data, cb) => {
    if (Env.myId !== 'storage:0') { return void cb('INVALID_STORAGE'); }
    const { file, unsafeKey } = data;

    // Remove "data:{mime};base64," and extract file extension
    let ext = '';
    const base64 = file.replace(/^(data:image\/([a-z+]+);base64,)(.+)/, (_str, _toRemove, format, b64) => {
        if (format === 'svg+xml') { ext = 'svg'; }
        else if (format === 'jpeg') { ext = 'jpg'; }
        else { ext = format; }
        return b64;
    });
    if (!ext) { return void cb('INVALID_FORMAT'); }

    // Remove any existing logo
    _removeLogo(Env);

    // Write to disk
    const buffer = Buffer.from(base64, "base64");
    const path = Path.join(Env.paths.logo, `logo.${ext}`);
    Fse.outputFile(path, buffer, err => {
        if (err) { return void cb(err); }

        // Add decree
        const decree = ['HAS_CUSTOM_LOGO', [true], unsafeKey, +new Date()];
        Decrees.onNewDecree(Env, decree, '', cb);
    });
};
const onRemoveLogo = (Env, data, cb) => {
    if (Env.myId !== 'storage:0') { return void cb('INVALID_STORAGE'); }
    const { unsafeKey } = data;

    // Delete file
    _removeLogo(Env);

    // Send decree
    const decree = ['HAS_CUSTOM_LOGO', [false], unsafeKey, +new Date()];
    Decrees.onNewDecree(Env, decree, '', cb);
};

const commands = {
    'GET_FILE_DESCRIPTOR_COUNT': onGetFileDescriptorCount,
    'GET_INVITATIONS': onGetInvitations,
    'CREATE_INVITATION': onCreateInvitation,
    'DELETE_INVITATION': onDeleteInvitation,
    'GET_USERS': onGetKnownUsers,
    'ADD_KNOWN_USER': onAddKnownUser,
    'DELETE_KNOWN_USER': onDeleteKnownUser,
    'UPDATE_KNOWN_USER': onUpdateKnownUser,
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
    'GET_PIN_INFO': onGetPinInfo,
    'GET_PIN_LIST': onGetPinList,
    'ARCHIVE_BLOCK': onArchiveBlock,
    'RESTORE_ARCHIVED_BLOCK': onRestoreArchivedBlock,
    'ARCHIVE_DOCUMENT': onArchiveDocument,
    'ARCHIVE_DOCUMENTS': onArchiveDocuments,
    'RESTORE_ARCHIVED_DOCUMENT': onRestoreArchivedDocument,
    'READ_REPORT': onReadReport,
    'ACCOUNT_ARCHIVAL_START': onAccountArchivalStart,
    'ACCOUNT_ARCHIVAL_BLOCK': onAccountArchivalBlock,
    'ACCOUNT_ARCHIVAL_END': onAccountArchivalEnd,
    'ACCOUNT_RESTORE_START': onAccountRestoreStart,
    'ACCOUNT_RESTORE_BLOCK': onAccountRestoreBlock,
    'ACCOUNT_RESTORE_END': onAccountRestoreEnd,
    'DISCONNECT_CHANNEL_MEMBERS': onDisconnectChannelMembers,
    'GET_ACCOUNT_ARCHIVE_STATUS': onGetAccountArchiveStatus,
    'CLEAR_CACHED_CHANNEL_INDEX': onClearCachedChannelIndex,
    'GET_CACHED_CHANNEL_INDEX': onGetCachedChannelIndex ,
    'CLEAR_CACHED_CHANNEL_METADATA': onClearCachedChannelMetadata,
    'GET_CACHED_CHANNEL_METADATA': onGetCachedChannelMetadata,
    'GET_ACTIVE_CHANNEL_COUNT': onGetActiveChannelCount,
    'GET_MODERATORS': onGetModerators,
    'ADD_MODERATOR': onAddModerator,
    'REMOVE_MODERATOR': onRemoveModerator,
    'UPLOAD_LOGO': onUploadLogo,
    'REMOVE_LOGO': onRemoveLogo
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
