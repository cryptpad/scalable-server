const Crypto = require('node:crypto');
const nThen = require('nthen');
const Util = require('../common/common-util');
const Nacl = require('tweetnacl/nacl-fast');

const padId = Crypto.randomBytes(16).toString('hex');
const padId2 = Crypto.randomBytes(16).toString('hex');
const padId3 = Crypto.randomBytes(16).toString('hex');
const padId4 = Crypto.randomBytes(16).toString('hex');
const blobId2 = Crypto.randomBytes(24).toString('hex');
const blobId3 = Crypto.randomBytes(24).toString('hex');
const hk = '0123456789abcdef';

const {
    connectUser,
    createAnonRpc, createUserRpc,
    getRandomKeys, getRandomMsg,
    getChannelPath
} = require('./common/utils.js');

console.log('linked', getChannelPath(padId));
console.log('linked', getChannelPath(padId2));
console.log('linked', getChannelPath(padId3));
console.log('linked', getChannelPath(padId4));

const Env = {};

const isClearedEvt = Util.mkEvent(true);

const signData = data => {
    const edPrivate = Util.decodeBase64(Env.padKeys.edPrivate);
    const msg = Util.decodeUTF8(JSON.stringify(data));
    data.proof = Util.encodeBase64(Nacl.sign.detached(msg, edPrivate));
    return data;
};
const signMsg = msgStr => {
    const edPrivate = Util.decodeBase64(Env.padKeys.edPrivate);
    const msg = Util.decodeUTF8(msgStr);
    return Util.encodeBase64(Nacl.sign(msg, edPrivate));
};

const sendMsg = wc => {
    Env.messages ||= [];
    const msg = signMsg(getRandomMsg());
    Env.messages.push(msg);
    return wc.bcast(msg);
};

const sendMessages = wc => {
    const send = () => { return sendMsg(wc); };
    return send().then(send).then(send).then(send).then(send);
};

Env.keys = getRandomKeys();
Env.padKeys = getRandomKeys();

const initPad = (network, channel, main) => {
    const txid = Crypto.randomBytes(4).toString('hex');
    return new Promise((resolve, reject) => {
        let _wc;
        network.on('message', (msg, sender) => {
            if (!_wc) { return; }
            const parsed = JSON.parse(msg);
            if (sender !== hk) { return; }
            if (parsed?.channel !== channel) { return; }
            if (parsed?.error === "EDELETED" &&
                parsed?.message === "TEST_RPC_INHERIT_OWNER" &&
                parsed?.channel === padId4) {
                Env.isDeleted = true;
                return;
            }
            if (parsed?.state === 1 && parsed?.channel === channel) {
                return sendMessages(_wc).then(() => {
                    resolve({network});
                }).catch(reject);
            }
        });
        network.join(channel).then(wc => {
            Env.myID = wc.myID;
            _wc = wc;
            if (main) { Env.wc = wc; }

            const md = { validateKey: Env.padKeys.edPublic };
            if (main) {
                md.owners = [Env.keys.edPublic];
                md.restricted = true;
                md.allowed = [];
            } else { md.linked = padId; }

            const msg = ['GET_HISTORY', channel, { txid, metadata: md }];
            network.sendto(hk, JSON.stringify(msg));
        }).catch(e => {
            reject(e);
        });
    });
};

const linkedContent = {
    media: [],
    checkpoints: [{
        rtChannel: padId2,
        blob: blobId2
    }, {
        rtChannel: padId3,
        blob: blobId3
    }],
    channels: []
};

const setLinked = args => {
    const {rpc, network} = args;
    if (!args.keys) { args.keys = Env.keys; }
    if (!Env.anonRpc) { Env.anonRpc = rpc; }
    return new Promise((resolve, reject) => {

        const toSend = signData({
            channel: padId,
            user: Env.keys.edPublic,
            netfluxId: Env.myID,
            content: linkedContent
        });

        Env.anonRpc.send("RESET_LINKED_DOCUMENTS", toSend, (e) => {
            if (e) { return reject(e); }
            resolve(args);
        });
    });
};

