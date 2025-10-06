// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Data = module.exports;
const Core = require("../../common/core");
const Util = require("../common-util");
const HKUtil = require("../hk-util");
const Meta = require("../metadata");

const {
    hkId
} = require("../../common/constants.js");

Data.getMetadataRaw = (Env, channel, _cb) => {
    const cb = Util.once(Util.mkAsync(_cb));
    if (!Core.isValidId(channel)) { return void cb('INVALID_CHAN'); }
    if (channel.length !== HKUtil.STANDARD_CHANNEL_LENGTH &&
        channel.length !== HKUtil.ADMIN_CHANNEL_LENGTH &&
        channel.length !== HKUtil.BLOB_ID_LENGTH) { return cb("INVALID_CHAN_LENGTH"); }

    // return synthetic metadata for admin broadcast channels as a safety net
    // in case anybody manages to write metadata
    if (channel.length === HKUtil.ADMIN_CHANNEL_LENGTH) {
        return void cb(void 0, {
            channel: channel,
            creation: +new Date(),
            owners: Env.admins,
        });
    }

    var cached = Env.metadata_cache[channel];
    if (HKUtil.isMetadataMessage(cached)) {
        Env.checkCache(channel);
        return void cb(void 0, cached);
    }

    const batchCb = (err, meta) => {
        if (!err && HKUtil.isMetadataMessage(meta) && !Env.metadata_cache[channel]) {
            Env.metadata_cache[channel] = meta;
            // clear metadata after a delay if nobody has joined the channel within 30s
            Env.checkCache(channel);
        }
        cb(err, meta);
    };

    Env.batchMetadata(channel, batchCb, function(done) {
        Env.worker.computeMetadata(channel, done);
    });
};

Data.getMetadata = (Env, channel, cb, /*Server, netfluxId*/) => {
    throw new Error("MAYBE_NOT_USED"); // XXX
    Data.getMetadataRaw(Env, channel, function (err, metadata) {
        if (err) { return void cb(err); }

        if (!metadata?.restricted) {
            // if it's not restricted then just call back
            return void cb(void 0, metadata);
        }

        // XXX allow list not implemented yet
        throw new Error("NOT_IMPLEMENTED");
    });
};


/* setMetadata
    - write a new line to the metadata log if a valid command is provided
    - data is an object: {
        channel: channelId,
        command: metadataCommand (string),
        value: value
    }
*/
Data.setMetadata = (Env, data, cb) => {
    const { channel, command, safeKey } = data;
    const unsafeKey = Util.unescapeKeyCharacters(safeKey);

    if (!channel || !Core.isValidId(channel)) { return void cb ('INVALID_CHAN'); }
    if (!command || typeof (command) !== 'string') { return void cb('INVALID_COMMAND'); }
    if (Meta.commands.indexOf(command) === -1) { return void cb('UNSUPPORTED_COMMAND'); }

    Env.queueMetadata(channel, (next) => {
        Data.getMetadataRaw(Env, channel, (err, metadata) => {
            if (err) {
                cb(err);
                return void next();
            }
            if (!Core.hasOwners(metadata)) {
                cb('E_NO_OWNERS');
                return void next();
            }

            // if you are a pending owner and not an owner
            // you can either ADD_OWNERS, or RM_PENDING_OWNERS
            // and you should only be able to add yourself as an owner
            // everything else should be rejected

            // else if you are not an owner
            // you should be rejected

            // else write the command

            if (Core.hasPendingOwners(metadata) &&
                Core.isPendingOwner(metadata, unsafeKey) &&
                        !Core.isOwner(metadata, unsafeKey)) {

                // If you are a pending owner, make sure you can
                // only add yourelf as an owner
                if ((command !== 'ADD_OWNERS' && command !== 'RM_PENDING_OWNERS')
                        || !Array.isArray(data.value)
                        || data.value.length !== 1
                        || data.value[0] !== unsafeKey) {
                    cb('INSUFFICIENT_PERMISSIONS');
                    return void next();
                }
                // fallthrough
            } else if (!Core.isOwner(metadata, unsafeKey)) {
                cb('INSUFFICIENT_PERMISSIONS');
                return void next();
            }

            // Add the new metadata line
            const line = [command, data.value, +new Date()];
            let changed = false;
            try {
                changed = Meta.handleCommand(metadata, line);
            } catch (e) {
                cb(e);
                return void next();
            }

            // if your command is valid but it didn't result in any
            // change to the metadata, call back now and don't write
            // any "useless" line to the log
            if (!changed) {
                cb(void 0, metadata);
                return void next();
            }
            // otherwise, write the change
            const str = JSON.stringify(line);
            Env.store.writeMetadata(channel, str, e => {
                if (e) {
                    cb(e);
                    return void next();
                }

                // send the message back to the person who changed it
                // since we know they're allowed to see it
                cb(void 0, metadata);
                next();

                const metadata_cache = Env.metadata_cache;

                // update the cached metadata
                metadata_cache[channel] = metadata;
                Env.checkCache(channel);

                // it's easy to check if the channel is restricted
                const isRestricted = metadata.restricted;
                // and these values will be used in any case
                const s_metadata = JSON.stringify(metadata);

                const channelData = Env.channel_cache[channel] || {};

                const fullMessage = [
                    0,
                    hkId,
                    "MSG",
                    channel, // should be replaced by user.id
                    s_metadata
                ];

                const coreId = Env.getCoreId(channel);

                if (!isRestricted) {
                    // pre-allow-list behaviour
                    // if it's not restricted, broadcast the new metadata to everyone
                    return Env.interface.sendEvent(coreId,
                        'HISTORY_CHANNEL_MESSAGE', {
                        users: channelData.users || [],
                        message: fullMessage
                    });
                }

                // otherwise derive the list of users (unsafeKeys)
                // that are allowed to stay
                const allowed = HKUtil.listAllowedUsers(metadata);
                // anyone who is not allowed will get the same error
                const s_error = JSON.stringify({
                    error: 'ERESTRICTED',
                    channel: channel,
                });

                // iterate over the channel's userlist
                const toRemove = [];
                (channelData.users || []).forEach(userId => {
                    const coreRpc = Env.getCoreId(userId);
                    Env.interface.sendQuery(coreRpc, 'GET_AUTH_KEYS', {
                        userId
                    }, res => {
                        const authKeys = res?.data || {};

                        // if the user is allowed to remain,
                        // send them the metadata
                        if (HKUtil.isUserSessionAllowed(allowed, authKeys)) {
                            fullMessage[4] = s_metadata;
                            return Env.interface.sendEvent(coreId,
                                'HISTORY_CHANNEL_MESSAGE', {
                                users: [userId],
                                message: fullMessage.slice()
                            });
                        }
                        // otherwise they are not in the list.
                        // send them an error and kick them out!
                        fullMessage[4] = s_error;
                        toRemove.push(userId);
                        Env.interface.sendEvent(coreId,
                            'HISTORY_CHANNEL_MESSAGE', {
                            users: [userId],
                            message: fullMessage.slice()
                        });
                    });
                });

                let list = channelData.users || [];
                toRemove.forEach(userId => {
                    let idx = list.indexOf(userId);
                    if (idx === -1) { return; }
                    list.splice(idx, 1);
                });
            });
        });
    });
};
