// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Config = require("../ws-config.js");
const Interface = require("../common/interface.js");
let Env = {};

let getHistoryHandler = function(args, cb, extra) {
    let s = extra.from.split(':');
    if (s[0] !== 'ws') {
        console.error('GET_HISTORY received from unauthorized server:', args, extra);
        cb('UNAUTHORIZED_USER', void 0);
        return;
    }

    // TODO: add consistent hash to know which storage to ask
    let storage = 'storage:0';
    Env.interface.sendQuery(storage, 'GET_HISTORY', args, function(error, data) {
        cb(error, data);
    });
}

let startServers = function() {
    Config.myId = 'core:0';
    let interface = Env.interface = Interface.init(Config);

    let COMMANDS = {
        'GET_HISTORY': getHistoryHandler,
    };

    interface.handleCommands(COMMANDS)
};

startServers();
