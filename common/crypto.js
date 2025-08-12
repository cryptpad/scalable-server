// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors

module.exports = cryptoLib => {
    let exports = {};
    exports.decodeBase64 =  msg => Buffer.from(msg, 'base64');
    let SodiumNative, NaCl;
    switch (cryptoLib) {
        case 'sodiumnative':
            SodiumNative = require("sodium-native");
            exports.sigVerify = (signedMessage, validateKey) => {
                let msg = signedMessage.subarray(64);
                return SodiumNative.crypto_sign_open(msg, signedMessage, validateKey);
            };
            exports.detachedVerify = (signedBuffer, signatureBuffer, validateKey) => SodiumNative.crypto_sign_verify_detached(signatureBuffer, signedBuffer, validateKey);
            exports.secretbox = (message, nonce, secretKey) => {
                let secretBox = Buffer.alloc(message.length + SodiumNative.crypto_box_MACBYTES);
                SodiumNative.crypto_secretbox_easy(secretBox, message, nonce, secretKey);
                return secretBox;
            };
            exports.secretboxOpen = (secretBox, nonce, secretKey) => {
                let msg = Buffer.alloc(secretBox.length - SodiumNative.crypto_secretbox_MACBYTES)
                if (SodiumNative.crypto_secretbox_open_easy(msg, secretBox, nonce, secretKey)) {
                    return msg;
                } else {
                    return void 0;
                }
            };
            break;
        default: // tweetNaCl
            NaCl = require("tweetnacl/nacl-fast");
            exports.sigVerify = NaCl.sign.open;
            exports.detachedVerify = NaCl.sign.detached.verify;
            exports.secretbox = NaCl.secretbox;
            exports.secretboxOpen = NaCl.secretbox.open;
            break;
    }
    return exports;
}
