const Crypto = require('node:crypto');
const WebSocket = require("ws");
const Netflux = require("netflux-websocket");

const Nacl = require('tweetnacl/nacl-fast');
const Util = require('../../common/common-util');

const infra = require('../../config/infra.json');
const config = require('../../config/config.json');

const Rpc = require('./rpc');

const wss = infra.websocket;
const wsCfg = config?.public?.websocket;

const padId = Crypto.randomBytes(16).toString('hex');
const hk = '0123456789abcdef';

const getWsURL = (index) => {
    // Index inside infra array
    const wssIndex = index % wss.length;
    // Public config
    const ws = wsCfg[wssIndex];

    const wsUrl = new URL('ws://localhost:3000');
    if (ws.host && ws.port) {
        wsUrl.host = ws.host;
        wsUrl.port = ws.port;
        wsUrl.protocol = ws.protocol || 'ws:';
    } else {
        wsUrl.href = ws.href;
    }
    return wsUrl.href;
};
const connectUser = index => {
    const f = () => {
        return new WebSocket(getWsURL(index));
    };
    return Netflux.connect('', f);
};


const getKeys = () => {
    const kp = Nacl.sign.keyPair();
    const edPublic = Util.encodeBase64(kp.publicKey);
    const edPrivate = Util.encodeBase64(kp.secretKey);
    return {
        edPublic, edPrivate
    };
};

const sendMsg = wc => {
    const rdm = Crypto.randomBytes(48).toString('hex');
    const msg = `test-${rdm}`;
    return wc.bcast(msg);
};
const initPad = (network) => {
    return new Promise((resolve, reject) => {
        network.join(padId).then(wc => {
            return sendMsg(wc);
        }).then(() => {
            resolve({network});
        }).catch(e => {
            reject(e);
        });
    });
};

const createAnon = (args) => {
    const { network } = args;
    network.historyKeeper = hk;
    return new Promise((resolve, reject) => {
        Rpc.createAnonymous(network, (e, rpc) => {
            if (e) { return reject(e); }
            resolve({rpc, network});
        });
    });
};

const checkAnon = (args) => {
    const {rpc, network} = args;
    return new Promise((resolve, reject) => {
        rpc.send("GET_FILE_SIZE", padId, (e, data) => {
            if (e) { return void reject(e); }
            const size = data[0];
            if (size !== 198) {
                reject('INVALID_SIZE');
            }
            resolve({network});
        });
    });
};

const createUser = (args) => {
    const { network } = args;
    return new Promise((resolve, reject) => {
        const {edPrivate, edPublic} = getKeys();
        let t = setTimeout(() => {
            reject('USER_RPC_TIMEOUT');
        }, 5000);
        Rpc.create(network, edPrivate, edPublic, (e, rpc) => {
            clearTimeout(t);
            if (e) { return reject(e); }
            resolve({network, rpc});
        });
    });
};

const checkUser = (/*args*/) => {
    //const {rpc, network} = args;
    return new Promise((resolve) => {
        // XXX later: check user commands
        // But COOKIE has already been tested while initializing RPC
        resolve();
    });
};

const initUser = () => {
    return new Promise((resolve, reject) => {
        connectUser(0)
        .then(initPad)
        .then(createAnon)
        .then(checkAnon)
        .then(createUser)
        .then(checkUser)
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
    console.log('SUCCESS');
    process.exit(1);
}).catch(e => {
    console.log('FAILED', e);
    process.exit(0);
});
