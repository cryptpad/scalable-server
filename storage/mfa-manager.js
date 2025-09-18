// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Util = require("./common-util.js");

const MFA = require("./storage/mfa");
const Sessions = require("./storage/sessions");

// Handle "basic" storage types commands

const MFAManager = {};


MFAManager.checkMFA = (Env, args, cb) => {
    const { publicKey } = args;
    // Success if we can't get the MFA settings
    MFA.read(Env, publicKey, (err, content) => {
        if (err) {
            if (err.code !== "ENOENT") {
                Env.Log.error('TOTP_VALIDATE_MFA_READ', {
                    error: err,
                    publicKey: publicKey,
                });
            }
            return void cb();
        }

        var parsed = Util.tryParse(content);
        if (!parsed) { return void cb(); }

        cb("NOT_ALLOWED");
    });
};

MFAManager.updateSession = (Env, args, cb) => {
    const { publicKey, oldKey, session } = args;
    Sessions.update(Env, publicKey, oldKey, session, "", cb);
};

module.exports = MFAManager;

