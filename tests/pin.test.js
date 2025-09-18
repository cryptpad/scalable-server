const Crypto = require('node:crypto');

const padId = Crypto.randomBytes(16).toString('hex');
const driveId = Crypto.randomBytes(16).toString('hex');
const blobId = Crypto.randomBytes(24).toString('hex');
const hk = '0123456789abcdef';

const {
    connectUser,
    createUserRpc,
    hashChannelList,
    getRandomKeys,
    getPinPath
} = require('./common/utils.js');

const keys = getRandomKeys();

const log = (require.main === module) ? console.log : function () {};

log('Pin log path', getPinPath(keys.edPublic));

const channels = [
    padId,
    blobId,
    driveId+'#drive'
];
const checkHash = hashChannelList(channels.sort());
const channels2 = [
    padId,
    driveId+'#drive'
];
const checkHash2 = hashChannelList(channels2.sort());

const initPin = args => {
    return new Promise((resolve, reject) => {
        const { network, rpc } = args;
        rpc.send('PIN', channels, err => {
            if (err) { return reject(err); }
            resolve({ network, rpc });
        });
    });
};
const checkPin = args => {
    return new Promise((resolve, reject) => {
        const { network, rpc } = args;
        rpc.send('GET_HASH', keys.edPublic, (e, hash) => {
            if (!(hash && hash[0])) {
                return reject('NO_HASH_RETURNED');
            }
            if (e) { return reject(e); }
            let h = hash[0];
            if (h !== checkHash) { return reject('WRONG_HASH_PIN'); }
            resolve({ network, rpc });
        });
    });
};
const initUnpin = args => {
    return new Promise((resolve, reject) => {
        const { network, rpc } = args;
        rpc.send('UNPIN', [blobId], err => {
            if (err) { return reject(err); }
            resolve({ network, rpc });
        });
    });
};
const checkUnpin = args => {
    return new Promise((resolve, reject) => {
        const { network, rpc } = args;
        rpc.send('GET_HASH', keys.edPublic, (e, hash) => {
            if (!(hash && hash[0])) {
                return reject('NO_HASH_RETURNED_AFTER_UNPIN');
            }
            if (e) { return reject(e); }
            let h = hash[0];
            if (h !== checkHash2) { return reject('WRONG_HASH_UNPIN'); }
            resolve({ network, rpc });
        });
    });
};


const initUser = () => {
    return new Promise((resolve, reject) => {
        connectUser(0)
        .then(network => {
            network.historyKeeper = hk;
            return createUserRpc({ network, keys });
        })
        .then(initPin)
        .then(checkPin)
        .then(initUnpin)
        .then(checkUnpin)
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
    console.log('PIN: success');
    if (require.main === module) { process.exit(0); }
    global?.onTestEnd?.(true);
}).catch(e => {
    console.log('PIN: failure');
    console.log(e);
    if (require.main === module) { process.exit(1); }
    global?.onTestEnd?.(false);
});
