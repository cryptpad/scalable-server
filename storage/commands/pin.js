// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const Core = require("../../common/core");

const Fs = require('node:fs');
const Pinning = module.exports;
const Util = require("../../common/common-util");
const nThen = require("nthen");

const escapeKeyCharacters = Util.escapeKeyCharacters;
const unescapeKeyCharacters = Util.unescapeKeyCharacters;

const sumChannelSizes = (sizes) => {
    // FIXME this synchronous code could be done by a worker // XXX
    return Object.keys(sizes).map(function (id) { return sizes[id]; })
        .filter(function (x) {
            // only allow positive numbers
            return !(typeof(x) !== 'number' || x <= 0);
        })
        .reduce(function (a, b) { return a + b; }, 0);
};

// FIXME it's possible for this to respond before the server has had a chance
// to fetch the limits. Maybe we should respond with an error...
// or wait until we actually know the limits before responding
const getLimit = Pinning.getLimit = (Env, safeKey, cb) => {
    let unsafeKey = unescapeKeyCharacters(safeKey);
    let limit = Env.limits[unsafeKey];
    let defaultLimit = typeof(Env.defaultStorageLimit) === 'number'?
        Env.defaultStorageLimit: Core.DEFAULT_LIMIT;

    let toSend = limit && typeof(limit.limit) === "number"?
        [limit.limit, limit.plan, limit.note] : [defaultLimit, '', ''];

    cb(void 0, toSend);
};

const getMultipleFileSize = Pinning.getMultipleFileSize = (Env, channels, cb, noRedirect) => {
    cb = Util.once(cb);
    const storages = Core.getChannelsStorage(Env, channels);
    const toSend = [];
    let toKeep;
    Object.keys(storages).forEach(storageId => {
        const _channels = storages[storageId];
        if (storageId !== Env.myId) {
            Array.prototype.push.apply(toSend, _channels);
            return;
        }
        toKeep = _channels;
    });

    let result = {};
    nThen(w => {
        if (toSend.length && !noRedirect) {
            // FIXME don't always send to core:0
            Env.interface.sendQuery('core:0',
                'GET_MULTIPLE_FILE_SIZE', toSend, w(res => {
                if (res.error) {
                    w.abort();
                    return void cb(res.error);
                }
                Util.extend(result, res.data);
            }));
        }
        if (toKeep && toKeep.length) {
            Env.worker.getMultipleFileSize(toKeep, w((err, value) => {
                if (err) {
                    w.abort();
                    return void cb(res.error);
                }
                Util.extend(result, value);
            }));
        }
    }).nThen(() => {
        cb(void 0, result);
    });
};

const loadUserPins = (Env, safeKey, cb) => {
    const session = Core.getSession(Env.pin_cache, safeKey);

    if (session.channels) {
        return cb(session.channels);
    }

    Env.batchUserPins(safeKey, cb, (done) => {
        Env.getPinState(safeKey, (err, value) => {
            if (!err) {
                // only put this into the cache if it completes
                session.channels = value;
            }
            done(value);
        });
    });
};

const truthyKeys = (O) => {
    try {
        return Object.keys(O).filter(function (k) {
            return O[k];
        });
    } catch (err) {
        return [];
    }
};

const getChannelList = Pinning.getChannelList =
                    (Env, safeKey, _cb, noRedirect) => {
    const cb = Util.once(Util.mkAsync(_cb));

    const storageId = Env.getStorageId(safeKey);
    if (storageId !== Env.myId && !noRedirect) {
        const coreId = Env.getCoreId(safeKey);
        return Env.interface.sendQuery(coreId, 'GET_CHANNEL_LIST', {
            safeKey
        }, res => {
            cb(res.data || []);
        });
    }

    loadUserPins(Env, safeKey, (pins) => {
        cb(truthyKeys(pins));
    });
};

Pinning.getChannelsTotalSize = (Env, channels, cb, noRedirect) => {
    cb = Util.once(cb);
    const storages = Core.getChannelsStorage(Env, channels);
    const toSend = [];
    let toKeep;
    Object.keys(storages).forEach(storageId => {
        const _channels = storages[storageId];
        if (storageId !== Env.myId) {
            Array.prototype.push.apply(toSend, _channels);
            return;
        }
        toKeep = _channels;
    });

    let result = 0;
    nThen(w => {
        if (toSend.length && !noRedirect) {
            // FIXME don't always send to core:0
            Env.interface.sendQuery('core:0',
                'GET_CHANNELS_TOTAL_SIZE', toSend, w(res => {
                if (res.error || typeof(res.data) !== "number") {
                    w.abort();
                    return void cb(res.error);
                }
                result += res.data;
            }));
        }
        if (toKeep && toKeep.length) {
            Env.worker.getTotalSize(toKeep, w((err, value) => {
                if (err) {
                    w.abort();
                    return void cb(res.error);
                }
                result += value;
            }));
        }
    }).nThen(() => {
        cb(void 0, result);
    });

};

