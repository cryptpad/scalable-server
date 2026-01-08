const nThen = require('nthen');
const Util = require("../../common/common-util");
const Core = require('../../common/core');
const Pinning = require('../../storage/commands/pin');

const StorageCommands = {};

StorageCommands.getFileSize = (Env, channel, cb) => {
    Core.coreToStorage(Env, channel, 'RPC_GET_FILE_SIZE', channel, cb);
};

StorageCommands.getMultipleFileSize = (Env, channels, _cb) => {
    const cb = Util.once(_cb);

    let result = {};
    const channelsByStorage = Core.getChannelsStorage(Env, channels);

    nThen(waitFor => {
        Object.keys(channelsByStorage).forEach(storageId => {
            const channels = channelsByStorage[storageId];
            Env.interface.sendQuery(storageId,
            'GET_MULTIPLE_FILE_SIZE', channels, waitFor(res => {
                if (res.error) {
                    waitFor.abort();
                    return void cb(res.error);
                }
                Util.extend(result, res.data);
            }));
        });
    }).nThen(() => {
        cb(void 0, result);
    });
};

StorageCommands.getTotalSize = (Env, safeKey, cb) => {
    Core.coreToStorage(Env, safeKey, 'GET_TOTAL_SIZE', { safeKey }, cb);
};

StorageCommands.getChannelsTotalSize = (Env, channels, cb) => {
    let result = 0;
    const channelsByStorage = Core.getChannelsStorage(Env, channels);

    nThen(waitFor => {
        Object.keys(channelsByStorage).forEach(storageId => {
            const channels = channelsByStorage[storageId];
            Env.interface.sendQuery(storageId,
            'GET_CHANNELS_TOTAL_SIZE', channels, waitFor(res => {
                if (res.error || typeof(res.data) !== "number") {
                    waitFor.abort();
                    return void cb(res.error);
                }
                result += res.data;
            }));
        });
    }).nThen(() => {
        cb(void 0, result);
    });
};

StorageCommands.getLimit = Pinning.getLimit;

StorageCommands.channelCommand = (cmd) => (Env, _key, data, cb) => {
    const id = Array.isArray(data) && data[1];
    if (!Core.isValidId(id)) { return void cb('INVALID_CHAN'); }
    Core.coreToStorage(Env, id, 'ADMIN_CMD', { cmd, data: { id } }, cb);
};

StorageCommands.keyCommand = (cmd) => (Env, _key, data, cb) => {
    const key = Array.isArray(data) && data[1];
    if (!Core.isValidPublicKey(key)) { return void cb("EINVAL"); }
    Core.coreToStorage(Env, key, 'ADMIN_CMD', { cmd, data: { key } }, cb);
};

StorageCommands.argsCommand = (cmd) => (Env, _key, data, cb) => {
    const args = Array.isArray(data) && data[1];
    if (!args) { return void cb("INVALID_ARGS"); }
    const { key } = args;
    if (!Core.isValidPublicKey(key)) { return void cb("EINVAL"); }
    Core.coreToStorage(Env, key, 'ADMIN_CMD', { cmd, data: args }, cb);
};

module.exports = StorageCommands;
