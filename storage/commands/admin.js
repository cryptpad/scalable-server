// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const Admin = module.exports;
const User = require('../storage/user');
const Fs = require('node:fs');
const getFolderSize = require("get-folder-size");
const nThen = require('nthen');


// XXX: Find a way to detect if it’s called from the same virtual machine?
Admin.getFileDescriptorCount = (Env, _args, cb) => {
    Fs.readdir('/proc/self/fd', function(err, list) {
        if (err) { return void cb(err); }
        cb(void 0, list.length);
    });
};

Admin.getKnownUsers = (Env, _args, cb) => {
    User.getAll(Env, cb);
};

Admin.getDiskUsage = (Env, _args, cb) => {
    Env.batchDiskUsage('', cb, function (done) {
        var data = {};
        nThen(function (waitFor) {
            getFolderSize('./', waitFor(function(err, info) {
                data.total = info;
            }));
            getFolderSize(Env.paths.pin, waitFor(function(err, info) {
                data.pin = info;
            }));
            getFolderSize(Env.paths.blob, waitFor(function(err, info) {
                data.blob = info;
            }));
            getFolderSize(Env.paths.staging, waitFor(function(err, info) {
                data.blobstage = info;
            }));
            getFolderSize(Env.paths.block, waitFor(function(err, info) {
                data.block = info;
            }));
            getFolderSize(Env.paths.data, waitFor(function(err, info) {
                data.datastore = info;
            }));
        }).nThen(function () {
            done(void 0, data);
        });
    });
};
