// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const Pins = module.exports;

const Fs = require("node:fs");
const Path = require("node:path");
const Util = require("../common/common-util");
const Store = require('./storage/file');

const Semaphore = require('saferphore');
const nThen = require('nthen');

/*  Accepts a reference to an object, and...
    either a string describing which log is being processed (backwards compatibility),
    or a function which will log the error with all relevant data
*/
const createLineHandler = Pins.createLineHandler = (ref, errorHandler) => {
    let fileName;
    if (typeof(errorHandler) === 'string') {
        fileName = errorHandler;
        errorHandler = function (label, data) {
            console.error(label, {
                log: fileName,
                data: data,
            });
        };
    }

    // passing the reference to an object allows us to overwrite accumulated pins
    // make sure to get ref.pins as the result
    // it's a weird API but it's faster than unpinning manually
    let pins = ref.pins = {};
    ref.index = 0;
    ref.first = 0;
    ref.latest = 0; // the latest message (timestamp in ms)
    ref.surplus = 0; // how many lines exist behind a reset


    // Extract metadata from the channel list (#block, #drive)
    let sanitize = (id, isPin) => {
        if (typeof(id) !== "string") { return; }
        let idx = id.indexOf('#');
        if (idx < 0) { return id; }

        let type = id.slice(idx+1);
        let sanitized = id.slice(0, idx);
        if (!isPin) { return sanitized; }

        if (type === 'block') { // Note: teams don't have a block
            ref.block = sanitized;
            return;
        }
        if (type === 'drive') {
            ref.drive = sanitized;
            return sanitized;
        }
        return sanitized;
    };

    return function (line, i) {
        ref.index++;
        if (!Boolean(line)) { return; }

        let l;
        try {
            l = JSON.parse(line);
        } catch (e) {
            return void errorHandler('PIN_LINE_PARSE_ERROR', line);
        }

        if (!Array.isArray(l)) {
            return void errorHandler('PIN_LINE_NOT_FORMAT_ERROR', l);
        }

        if (typeof(l[2]) === 'number') {
            if (!ref.first) { ref.first = l[2]; }
            ref.latest = l[2]; // date
        }

        switch (l[0]) {
            case 'RESET': {
                pins = ref.pins = {};
                if (l[1] && l[1].length) {
                    l[1].forEach((x) => {
                        x = sanitize(x, true);
                        if (!x) { return; }
                        ref.pins[x] = 1;
                    });
                }
                ref.surplus = ref.index;
                // fallthrough
            }
            case 'PIN': {
                l[1].forEach((x) => {
                    x = sanitize(x, true);
                    if (!x) { return; }
                    pins[x] = 1;
                });
                break;
            }
            case 'UNPIN': {
                l[1].forEach((x) => {
                    x = sanitize(x, false);
                    if (!x) { return; }
                    delete pins[x];
                });
                break;
            }
            default:
                errorHandler("PIN_LINE_UNSUPPORTED_COMMAND", l);
        }

        if (i === 0) { // First line when using Pins.load
            if (l[0] === 'PIN' || ref.block) { ref.user = true; } // teams always start with RESET
        }

    };
};


const processPinFile = (pinFile, fileName) => {
    const ref = {};
    const handler = createLineHandler(ref, fileName);
    pinFile.split('\n').forEach(handler);
    return ref;
};

/*
    takes contents of a pinFile (UTF8 string)
    and the pin file's name
    returns an array of of channel ids which are pinned

    throw errors on pin logs with invalid pin data
*/
Pins.calculateFromLog = function (pinFile, fileName) {
    const ref = processPinFile(pinFile, fileName);
    return Object.keys(ref.pins);
};

/*
    pins/
    pins/A+/
    pins/A+/A+hyhrQLrgYixOomZYxpuEhwfiVzKk1bBp+arH-zbgo=.ndjson
*/

Pins.load = (cb, config) => {
    // XXX eviction
    throw new Error("EVICTION NOT IMPLEMENTED");


    const sema = Semaphore.create(config.workers || 5);

    let dirList;
    const fileList = [];
    const pinned = {};

    var pinPath = config.pinPath || './pins';
    var done = Util.once(cb);
    var handler = config.handler;
    let store;

    nThen((waitFor) => {
        Store.create({
            filePath: config.pinPath,
            volumeId: 'pins'
        }, waitFor((err, _) => {
            if (err) {
                waitFor.abort();
                return void done(err);
            }
            store = _;
        }));
    }).nThen((waitFor) => {
        // recurse over the configured pinPath, or the default
        Fs.readdir(pinPath, waitFor((err, list) => {
            if (err) {
                if (err.code === 'ENOENT') {
                    dirList = [];
                    return; // this ends up calling back with an empty object
                }
                waitFor.abort();
                return void done(err);
            }
            dirList = list;
        }));
    }).nThen((waitFor) => {
        dirList.forEach((f) => {
            sema.take((returnAfter) => {
                // iterate over all the subdirectories in the pin store
                Fs.readdir(Path.join(pinPath, f), waitFor(returnAfter((err, list2) => {
                    if (err) {
                        waitFor.abort();
                        return void done(err);
                    }
                    list2.forEach((ff) => {
                        if (config && config.exclude && config.exclude.indexOf(ff) > -1) { return; }
                        fileList.push(ff.replace(/(\.ndjson)$/, ''));
                    });
                })));
            });
        });
    }).nThen((waitFor) => {
        fileList.forEach((id) => {
            sema.take((returnAfter) => {
                var next = waitFor(returnAfter());
                var ref = {};
                var h = createLineHandler(ref, id);
                store.readMessagesBin(id, 0, (msgObj, next) => {
                    h(msgObj.buff.toString('utf8'));
                    next();
                }, (err) => {
                    if (err) {
                        waitFor.abort();
                        return void done(err);
                    }
                    if (handler) {
                        return void handler(ref, id, next);
                    }
                    const hashes = Object.keys(ref.pins);
                    hashes.forEach((x) => {
                        (pinned[x] = pinned[x] || {})[id] = 1;
                    });
                    next();
                });
            });
        });
    }).nThen(() => {
        done(void 0, pinned);
    });
};

