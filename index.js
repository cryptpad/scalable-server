// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later
const { fork } = require('child_process')
const Crypto = require('crypto');
const cliArgs = require("minimist")(process.argv.slice(2));

// XXX:  add some process to start nodes individually
if (cliArgs.h || cliArgs.help) {
    console.log(`Usage ${process.argv[1]}:`);
    console.log("\t--help, -h\tDisplay this help");
    console.log("\t--type,-t\tSet the core type (if unset, starts every core)");
    console.log("\t--index,-i\tSet the core node index (default: 0)");
    process.exit(1);
}

let serverConfig = require('./config/config.json');
const infraConfig = require('./config/infra.json');

const Log = {
    debug: console.debug,
    error: console.error,
    info: console.log,
    verbose: console.info,
    warn: console.warn
};

const startNode = (type, index, forking, cb) => {
    if (typeof (cb) !== 'function') { cb = () => { }; };

    const nodeFile = './build/' + type + '.js';
    const initConfig = {
        myId: `${type}:${index}`,
        index,
        server: serverConfig,
        infra: infraConfig
    };

    Log.info(`Starting: ${initConfig.myId}`);
    if (forking) {
        let nodeProcess = fork(nodeFile);
        nodeProcess.send(initConfig);
        nodeProcess.on('message', (message) => {
            if (message.msg === 'READY') {
                Log.info(`Started: ${type}:${message.index}`);
                cb();
            }
        });
    } else {
        require(nodeFile).start(initConfig);
    }
};

const coresReady = () => {
    infraConfig?.websocket?.forEach((_, index) => {
        startNode('websocket', index, true);
    });
    infraConfig?.storage?.forEach((_, index) => {
        startNode('storage', index, true);
    });
};

const startCores = () => {
    // XXX: add a better way to generate the node shared key
    if (!serverConfig?.private?.nodes_key) {
        if (!serverConfig?.private) {
            serverConfig.private = { };
        }
        serverConfig.private.nodes_key = Buffer.from(Crypto.randomBytes(32), 'base64');
    }
    const corePromises = infraConfig?.core.map((_, index) => new Promise((resolve, reject) => {
        startNode('core', index, true, (err) => {
            if (err) {
                Log.error(err);
                return reject(err);
            }
            return resolve();
        });
    }));

    Promise.all(corePromises)
        .then(() => { coresReady(); })
        .catch((e) => { return Log.error(e); });
};

// Start process

if (cliArgs.type || cliArgs.t) {
    const type = cliArgs.type || cliArgs.t;
    const index = Number(cliArgs.index || cliArgs.i || 0);
    if (!serverConfig?.private?.nodes_key) {
        throw Error('E_MISSINGKEY');
    }
    startNode(type, index, false, (err) => {
        if (err) { return Log.error(err); }
    });
} else {
    startCores();
}