Pinning.getTotalSize = (Env, safeKey, cb, noRedirect) => {
    const unsafeKey = unescapeKeyCharacters(safeKey);
    const limit = Env.limits[unsafeKey];

    // Get a common key if multiple users share the same quota, otherwise take the public key
    const batchKey = (limit && Array.isArray(limit.users)) ? limit.users.join('') : safeKey;

    const storageId = Env.getStorageId(batchKey);
    if (Env.myId !== storageId && !noRedirect) {
        const coreId = Env.getCoreId(batchKey);
        return Env.interface.sendQuery(coreId, 'GET_TOTAL_SIZE', {
            safeKey,
            batchKey
        }, res => {
            cb(res.error, res.data);
        });
    }

    Env.batchTotalSize(batchKey, cb, (done) => {
        const channels = [];

        const addUnique = function (channel) {
            if (channels.indexOf(channel) !== -1) { return; }
            channels.push(channel);
        };

        nThen((waitFor) => {
            // Get the channels list for our user account
            getChannelList(Env, safeKey, waitFor(_channels => {
                if (!_channels) {
                    waitFor.abort();
                    return done('INVALID_PIN_LIST');
                }
                _channels.forEach(addUnique);
            }));
            // Get the channels list for users sharing our quota
            if (limit && Array.isArray(limit.users) && limit.users.length > 1) {
                limit.users.forEach((key) => {
                    if (key === unsafeKey) { return; } // Don't count ourselves twice
                    getChannelList(Env, key, waitFor(_channels => {
                        if (!_channels) { return; } // Broken user, don't count their quota
                        _channels.forEach(addUnique);
                    }));
                });
            }
        }).nThen(() => {
            Pinning.getChannelsTotalSize(Env, channels, done);
        });
    });
};

/*  Users should be able to clear their own pin log with an authenticated RPC
*/
Pinning.removePins = (Env, safeKey, cb) => {
    Env.pinStore.archiveChannel(safeKey, undefined, err => {
        Env.Log.info('ARCHIVAL_PIN_BY_OWNER_RPC', {
            safeKey: safeKey,
            status: err? String(err): 'SUCCESS',
        });

        if (err) { return void cb(err); }
        cb(void 0, 'OK');
    });
};

Pinning.trimPins = (Env, safeKey, cb) => {
    cb("NOT_IMPLEMENTED");
};

const getFreeSpace = Pinning.getFreeSpace = (Env, safeKey, cb) => {
    getLimit(Env, safeKey, (e, limit) => {
        if (e) { return void cb(e); }
        Pinning.getTotalSize(Env, safeKey, (e, size) => {
            if (typeof(size) === 'undefined') { return void cb(e); }

            const rem = limit[0] - size;
            if (typeof(rem) !== 'number') {
                return void cb('invalid_response');
            }
            cb(void 0, rem);
        });
    });
};

Pinning.getHash = (Env, safeKey, cb) => {
    getChannelList(Env, safeKey, (channels) => {
        Env.hashChannelList(channels, cb);
    });
};

Pinning.pinChannel = (Env, safeKey, channels, cb) => {
    if (!channels && channels.filter) {
        return void cb('INVALID_PIN_LIST');
    }

    // get channel list ensures your session has a cached channel list
    getChannelList(Env, safeKey, (pinned) => {
        const session = Core.getSession(Env.pin_cache, safeKey);

        // only pin channels which are not already pinned
        const toStore = channels.filter((channel) => {
            return channel && pinned.indexOf(channel) === -1;
        });

        if (toStore.length === 0) {
            return void cb();
        }

        let pin = () => {
            Env.pinStore.message(safeKey, JSON.stringify([
                'PIN', toStore, +new Date()
            ]), (e) => {
                if (e) { return void cb(e); }
                if (!session || !session.channels) { return void cb(); }
                toStore.forEach((channel) => {
                    session.channels[channel] = true;
                });
                cb();
            });
        };

        // Support tickets are always pinned, no need to check the limit
        if (safeKey === escapeKeyCharacters(Env.supportPinKey)) {
            return void pin();
        }

        getMultipleFileSize(Env, toStore, (e, sizes) => {
            if (typeof(sizes) === 'undefined') { return void cb(e); }
            const pinSize = sumChannelSizes(sizes);

            getFreeSpace(Env, safeKey, (e, free) => {
                if (typeof(free) === 'undefined') {
                    Env.Log.warn('getFreeSpace', e);
                    return void cb(e);
                }
                if (pinSize > free) { return void cb('E_OVER_LIMIT'); }

                pin();
            });
        });
    });
};

