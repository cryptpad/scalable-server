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

StorageCommands.getChannelList = (Env, safeKey, cb) => {
    Core.coreToStorage(Env, safeKey, 'GET_CHANNEL_LIST', { safeKey }, cb);
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

StorageCommands.getRegisteredUsers = (Env, cb) => {
    let users = 0;
    Env.interface.broadcast('storage', 'GET_REGISTERED_USERS', {}, res => {
        res.forEach(obj => {
            if (obj.error) { return; }
            users += obj.data?.users;
        });
        cb(void 0, {users});
    }, ['storage:0']);
};

StorageCommands.getLimit = Pinning.getLimit;


module.exports = StorageCommands;
