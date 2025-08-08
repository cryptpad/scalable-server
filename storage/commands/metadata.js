// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Data = module.exports;
const Core = require("./core");
const Util = require("../common-util");
const HK = require("../hk-util");

Data.getMetadataRaw = (Env, channel, _cb) => {
    const cb = Util.once(Util.mkAsync(_cb));
    if (!Core.isValidId(channel)) { return void cb('INVALID_CHAN'); }
    if (channel.length !== HK.STANDARD_CHANNEL_LENGTH &&
        channel.length !== HK.ADMIN_CHANNEL_LENGTH &&
        channel.length !== HK.BLOB_ID_LENGTH) { return cb("INVALID_CHAN_LENGTH"); }

    // return synthetic metadata for admin broadcast channels as a safety net
    // in case anybody manages to write metadata
    if (channel.length === HK.ADMIN_CHANNEL_LENGTH) {
        return void cb(void 0, {
            channel: channel,
            creation: +new Date(),
            owners: Env.admins, // XXX Env.admins not implemented
        });
    }

    var cached = Env.metadata_cache[channel];
    if (HK.isMetadataMessage(cached)) {
        Env.checkCache(channel);
        return void cb(void 0, cached);
    }

    Env.batchMetadata(channel, cb, function(done) {
        Env.worker.computeMetadata(channel, function(err, meta) {
            if (!err && HK.isMetadataMessage(meta)) {
                Env.metadata_cache[channel] = meta;
                // clear metadata after a delay if nobody has joined the channel within 30s
                Env.checkCache(channel);
            }
            done(err, meta);
        });
    });
};

Data.getMetadata = (Env, channel, cb, /*Server, netfluxId*/) => {
    Data.getMetadataRaw(Env, channel, function (err, metadata) {
        if (err) { return void cb(err); }

        if (!metadata?.restricted) {
            // if it's not restricted then just call back
            return void cb(void 0, metadata);
        }

        /*
        const session = HK.getNetfluxSession(Env, netfluxId);
        const allowed = HK.listAllowedUsers(metadata);

        if (!HK.isUserSessionAllowed(allowed, session)) {
            return void cb(void 0, {
                restricted: metadata.restricted,
                allowed: allowed,
                rejected: true,
            });
        }
        cb(void 0, metadata);
        */
        // XXX allow list not implemented yet
        throw new Error("NOT_IMPLEMENTED");
    });
};
