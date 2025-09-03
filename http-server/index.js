const Express = require('express');
const Http = require('http');
const Path = require('node:path');
const Fs = require('node:fs');
const Logger = require("../common/logger.js");
const Util = require("../common/common-util.js");
const { createProxyMiddleware } = require("http-proxy-middleware");
const Default = require("./defaults");
const gzipStatic = require('connect-gzip-static');


// XXX Later: use cluster to serve the static files

/* // XXX TODO
    Load balancing with consistent hash? Or cycle between each node
*/

const EXEMPT = [
    /^\/common\/onlyoffice\/.*\.html.*/,
    /^\/common\/onlyoffice\/dist\/.*\/sdkjs\/common\/spell\/spell\/spell.js.*/,  // OnlyOffice loads spell.wasm in a way that needs unsave-eval
    /^\/(sheet|presentation|doc)\/inner\.html.*/,
    /^\/unsafeiframe\/inner\.html.*$/,
];

const applyHeaderMap = (res, map) => {
    for (let header in map) {
        if (typeof(map[header]) === 'string') { res.setHeader(header, map[header]); }
    }
};

const cacheHeaders = (Env, key, headers) => {
    if (Env.DEV_MODE) { return; }
    Env[key] = headers;
};

const getHeaders = (Env, type) => {
    const key = type + 'HeadersCache';
    if (Env[key]) { return Util.clone(Env[key]); }

    const headers = Default.httpHeaders(Env);

    let csp;
    if (type === 'office') {
        csp = Default.padContentSecurity(Env);
    } else {
        csp = Default.contentSecurity(Env);
    }
    headers['Content-Security-Policy'] = csp;
    headers["Cross-Origin-Resource-Policy"] = 'cross-origin';
    headers["Cross-Origin-Embedder-Policy"] = 'require-corp';
    cacheHeaders(Env, key, headers);

    // Don't set CSP headers on /api/ endpoints
    // because they aren't necessary and they cause problems
    // when duplicated by NGINX in production environments
    if (type === 'api') { delete headers['Content-Security-Policy']; }

    return Util.clone(headers);
};

const setHeaders = (Env, req, res) => {
    let type;
    if (EXEMPT.some(regex => regex.test(req.url))) {
        type = 'office';
    } else if (/^\/api\/(broadcast|config)/.test(req.url)) {
        type = 'api';
    } else {
        type = 'standard';
    }

    let h = getHeaders(Env, type);

    // Allow main domain to load resources from the sandbox URL
    if (!Env.enableEmbedding && req.get('origin') === Env.httpUnsafeOrigin &&
        /^\/common\/onlyoffice\/dist\/.*\/fonts\/.*/.test(req.url)) {
        h['Access-Control-Allow-Origin'] = Env.httpUnsafeOrigin;
    }

    applyHeaderMap(res, h);
};


Express.static.mime.define({'application/wasm': ['wasm']});

const initFeedback = (Env, app) => {
    if (!Env.logFeedback) { return; }

    const logFeedback = (url) => {
        url.replace(/\?(.*?)=/, (all, fb) => {
            Env.Log.feedback(fb, '');
        });
    };

    app.head(/^\/common\/feedback\.html/, (req, res, next) => {
        logFeedback(req.url);
        next();
    });
};

const initProxy = (Env, app, server, infra) => {
    const getURL = obj => {
        if (obj.href) {
            return obj.href;
        }
        let url = new URL('http://localhost');
        url.host = obj.host === '::' ? 'localhost' : obj.host;
        url.port = obj.port;
        return url.href;
    };
    const wsList = server?.public?.websocket?.map(getURL);
    const httpList = infra?.websocket?.map(getURL);

    let i = 0;
    let j = 0;
    const wsProxy = createProxyMiddleware({
        router: (/*req*/) => {
            return wsList[i++%wsList.length];
        },
        ws: true,
        onProxyReqWs: function (proxyReq, req) {
            proxyReq.setHeader('X-Real-Ip', req.socket.remoteAddress);
        },
        logger: Logger(['error'])
    });
    const httpProxy = createProxyMiddleware({
        router: req => {
            return httpList[j++%httpList.length] + req.originalUrl.slice(1);
        },
        logger: Logger(['error'])
    });

    app.use('/cryptpad_websocket', wsProxy);
    app.use('/api', httpProxy);
    app.use('/ssoauth', httpProxy); // XXX check


    const storeProxy = createProxyMiddleware({
        router: req => {
            // XXX consistent hash
            // NOTE: for /blob and /datastore and /block
            // NOTE2: we'll have to add the express middleware for
            //        these endpoints in storage's server
            console.log(req.url);
            throw new Error('NOT_IMPLEMENTED');
            return '';
        },
        logger: Logger(['error'])
    });
    app.use('/blob', storeProxy);
    app.use('/datastore', storeProxy);
    app.use('/block', storeProxy);

    return wsProxy;
};

