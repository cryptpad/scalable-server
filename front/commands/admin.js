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

const onGetWsData = (Env, args, cb) => {
    try {
        const prom = [];
        Env.workers._workers.forEach(state => {
            prom.push(new Promise((res) => {
                Env.workers.sendTo(state, 'GET_WS_DATA', {}, (err, data) => {
                    if (err) {
                        return res({ error: err, pid: state.pid });
                    }
                    res(data);
                });
            }));
        });

        const data = {};
        onGetActiveSessions(Env, {}, (err, val) => {
            data.myId = Env?.myId;
            data.main_nb = val?.total;
            data.main_unique = val?.unique?.length;
        });
        data.workers = {};
        data.errors = [];

        Promise.all(prom).then(values => {
            values.forEach(obj => {
                if (obj.error) {
                    data.errors.push(obj);
                    return;
                }
                data.workers[obj.pid] = obj;
            });
            cb(void 0, data);
        }).catch(err => {
            cb(err);
        });
    } catch (e) {
        cb(e);
    }
};

const commands = {
    'FLUSH_CACHE': onFlushCache,
    'GET_ACTIVE_SESSIONS': onGetActiveSessions,
    'GET_ACTIVE_USERS': onGetActiveUsers,
    'SET_MODERATORS': onSetModerators,
    'DEBUG_GET_WS_DATA': onGetWsData
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
