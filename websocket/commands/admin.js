const onFlushCache = (Env, args, cb) => {
    Env.FRESH_KEY = args.freshKey;
    Env.workers.broadcast('FLUSH_CACHE', args, () => { cb(); });
};

const onGetActiveSessions = (Env, args, cb) => {
    const users = Object.keys(Env.users);
    const total = users.length;
    let unique = [];
    users.forEach(u => {
        const user = Env.users[u];
        const req = user?.socket?.upgradeReq;
        const conn = req?.connection;
        const ip = req?.headers?.['x-forwarded-for'] || conn?.remoteAddress;
        if (!unique.includes(ip)) { unique.push(ip); }
    });
    cb(void 0, { total, unique });
};

const commands = {
    'FLUSH_CACHE': onFlushCache,
    'GET_ACTIVE_SESSIONS': onGetActiveSessions,
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
