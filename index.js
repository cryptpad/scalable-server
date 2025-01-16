// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later
const { fork } = require('child_process')
const Config = require('./ws-config')
let cores_pending = 0;

const start_node = (type, id) => {
    console.log(`Start: ${type}:${id}`);
    let node_process;
    // TODO: replace this port computation with something without potential
    // collisions with the config file
    if (type === 'ws') {
        node_process = fork('websocket/index.js', ['--id', id, '--port', 3000 + id]);
    } else {
        node_process = fork(type + '/index.js', ['--id', id]);
    }
    node_process.on('message', (message) => {
        if (message.msg === 'READY') {
            console.log(`Started: ${type}:${message.idx}`);
        }
    });
};

const cores_ready = () => {
    Config.infra.ws.forEach((_, id) => {
        start_node('ws', id);
    });
    Config.infra.storage.forEach((_, id) => {
        start_node('storage', id);
    });
};

Config.infra.core.forEach((_, id) => {
    console.log(`Start: core:${id}`);
    let core_process = fork('core/index.js', ['--id', id]);
    cores_pending++;
    core_process.on('message', (message) => {
        if (message.msg === 'READY') {
            console.log(`Started: core:${message.idx}`);
            cores_pending--;
            if (!cores_pending) {
                cores_ready();
            }
        }
    });
});
