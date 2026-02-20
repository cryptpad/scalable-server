// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors

/* Integration test about basic channel usage:
 * Multiple users will connect to different front nodes and
 * join the same pad. We'll make sure they all receive the correct
 * JOIN, MSG and LEAVE messages as weell as the pad history.
 */

const { connectUser, getChannelPath } = require('./common/utils');

const Crypto = require('node:crypto');
const CPCrypto = require('chainpad-crypto');
const CPNetflux = require('chainpad-netflux');

const nbUsers = 5;
const users = {};

// From common-util + Buffer instead of window.atob
const base64ToHex = (b64String) => {
    var hexArray = [];
    Buffer.from(b64String.replace(/-/g, '/'), 'base64').toString('binary').split("").forEach(function(e){
        var h = e.charCodeAt(0).toString(16);
        if (h.length === 1) { h = "0"+h; }
        hexArray.push(h);
    });
    return hexArray.join("");
};


const hk = '0123456789abcdef';
let secret = {
    keys: CPCrypto.createEditCryptor2()
};
secret.channel = base64ToHex(secret?.keys?.chanId);
console.log(getChannelPath(secret.channel));
const encryptor = CPCrypto.createEncryptor(secret?.keys);

const startUsers = () => {
    return new Promise((resolve, reject) => {
        const all = [];
        for (let i = 0; i < nbUsers; i++) {
            all.push(connectUser(i));
        }
        Promise.all(all).then(values => {
            values.forEach((network, i) => {
                users[i] = {
                    network: network
                };
            });
            resolve();
        }).catch(reject);
    });
};


let getMsg = isCp => {
    const base = Crypto.randomBytes(30).toString('hex');
    const iterations = isCp ? 1500 + Math.floor(Math.random * 3000) : 5 + Math.floor(Math.random() * 10);
    return base.repeat(iterations);
};

let signMsg = (isCp) => {
    let msg = getMsg(isCp);
    let signed = encryptor.encrypt(msg); // Signature is already part of it
    if (!isCp) { return signed; }
    let id = msg.slice(0, 8);
    return `cp|${id}|${signed}`;
};

const initPad = () => {
    const user = users[0];
    const network = user.network;
    const txid = Crypto.randomBytes(4).toString('hex');
    return new Promise((resolve, reject) => {
        network.on('message', (msg, sender) => {
            if (!user.wc) { return; }
            const parsed = JSON.parse(msg);
            if (sender !== hk) { return; }
            if (parsed?.state === 1 && parsed?.channel === secret?.channel) {
                resolve();
            }
        });
        network.join(secret?.channel).then(wc => {
            user.wc = wc;
            const msg = ['GET_HISTORY', secret.channel, {
                txid, metadata: {
                    validateKey: secret?.keys?.validateKey,
                    owners: [],
                    allowed: []
                }
            }];
            network.sendto(hk, JSON.stringify(msg));
        }).catch(e => {
            reject(e);
        });
    });
};

const joinPad = () => {
    let res, rej;
    const prom = new Promise((resolve, reject) => {
        res = resolve;
        rej = reject;
    });

    const all = Object.values(users).map(({ network }) => {
        return network.join(secret.channel);
    });

    Promise.all(all).then(webChannels => {
        webChannels.forEach((wc, idx) => {
            const hist = [];
            users[idx].wc = wc;
            users[idx].id = wc.myID;
            users[idx].history = hist;
            wc.on('message', (msg, sender) => {
                hist.push({
                    user: sender, msg
                });
            });
        });
        setTimeout(() => {
            // Timeout here to make sure all users have received
            // all JOIN messages (race condition possible due to
            // the use of multiple ws nodes)
            res();
        }, 100);
    }).catch(rej);

    return prom;
};

const sendPadMessage = (user) => {
    const msg = signMsg(false);
    return new Promise((res, rej) => {
        user.wc.bcast(msg).then(() => {
            user.history.push({ user: user.id, msg });
            res();
        }).catch(rej);
    });
};

const sendMessages = () => {
    let all = Object.values(users).map(user => Promise.all([
        sendPadMessage(user),
        sendPadMessage(user)
    ]));
    return Promise.all(all);
};

