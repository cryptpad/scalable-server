const Crypto = require('node:crypto');
const Upload = require('./common/upload.js');

const blobId = Crypto.randomBytes(24).toString('hex');
const blobId2 = Crypto.randomBytes(24).toString('hex');
const hk = '0123456789abcdef';

const {
    connectUser, getOrigin,
    createUserRpc,
    getRandomKeys,
    getBlobPath
} = require('./common/utils.js');

const keys = getRandomKeys();
const origin = getOrigin();

const cryptKey = new Uint8Array(Crypto.randomBytes(32));

const file = new Uint8Array(Crypto.randomBytes(256000));
const file2 = new Uint8Array(Crypto.randomBytes(256000));

console.log('Blob path', getBlobPath(blobId));
console.log('Blob path2', getBlobPath(blobId2));

const isEqual = (a, b) => {
    return Buffer.compare(a, b) === 0;
};

const log = (require.main === module) ? console.log : function () {};

log('Blob Owner key', keys.edPublic);

const getUploadCmd = (rpc) => {
    return {
        uploadStatus: (id, size, cb) => {
            rpc.send('UPLOAD_STATUS', {id, size}, function (e, res) {
                if (e) { return void cb(e); }
                var pending = res[0];
                if (typeof(pending) !== 'boolean') {
                    return void cb('INVALID_RESPONSE');
                }
                cb(void 0, pending);
            });
        },
        uploadCancel: (id, size, cb) => {
            rpc.send('UPLOAD_CANCEL', {id, size}, function (e) {
                if (e) { return void cb(e); }
                cb();
            });
        },
        uploadComplete: (id, owned, cb) => {
            let prefix = owned ? 'OWNED_' : '';
            rpc.send(prefix+'UPLOAD_COMPLETE', id, function (e, res) {
                if (e) { return void cb(e); }
                var id = res[0];
                if (typeof(id) !== 'string') {
                    return void cb('INVALID_ID');
                }
                cb(void 0, id);
            });
        },
        uploadChunk: (id, chunk, cb) => {
            rpc.send.unauthenticated('UPLOAD', {
                chunk, id
            }, function (e, msg) {
                cb(e, msg);
            });
        }
    };
};

const uploadBlob = args => {
    return new Promise((resolve, reject) => {
        const { network, rpc } = args;
        const rpcCmd = getUploadCmd(rpc);

        const u8 = file;
        const key = cryptKey;

        Upload.handleFile({
            USE_WS: true,
            owned: true,
            id: blobId,
            force: true, // override pending uploads

            u8, key, rpcCmd,
            origin, keys,
            updateProgress: (val) => {
                log("Progress WS upload:", Math.floor(val)+"%");
            }
        }, (err, url) => {
            if (err) { return reject(err); }
            resolve({ network, rpc, url });
        });
    });
};

const checkBlob = (args) => {
    const { network, rpc, url } = args;
    const blobUrl = origin + url;
    log('Encrypted Blob URL:', blobUrl);
    // fetch encrypted blob
    return new Promise((resolve, reject) => {
        fetch(blobUrl).then(res => {
            // conver to array buffer
            return res.arrayBuffer();
        }).then(buff => {
            // decrypt associated Uint8Array
            const u8 = new Uint8Array(buff);
            return new Promise((res, rej) => {
                Upload.fileCrypto.decrypt(u8, cryptKey, (err, val) => {
                    if (err) { return rej(err); }
                    res(val);
                });
            });
        }).then(dec => {
            // convert resulting blob to array buffer
            return dec.content.arrayBuffer();
        }).then(dec_buff => {
            // compare wiht original "file"
            const u8 = new Uint8Array(dec_buff);
            const equals = isEqual(file, u8);
            if (equals) { return resolve({network, rpc}); }
            reject('INVALID_DECRYPTED_BLOB');
        }).catch(reject);
    });
};

const uploadBlobHttp = args => {
    return new Promise((resolve, reject) => {
        const { network, rpc } = args;
        const rpcCmd = getUploadCmd(rpc);

        const u8 = file2;
        const key = cryptKey;

        Upload.handleFile({
            USE_WS: false,
            owned: true,
            id: blobId2,
            force: true, // override pending uploads

            u8, key, rpcCmd,
            origin, keys,
            updateProgress: (val) => {
                log("Progress HTTP upload:", Math.floor(val)+"%");
            }
        }, (err, url) => {
            if (err) { return reject(err); }
            resolve({ network, rpc, url });
        });
    });
};

const checkBlobHttp = (args) => {
    const { network, rpc, url } = args;
    const blobUrl = origin + url;
    log('Encrypted Blob2 URL:', blobUrl);
    // fetch encrypted blob
    return new Promise((resolve, reject) => {
        fetch(blobUrl).then(res => {
            // conver to array buffer
            return res.arrayBuffer();
        }).then(buff => {
            // decrypt associated Uint8Array
            const u8 = new Uint8Array(buff);
            return new Promise((res, rej) => {
                Upload.fileCrypto.decrypt(u8, cryptKey, (err, val) => {
                    if (err) { return rej(err); }
                    res(val);
                });
            });
        }).then(dec => {
            // convert resulting blob to array buffer
            return dec.content.arrayBuffer();
        }).then(dec_buff => {
            // compare wiht original "file"
            const u8 = new Uint8Array(dec_buff);
            const equals = isEqual(file2, u8);
            if (equals) { return resolve({network, rpc}); }
            reject('INVALID_DECRYPTED_BLOB2');
        }).catch(reject);
    });
};

const initUser = () => {
    return new Promise((resolve, reject) => {
        connectUser(0)
        .then(network => {
            network.historyKeeper = hk;
            return createUserRpc({ network, keys });
        })
        .then(uploadBlob)
        .then(checkBlob)
        .then(uploadBlobHttp)
        .then(checkBlobHttp)
        .then(() => {
            resolve();
        }).catch(e => {
            console.error(e);
            reject(e);
        });
    });
};

initUser()
.then(() => {
    console.log('BLOB: success');
    if (require.main === module) { process.exit(0); }
    global?.onTestEnd?.(true);
}).catch(e => {
    console.log('BLOB: failure');
    console.log(e);
    if (require.main === module) { process.exit(1); }
    global?.onTestEnd?.(false);
});
