// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const WebSocket = require("ws");

/* This function initializes the different ws connections from the Ws and
    * Storage components
    * config contains:
    * - ../config.js
    * - whoami */
let connect = function(config) {
    const myId = config.id;

    let wsConnect = function(server) {
        let ws = WebSocket('ws://' + server.host + ':' + server.port)
            .on('error', function(err) {
                console.error('WebSocket Connection error:', err);
            })
            .on('close', function() {
                delete ws;
            });
        return ws;
    }

    let ws = [];
    // Connect to each core
    // TODO: error handling
    config.infra.core.forEach((server, i) => {
        ws[i] = wsConnect(server);
    });

    ws.forEach((wsConnection, i) => {
        /* TODO: error handling */
        if (!wsConnection) {
            // setTimeout?
            console.log('Error while connecting with core server ', i);
        }
    });

    let disconnect = function() {

    };

    let sendEvent = function(dest, command, args) {
        let msg = { CMD: command, ARGS: args, FROM: myId };
        let wsDest = ws[dest];
        if (!wsDest) {
            console.error('Server ', dest, ' unreachable');
            return false;
        }
        wsDest.send(JSON.stringify(msg));
        return true;
    };

    let sendQuery = function(dest, command, args, cb) {
        let msg = { CMD: command, ARGS: args, FROM: myId };
        let wsDest = ws[dest];
        if (!wsDest) {
            console.error('Server ', dest, ' unreachable');
            return false;
        }
        wsDest.send(JSON.stringify(msg));
        // TODO: handle callback
    };

    let onMessage = function(data) {
        let msg = {};
        try {
            msg = JSON.parse(data);
        } catch (err) {
            console.log('JSON parse error:', e)
            return;
        }
        return msg;
    };

    return { sendEvent, sendQuery, onMessage, disconnect };
};

/* This function initializes the different ws servers on the Core components */
let init = function(config) {
    let disconnect = function() {
    };

    let sendEvent = function(dest, command, args) {
    };

    let sendQuery = function(dest, command, args, cb) {
    };

    let onMessage = function(data) {
    };

    return { sendEvent, sendQuery, onMessage, disconnect };
};

module.exports = { connect, init };
