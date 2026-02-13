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
            info: writeLog(verbose ? console.log : noop),
            verbose: writeLog(verbose ? console.info : noop),
            error: writeLog(console.error),
            warn: writeLog(console.warn),
            debug: writeLog(console.debug),
            feedback: writeLog(console.log)
        };
    }

    return {
        info: writeLog(toLog.includes('info') ? console.log : noop),
        verbose: writeLog(toLog.includes('verbose') ? console.log : noop),
        error: writeLog(toLog.includes('error') ? console.error : noop),
        warn: writeLog(toLog.includes('warn') ? console.warn : noop),
        debug: writeLog(toLog.includes('debug') ? console.debug : noop),
        feedback: writeLog(toLog.includes('feedback') ? console.log : noop),
    };
};

module.exports = Logger;

