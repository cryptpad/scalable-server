const Default = require('./defaults.js');
const Util = require("../common/common-util.js");

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

module.exports = { setHeaders };
