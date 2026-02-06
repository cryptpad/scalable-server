// SPDX-FileCopyrightText: 2026 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// If the last argument of the logger is a function, then it’s an async callback
const Logger = (toLog = [], verbose) => {
    const noop = () => {};

    const writeLog = (f) => function () {
        const args = Array.prototype.slice.call(arguments);
        if (!args.length) { return f(''); }
        let cb = args.pop();
        if (typeof(cb) !== 'function') {
            args.push(cb);
            cb = undefined;
        }
        f.apply(console, args);
        if (cb) { setTimeout(cb); }
    };


    if (!toLog.length) {
        return {
            info: verbose ? writeLog(console.log) : noop,
            verbose: verbose ? writeLog(console.info) : noop,
            error: writeLog(console.error),
            warn: writeLog(console.warn),
            debug: writeLog(console.debug),
            feedback: writeLog(console.log)
        };
    }

    return {
        info: toLog.includes('info') ? writeLog(console.log) : noop,
        verbose: toLog.includes('verbose') ? writeLog(console.log) : noop,
        error: toLog.includes('error') ? writeLog(console.error) : noop,
        warn: toLog.includes('warn') ? writeLog(console.warn) : noop,
        debug: toLog.includes('debug') ? writeLog(console.debug) : noop,
        feedback: toLog.includes('feedback') ? writeLog(console.log) : noop,
    };
};

module.exports = Logger;