const checkLinked = args => {
    return new Promise((resolve, reject) => {
        Env.anonRpc.send("GET_LINKED_DOCUMENTS", { channel: padId }, (e, data) => {
            if (e || data?.error) { return reject(e || data.error); }
            const json = data[0];
            const cps = json.checkpoints;
            if (cps.length !== 2 || cps[0].blob !== blobId2 || cps[0].rtChannel !== padId2
                  || cps[1].blob !== blobId3 || cps[1].rtChannel !== padId3) {
                return reject('INVALID_LINKED_DATA');
            }
            resolve(args);
        });
    });
};

const checkAccess = (args) => {
    return new Promise((resolve, reject) => {
        connectUser(1).then(network => {
            network.join(padId3).then(() => {
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

const checkDestroy = (args) => {
    Env.ownerRpc = args.rpc;
    return new Promise((resolve, reject) => {
        Env.ownerRpc.send('REMOVE_OWNED_CHANNEL', {
            channel: padId4,
            reason: 'TEST_RPC_INHERIT_OWNER'
        }, (e) => {
            if (e) { return reject(e); }
            if (!Env.isDeleted) {
                return reject("MISSING_EDELETED_MESSAGE");
            }
            resolve(args);
        });
    });
};

const getTotalSize = (args) => {
    return new Promise((resolve, reject) => {
        Env.anonRpc.send("GET_FILE_SIZE", padId, (e, data) => {
            if (e) { return void reject(e); }
            const size = data[0];
            Env.totalSize = size;
            resolve();
        });
    });
};
const checkHistorySize = (args) => {
    return new Promise((resolve, reject) => {
        Env.anonRpc.send("GET_HISTORY_SIZE", { channel: padId }, (e, data) => {
            if (e) { return void reject(e); }

            const size = data[0].size;
            const hash = data[0].hash;
            Env.expectedSize = size;
            if (size !== 3567) { // padId + padId3 + their metadata
                reject('INVALID_SIZE');
            }
            Env.trimHash = hash;
            resolve(args);
        });
    });
};

const trimPad = (args) => {
    return new Promise((resolve, reject) => {
        Env.ownerRpc.send('TRIM_HISTORY', {
            channel: padId,
            hash: Env.trimHash
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
            if (size !== Env.expectedSize) { // 3 messages + metadata
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
            reason: 'TEST_RPC_REMOVE_PARENT'
        }, (e) => {
            if (e) { return reject(e); }
            resolve();
        });
    });
};
const checkRemoved = (args) => {
    return new Promise((resolve, reject) => {
        nThen(w => {
            Env.anonRpc.send("IS_NEW_CHANNEL", padId, w((e, data) => {
                if (e) { w.abort(); return void reject(e); }
                const value = data[0].reason;
                if (value !== "TEST_RPC_REMOVE_PARENT") {
                    w.abort();
                    reject('INVALID_REASON');
                }
            }));
            Env.anonRpc.send("IS_NEW_CHANNEL", padId2, w((e, data) => {
                if (e) { w.abort(); return void reject(e); }
                const value = data[0].reason;
                if (value !== "TRIM_HISTORY") { // TRIM
                    w.abort();
                    reject('INVALID_REASON');
                }
            }));
            Env.anonRpc.send("IS_NEW_CHANNEL", padId3, w((e, data) => {
                if (e) { w.abort(); return void reject(e); }
                const value = data[0].reason;
                if (value !== "TEST_RPC_REMOVE_PARENT") {
                    w.abort();
                    reject('INVALID_REASON');
                }
            }));
            Env.anonRpc.send("IS_NEW_CHANNEL", padId4, w((e, data) => {
                if (e) { w.abort(); return void reject(e); }
                const value = data[0].reason;
                if (value !== "TEST_RPC_INHERIT_OWNER") {
                    w.abort();
                    reject('INVALID_REASON');
                }
            }));
        }).nThen(() => {
            resolve(args);
        });
    });
};

const initUser = () => {
    return new Promise((resolve, reject) => {
        connectUser(0)
        .then(network => { return initPad(network, padId, true); })
        .then(obj => { return initPad(obj.network, padId2, false); })
        .then(obj => { return initPad(obj.network, padId3, false); })
        .then(obj => { return initPad(obj.network, padId4, false); })
        .then(createAnonRpc)
        .then(setLinked)
        .then(checkLinked)
        .then(checkAccess)
        .then(createUserRpc)
        .then(checkDestroy)
        .then(getTotalSize)
        .then(checkHistorySize)
        .then(trimPad)
        .then(checkTrim)
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
