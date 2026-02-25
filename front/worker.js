const Util = require("../common/common-util");
const Http = require("node:http");
const Express = require("express");
const Environment = require('../common/env');
const Logger = require('../common/logger');
const WebSocketServer = require('ws').Server;
const { setHeaders } = require('../http-server/headers.js');
const Crypto = require('crypto');

const cookieParser = require("cookie-parser");
const bodyParser = require('body-parser');

const COMMANDS = {};
const Env = {
    active: true,
    isWorker: true,
    users: {}
};

const app = Express();

app.use(function (req, res, next) {
    setHeaders(Env, req, res);
    if (/[\?\&]ver=[^\/]+$/.test(req.url)) { res.setHeader("Cache-Control", "max-age=31536000"); }
    else { res.setHeader("Cache-Control", "no-cache"); }
    next();
});

const response = Util.response((errLabel, info) => {
    Env.Log.error('WORKER__' + errLabel, info);
});
const guid = () => {
    let id = Util.uid();
    return response.expected(id)? guid(): id;
};
const sendCommand = (cmd, data, cb) => {
    const txid = guid();
    response.expect(txid, (err, response) => {
        cb(err, response);
    }, 2*60000); // 2min timeout
    process.send({
        txid, cmd, data,
        pid: Env.pid
    });
};

app.use(bodyParser.urlencoded({
    extended: true
}));
app.use(cookieParser());

// if dev mode: never cache
const cacheString = () => {
    return (Env.FRESH_KEY? '-' + Env.FRESH_KEY: '') + (Env.DEV_MODE? '-' + (+new Date()): '');
};

const makeRouteCache = (template, cacheName) => {
    const cleanUp = {};

    return function (req, res) {
        const cache = Env[cacheName] ||= {};
        const host = req.headers.host.replace(/\:[0-9]+/, '');
        res.setHeader('Content-Type', 'text/javascript');
        // don't cache anything if you're in dev mode
        if (Env.DEV_MODE) {
            return void res.send(template(host));
        }
        // generate a lookup key for the cache
        let cacheKey = host + ':' + cacheString();

        // we must be able to clear the cache when updating any mutable key
        // if there's nothing cached for that key...
        if (!cache[cacheKey]) {
            // generate the response and cache it in memory
            cache[cacheKey] = template(host);
            // and create a function to conditionally evict cache entries
            // which have not been accessed in the last 20 seconds
            cleanUp[cacheKey] = Util.throttle(function () {
                delete cleanUp[cacheKey];
                delete cache[cacheKey];
            }, 20000);
        }

        // successive calls to this function
        if (typeof (cleanUp[cacheKey]) === "function") {
            cleanUp[cacheKey]();
        }
        return void res.send(cache[cacheKey]);
    };
};
const serveConfig = makeRouteCache(function () {
    // NOTE: we may extract JSON from this config using slice(27, -5)
    const ssoList = Env.sso && Env.sso.enabled && Array.isArray(Env.sso.list) &&
                    Env.sso.list.map(function (obj) { return obj.name; }) || [];
    const SSOUtils = Env?.plugins?.SSO?.utils;
    const ssoCfg = (SSOUtils && ssoList.length) ? {
        force: (Env.sso && Env.sso.enforced && 1) || 0,
        password: (Env.sso && Env.sso.cpPassword && (Env.sso.forceCpPassword ? 2 : 1)) || 0,
        list: ssoList
    } : false;

    return [
        'define(function(){',
        'return ' + JSON.stringify({
            requireConf: {
                waitSeconds: 600,
                urlArgs: 'ver=' + Env.version + cacheString(),
            },
            removeDonateButton: (Env.removeDonateButton === true),
            accounts_api: Env.accounts_api,
            websocketPath: Env.websocketPath,
            httpUnsafeOrigin: Env.httpUnsafeOrigin,
            adminEmail: Env.adminEmail,
            adminKeys: Env.admins,
            moderatorKeys: Env.moderators,
            inactiveTime: Env.inactiveTime,
            supportMailbox: Env.supportMailbox,
            supportMailboxKey: Env.supportMailboxKey,
            defaultStorageLimit: Env.defaultStorageLimit,
            maxUploadSize: Env.maxUploadSize,
            premiumUploadSize: Env.premiumUploadSize,
            restrictRegistration: Env.restrictRegistration,
            restrictSsoRegistration: Env.restrictSsoRegistration,
            appsToDisable: Env.appsToDisable,
            httpSafeOrigin: Env.httpSafeOrigin,
            enableEmbedding: Env.enableEmbedding,
            fileHost: Env.fileHost,
            shouldUpdateNode: Env.shouldUpdateNode || undefined,
            listMyInstance: Env.listMyInstance,
            sso: ssoCfg,
            enforceMFA: Env.enforceMFA,
            onlyOffice: Env.onlyOffice
        }, null, '\t'),
        '});'
    ].join(';\n');
}, 'configCache');
const serveBroadcast = makeRouteCache(function () {
    let maintenance = Env.maintenance;
    if (maintenance && maintenance.end && maintenance.end < (+new Date())) {
        maintenance = undefined;
    }
    return [
        'define(function(){',
        'return ' + JSON.stringify({
            curvePublic: Env?.curveKeys?.curvePublic,
            lastBroadcastHash: Env.lastBroadcastHash,
            surveyURL: Env.surveyURL,
            maintenance: maintenance
        }, null, '\t'),
        '});'
    ].join(';\n');
}, 'broadcastCache');
const Define = (obj) => {
    return `define(function (){
    return ${JSON.stringify(obj, null, '\t')};
});`;
};
const serveInstance = (req, res) => {
    res.setHeader('Content-Type', 'text/javascript');
    res.send(Define({
        color: Env.accentColor,
        name: Env.instanceName,
        description: Env.instanceDescription,
        location: Env.instanceJurisdiction,
        notice: Env.instanceNotice,
    }));
};

