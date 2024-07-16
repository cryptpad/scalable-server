const Store = require("./storage/file");

let Env = {
    metadata_cache: {},
    channel_cache: {},
    cache_checks: {},

    batchIndexReads: BatchRead("HK_GET_INDEX"),
    batchMetadata: BatchRead('GET_METADATA'),
};

Env.checkCache = function(channel) {
    var f = Env.cache_checks[channel] || Util.throttle(function() {
        delete Env.cache_checks[channel];
        if (Env.channel_cache[channel]) { return; }
        delete Env.metadata_cache[channel];
    }, 30000);
    f();
};

Store.create({
    filePath: './data/channel',
    archivePath: './data/archive',
    volumeId: 'channel'
}, function(err, _store) {
    if (err) { console.error('Error:', err); }
    Env.store = _store;
});
