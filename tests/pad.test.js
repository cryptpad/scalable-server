// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors

/* Integration test about basic pad usage.
 * Multiple users will connect to different websocket nodes and
 * join the same pad. We'll make sure they all receive the correct
 * JOIN, MSG and LEAVE messages as weell as the pad history.
 */

const Crypto = require('node:crypto');

const nbUsers = 5;
const users = {};

const padId = Crypto.randomBytes(16).toString('hex');
const hk = '0123456789abcdef';

const {
    connectUser,
    getRandomMsg,
    getChannelPath
} = require('./common/utils.js');
console.log('pad', getChannelPath(padId));

const startUsers = () => {
    return new Promise((resolve, reject) => {
        const all = [];
        for (let i=0; i<nbUsers; i++) {
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

const joinPad = () => {
    let res, rej;
    const prom  = new Promise((resolve, reject) => {
        res = resolve;
        rej = reject;
    });

    const all = Object.values(users).map(({network}) => {
        return network.join(padId);
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

const messages = [];

const sendPadMessage = (user) => {
    const msg = getRandomMsg();
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

        const txid = Crypto.randomBytes(4).toString('hex');

        const expected = messages.slice(startHistIdx).map(obj => obj.msg);
        const lastKnownHash = expected[0].slice(0,64);

        const hist = [];

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
        const txid = Crypto.randomBytes(4).toString('hex');

        const expected = messages.map(obj => obj.msg);

        const hist = [];

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

        const txid = Crypto.randomBytes(4).toString('hex');

        const expected = messages.slice(startHistIdx, endHistIdx).map(obj => obj.msg);
        const to = expected[0].slice(0,64);
        const from = expected.at(-1).slice(0,64);

        const hist = [];

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
            if (typeof(lag) !== "number") {
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
    console.log('PAD: success');
    if (require.main === module) { process.exit(0); }
    global?.onTestEnd?.(true);
}).catch(e => {
    console.log('PAD: failure');
    console.error(e);
    global?.onTestEnd?.(false);
});
