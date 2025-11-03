// SPDX-FileCopyrightText: 2023 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const Util = require("../../common/common-util");
const Commands = module.exports;

// Send all commands to storage directly
[
    'TOTP_SETUP',
    'TOTP_VALIDATE',
    'TOTP_MFA_CHECK',
    'TOTP_REVOKE',
    'TOTP_WRITE_BLOCK',
    'TOTP_REMOVE_BLOCK'
].forEach(cmd => {
    const command = Commands[cmd] = (Env, body, cb) => {
        const safeKey = Util.escapeKeyCharacters(body.publicKey);
        const storageId = Env.getStorageId(safeKey);
        Env.interface.sendQuery(storageId, `${cmd}`, body, res => {
            cb(res.error, res.data);
        });
    };
    command.complete = (Env, body, cb) => {
        if (cmd === 'TOTP_MFA_CHECK') {
            return void cb();
        }
        const safeKey = Util.escapeKeyCharacters(body.publicKey);
        const storageId = Env.getStorageId(safeKey);
        Env.interface.sendQuery(storageId, `${cmd}_COMPLETE`, body, res => {
            cb(res.error, res.data);
        });
    };

});