Pinning.unpinChannel = (Env, safeKey, channels, cb) => {
    if (!channels && channels.filter) {
        // expected array
        return void cb('INVALID_PIN_LIST');
    }

    getChannelList(Env, safeKey, (pinned) => {
        const session = Core.getSession(Env.pin_cache, safeKey);

        // only unpin channels which are pinned
        const toStore = channels.filter((channel) => {
            return channel && pinned.indexOf(channel) !== -1;
        });

        if (toStore.length === 0) {
            return void cb();
        }

        Env.pinStore.message(safeKey, JSON.stringify([
            'UNPIN', toStore, +new Date()
        ]), (e) => {
            if (e) { return void cb(e); }
            toStore.forEach((channel) => {
                delete session.channels[channel];
            });
            cb();
        });
    });
};

Pinning.resetUserPins = (Env, safeKey, channelList, _cb) => {
    const cb = Util.once(Util.mkAsync(_cb));
    if (!Array.isArray(channelList)) { return void cb('INVALID_PIN_LIST'); }
    const session = Core.getSession(Env.pin_cache, safeKey);


    if (!channelList.length) {
        return void cb();
    }

    let reset = () => {
        const pins = {};
        Env.pinStore.message(safeKey, JSON.stringify([
            'RESET', channelList, +new Date()
        ]), (e) => {
            if (e) { return void cb(e); }
            channelList.forEach((channel) => {
                pins[channel] = true;
            });

            // update in-memory cache IFF the reset was allowed.
            if (session) { session.channels = pins; }
            cb();
        });
    };

    // Support tickets are always pinned, no need to check the limit
    if (safeKey === escapeKeyCharacters(Env.supportPinKey)) {
        return void reset();
    }

    getMultipleFileSize(Env, channelList, (e, sizes) => {
        if (typeof(sizes) === 'undefined') { return void cb(e); }
        const pinSize = sumChannelSizes(sizes);


        getLimit(Env, safeKey, (e, limit) => {
            if (e) {
                Env.Log.warn('[RESET_ERR]', e);
                return void cb(e);
            }

            /*  we want to let people pin, even if they are over their limit,
                but they should only be able to do this once.

                This prevents data loss in the case that someone registers, but
                does not have enough free space to pin their migrated data.

                They will not be able to pin additional pads until they upgrade
                or delete enough files to go back under their limit. */
            if (pinSize > limit[0] && session.hasPinned) {
                return void(cb('E_OVER_LIMIT'));
            }
            reset();
        });
    });
};

Pinning.getFileSize = (Env, channel, cb) => {
    Env.worker.getFileSize(channel, cb);
};

/*  accepts a list, and returns a sublist of channel or file ids which seem
    to have been deleted from the server (file size 0)

    we might consider that we should only say a file is gone if fs.stat returns
    ENOENT, but for now it's simplest to just rely on getFileSize...
*/
Pinning.getDeletedPads = (Env, channels, cb) => {
    Env.worker.getDeletedPads(channels, cb);
};

const computeRegisteredUsers = (Env, cb) => {
    Env.batchRegisteredUsers('', cb, (done) => {
        const dir = Env.paths.pin;
        let folders;
        let users = 0;
        nThen(waitFor => {
            Fs.readdir(dir, waitFor((err, list) => {
                if (err) {
                    waitFor.abort();
                    return void done(err);
                }
                folders = list;
            }));
        }).nThen(waitFor => {
            folders.forEach((f) => {
                const dir = Env.paths.pin + '/' + f;
                Fs.readdir(dir, waitFor((err, list) => {
                    if (err) { return; }
                    // Don't count placeholders
                    list = list.filter(name => {
                        return !/\.placeholder$/.test(name);
                    });
                    users += list.length;
                }));
            });
        }).nThen(() => {
            done(void 0, {users});
        });
    });
};
Pinning.getRegisteredUsers = (Env, cb) => {
    if (Env.myId !== "storage:0") {
        return void computeRegisteredUsers(Env, cb);
    }

    let users = 0;
    const onResult = (err, value) => {
        if (err || typeof(value?.users) !== "number") {
            Env.Log.error("GET_REGISTERED_USERS_ERR", err);
            return;
        }
        users += value?.users;
    };

    nThen(waitFor => {
        Env.interface.sendQuery('core:0', 'GET_REGISTERED_USERS', {},
            waitFor(res => { onResult(res.error, res.data); }));

        computeRegisteredUsers(Env, waitFor(onResult));
    }).nThen(() => {
        cb(void 0, {users});
    });
};
