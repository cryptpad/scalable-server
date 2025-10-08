const nThen = require('nthen');
const Util = require("../../common/common-util");
const Core = require('../../common/core');
const Pinning = require('../../storage/commands/pin');

const StorageCommands = {};

StorageCommands.getFileSize = (Env, channel, cb) => {
    const storageId = Env.getStorageId(channel);
    Env.interface.sendQuery(storageId, 'RPC_GET_FILE_SIZE', channel, res => {
        if (res.error) { return void cb(res.error); }
        cb(void 0, res.data);
    });
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
    const storageId = Env.getStorageId(safeKey);
    Env.interface.sendQuery(storageId, 'GET_CHANNEL_LIST', {
        safeKey
    }, response => {
        cb(response.error, response.data);
    });
};

StorageCommands.getTotalSize = (Env, safeKey, cb) => {
    const storageId = Env.getStorageId(safeKey);
    Env.interface.sendQuery(storageId, 'GET_TOTAL_SIZE', {
        safeKey
    }, response => {
        cb(response.error, response.data);
    });
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

StorageCommands.onBlockCheck = (Env, args, cb) => {
    const storageId = Env.getStorageId(args.blockId);
    Env.interface.sendQuery(storageId, 'BLOCK_CHECK', args, res => {
        if (res.error) { return void cb(res.error); }
        cb(void 0, res.data);
    });
};
StorageCommands.onGetMFA = (Env, args, cb) => {
    const storageId = Env.getStorageId(args.blockId);
    Env.interface.sendQuery(storageId, 'BLOCK_GET_MFA', args, res => {
        if (res.error) { return void cb(res.error); }
        cb(void 0, res.data);
    });
};
StorageCommands.onSessionsCommand = (Env, args, cb) => {
    const storageId = Env.getStorageId(args.blockId);
    Env.interface.sendQuery(storageId, 'SESSIONS_CMD', args, res => {
        if (res.error) { return void cb(res.error); }
        cb(void 0, res.data);
    });
};
StorageCommands.onUserRegistryCommand = (Env, args, cb) => {
    const storageId = Env.getStorageId(args.edPublic);
    Env.interface.sendQuery(storageId, 'USER_REGISTRY_CMD', args, res => {
        if (res.error) { return void cb(res.error); }
        cb(void 0, res.data);
    });
};
StorageCommands.onInvitationCommand = (Env, args, cb) => {
    const storageId = Env.getStorageId(args.inviteToken);
    Env.interface.sendQuery(storageId, 'INVITATION_CMD', args, res => {
        if (res.error) { return void cb(res.error); }
        cb(void 0, res.data);
    });
};




module.exports = StorageCommands;
