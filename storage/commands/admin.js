// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const User = require('../storage/user');
const Users = require('./users');
const Invitation = require('./invitation');
const Pinning = require('./pin');
const Fs = require('node:fs');
const getFolderSize = require("get-folder-size");
const nThen = require('nthen');


// XXX: Find a way to detect if it’s called from the same virtual machine?
const getFileDescriptorCount = (Env, _args, cb) => {
    Fs.readdir('/proc/self/fd', function(err, list) {
        if (err) { return void cb(err); }
        cb(void 0, list.length);
    });
};

const getKnownUsers = (Env, _args, cb) => {
    User.getAll(Env, cb);
};

const addKnownUser = (Env, data, cb) => {
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

const getDiskUsage = (Env, _args, cb) => {
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

const getUserQuota = (Env, args, cb) => {
    const key = args[1];
    Pinning.getLimit(Env, key, cb);
};

const onGetInvitations = (Env, _args, cb) => {
    Invitation.getAll(Env, cb);
};

const onGetPinActivity = (Env, data, cb) => {
    Env.workers.send('GET_PIN_ACTIVITY', data, cb);
};

const onGetUserStorageStats = (Env, data, cb) => {
    Env.workers.send('GET_USER_STORAGE_STATS', data, cb);
};

const onGetPinLogStatus = (Env, data, cb) => {
    Env.workers.send('GET_PIN_LOG_STATUS', data, cb);
};

const commands = {
    'GET_FILE_DESCRIPTOR_COUNT': getFileDescriptorCount,
    'GET_INVITATIONS': onGetInvitations,
    'GET_USERS': getKnownUsers,
    'ADD_KNOWN_USER': addKnownUser,
    'GET_DISK_USAGE': getDiskUsage,
    'GET_USER_QUOTA': getUserQuota,
    'GET_PIN_ACTIVITY': onGetPinActivity,
    'GET_USER_STORAGE_STATS': onGetUserStorageStats,
    'GET_PIN_LOG_STATUS': onGetPinLogStatus,
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
