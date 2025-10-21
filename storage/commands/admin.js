// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const Admin = module.exports;
const User = require('../storage/user');
const Fs = require('node:fs');


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
