const Crypto = require('node:crypto');

const padId = Crypto.randomBytes(16).toString('hex');
const hk = '0123456789abcdef';

const {
    getWsURL, connectUser,
    createAnonRpc, createUserRpc,
    getRandomKeys, getRandomMsg,
    getChannelPath
} = require('./common/utils.js');

console.log('rpc', getChannelPath(padId));

const Env = {};

const sendMsg = wc => {
    return wc.bcast(getRandomMsg());
};

const initPad = (network) => {
    const txid = Crypto.randomBytes(4).toString('hex');
    const {edPrivate, edPublic} = getRandomKeys();
    Env.keys = { edPublic, edPrivate };
    return new Promise((resolve, reject) => {
        network.on('message', (msg, sender) => {
            if (!Env.wc) { return; }
            const parsed = JSON.parse(msg);
            if (sender !== hk) { return; }
            if (parsed?.state === 1 && parsed?.channel === padId) {
                sendMsg(Env.wc).then(() => {
                    resolve({network});
                }).catch(reject);
            }
        });
        network.join(padId).then(wc => {
            Env.wc = wc;
            const msg = ['GET_HISTORY', padId, {
                txid, metadata: {
                    owners: [Env.keys.edPublic],
                    restricted: true,
                    allowed: []
                }
            }];
            network.sendto(hk, JSON.stringify(msg));
        }).catch(e => {
            reject(e);
        });
    });
};

const checkAnon = (args) => {
    const {rpc, network} = args;
    return new Promise((resolve, reject) => {
        rpc.send("GET_FILE_SIZE", padId, (e, data) => {
            if (e) { return void reject(e); }
            const size = data[0];
            if (size !== 358) { // metadata + data
                console.error(size);
                reject('INVALID_SIZE');
            }
            resolve({
                network,
                keys: Env.keys
            });
        });
    });
};

const checkUser = (args) => {
    //const {rpc, network} = args;
    return new Promise((resolve) => {
        // XXX later: check user commands
        // But COOKIE has already been tested while initializing RPC
        resolve(args);
    });
};

const checkAccess = (args) => {
    return new Promise((resolve, reject) => {
        connectUser(1).then(network => {
            network.join(padId).then(() => {
                reject('ACCESS_NOT_REJECTED');
            }).catch(e => {
                if (e.type !== "ERESTRICTED") {
                    console.error("UNEXPECTED ERROR", e);
                    return reject("INVALID_ERROR");
                }
                resolve(args);
            });
        }).catch(reject);
    });
};

const checkHistoryAccess = () => {
    const txid = Crypto.randomBytes(4).toString('hex');
    return new Promise((resolve, reject) => {
        connectUser(2).then(network => {
            const msg = ['GET_HISTORY', padId, {
                txid
            }];
            network.sendto(hk, JSON.stringify(msg)).then(() => {
                reject('HISTORY_NOT_REJECTED');
            }).catch(e => {
                if (e.type !== "ERESTRICTED") {
                    console.error("UNEXPECTED ERROR", e);
                    return reject("INVALID_ERROR");
                }
                resolve();
            });
        }).catch(reject);
    });
};

const initUser = () => {
    return new Promise((resolve, reject) => {
        connectUser(0)
        .then(initPad)
        .then(createAnonRpc)
        .then(checkAnon)
        .then(createUserRpc)
        .then(checkUser)
        .then(checkAccess)
        .then(checkHistoryAccess)
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
    console.log('RPC: success');
    if (require.main === module) { process.exit(0); }
    global?.onTestEnd?.(true);
}).catch(e => {
    console.log('RPC: failure');
    console.log(e);
    if (require.main === module) { process.exit(1); }
    global?.onTestEnd?.(false);
});
