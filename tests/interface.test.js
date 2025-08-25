// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors

/* This is a simple ping and pong process that spawns 3 nodes which will send
 * ping requests to a single core process which will answer them with its
 * current timestamp as soon as it receives them.
 */

const test = require("node:test");
const assert = require("node:assert");
const Interface = require("../common/interface.js");
const cli_args = require('minimist')(process.argv.slice(2));
let ITERS = Number(cli_args.iter) || 1000;
let NTRIES = Number(cli_args.tries) || 5;

if (cli_args.h || cli_args.help) {
    console.log('Usage', process.argv[1], '[--argument value]');
    console.log('Arguments:');
    console.log('\t--iter\t\tUse n results for averaging.');
    console.log('\t--tries\t\tThe number full loops.');
    console.log('\t--help -h\tDisplay this help.');
    process.exit(1);
}


let sleep = (ms) => { return new Promise(resolve => setTimeout(resolve, ms)); };

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

let coreStart = (myId) => {
    return new Promise((resolve, reject) => {
        Config.myId = myId;
        Interface.init(Config, (err, _interface) => {
            if (err) { return reject(err); }

            let pingHandler = function(args, cb) {
                cb(void 0, { ping: args, pong: (new Date()).getTime() });
            }

            let COMMANDS = { 'PING': pingHandler };
            _interface.handleCommands(COMMANDS);
            return resolve(_interface);
        });
    });
};

let wsStart = (myId) => {
    return new Promise((resolve, reject) => {
        Config.myId = myId;
        Interface.connect(Config, (err, _interface) => {
            if (err) {
                return reject(err);
            }
            let other = 'core:0';

            let i = 0;
            let timings = [];

            let sendPing = () => {
                return new Promise(resolve => {
                    let leftToRun = 0;
                    for (i = 0; i < NTRIES * ITERS; i++) {
                        leftToRun++;
                        let outcome = _interface.sendQuery(other, 'PING', (new Date()).getTime(), function(response) {
                            let now = (new Date()).getTime();
                            let pingTime = response.data.ping;
                            timings[i++ % ITERS] = now - pingTime;
                            if (!(i % ITERS)) {
                                let average = timings.reduce((acc, x) => (acc + x), 0) / ITERS;
                                console.log(`${myId}: Average over ${ITERS}: ${average}ms`)
                            }
                            leftToRun--;
                            if (leftToRun == 0) {
                                return resolve(true);
                            }
                        });
                        if (!outcome) {
                            return resolve(false);
                        }
                    }
                });
            };

            let disconnect = () => {
                _interface.disconnect();
            };

            let reset = function() {
                i = 0;
                timings = [];
            };

            return resolve({ sendPing, reset, disconnect });
        });
    });
};

let clients = [];
let server;

test("Initialize a server", async () => {
    server = await coreStart('core:0');
    assert.ok(server);
});

test("Initialize a client", async () => {
    let client = await wsStart('ws:0');
    assert.ok(clients[0] = client);
});

test("Initialize multiple clients", async () => {
    let client = await wsStart('ws:1');
    assert.ok(clients[1] = client);
    client = await wsStart('ws:2');
    assert.ok(clients[2] = client);
});

test("Launch queries", async () => {
    await sleep(100);
    assert.ok(await clients[0].sendPing());
});

test("Launch multiple queries", async () => {
    clients[0].reset();
    await sleep(50);
    for (let i = 0; i < 3; i++) {
        assert.ok(await clients[i].sendPing());
    };
});

test("Stop clients", () => {
    for (let i = 0; i < 3; i++) {
        clients[i].disconnect();
    }
});

test("Stop server", () => {
    server.disconnect();
})
