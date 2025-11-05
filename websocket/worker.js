const Util = require("../common/common-util");
const Http = require("node:http");
const Express = require("express");
const Environment = require('../common/env');
const Logger = require('../common/logger');
const { setHeaders } = require('../http-server/headers.js');

const cookieParser = require("cookie-parser");
const bodyParser = require('body-parser');

const COMMANDS = {};
const Env = {
    isWorker: true
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
    Env.curveKeys = curveKeys;
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

const init = (config, cb) => {
    Env.config = config;
    Env.Log = Logger();

    Environment.init(Env, config);
    servePlugins(Env);

    const cfg = config?.infra?.websocket[config.index];
    const server = Http.createServer(app);
    server.listen(cfg.port, cfg.host, () => {
        Env.Log.verbose('HTTP worker listening on port', cfg.port);
        cb();
    });
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
