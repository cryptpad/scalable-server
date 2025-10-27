// SPDX-FileCopyrightText: 2023 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const Path = require("node:path");
const Basic = require("../../common/storage/basic");
const Util  = require("../../common/common-util");
const Sessions = require("./sessions");
const nThen = require("nthen");
const Core = require("../../common/core");

const MFA = module.exports;

/*
This module manages storage related to accounts' multi-factor authentication settings.

These settings are checked every time a block is accessed, so we do as little as possible
so that it can be accessed quickly.

*/

/*  The path for a given account's settings is based on the public signing key
    which identifies its "login block". We expect that any action to create or access
    a block will be authenticated with a challenge-response protocol, so we
    don't bother checking the validity of an identifier in here aside from
    ensuring that it won't throw when using string methods.

*/
const pathFromId = (Env, id) => {
    if (!id || typeof(id) !== 'string') { return; }
    id = Util.escapeKeyCharacters(id);
    return Path.join(Env.paths.base, "mfa", id.slice(0, 2), `${id}.json`);
};

MFA.read = (Env, id, cb, noRedirect) => {
    const storageId = Env.getStorageId(id);
    if (storageId !== Env.myId && !noRedirect) {
        return Core.storageToStorage(Env, id, 'BLOCK_GET_MFA', {
            blockId: id
        }, cb);
    }

    const path = pathFromId(Env, id);
    Basic.read(Env, path, cb);
};

// data should be a string
MFA.write = (Env, id, data, cb) => {
    const path = pathFromId(Env, id);
    Basic.write(Env, path, data, cb);
};

MFA.delete = (Env, id, cb) => {
    const path = pathFromId(Env, id);
    Basic.delete(Env, path, cb);
};

MFA.revoke = (Env, publicKey, cb) => {
    nThen(w => {
        MFA.delete(Env, publicKey, w(err => {
            if (!err) { return; }
            w.abort();
            Env.Log.error('TOTP_REVOKE_MFA_DELETE', {
                error: err,
                publicKey: publicKey,
            });
            cb('MFA_ERROR');
        }));
    }).nThen(() => {
        Sessions.deleteUser(Env, publicKey, err => {
            if (!err) { return; }
            // If we can't delete the sessions, don't send an error, just log to the server.
            // The MFA will still be correctly disabled as long as the first step is done.
            Env.Log.error('TOTP_REVOKE_SESSIONS__DELETE', {
                error: err,
                publicKey: publicKey,
            });
        });
    }).nThen(() => {
        cb(void 0, {
            success: true
        });
    });
};

MFA.copy = (Env, oldKey, newKey, cb) => {
    let content;
    nThen(w => {
        MFA.read(Env, oldKey, w((err, c) => {
            if (err) {
                // No MFA configured, nothing to copy
                w.abort();
                return void cb();
            }
            content = c;
        }));
    }).nThen(() => {
        MFA.write(Env, newKey, content, cb);
    });
};