app.get('/api/config', serveConfig);
app.get('/api/broadcast', serveBroadcast);
app.get('/api/instance', serveInstance);

const servePlugins = Env => {
    const plugins = Env.plugins;
    let extensions = plugins._extensions;
    let styles = plugins._styles;
    let str = JSON.stringify(extensions);
    let str2 = JSON.stringify(styles);
    let js = `let extensions = ${str};
let styles = ${str2};
let lang = window.cryptpadLanguage;
let paths = [];
extensions.forEach(name => {
    paths.push(\`optional!/\${name}/extensions.js\`);
    paths.push(\`optional!json!/\${name}/translations/messages.json\`);
    const l = lang === "en" ? '' : \`\${lang}.\`;
    paths.push(\`optional!json!/\${name}/translations/messages.\${l}json\`);
});
styles.forEach(name => {
    paths.push(\`optional!less!/\${name}/style.less\`);
});
define(paths, function () {
    let args = Array.prototype.slice.apply(arguments);
    return args;
}, function () {
    // ignore missing files
});`;
    app.get('/extensions.js', (req, res) => {
        res.setHeader('Content-Type', 'text/javascript');
        res.send(js);
    });
};

app.get('/api/profiling', (/*req, res*/) => {
    // XXX
    // XXX Env.enableProfiling, Env.profilingWindow
    throw new Error('NOT_IMPLEMENTED');
});

// HTTP commands
// This endpoint handles authenticated RPCs over HTTP
// via an interactive challenge-response protocol
app.use(Express.json());
app.post('/api/auth', (req, res) => {
    const body = Util.clone(req.body);
    const cookies = req.cookies;
    body._cookies = cookies;
    sendCommand('HTTP_COMMAND', body, (err, response) => {
        if (err) {
            return res.status(500).json({
                error: err
            });
        }
        if (response._cookie) {
            res.setHeader('Set-Cookie', response._cookie);
        }
        res.status(200).json(response);
    });
});

COMMANDS.NEW_DECREES = (data, cb) => {
    const { decrees, type, curveKeys, freshKey } = data;
    Env.FRESH_KEY = freshKey;
    Env.curveKeys ||= curveKeys;
    Env.getDecree(type).loadRemote(Env, decrees);
    [ 'configCache', 'broadcastCache', ].forEach(key => {
        Env[key] = {};
    });
    cb();
};

COMMANDS.FLUSH_CACHE = (args, cb) => {
    Env.FRESH_KEY = args.freshKey;
    cb();
};

// WEBSOCKET

