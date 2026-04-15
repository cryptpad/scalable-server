// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors

module.exports = cryptoLib => {
    let exports = {};
    exports.decodeBase64 =  msg => Buffer.from(msg, 'base64');
    exports.encodeBase64 = msg => Buffer.from(msg).toString('base64');
    exports.decodeUTF8 = msg => Buffer.from(msg, 'utf8');
    exports.encodeUTF8 = msg => Buffer.from(msg).toString('utf8');
    let SodiumNative, NaCl;
    switch (cryptoLib) {
        case 'sodiumnative':
            SodiumNative = require("sodium-native");
            exports.sigVerify = (signedMessage, validateKey) => {
                let msg = signedMessage.subarray(64);
                let ok = SodiumNative.crypto_sign_open(msg, signedMessage, validateKey);
                if (!ok) { return false; }
                return msg;
            };
            exports.detachedVerify = (signedBuffer, signatureBuffer, validateKey) => SodiumNative.crypto_sign_verify_detached(signatureBuffer, signedBuffer, validateKey);
            exports.secretbox = (message, nonce, secretKey) => {
                let secretBox = Buffer.alloc(message.length + SodiumNative.crypto_box_MACBYTES);
                SodiumNative.crypto_secretbox_easy(secretBox, message, nonce, secretKey);
                return secretBox;
            };
            exports.secretboxOpen = (secretBox, nonce, secretKey) => {
                let msg = Buffer.alloc(secretBox.length - SodiumNative.crypto_secretbox_MACBYTES);
                if (SodiumNative.crypto_secretbox_open_easy(msg, secretBox, nonce, secretKey)) {
                    return msg;
                } else {
                    return void 0;
                }
            };
            exports.publicKeyFromSecretKey = (secretKey) => {
                let pk = new Uint8Array(SodiumNative.crypto_sign_PUBLICKEYBYTES);
                SodiumNative.crypto_sign_ed25519_sk_to_pk(pk, secretKey);
                return pk;
            };
            break;
        default: // tweetNaCl
            NaCl = require("tweetnacl/nacl-fast");
            exports.sigVerify = NaCl.sign.open;
            exports.detachedVerify = NaCl.sign.detached.verify;
            exports.secretbox = NaCl.secretbox;
            exports.secretboxOpen = NaCl.secretbox.open;
            exports.publicKeyFromSecretKey = (secretKey) => {
                return Nacl.sign.keyPair.fromSecretKey(secretKey);
            };
            break;
    }
    return exports;
};
