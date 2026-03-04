const onFlushCache = (Env, args, cb) => {
    Env.FRESH_KEY = args.freshKey;
    Env.workers.broadcast('FLUSH_CACHE', args, () => { cb(); });
};

const onGetActiveSessions = (Env, args, cb) => {
    const users = Object.keys(Env.users);
    const total = users.length;
    let unique = new Set();
    users.forEach(u => {
        const ip = Env.users[u]?.ip;
        if (ip) { unique.add(ip); }
    });
    cb(void 0, { total, unique: Array.from(unique) });
};

const onGetActiveUsers = (Env, args, cb) => {
    const users = Object.keys(Env.users);
    cb(void 0, { myId: Env.myId, users });
};

const onSetModerators = (Env, args) => {
    Env.moderators = args.moderators;
    if (args.freshKey) {
        onFlushCache(Env, args, () => { });
    }
    Env.workers.broadcast('SET_MODERATORS', Env.moderators, () => {
        Env.Log.silly('SET_MODERATORS_FRONT_WORKERS');
    });
};

const commands = {
    'FLUSH_CACHE': onFlushCache,
    'GET_ACTIVE_SESSIONS': onGetActiveSessions,
    'GET_ACTIVE_USERS': onGetActiveUsers,
    'SET_MODERATORS': onSetModerators,
};

module.exports = {
    command: (Env, args, cb) => {
        const { cmd, data } = args;
        const command = commands[cmd];

        if (typeof (command) === 'function') {
            return void command(Env, data, cb);
        }

        return void cb('UNHANDLED_ADMIN_COMMAND');
    },
};
