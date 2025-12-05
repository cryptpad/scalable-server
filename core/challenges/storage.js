// SPDX-FileCopyrightText: 2023 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const Util = require("../../common/common-util");

// Send all commands to storage directly

const add = (list, autocomplete = []) => {
    const Commands = {};
    list.forEach(cmd => {
        const command = Commands[cmd] = (Env, body, cb) => {
            const safeKey = Util.escapeKeyCharacters(body.publicKey);
            const storageId = Env.getStorageId(safeKey);
            Env.interface.sendQuery(storageId, `${cmd}`, body, res => {
                cb(res.error, res.data);
            });
        };
        command.complete = (Env, body, cb) => {
            if (autocomplete.includes(cmd)) {
                return void cb();
            }
            const safeKey = Util.escapeKeyCharacters(body.publicKey);
            const storageId = Env.getStorageId(safeKey);
            Env.interface.sendQuery(storageId, `${cmd}_COMPLETE`, body, res => {
                cb(res.error, res.data);
            });
        };
    });
    return Commands;
};

module.exports = { add };