const now = () => {
    return +new Date();
};
const randName = () => {
    return Crypto.randomBytes(16).toString('hex');
};
const createUniqueName = (Env) => {
    const name = randName();
    if (typeof(Env.users[name]) === 'undefined') { return name; }
    return createUniqueName(Env);
};
const socketSendable = (socket) => {
    return socket && socket.readyState === 1;
};
const QUEUE_CHR = 1024 * 1024 * 4;
const WEBSOCKET_CLOSING = 2;
const WEBSOCKET_CLOSED = 3;

const dropUser = (user, reason) => {
    if (!user || !user.socket) { return; }
    if (user.socket.readyState !== WEBSOCKET_CLOSING
        && user.socket.readyState !== WEBSOCKET_CLOSED) {
        try {
            user.socket.close();
        } catch (e) {
            Env.Log.error(e, 'FAIL_TO_DISCONNECT', { id: user.id, });
            try {
                user.socket.terminate();
            } catch (ee) {
                Env.Log.error(ee, 'FAIL_TO_TERMINATE', {
                    id: user.id
                });
            }
        }
    }

    // Warn main thread
    sendCommand('WS_DROP_USER', {
        id: user.id, reason
    }, () => { });

    // Clean memory
    delete Env.users[user.id];

    // Log unexpected errors
    if (Env.logIP &&
        !['SOCKET_CLOSED', 'INACTIVITY'].includes(reason)) {
        return void Env.Log.info('USER_DISCONNECTED_ERROR', {
            userId: user.id,
            reason: reason
        });
    }
    if (['BAD_MESSAGE', 'SEND_MESSAGE_FAIL_2'].includes(reason)) {
        return void Env.Log.error('SESSION_CLOSE_WITH_ERROR', {
            userId: user.id,
            reason: reason,
        });
    }

    if (['SOCKET_CLOSED', 'SOCKET_ERROR'].includes(reason)) {
        return;
    }
    Env.Log.verbose('SESSION_CLOSE_ROUTINE', {
        userId: user.id,
        reason: reason,
    });
};

const sendMsgPromise = (user, msg) => {
    return new Promise((resolve, reject) => {
        // don't bother trying to send if the user doesn't
        // exist anymore
        if (!user) { return void reject("NO_USER"); }
        // or if you determine that it's unsendable
        if (!socketSendable(user.socket)) {
            return void reject("UNSENDABLE");
        }

        Env.Log.verbose('Sending', msg, 'to', user.id);

        try {
            const strMsg = JSON.stringify(msg);
            user.inQueue += strMsg.length;
            user.sendMsgCallbacks.push(() => {
                resolve({
                    length: strMsg.length
                });
            });
            user.socket.send(strMsg, () => {
                user.inQueue -= strMsg.length;
                if (user.inQueue > QUEUE_CHR) { return; }
                const smcb = user.sendMsgCallbacks;
                user.sendMsgCallbacks = [];
                try {
                    smcb.forEach((cb)=>{cb();});
                } catch (e) {
                    Env.Log.error(e, 'SEND_MESSAGE_FAIL');
                }
            });
        } catch (e) {
            // call back any pending callbacks before you
            // drop the user
            reject(e);
            Env.Log.error(e, 'SEND_MESSAGE_FAIL_2');
            dropUser(user, 'SEND_MESSAGE_FAIL_2');
        }
    });
};
const sendMsg = (user, msg) => {
    sendMsgPromise(user, msg).catch(e => {
        Env.Log.error(e, 'SEND_MESSAGE', {
            user: user.id,
            message: msg
        });
    });
};

const handleMessage = (user, msg, cb) => {
    try {
        let json = JSON.parse(msg);
        let seq = json.shift();
        let cmd = json[0];

        user.timeOfLastMessage = now();
        user.pingOutstanding = false;

        sendCommand('WS_MESSAGE', {
            userId: user.id,
            cmd, seq, json,
            length: msg.length
        }, cb);
    } catch (e) {
        cb(e);
    }
};

