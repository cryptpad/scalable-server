// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors

/* This is a simple ping and pong process that spawns 3 nodes which will send
 * ping requests to a single core process which will answer them with its
 * current timestamp as soon as it receives them.
 */

const Interface = require("../common/interface.js");
const ITERS = 500;
const NTRIES = 5;

let Config = {
    infra: {
        core: [{
            host: 'localhost',
            port: 3010
        }],
        ws: [{
            host: 'localhost',
            port: 3012
        }, {
            host: 'localhost',
            port: 3013
        }, {
            host: 'localhost',
            port: 3014
        }]
    }
};

let coreStart = function(myId) {
    Config.myId = myId;
    let interface = Interface.init(Config);
    let other = 'ws:0';

    let pingHandler = function(args, cb, extra) {
        cb(void 0, { ping: args, pong: (new Date()).getTime() });
    }

    let COMMANDS = { 'PING': pingHandler };
    interface.handleCommands(COMMANDS);
};

let wsStart = function(myId) {
    Config.myId = myId;
    let interface = Interface.connect(Config);
    let other = 'core:0';

    let i = 0;
    let timings = [];

    let sendPing = async function() {
        interface.sendQuery(other, 'PING', (new Date()).getTime(), function(response) {
            let now = (new Date()).getTime();
            let pingTime = response.data.ping;
            timings[i++ % ITERS] = now - pingTime;
            if (!(i % ITERS)) {
                let average = timings.reduce((acc, x) => (acc + x), 0) / ITERS;
                console.log(`${myId}: Average over ${ITERS}: ${average}ms`)
            }
        });
        if (i < NTRIES * ITERS) {
            setTimeout(sendPing);
        } else {
            // TODO: implement disconnects
            interface.disconnect();
        }
    };
    setTimeout(sendPing, 300);
};

coreStart('core:0');

wsStart('ws:0');
wsStart('ws:1');
wsStart('ws:2');