const checkRejectSignature = () => {
    const msg = getMsg(false);
    const user = users[0];
    return new Promise((resolve, reject) =>
        user?.wc?.bcast(msg).then(reject).catch(resolve)
    );
};

const checkUsers = () => {
    return new Promise((resolve, reject) => {
        Object.values(users).every(user => {
            const lag = user?.network?.getLag?.();
            if (typeof (lag) !== "number") {
                // reject if one user doesn't have a valid network;
                return void reject(new Error("CHECK_USERS_EINVAL"));
            }
            return true;
        });
        // resolve if they all have a valid network and lag value
        resolve();
    });
};

const checkPad = () => {
    return new Promise((resolve, reject) => {
        Object.values(users).every(user => {
            try {
                const network = user.network;
                const id = user.id;
                const wc = network.webChannels[0];
                const members = wc?.members;
                if (!Array.isArray(members)) {
                    throw new Error("PAD_WC_ERROR");
                }
                if (members.length !== (nbUsers + 1)) {
                    throw new Error("PAD_MEMBERS_ERROR");
                }
                if (!id) {
                    throw new Error("PAD_MYID_ERROR");
                }
            } catch (e) {
                reject(e);
                return false;
            }
            return true;
        });
        // resolve if they all have a valid webchannel
        resolve();
    });
};

const getHistory = (index, lastKnownHash) => {
    return new Promise((resolve, reject) => {
        const hist = [];
        const validateKey = secret?.keys?.validateKey;

        const onMessage = (_msg, sender, _validateKey, _isCp, hash) => {
            if (sender !== hk) { return; }
            hist.push(hash);
        };

        const onReady = () => {
            resolve(hist);
        };

        let network;
        connectUser(index)
            .then(_network => {
                network = _network;
                // console.error(secret.keys);

                CPNetflux.start({
                    lastKnownHash,
                    network,
                    channel: secret.channel,
                    crypto: encryptor,
                    validateKey,
                    onChannelError: reject,
                    onReady,
                    onMessage,
                    noChainPad: true
                });
            })
            .catch(e => {
                console.error(e);
                reject(e);
            });
    });
};

const checkHistories = () => new Promise((resolve, reject) => {
    const startHistIdx = Math.max(nbUsers - 2, 1);
    let lastKnownHash;
    // Check Full History
    getHistory(nbUsers).then(expected => {
        let failed = [];
        lastKnownHash = expected[startHistIdx];
        for (let i in Object.keys(users)) {
            const user = users[i];
            const historyHashes = user?.history?.map(obj => { return obj.msg.slice(0, 64); });
            if ( JSON.stringify(historyHashes) !== JSON.stringify(expected) ) {
                failed.push([i, users[i].id, historyHashes]);
            }
        }
        failed.length ? reject(expected.concat(failed)) : resolve();
    }).catch(e => {
        reject('CHECK_FULL_HISTORY_ERROR' + JSON.stringify(e));
    });

    getHistory(nbUsers, lastKnownHash).then(expected => {
        let failed = [];
        for (let i in Object.keys(users)) {
            const user = users[i];
            const historyHashes = user?.history?.map(obj => { return obj.msg.slice(0, 64); });
            if ( JSON.stringify(historyHashes) !== JSON.stringify(expected) ) {
                failed.push([i, users[i].id, historyHashes]);
            }
        }
        failed.length ? reject(expected.concat(failed)) : resolve();
    }).catch(e => {
        reject('CHECK_HISTORY_ERROR' + JSON.stringify(e));
    });
});

startUsers()
    .then(checkUsers)
    .then(initPad)
    .then(joinPad)
    .then(checkPad)
    .then(sendMessages)
    .then(checkRejectSignature)
    .then(checkHistories)
    .then(() => {
        console.log('CRYPTO: success');
        if (require.main === module) { process.exit(0); }
        global?.onTestEnd?.(true);
    }).catch(e => {
        console.log('CRYPTO: failure');
        console.error(e);
        if (require.main === module) { process.exit(1); }
        global?.onTestEnd?.(false);
    });