const LAG_MAX_BEFORE_DISCONNECT = 60000;
const LAG_MAX_BEFORE_PING = 15000;
const checkUserActivity = () => {
    const time = now();
    Object.keys(Env.users).forEach((userId) => {
        const u = Env.users[userId];
        try {
            if (time - u.timeOfLastMessage > LAG_MAX_BEFORE_DISCONNECT) {
                dropUser(u, 'BAD_MESSAGE');
            }
            if (!u.pingOutstanding && time - u.timeOfLastMessage > LAG_MAX_BEFORE_PING) {
                sendMsg(u, [0, '', 'PING', now()]);
                u.pingOutstanding = true;
                sendCommand('WS_SEND_PING', {}, () => {});
            }
        } catch (err) {
            Env.Log.error(err, 'USER_ACTIVITY_CHECK');
        }
    });
};
const initServerHandlers = () => {
    if (!Env.wss) { throw new Error('No WebSocket Server'); }

    setInterval(() => {
        checkUserActivity();
    }, 5000);


    Env.wss.on('connection', (socket, req) => {
        // refuse new connections if the server is shutting down
        if (!Env.active) { return; }
        if (!socket.upgradeReq) { socket.upgradeReq = req; }

        const ip = (req.headers && req.headers['x-real-ip'])
                      || req.socket.remoteAddress || '';
        const user = {
            socket: socket,
            id: createUniqueName(Env),
            timeOfLastMessage: now(),
            pingOutstanding: false,
            inQueue: 0,
            ip: ip.replace(/^::ffff:/, ''),
            sendMsgCallbacks: [],
        };
        Env.users[user.id] = user;
        sendMsg(user, [0, '', 'IDENT', user.id]);

        sendCommand('WS_NEW_USER', {
            id: user.id,
            ip: user.ip
        }, () => { });


        socket.on('message', message => {
            if (!Env.users[user.id]) { return; } // websocket closing
            Env.Log.verbose('Receiving', JSON.parse(message), 'from', user.id);
            handleMessage(user, message, e => {
                if (!e) { return; }
                Env.Log.error(e, 'NETFLUX_BAD_MESSAGE', {
                    user: user.id,
                    message: message,
                });
                dropUser(user, 'BAD_MESSAGE');
            });
        });
        socket.on('close', function () {
            dropUser(user, 'SOCKET_CLOSED');
        });
        socket.on('error', function (err) {
            Env.Log.error(err, 'NETFLUX_WEBSOCKET_ERROR');
            dropUser(user, 'SOCKET_ERROR');
        });
    });

};

COMMANDS.WS_SEND_MESSAGE = (args, cb) => {
    const { id, msg } = args;
    const user = Env.users[id];
    sendMsgPromise(user, msg).then((obj) => {
        cb(void 0, obj);
    }).catch(e => {
        cb(e);
    });
};
COMMANDS.WS_SHUTDOWN = (args, cb) => {
    if (!Env.wss) { return; }
    Env.active = false;
    Env.wss.close();
    delete Env.wss;
    cb();
};

COMMANDS.SET_MODERATORS = (args, cb) => {
    Env.Log.verbose('SET_MODERATORS_FRONT_WORKER');
    Env.moderators = args;
    cb();
};

// INIT Worker

const init = (config, cb) => {
    Env.Log = Logger(config.config, config.myId);

    Environment.init(Env, config);
    servePlugins(Env);

    const cfg = config?.infra?.front[config.index];
    const server = Http.createServer(app);
    server.listen(cfg.port, cfg.host, () => {
        Env.Log.verbose('HTTP worker listening on port', cfg.port);
        cb();
    });

    Env.wss = new WebSocketServer({ server });
    initServerHandlers(Env);
};

let ready = false;
process.on('message', function(obj) {
    if (!obj || !obj.txid || !obj.pid) {
        return void process.send({
            error: 'E_INVAL',
            data: obj,
        });
    }

    if (response.expected(obj.txid) && (obj.response || obj.error)) {
        response.handle(obj.txid, [obj.error, obj.response]);
        return;
    }

    const command = COMMANDS[obj.command];
    const data = obj.data;
    Env.pid = obj.pid;

    const cb = function(err, value) {
        process.send({
            error: Util.serializeError(err),
            txid: obj.txid,
            pid: obj.pid,
            value: value,
        });
    };

    if (!ready) {
        return void init(obj.config, (err) => {
            if (err) { return void cb(Util.serializeError(err)); }
            ready = true;
            cb();
        });
    }

    if (typeof (command) !== 'function') {
        return void cb("E_BAD_COMMAND");
    }
    command(data, cb);
});

process.on('uncaughtException', function(err) {
    console.error('[%s] UNCAUGHT EXCEPTION IN DB WORKER', new Date());
    console.error(err);
    console.error("TERMINATING");
    process.exit(1);
});
