// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors

/* Integration test about basic channel usage:
 * Multiple users will connect to different websocket nodes and
 * join the same pad. We'll make sure they all receive the correct
 * JOIN, MSG and LEAVE messages as weell as the pad history.
 */


const NodeCrypto = require('node:crypto');
/* NOTE: both are needed as signature creation is not part of the server */
const Sodium = require('sodium-native');
const Crypto = require("../../common/crypto.js")("sodium-native");
const NaClUtil = require("tweetnacl-util");

const WebSocket = require("ws");
const Netflux = require("netflux-websocket");
const Hash = require("./common-hash");

const config = require('../../config/config.json');

const nbUsers = 5;
const users = {};

let padId = "";

const hk = '0123456789abcdef';
let secret = {};
let hash_prefix = NodeCrypto.randomBytes(12).toString('base64').replace('/', '-').slice(0, 14);
let hash = "/2/undefined/edit/" + hash_prefix; // missing 10 characters

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
    const base = NodeCrypto.randomBytes(30).toString('hex');
    const iterations = isCp ? 1500 + Math.floor(Math.random * 3000) : 5 + Math.floor(Math.random() * 10);
    return base.repeat(iterations);
};

let makeHash = (id) => {
    let l = String(id).length;
    let add = 10 - l;
    let str = String(id);
    for (let i = 0; i < add; i++) {
        str = 'x' + str;
    }
    let _hash = hash + str + '/';
    return _hash;
};

let signMsg = (isCp, secret) => {
    let msg = getMsg(isCp);
    let signKey = NaClUtil.decodeBase64(secret.keys.signKey);
    let msg8 = NaClUtil.decodeUTF8(msg);
    let signed8 = new Uint8Array(msg8.length + 64);
    // let signed2 = NaClUtil.encodeBase64(nacl.sign(NaClUtil.decodeUTF8(msg), signKey));
    Sodium.crypto_sign(signed8, msg8, signKey);
    let signed = NaClUtil.encodeBase64(signed8);
    if (!isCp) { return signed; }
    let id = msg.slice(0, 8);
    return `cp|${id}|${signed}`;
};

