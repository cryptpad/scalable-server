const Crypto = require('node:crypto');

const padId = Crypto.randomBytes(16).toString('hex');
const hk = '0123456789abcdef';

const {
    connectUser,
    createAnonRpc, createUserRpc,
    getRandomKeys, getRandomMsg,
    getChannelPath
} = require('./common/utils.js');

console.log('rpc', getChannelPath(padId));

const Env = {};

const sendMsg = wc => {
    Env.messages ||= [];
    const msg = getRandomMsg();
    Env.messages.push(msg);
    return wc.bcast(msg);
};

const sendMessages = wc => {
    const send = () => { return sendMsg(wc); };
    return send().then(send).then(send).then(send).then(send);
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
            if (parsed?.error === "EDELETED" &&
                parsed?.message === "TEST_RPC" &&
                parsed?.channel === padId) {
                Env.isDeleted = true;
                return;
            }
            if (parsed?.error === "ECLEARED" &&
                parsed?.channel === padId) {
                Env.isCleared = true;
                return;
            }
            if (parsed?.state === 1 && parsed?.channel === padId) {
                return sendMessages(Env.wc).then(() => {
                    resolve({network});
                    Env.wc.leave();
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
    Env.anonRpc = rpc;
    return new Promise((resolve, reject) => {
        rpc.send("GET_FILE_SIZE", padId, (e, data) => {
            if (e) { return void reject(e); }
            const size = data[0];
            if (size !== 1150) { // 5 messages, metadata + data
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
    const {rpc} = args;
    Env.ownerRpc = rpc;
    return Promise.resolve(args);
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

const checkAllowed = (args) => {
    const {network} = args;
    return new Promise((resolve, reject) => {
        network.join(padId).then((wc) => {
            resolve(args);
            Env.wc = wc;
        }).catch(e => {
            console.error("UNEXPECTED ERROR", e);
            return reject("INVALID_ERROR");
        });
    });
};

const checkHistoryAccess = (args) => {
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
                resolve(args);
            });
        }).catch(reject);
    });
};

const trimPad = (args) => {
    return new Promise((resolve, reject) => {
        // Remove the first 2 messages
        const hash = Env.messages[2].slice(0,64);
        Env.ownerRpc.send('TRIM_HISTORY', {
            channel: padId,
            hash
        }, (e) => {
            if (e) { return reject(e); }
            resolve(args);
        });
    });
};
const checkTrim = (args) => {
    return new Promise((resolve, reject) => {
        Env.anonRpc.send("GET_FILE_SIZE", padId, (e, data) => {
            if (e) { return void reject(e); }
            const size = data[0];
            if (size !== 754) { // 3 messages + metadata
                console.error(size);
                reject('INVALID_SIZE');
            }
            resolve(args);
        });
    });
};

const clearPad = (args) => {
    return new Promise((resolve, reject) => {
        Env.ownerRpc.send('CLEAR_OWNED_CHANNEL', padId, (e) => {
            if (e) { return reject(e); }
            if (!Env.isCleared) {
                return reject("MISSING_ECLEARED_MESSAGE");
            }
            resolve(args);
        });
    });
};
const checkClear = (args) => {
    return new Promise((resolve, reject) => {
        Env.anonRpc.send("GET_FILE_SIZE", padId, (e, data) => {
            if (e) { return void reject(e); }
            const size = data[0];
            if (size !== 160) { // cleared channel + metadata
                console.error(size);
                reject('INVALID_SIZE');
            }
            resolve(args);
        });
    });
};

const removePad = (args) => {
    return new Promise((resolve, reject) => {
        Env.ownerRpc.send('REMOVE_OWNED_CHANNEL', {
            channel: padId,
            reason: 'TEST_RPC'
        }, (e) => {
            if (e) { return reject(e); }
            if (!Env.isDeleted) {
                return reject("MISSING_EDELETED_MESSAGE");
            }
            resolve(args);
        });
    });
};
const checkRemoved = (args) => {
    return new Promise((resolve, reject) => {
        Env.anonRpc.send("IS_NEW_CHANNEL", padId, (e, data) => {
            if (e) { return void reject(e); }
            const value = data[0];
            if (!value.isNew) { return reject('DELETION_ERROR'); }
            if (value.reason !== "TEST_RPC") {
                console.error(value);
                reject('INVALID_REASON');
            }
            resolve(args);
        });
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
        .then(checkAllowed)
        .then(checkHistoryAccess)
        .then(trimPad)
        .then(checkTrim)
        .then(clearPad)
        .then(checkClear)
        .then(removePad)
        .then(checkRemoved)
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
