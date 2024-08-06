// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const NaCl = require("tweetnacl/nacl-fast");
const SodiumNative = require("sodium-native");

module.exports = cryptoLib => {
    let exports = {};
    exports.decodeBase64 =  msg => Buffer.from(msg, 'base64');
    switch (cryptoLib) {
        case 'tweetnacl':
            exports.sigVerify = NaCl.sign.open; // (message, key) -> bool
            break;
        case 'sodiumnative':
            exports.sigVerify = (signedMessage, validateKey) => {
                let msg = signedMessage.subarray(64);
                return SodiumNative.crypto_sign_open(msg, signedMessage, validateKey);
            }
            break;
        default:
            exports.sigVerify = NaCl.sign.open;
            break;
    }
    return exports;
}
