const Util = require("./common-util.js");
const Path = require('node:path');
const Fs = require("node:fs");
const readFileBin = require("../storage/stream-file").readFileBin;
const Schedule = require("../storage/schedule");
const Fse = require("fs-extra");
const nThen = require("nthen");

const Decrees = {};

const Utils = Decrees.Utils = {};
const isString = (str) => {
    return typeof(str) === "string";
};
const isInteger = (n) => {
    return !(typeof(n) !== 'number' || isNaN(n) || (n % 1) !== 0);
};
Utils.args_isBoolean = (args) => {
    return !(!Array.isArray(args) || typeof(args[0]) !== 'boolean');
};
Utils.args_isString = (args) => {
    return !(!Array.isArray(args) || !isString(args[0]));
};
Utils.args_isInteger = (args) => {
    return !(!Array.isArray(args) || !isInteger(args[0]));
};
Utils.args_isPositiveInteger = (args) => {
    return Array.isArray(args) && isInteger(args[0]) && args[0] > 0;
};

Decrees.create = (name, commands) => {
    // [<command>, <args>, <author>, <time>]
    const handleCommand = (Env, line) => {
        let command = line[0];
        let args = line[1];

        if (typeof(commands[command]) !== 'function') {
            throw new Error("DECREE_UNSUPPORTED_COMMAND");
        }

        let outcome = commands[command](Env, args);
        return outcome;
    };

    const createLineHandler = (Env) => {
        const Log = Env.Log;

        let index = -1;

        return (err, line) => {
            index++;
            if (err) {
                // Log the error and bail out
                return void Log.error("DECREE_LINE_ERR", {
                    error: err.message,
                    index: index,
                    line: line,
                });
            }

            if (Array.isArray(line)) {
                try {
                    return handleCommand(Env, line);
                } catch (err2) {
                    return void Log.error("DECREE_COMMAND_ERR", {
                        error: err2.message,
                        index: index,
                        line: line,
                    });
                }
            }

            Log.error("DECREE_HANDLER_WEIRD_LINE", {
                line: line,
                index: index,
            });
        };
    };

    const loadRemote = (Env, decrees, cb) => {
        cb ||= () => {};
        if (!Array.isArray(decrees)) {
            return void cb('INVALID_DECREES');
        }
        decrees.forEach(line => {
            if (!Array.isArray(line)) { return; }
            try {
                handleCommand(Env, line);
            } catch {}
        });
        cb();
    };

    const load = (Env, _cb) => {
        Env.scheduleDecree ||= Schedule();

        const toSend = [];

        const cb = Util.once(Util.mkAsync((err) => {
            if (err && err.code !== 'ENOENT') {
                return void _cb(err);
            }
            _cb(void 0, toSend);
        }));

        Env.scheduleDecree.blocking('', (unblock) => {
            const done = Util.once(Util.both(cb, unblock));
            nThen((w) => {
                // ensure that the path to the decree log exists
                Fse.mkdirp(Env.paths.decree, w(function (err) {
                    if (!err) { return; }
                    w.abort();
                    done(err);
                }));
            }).nThen(function () {
                const decreeName = Path.join(Env.paths.decree, name);
                const stream = Fs.createReadStream(decreeName, {
                    start: 0
                });
                const handler = createLineHandler(Env);
                readFileBin(stream, (msgObj, next) => {
                    let text = msgObj.buff.toString('utf8');
                    let line;
                    let changed = false;
                    try {
                        line = JSON.parse(text);
                        changed = handler(void 0, line);
                    } catch (err) {
                        handler(err, text);
                    }
                    if (changed) { toSend.push(line); }
                    next();
                }, (err) => {
                    done(err);
                });
            });
        });
    };

    const write = function (Env, decree, _cb) {
        var path = Path.join(Env.paths.decree, name);
        Env.scheduleDecree.ordered('', function (next) {
            var cb = Util.both(Util.mkAsync(_cb), next);
            Fs.appendFile(path, JSON.stringify(decree) + '\n', cb);
        });
    };

    return {
        handleCommand,
        loadRemote,
        load,
        write
    };
};

module.exports = Decrees;
