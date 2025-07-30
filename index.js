// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later
const { fork } = require('child_process')
const cli_args = require("minimist")(process.argv.slice(2));


// XXX:  add some process to start nodes individually
if (cli_args.h || cli_args.help) {
    console.log(`Usage ${process.argv[1]}:`);
    console.log("\t--help, -h\tDisplay this help");
    console.log("\t--type\tSet the core type (if unset, starts every core)");
    console.log("\t--id\tSet the core node id (default: 0)");
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

const start_node = (type, index) => {
    Log.info(`Starting: ${type}:${index}`);
    let node_process;
    node_process = fork('./build/' + type + '.js');
    const init_config = {
        name: `${type}:${index}`,
        index,
        config: {
            server: serverConfig,
            infra: infraConfig
        }
    };
    node_process.send(init_config);
    node_process.on('message', (message) => {
        if (message.msg === 'READY') {
            console.log(`Started: ${type}:${message.index}`);
        }
    });
};

const cores_ready = () => {
    infraConfig?.websocket?.forEach((_, index) => {
        start_node('websocket', index);
    });
    infraConfig?.storage?.forEach((_, index) => {
        start_node('storage', index);
    });
};

const startCores = () => {
    const corePromises = infraConfig?.core.map((_, index) => new Promise((resolve) => {
        console.log(`Starting: core:${index}`);
        let core_process = fork('build/core.js');
        const init_config = {
            name: `core:${index}`,
            index,
            config: {
                server: serverConfig,
                infra: infraConfig,
            }
        };
        core_process.send(init_config);
        core_process.on('message', (message) => {
            if (message.msg === 'READY') {
                Log.info(`Started: core:${message.index}`);
                return resolve();
            }
        });
    }));

    Promise.all(corePromises)
        .then(() => { cores_ready(); })
        .catch((e) => { return Log.error(e); });
};

startCores();
