// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Config = require("../ws-config.js");
const Interface = require("../common/interface.js");
let Env = {};

// TODO: add consistent hash to know which storage to ask
let getStorageId = function(channelName) {
    return 'storage:0';
};

let wsToStorage = function(command) {
    return function(args, cb, extra) {
        let s = extra.from.split(':');
        if (s[0] !== 'ws') {
            console.error('GET_HISTORY received from unauthorized server:', args, extra);
            cb('UNAUTHORIZED_USER', void 0);
            return;
        }
        let channelName = args.channelName;

        let storage = getStorageId(channelName);

        Env.interface.sendQuery(storage, command, args, function(response) {
            cb(response.error, response.data);
        });
    };
};

let startServers = function() {
    Config.myId = 'core:0';
    let interface = Env.interface = Interface.init(Config);

    let queryToStorage = ['GET_HISTORY', 'GET_METADATA'];
    let COMMANDS = {};
    queryToStorage.forEach(function(command) {
        COMMANDS[command] = wsToStorage(command);
    });

    interface.handleCommands(COMMANDS)
};

startServers();
