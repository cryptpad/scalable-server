// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors

module.exports = cryptoLib => {
    let exports = {};
    exports.decodeBase64 =  msg => Buffer.from(msg, 'base64');
    switch (cryptoLib) {
        case 'sodiumnative':
            const SodiumNative = require("sodium-native");
            exports.sigVerify = (signedMessage, validateKey) => {
                let msg = signedMessage.subarray(64);
                return SodiumNative.crypto_sign_open(msg, signedMessage, validateKey);
            };
            exports.detachedVerify = (signedBuffer, signatureBuffer, validateKey) => SodiumNative.crypto_sign_verify_detached(signatureBuffer, signedBuffer, validateKey);
            break;
        default: // tweetNaCl
            const NaCl = require("tweetnacl/nacl-fast");
            exports.sigVerify = NaCl.sign.open;
            exports.detachedVerify = NaCl.sign.detached.verify;
            break;
    }
    return exports;
}
