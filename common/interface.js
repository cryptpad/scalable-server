// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const WebSocket = require("ws");
/* This function initializes the different ws connections from the Ws and
    * Storage components
    * config contains:
    * - ../config.js
    * - whoami */
let connect = function(config) {

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
