// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors

// Admin private key: Kr9wV6O/9qea9LasPAJSC247FBKnSTLfx048/rpXs4z0wRJj2FE3qztPwz3j6/GFLr1n0e765Bpe2UoW7HEVjQ==
// Admin public key: 9MESY9hRN6s7T8M94+vxhS69Z9Hu+uQaXtlKFuxxFY0=

const Crypto = require('node:crypto');

const decreeValue= Crypto.randomBytes(16).toString('hex');

const hk = '0123456789abcdef';

const {
    connectUser,
    createUserRpc,
} = require('../utils.js');

const initAdmin = (network) => {
    const keys = {
        edPrivate: 'Kr9wV6O/9qea9LasPAJSC247FBKnSTLfx048/rpXs4z0wRJj2FE3qztPwz3j6/GFLr1n0e765Bpe2UoW7HEVjQ==',
        edPublic: '9MESY9hRN6s7T8M94+vxhS69Z9Hu+uQaXtlKFuxxFY0='
    };
    return new Promise((resolve, reject) => {
        resolve({network, keys});
    });
};

const sendDecree = (args) => {
    const { rpc } = args;
    return new Promise((resolve, reject) => {
        rpc.send('ADMIN', [
            'ADMIN_DECREE',
            ['TEST_DECREE', decreeValue]
        ], (err) => {
            if (err) { return reject(err); }
            resolve({ rpc });
        });
    });
};

const checkDecree = (args) => {
    const { rpc } = args;
    return new Promise((resolve, reject) => {
        rpc.send('ADMIN', [
            'CHECK_TEST_DECREE',
            []
        ], (err, res) => {
            if (err) { return reject(err); }
            const value = res[0];
            if (value !== decreeValue) {
                return reject('INVALID_RESULT');
            }
            resolve();
        });
    });
};

const initTest = () => {
    return new Promise((resolve, reject) => {
        connectUser(0)
        .then(initAdmin)
        .then(createUserRpc)
        .then(sendDecree)
        .then(checkDecree)
        .then(() => {
            resolve();
        }).catch(e => {
            console.error(e);
            reject(e);
        });
    });
};

initTest()
.then(() => {
    console.log('SUCCESS');
    process.exit(1);
}).catch(e => {
    console.log('FAILED', e);
    process.exit(0);
});
