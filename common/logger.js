// SPDX-FileCopyrightText: 2026 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later
const Store = require("../storage/storage/file");
const Util = require("./common-util");
const Path = require("node:path");

// various degrees of logging
const logLevels = ['silly', 'verbose', 'debug', 'feedback', 'info', 'warn', 'error'];
const handlers = {};

const messageTemplate = (type, time, tag, info, nodeId) => {
    return JSON.stringify([type.toUpperCase(), time, nodeId, tag, info]);
};

const noop = () => {};

const getDateString = () => {
    const now = new Date();
    const year = String(now.getFullYear());
    const month = String((now.getMonth() + 1)).padStart(2, 0);
    const day = String(now.getDate()).padStart(2,0);
    return `${month}${year}-${month}-${day}`;
};

const wrapCb = (f) => function() {
    const args = Array.prototype.slice.call(arguments);
    if (!args.length) { return f(''); }
    let cb = args.pop();
    if (typeof(cb) !== 'function') {
        args.push(cb);
        cb = undefined;
    }
    f.apply(console, args);
    if (cb) { Util.mkAsync(cb)(); }
};

const write = function (ctx, content, cb) {
    if (!ctx.store) {
        cb = Util.mkAsync(cb);
        return void cb();
    }
    ctx.store.log(`${getDateString()}-${ctx.logId}`, content, cb);
};

['silly', 'debug', 'verbose', 'feedback', 'info'].forEach((level) => {
    handlers[level] =  console.log;
});
handlers['warn'] = console.warn;
handlers['error'] = console.error;

const createLogType = function (ctx, type) {
    if (logLevels.indexOf(type) < logLevels.indexOf(ctx.logLevel)) {
        return wrapCb(noop);
    }
    // arguments: tag, info1, info2, ..., cb
    return function () {
        const args = Array.prototype.slice.call(arguments);
        const tag = args.shift();
        let cb = args.pop();
        if (typeof (cb) !== 'function') {
            args.push(cb);
            cb = noop;
        }
        let info = args.shift() || "";
        if (args.length !== 0) { // Otherwise an issue with objects (and can’t double-stringify)
            // To take into account console.log("send from %s to %s", sender, recv)
            // from external libraries
            if (info.includes('%s')) {
                info = info.replace(/%s/g, () => args.shift());
            } else {
                args.unshift(info);
                info = args.join(' ');
            }
        }
        if (ctx.shutdown) {
            throw new Error("Logger has been shut down!");
        }
        const time = new Date().toISOString();
        let content;
        try {
            content = messageTemplate(type, time, tag, info, ctx.myId);
        } catch (e) {
            return;
        }
        if (ctx.logToStdout && typeof(handlers[type]) === 'function') {
            handlers[type](content);
        }
        ctx.onReady?.reg(() => {
            write(ctx, content, cb);
        }); 
    };
};

const createMethods = function (ctx) {
    const log = {};
    logLevels.forEach(function (type) {
        log[type] = createLogType(ctx, type);
    });

    // Generate a sublogger that reuses the original logger with different
    // logLevel < current logLevel and custom tag
    log.subLogger = (logLevel, tag) => {
        const subLog = {};
        const newctx = ctx;
        ctx.logLevel = logLevel;
        logLevels.forEach(function(level) {
            if (logLevels.indexOf(level) < logLevels.indexOf(newctx.logLevel)) {
                subLog[level] = wrapCb(noop);
            } else {
                subLog[level] = function() {
                    const args = Array.prototype.slice.call(arguments);
                    if (tag) { args.unshift(tag); }
                    log[level].apply(console, args);
                };
            }
        });
        return subLog;
    };
    return log;
};


const Logger = (loggerConfig, myId) => {
    loggerConfig ||= {};
    const logId = myId ? myId.split(':')?.[0] : 'unknown';
    if (typeof(loggerConfig?.logLevel) !== 'string') {
        loggerConfig.logLevel = 'info';
    }

    const ctx = {
        logFeedback: Boolean(loggerConfig.logFeedback),
        logLevel: loggerConfig.logLevel,
        logToStdout: loggerConfig.logToStdout,
        logPath: loggerConfig.logPath,
        logId,
        myId,
    };

    if (!loggerConfig.logPath) {
        console.log(`${myId}: No logPath configured. Logging to file disabled`);
        const logger = createMethods(ctx);
        logger.shutdown = noop;
        return logger;
    }

    ctx.onReady = Util.mkEvent(true);
    // XXX: there can be a bit of an overlap during year changes before
    // restarting the service
    const year = (new Date()).getFullYear().toString();

    Store.create({
        filePath: Path.join(loggerConfig.logPath, year),
        archivePath: loggerConfig.archivePath,
    }, function (err, store) {
        if (err) {
            throw err;
        }
        ctx.store = store;
        ctx.onReady.fire();
    });

    const logger = createMethods(ctx);
    logger.shutdown = () => {
        delete ctx.store;
        ctx.shutdown = true;
        ctx.store.shutdown();
    };
    return Object.freeze(logger);
};

module.exports = Logger;
