// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later
const { fork } = require('child_process')
const cli_args = require("minimist")(process.argv.slice(2));

// XXX:  add some process to start nodes individually
if (cli_args.h || cli_args.help) {
    console.log(`Usage ${process.argv[1]}:`);
    console.log("\t--help, -h\tDisplay this help");
    console.log("\t--type,-t\tSet the core type (if unset, starts every core)");
    console.log("\t--index,-i\tSet the core node index (default: 0)");
    return;
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

const start_node = (type, index, do_fork, cb) => {
    if (typeof (cb) !== 'function') { cb = () => { }; };

    const node_file = './build/' + type + '.js';
    const init_config = {
        myId: `${type}:${index}`,
        index,
        server: serverConfig,
        infra: infraConfig
    };

    Log.info(`Starting: ${type}:${index}`);
    if (do_fork) {
        let node_process = fork(node_file);
        node_process.send(init_config);
        node_process.on('message', (message) => {
            if (message.msg === 'READY') {
                Log.info(`Started: ${type}:${message.index}`);
                cb();
            }
        });
    } else {
        require(node_file).start(init_config);
    }
};

const cores_ready = () => {
    infraConfig?.websocket?.forEach((_, index) => {
        start_node('websocket', index, true);
    });
    infraConfig?.storage?.forEach((_, index) => {
        start_node('storage', index, true);
    });
};

const startCores = () => {
    const corePromises = infraConfig?.core.map((_, index) => new Promise((resolve, reject) => {
        start_node('core', index, true, (err) => {
            if (err) {
                Log.error(err);
                return reject(err);
            }
            return resolve();
        });
    }));

    Promise.all(corePromises)
        .then(() => { cores_ready(); })
        .catch((e) => { return Log.error(e); });
};

// Start process

if (cli_args.type || cli_args.t) {
    const type = cli_args.type || cli_args.t;
    const index = Number(cli_args.index || cli_args.i || 0);
    start_node(type, index, false, (err) => {
        if (err) { return Log.error(err); }
    });
    return;
}

startCores();
