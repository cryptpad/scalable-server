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

let config = require('./config/config.json');
const infra = require('./config/infra.json');
config.infra = infra;

const Log = {
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
};

const start_node = (type, index) => {
    Log.log(`Starting: ${type}:${index}`);
    let node_process;
    node_process = fork('./build/' + type + '.js');
    const init_config = {
        name: `${type}:${index}`,
        index,
        config
    };
    node_process.send(init_config);
    node_process.on('message', (message) => {
        if (message.msg === 'READY') {
            console.log(`Started: ${type}:${message.index}`);
        }
    });
};

const cores_ready = () => {
    config?.infra?.websocket?.forEach((_, index) => {
        start_node('websocket', index);
    });
    config?.infra?.storage?.forEach((_, index) => {
        start_node('storage', index);
    });
};

const corePromises = config?.infra?.core.map((_, index) => new Promise((resolve) => {
    console.log(`Starting: core:${index}`);
    let core_process = fork('build/core.js');
    const init_config = {
        name: `core:${index}`,
        index,
        config
    };
    core_process.send(init_config);
    core_process.on('message', (message) => {
        if (message.msg === 'READY') {
            console.log(`Started: core:${message.index}`);
            return resolve();
        }
    });
}));

Promise.all(corePromises)
    .then(() => { cores_ready(); })
    .catch((e) => { return Log.error(e); });
