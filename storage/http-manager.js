const Path = require('node:path');
const Express = require('express');
const BlockStore = require("./storage/block");
const { setHeaders } = require('../http-server/headers.js');
const CpCrypto = require("../common/crypto.js")('sodiumnative');
const Util = require('../common/common-util');


const create = (Env, app) => {
    app.use('/blob', function (req, res, next) {
        // Head requests are used to check the size of a blob.
        const url = req.url;
        if (typeof(url) === "string" && Env.blobStore) {
            const s = url.split('/');
            if (s[1] && s[1].length === 2 && s[2] && s[2].length === Env.blobStore.BLOB_LENGTH) {
                Env.blobStore.updateActivity(s[2], () => {});
            }
        }
        if (req.method === 'HEAD') {
            Express.static(Path.resolve(Env.paths.blob), {
                setHeaders: function (res /*, path, stat */) {
                    res.set('Access-Control-Allow-Origin', Env.enableEmbedding? '*': Env.permittedEmbedders);
                    res.set('Access-Control-Allow-Headers', 'Content-Length');
                    res.set('Access-Control-Expose-Headers', 'Content-Length');
                }
            })(req, res, next);
            return;
        }
        next();
    });

    app.use(function (req, res, next) {
    /*  These are pre-flight requests, through which the client
        confirms with the server that it is permitted to make the
        actual requests which will follow */
        if (req.method === 'OPTIONS' && /\/blob\//.test(req.url)) {
            res.setHeader('Access-Control-Allow-Origin', Env.enableEmbedding? '*': Env.permittedEmbedders);
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'DNT,X-CustomHeader,Keep-Alive,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Content-Range,Range,Access-Control-Allow-Origin');
            res.setHeader('Access-Control-Max-Age', 1728000);
            res.setHeader('Content-Type', 'application/octet-stream; charset=utf-8');
            res.setHeader('Content-Length', 0);
            res.statusCode = 204;
            return void res.end();
        }

        setHeaders(Env, req, res);
        if (/[\?\&]ver=[^\/]+$/.test(req.url)) { res.setHeader("Cache-Control", "max-age=31536000"); }
        else { res.setHeader("Cache-Control", "no-cache"); }
        next();
    });

    app.use("/blob", Express.static(Path.resolve(Env.paths.blob), {
        maxAge: Env.DEV_MODE? "0d": "365d"
    }));
    app.use("/datastore",
        (req, res, next) => {
            if (req.method === 'HEAD') {
                next();
            } else {
                res.status(403).end();
            }
        },
        Express.static(Env.paths.channel, {
            maxAge: "0d"
        }
    ));

    // XXX plugins

    // XXX XXX XXX BLOCK TOTP XXX XXX XXX

    // TODO this would be a good place to update a block's atime
    // in a manner independent of the filesystem. ie. for detecting and archiving
    // inactive accounts in a way that will not be invalidated by other forms of access
    // like filesystem backups.
    app.use("/block", Express.static(Path.resolve(Env.paths.block), {
        maxAge: "0d",
    }));
    // In case of a 404 for the block, check if a placeholder exists
    // and provide the result if that's the case
    app.use("/block", (req, res, next) => {
        const url = req.url;
        if (typeof(url) === "string") {
            const s = url.split('/');
            if (s[1] && s[1].length === 2 && BlockStore.isValidKey(s[2])) {
                return BlockStore.readPlaceholder(Env, s[2], (content) => {
                    res.status(404).json({
                        reason: content,
                        code: 404
                    });
                });
            }
        }
        next();
    });

    app.use('/upload-blob', Express.json({limit:"500kb"}), (req, res) => {
        if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Origin', Env.enableEmbedding? '*': Env.permittedEmbedders);
            res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'DNT,X-CustomHeader,Keep-Alive,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Content-Range,Range,Access-Control-Allow-Origin');
            res.setHeader('Access-Control-Max-Age', 1728000);
            res.setHeader('Content-Type', 'application/octet-stream; charset=utf-8');
            res.setHeader('Content-Length', 0);
            res.statusCode = 204;
            return void res.end();
        }

        const { chunk, sig, edPublic } = req.body;

        const forbidden = reason => {
            return void res.status(403).send({error: reason});
        };

        try {
            // Check signature
            const sigu8 = Util.decodeBase64(sig);
            const vkey = Util.decodeBase64(edPublic);
            const ok = CpCrypto.sigVerify(sigu8, vkey);
            if (!ok) { return forbidden('INVALID_KEY'); }
            const cookie = Util.encodeUTF8(sigu8.subarray(64));
            // Check cookie
            const safeKey = Util.escapeKeyCharacters(edPublic);
            Env.blobStore.checkUploadCookie(safeKey, value => {
                if (value !== cookie) {
                    return forbidden('INVALID_COOKIE');
                }
                // Upload chunk
                Env.blobStore.upload(safeKey, chunk, (err) => {
                    if (err) {
                        return res.status(500).send({error: err});
                    }
                    // Get new cookie
                    Env.blobStore.uploadCookie(safeKey, (err, _c) => {
                        if (err) {
                            return res.status(500).send({error: err});
                        }
                        res.status(200).send({
                            cookie: _c
                        });
                    });
                });
            });

        } catch (e) {
            return void res.status(500).send({error: e.message});
        }
    });

    app.use('/api/updatequota', (req, res) => {
        Env.updateLimits();
        res.status(200).send();
    });
};

module.exports = { create };
