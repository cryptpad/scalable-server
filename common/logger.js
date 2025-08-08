const Logger = (toLog = [], verbose) => {
    const noop = () => {};

    if (!toLog.length) {
        return {
            info: console.log,
            verbose: verbose ? console.info : noop,
            error: console.error,
            warn: console.warn,
            debug: console.debug
        };
    }

    return {
        info: toLog.includes('info') ? console.log : noop,
        verbose: toLog.includes('verbose') ? console.log : noop,
        error: toLog.includes('error') ? console.error : noop,
        warn: toLog.includes('warn') ? console.warn : noop,
        debug: toLog.includes('debug') ? console.debug : noop,
    };
};

module.exports = Logger;

