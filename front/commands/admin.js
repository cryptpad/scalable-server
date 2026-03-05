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
        data.workers = {};
        data.errors = [];

        Promise.all(prom).then(values => {
            onGetActiveSessions(Env, {}, (err, val) => {
                data.myId = Env?.myId;
                data.main_nbWS = val?.total;
                data.main_uniqueIP = val?.unique?.length;
            });

            const details = {};
            const details_id = {};
            const details_ip = {};
            const empty_user = new Set();
            Object.keys(Env.users).forEach(id => {
                const user = Env.users[id];
                const ip = user.ip;
                let key = ip || id;
                details[key] ||= {};
                details_id[id] = user.channels.size;
                Array.from(user.channels).forEach(chan => {
                    details[key][chan] ||= 0;
                    details[key][chan]++;
                });
                if (user.isEmpty) {
                    empty_user.add(id);
                }
                if (!ip) { return; }
                details_ip[ip] ||= [];
                details_ip[ip].push(id);
            });
            data.padsPerIP = details;
            data.padsPerWS = details_id;
            data.WSPerIP = details_ip;
            data.emptyUsers = Array.from(empty_user);

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
