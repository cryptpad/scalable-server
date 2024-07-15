const Data = module.exports;
const Meta = require("../metadata");
const Core = require("./core");
const Util = require("../common-util");
const HK = require("../hk-util");

Data.getMetadataRaw = function (Env, channel /* channelName */, _cb) {
    const cb = Util.once(Util.mkAsync(_cb));
    if (!Core.isValidId(channel)) { return void cb('INVALID_CHAN'); }
    if (channel.length !== HK.STANDARD_CHANNEL_LENGTH &&
        channel.length !== HK.ADMIN_CHANNEL_LENGTH) { return cb("INVALID_CHAN_LENGTH"); }

    // return synthetic metadata for admin broadcast channels as a safety net
    // in case anybody manages to write metadata
    if (channel.length === HK.ADMIN_CHANNEL_LENGTH) {
        return void cb(void 0, {
            channel: channel,
            creation: +new Date(),
            owners: Env.admins,
        });
    }

    var cached = Env.metadata_cache[channel];
    if (HK.isMetadataMessage(cached)) {
        Env.checkCache(channel);
        return void cb(void 0, cached);
    }

    Env.batchMetadata(channel, cb, function (done) {
        Env.computeMetadata(channel, function (err, meta) {
            if (!err && HK.isMetadataMessage(meta)) {
                Env.metadata_cache[channel] = meta;
                // clear metadata after a delay if nobody has joined the channel within 30s
                Env.checkCache(channel);
            }
            done(err, meta);
        });
    });
};