const initHeaders = (Env, app) => {
    app.use((req, res, next) => {
        // XXX OPTIONS method?
        setHeaders(Env, req, res);
        if (/[\?\&]ver=[^\/]+$/.test(req.url)) {
            res.setHeader("Cache-Control", "max-age=31536000");
        } else {
            res.setHeader("Cache-Control", "no-cache");
        }
        next();
    });
};

const initPlugins = (/*Env, app*/) => {
    // XXX TODO plugins
    /*
    Object.keys(plugins || {}).forEach(name => {
        let plugin = plugins[name];
        if (!plugin.addHttpEndpoints) { return; }
        plugin.addHttpEndpoints(Env, app);
    });
    */
};

const initStatic = (Env, app) => {
    // serve custom app content from the customize directory
    // useful for testing pages customized with opengraph data
    const root = '../cryptpad';
    app.use(Express.static(Path.resolve(root, './customize/www')));
    app.use(gzipStatic(Path.resolve(root, './www')));

    app.use("/common", Express.static(Path.resolve(root, './src/common')));

    let mainPages = Env.mainPages || Default.mainPages();
    let mainPagePattern = new RegExp('^\/(' + mainPages.join('|') + ').html$');
    app.get(mainPagePattern, Express.static(Path.resolve(root, './customize')));
    app.get(mainPagePattern, Express.static(Path.resolve(root, './customize.dist')));

    const customize = Path.resolve(root, 'customize');
    const customizeDist = Path.resolve(root, 'customize.dist');

    app.use("/customize", Express.static(customize));
    app.use("/customize", Express.static(customizeDist));
    app.use("/customize.dist", Express.static(customizeDist));
    app.use(/^\/[^\/]*$/, Express.static(customize));
    app.use(/^\/[^\/]*$/, Express.static(customizeDist));

    let four04 = Path.resolve(root, './customize.dist/404.html');
    let fivehundred = Path.resolve(root, './customize.dist/500.html');
    let custom_four04 = Path.resolve(root, './customize/404.html');
    let custom_fivehundred = Path.resolve(root, './customize/500.html');

    const send404 = (res, path) => {
        if (!path && path !== four04) { path = four04; }
        Fs.exists(path, (exists) => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            if (exists) { return Fs.createReadStream(path).pipe(res); }
            send404(res);
        });
    };
    const send500 = (res, path) => {
        if (!path && path !== fivehundred) { path = fivehundred; }
        Fs.exists(path, (exists) => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            if (exists) { return Fs.createReadStream(path).pipe(res); }
            send500(res);
        });
    };
    app.use((req, res) => {

        if (/^(\/favicon\.ico\/|.*\.js\.map|.*\/translations\/.*\.json)/.test(req.url)) {
            // ignore common 404s
        } else {
            Env.Log.info('HTTP_404', req.url);
        }

        res.status(404);
        send404(res, custom_four04);
    });

    // default message for thrown errors in ExpressJS routes
    app.use((err, req, res) => {
        Env.Log.error('EXPRESSJS_ROUTING', {
            error: err.stack || err,
        });
        res.status(500);
        send500(res, custom_fivehundred);
    });
};

const initEnv = (Env, server) => {
    const config = server?.options || {};
    const publicConfig = server?.public || {};

    // Origin and ports
    Env.httpUnsafeOrigin = publicConfig?.main?.origin;
    Env.httpSafeOrigin = publicConfig?.main?.sandboxOrigin;
    const unsafe = new URL(Env.httpUnsafeOrigin);
    const safe = new URL(Env.httpSafeOrigin);
    Env.httpAddress = unsafe.hostname;
    Env.httpPort = unsafe.port;
    if (unsafe.port && unsafe.hostname === safe.hostname) {
        Env.httpSafePort = safe.port;
    }

    Env.logFeedback = Boolean(config.logFeedback);

    const DEV = process.env.DEV;
    Env.DEV_MODE = String(DEV) === "1";

    Env.enableEmbedding = false; // XXX decree...
    Env.permittedEmbedders = publicConfig?.main?.sandboxOrigin;
};

const start = (config) => {
    const {server, infra} = config;
    const Env = {
        Log: Logger()
    };

    initEnv(Env, server);

    const app = Express();

    initFeedback(Env, app);
    const wsProxy = initProxy(Env, app, server, infra);

    initHeaders(Env, app);
    initPlugins(Env, app);
    initStatic(Env, app);

    const httpServer = Http.createServer(app);
    httpServer.listen(Env.httpPort, Env.httpAddress, () => {
        if (process.send !== undefined) {
            process.send({
                type: 'http',
                index: 0,
                dev: Env.DEV_MODE,
                msg: 'READY'
            });
        } else {
            Env.Log.info('HTTP server started');
            if (Env.DEV_MODE) {
                Env.Log.info('DEV mode enabled');
            }
        }
    });
    httpServer.on('upgrade', wsProxy.upgrade);

    if (Env.httpSafePort) {
        const safeServer = Http.createServer(app);
        safeServer.listen(Env.httpSafePort, Env.httpAddress, () => {
            if (process.send) { return; }
            Env.Log.info('HTTP sandbox started');
        });
    }
};

module.exports = {
    start
};

