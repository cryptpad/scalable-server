// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 XWiki CryptPad Team <contact@cryptpad.org> and contributors

/* Tests that /common/crypto.js crypto implementations are consistent between
 * the different libraries
 */
const nodeCrypto = require('node:crypto');
const CryptoLibs = [
    require('../common/crypto.js')('default'), //tweetnacl
    require('../common/crypto.js')('sodium-native'),
];

const CryptoSize = CryptoLibs.length;

const testHash = () =>  new Promise((resolve, reject) => {
    const testInputs = [];
    for (let i = 0; i < 5; ++i) {
        testInputs.push(new Uint8Array(nodeCrypto.randomBytes(24)));
    }
    const outputs = CryptoLibs.map((CryptoLib) => testInputs.map((msg) => CryptoLib.hash(msg)));
    for (let i = 1; i < outputs.length; i++) {
        for (let j = 0; j < 5; j++) {
            if (typeof (outputs[i][j]) !== typeof (outputs[0][j]) ||
                outputs[i][j].toString() !== outputs[0][j].toString()) {
                return reject('Hash failure');
            }
        }
    };
    resolve();
});

const testPkFromSk = () => new Promise((resolve, reject) => {
    const keyPair = {
        publicKey: Uint8Array.from(CryptoLibs[0].decodeBase64('YznSZYpYQ5ou3rB51HtZbObHJUJnLXKPkSGjvoPzpkI=')),
        secretKey: Uint8Array.from(CryptoLibs[0].decodeBase64('m0pTo4eSJ11T2uP0+aJZQzbNSfyKJHbKFFqa6ppTniZjOdJlilhDmi7esHnUe1ls5sclQmctco+RIaO+g/OmQg==')),
    };
    for (let i = 0; i < CryptoSize; i++) {
        if (keyPair.publicKey.toString() !== CryptoLibs[i].publicKeyFromSecretKey(keyPair.secretKey).toString()) {
            reject('Deriving public key failed');
        }
    };
    resolve(keyPair);
});

const testSignature = (keyPair) => new Promise((resolve, reject) => {
    const testMsg = Uint8Array.from(Buffer.from("Test message"));
    const testSig = Uint8Array.from(CryptoLibs[0].decodeBase64('U4c8aE/gd6hx5kMPM0MAC+JCj5TPUwkrepD1+5E4/ocuWmJguRsoCWOd+8UMrdCOs/Hor2o4wfbKKQC4QUWWB1Rlc3QgbWVzc2FnZQ=='));
    const testDetached = Uint8Array.from(CryptoLibs[0].decodeBase64('U4c8aE/gd6hx5kMPM0MAC+JCj5TPUwkrepD1+5E4/ocuWmJguRsoCWOd+8UMrdCOs/Hor2o4wfbKKQC4QUWWBw=='));
    for (let i = 0; i < CryptoSize; i++) {
        if (CryptoLibs[i].sigVerify(testSig, keyPair.publicKey).toString() !== testMsg.toString()) {
            return reject('Signature verification failed');
        }
        if (!CryptoLibs[i].detachedVerify(testMsg, testDetached, keyPair.publicKey)) {
            return reject('Detached signature verification failed');
        }
    }
    resolve();
});

const testSecretBox = () => new Promise((resolve, reject) => {
    const secretKey = Uint8Array.from(nodeCrypto.randomBytes(32));
    const nonce = Uint8Array.from(nodeCrypto.randomBytes(24));
    const testMsg = Uint8Array.from(Buffer.from("Test message"));
    const testEnc = CryptoLibs[0].secretbox(testMsg, nonce, secretKey);
    for (let i = 0; i < CryptoSize; i++) {
        if (CryptoLibs[i].secretboxOpen(testEnc, nonce, secretKey).toString() !== testMsg.toString()) {
            reject('Opening secretbox failed');
        }
    }
    resolve();
});

testHash()
    .then(testPkFromSk)
    .then(testSignature)
    .then(testSecretBox)
    .then(() => {
        console.log('CRYPTOAGILITY: success');
        if (require.main === module) { process.exit(0); }
        global?.onTestEnd?.(true);
    })
    .catch(e => {
        console.log('CRYPTOAGILITY: failure');
        console.error(e);
        if (require.main === module) { process.exit(1); }
        global?.onTestEnd?.(false);
    });
