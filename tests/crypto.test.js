// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors

/* Integration test about basic channel usage:
 * Multiple users will connect to different websocket nodes and
 * join the same pad. We'll make sure they all receive the correct
 * JOIN, MSG and LEAVE messages as weell as the pad history.
 */


const Crypto = require('node:crypto');
const WebSocket = require("ws");
const Netflux = require("netflux-websocket");
const CPCrypto = require('chainpad-crypto');
const CPNetflux = require('chainpad-netflux');

const config = require('../config/config.json');

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
const encryptor = CPCrypto.createEncryptor(secret?.keys);

const mainCfg = config?.public?.main;
const getWsURL = () => {
    const wsUrl = new URL('ws://localhost:3000/cryptpad_websocket');
    if (mainCfg.origin) {
        let url = new URL(mainCfg.origin);
        wsUrl.hostname = url.hostname;
        wsUrl.port = url.port;
        wsUrl.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    }
    return wsUrl.href;
};

const connectUser = index => {
    const f = () => {
        return new WebSocket(getWsURL(index));
    };
    return Netflux.connect('', f);
};

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
                // Timeout to make sure that the chan is creadet before joining it
                setTimeout(resolve, 200);
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

    padId = secret.channel;

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
            setTimeout(() => {
                // Timeout here to make sure all users have received
                // all messages (race condition possible due to
                // the use of multiple ws nodes)
                res();
            }, 200);
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

const checkHistory = (index, expected, lastKnownHash) => {
    return new Promise((resolve, reject) => {
        const hist = [];
        const validateKey = secret?.keys?.validateKey;
        const expectedMsgs = expected.map(msg => encryptor.decrypt(msg, validateKey));

        const onMessage = (msg, sender) => {
            if (sender !== hk) { return; }
            hist.push(msg);
        };

        const onReady = () => {
            if (JSON.stringify(expectedMsgs) !== JSON.stringify(hist)) {
                    return void reject("CHECK_HISTORY_MISMATCH_ERROR");
            }
            resolve();
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

const checkHistories = () => {
    // Check Full History
    let expected = users[0].history.map(obj => obj.msg);
    let checkHistoryPromises = Object.keys(users).map(user => checkHistory(user, expected));

    // Check with lastKnownHash
    const startHistIdx = Math.max(nbUsers - 2, 1);
    expected = users[0].history.slice(startHistIdx).map(obj => obj.msg);
    const lastKnownHash = expected[0].slice(0, 64);
    checkHistoryPromises.concat(Object.keys(users).map(user => checkHistory(user, expected, lastKnownHash)));
    return Promise.all(checkHistoryPromises);
};

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
