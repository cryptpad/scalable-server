// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later
const Util = require("../common-util.js");
const ChannelManager = require("../channel_manager.js");
const Meta = require("../commands/metadata.js");

const Env = {};
let ready = false;

const init = (conf, _cb) => {
    const cb = Util.once(Util.mkAsync(_cb));
    if (!conf) {
        return void cb('E_INVALID_CONFIG');
    };

    Env.paths = {
        baseDir: conf.baseDir,
    };

    Env.CM = ChannelManager.create(Env, Env.paths.baseDir);
};

let computeIndex = (data, cb) => {
    if (!data || !data.channel) {
        return void cb('E_NO_CHANNEL');
    }

    Env.CM.computeIndex(data.channel, cb);
};

let computeMetadata = (data, cb) => {
    if (!data || !data.channel) {
        return void cb('E_NO_CHANNEL');
    }
    Meta.computeMetadata(Env, data.channel, cb);
};

const COMMANDS = {
    COMPUTE_INDEX: computeIndex,
    COMPUTE_METADATA: computeMetadata,
};

process.on('message', function(data) {
    if (!data || !data.txid || !data.pid) {
        return void process.send({
            error: 'E_INVAL',
            data: data,
        });
    }

    const cb = function(err, value) {
        process.send({
            error: Util.serializeError(err),
            txid: data.txid,
            pid: data.pid,
            value: value,
        });
    };

    if (!ready) {
        return void init(data.config, function(err) {
            if (err) { return void cb(Util.serializeError(err)); }
            ready = true;
            cb();
        });
    }

    const command = COMMANDS[data.command];
    if (typeof (command) !== 'function') {
        return void cb("E_BAD_COMMAND");
    }
    command(data, cb);
});

process.on('uncaughtException', function(err) {
    console.error('[%s] UNCAUGHT EXCEPTION IN DB WORKER', new Date());
    console.error(err);
    console.error("TERMINATING");
    process.exit(1);
});