const joinPad = () => {
    let res, rej;
    const prom = new Promise((resolve, reject) => {
        res = resolve;
        rej = reject;
    });

    let hash = makeHash(0);
    secret = Hash.getSecrets('pad', hash);
    padId = secret.channel;

    const all = Object.values(users).map(({ network }) => {
        return network.join(secret.channel);
    });

    Promise.all(all).then(webChannels => {
        webChannels.forEach((wc, idx) => {
            const hist = [];
            users[idx].wc = wc;
            users[idx].id = wc.myID;
            users[idx].secret = secret;
            users[idx].pads = [hash];
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

const messages = [];

const sendPadMessage = (user) => {
    // const rdm = NodeCrypto.randomBytes(48).toString('hex');
    // const msg = `test-${user.id}-${rdm}`;
    const msg = signMsg(false, user.secret);
    return new Promise((res, rej) => {
        user.wc.bcast(msg).then(() => {
            messages.push({ user: user.id, msg });
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

const checkHistory = () => {
    return new Promise((resolve, reject) => {
        const startHistIdx = 4;

        const txid = NodeCrypto.randomBytes(4).toString('hex');

        const expected = messages.slice(startHistIdx).map(obj => obj.msg);
        const lastKnownHash = expected[0].slice(0, 64);

        const hist = [];
        const validateKey = NaClUtil.decodeBase64(secret?.keys?.validateKey);

        const onMessage = (msg, sender) => {
            const parsed = JSON.parse(msg);
            if (sender !== hk) { return; }
            if (parsed.state === 1 && parsed.channel === padId) {
                if (JSON.stringify(expected) !== JSON.stringify(hist)) {
                    return void reject("CHECK_HISTORY_MISMATCH_ERROR");
                }
                resolve();
            }
            if (!Array.isArray(parsed) || parsed[3] !== padId) { return; }
            if (Crypto.sigVerify(NaClUtil.decodeBase64(parsed[4]), validateKey) === null) { return reject('EINVALIDSIG'); }
            hist.push(parsed[4]);
        };

        let network;
        connectUser(nbUsers)
            .then(_network => {
                network = _network;
                _network.on('message', onMessage);
                return _network.join(padId);
            }).then(() => {
                const msg = ['GET_HISTORY', padId, {
                    txid, lastKnownHash
                }];
                network.sendto(hk, JSON.stringify(msg));
            }).catch(e => {
                console.error(e);
                reject(e);
            });
    });
};

const checkFullHistory = () => {
    return new Promise((resolve, reject) => {
        const txid = NodeCrypto.randomBytes(4).toString('hex');

        const expected = messages.map(obj => obj.msg);

        const hist = [];
        const validateKey = NaClUtil.decodeBase64(secret?.keys?.validateKey);

        const onMessage = (msg, sender) => {
            const [command, parsed] = JSON.parse(msg);
            if (sender !== hk) { return; }
            if (command === 'FULL_HISTORY_END' && parsed === padId) {
                if (JSON.stringify(expected) !== JSON.stringify(hist)) {
                    return void reject("CHECK_HISTORY_MISMATCH_ERROR");
                }
                resolve();
            }
            if (!Array.isArray(parsed) || parsed[3] !== padId) { return; }
            if (Crypto.sigVerify(NaClUtil.decodeBase64(parsed[4]), validateKey) === null) { return reject('EINVALIDSIG'); }
            hist.push(parsed[4]);
        };

        let network;
        connectUser(nbUsers)
            .then(_network => {
                network = _network;
                _network.on('message', onMessage);
                return _network.join(padId);
            }).then(() => {
                const msg = ['GET_FULL_HISTORY', padId, {
                    txid
                }];
                network.sendto(hk, JSON.stringify(msg));
            }).catch(e => {
                console.error(e);
                reject(e);
            });
    });
};

const checkHistoryRange = () => {
    return new Promise((resolve, reject) => {
        const startHistIdx = 2;
        const endHistIdx = 6;

        const txid = NodeCrypto.randomBytes(4).toString('hex');

        const expected = messages.slice(startHistIdx, endHistIdx).map(obj => obj.msg);
        const to = expected[0].slice(0, 64);
        const from = expected.at(-1).slice(0, 64);

        const hist = [];
        const validateKey = NaClUtil.decodeBase64(secret?.keys?.validateKey);

        const onMessage = (msg, sender) => {
            const [command, _txid, parsed] = JSON.parse(msg);
            if (sender !== hk) { return; }
            if (command === 'HISTORY_RANGE_END' && parsed === padId) {
                if (JSON.stringify(expected) !== JSON.stringify(hist)) {
                    return void reject("CHECK_HISTORY_MISMATCH_ERROR");
                }
                resolve();
            }
            if (!Array.isArray(parsed) || txid !== _txid || parsed[3] !== padId) { return; }
            if (Crypto.sigVerify(NaClUtil.decodeBase64(parsed[4]), validateKey) === null) { return reject('EINVALIDSIG'); }
            hist.push(parsed[4]);
        };

        let network;
        connectUser(nbUsers)
            .then(_network => {
                network = _network;
                _network.on('message', onMessage);
                return _network.join(padId);
            }).then(() => {
                const msg = ['GET_HISTORY_RANGE', padId, {
                    txid, to, from, count: 4
                }];
                network.sendto(hk, JSON.stringify(msg));
            }).catch(e => {
                console.error(e);
                reject(e);
            });
    });
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

const checkMessages = () => {
    return new Promise((resolve, reject) => {
        Object.values(users).every(user => {
            try {
                const hist = user.history;
                if (hist.length !== messages.length) {
                    throw new Error("CHECK_MESSAGES_LENGTH_ERROR");
                }
                if (hist.some((obj, i) => {
                    const msg = messages[i];
                    return msg.user !== obj.user
                        || msg.msg !== obj.msg;
                })) {
                    throw new Error("MESSAGES_ORDER_ERROR");
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

startUsers()
    .then(checkUsers)
    .then(joinPad)
    .then(checkPad)
    .then(sendMessages)
    .then(checkMessages)
    .then(checkHistory)
    .then(checkFullHistory)
    .then(checkHistoryRange)
    .then(() => {
        console.log('All pads tests passed!');
        process.exit(0);
    }).catch(e => {
        console.error(e);
        process.exit(1);
    });
