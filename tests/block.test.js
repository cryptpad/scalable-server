const Crypto = require('node:crypto');
const Block = require('./common/block');
const Util = require('../common/common-util');

const {
    connectUser,
    getRandomKeys,
    getBlockPath
} = require('./common/utils.js');

const keys = getRandomKeys();
const cryptKey = Crypto.randomBytes(32);
const blockKeys = {
    sign: keys,
    symmetric: cryptKey
};

const randomString = Crypto.randomBytes(16).toString('hex');

const log = (require.main === module) ? console.log : function () {};

log('Block path', getBlockPath(keys.edPublic));

const writeBlock = args => {
    return new Promise((resolve, reject) => {
        Block.writeLoginBlock({
            blockKeys,
            content: {
                randomString,
                test: true
            },
        }, (e, res) => {
            if (e) {
                console.error(e, res);
                return reject(e);
            }
            resolve(args);
        });
    });
};
const checkBlock = args => {
    return new Promise((resolve, reject) => {
        const url = Block.getBlockUrl(blockKeys);
        log('Block URL:', url);
        Util.getBlock(url, {}, (err, res) => {
            if (err) { return reject(err); }
            res.arrayBuffer().then(arraybuffer => {
                const block = new Uint8Array(arraybuffer);
                let decryptedBlock = Block.decrypt(block, blockKeys);
                if (!decryptedBlock) {
                    return reject('DECRYPTION_ERROR');
                }
                if (decryptedBlock.randomString === randomString
                    && decryptedBlock.test) {
                    return resolve(args);
                }
                reject('INVALID_BLOCK_CONTENT');
            });
        });
    });
};
const removeBlock = args => {
    return new Promise((resolve, reject) => {
        Block.removeLoginBlock({
            blockKeys,
            reason: 'INTEGRATION_TEST'
        }, (e, res) => {
            if (e) {
                console.error(e, res);
                return reject(e);
            }
            resolve(args);
        });
    });
};
const checkRemovedBlock = args => {
    return new Promise((resolve, reject) => {
        const url = Block.getBlockUrl(blockKeys);
        Util.getBlock(url, {}, (e, res) => {
            if (e === 404 && res?.reason === 'INTEGRATION_TEST') {
                return resolve(args);
            }
            console.log(e, res);
            reject('BLOCK_DELETION_ERROR');
        });
    });
};

const initUser = () => {
    return new Promise((resolve, reject) => {
        connectUser(0)
        .then(writeBlock)
        .then(checkBlock)
        .then(removeBlock)
        .then(checkRemovedBlock)
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
    console.log('BLOCK: success');
    if (require.main === module) { process.exit(0); }
    global?.onTestEnd?.(true);
}).catch(e => {
    console.log('BLOCK: failure');
    console.log(e);
    if (require.main === module) { process.exit(1); }
    global?.onTestEnd?.(false);
});
