// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors

const loadSodium = cryptoLib => {
    let sodiumLib = {};
    let SodiumNative, NaCl;
    switch (cryptoLib) {
        case 'sodiumnative':
            try {
                SodiumNative = require("sodium-native");
                sodiumLib.sigVerify = (signedMessage, validateKey) => {
                    let msg = signedMessage.subarray(64);
                    let ok = SodiumNative.crypto_sign_open(msg, signedMessage, validateKey);
                    if (!ok) { return false; }
                    return msg;
                };
                sodiumLib.detachedVerify = (signedBuffer, signatureBuffer, validateKey) => SodiumNative.crypto_sign_verify_detached(signatureBuffer, signedBuffer, validateKey);
                sodiumLib.secretbox = (message, nonce, secretKey) => {
                    let secretBox = Buffer.alloc(message.length + SodiumNative.crypto_box_MACBYTES);
                    SodiumNative.crypto_secretbox_easy(secretBox, message, nonce, secretKey);
                    return secretBox;
                };
                sodiumLib.secretboxOpen = (secretBox, nonce, secretKey) => {
                    let msg = Buffer.alloc(secretBox.length - SodiumNative.crypto_secretbox_MACBYTES);
                    if (SodiumNative.crypto_secretbox_open_easy(msg, secretBox, nonce, secretKey)) {
                        return msg;
                    } else {
                        return void 0;
                    }
                };
                sodiumLib.publicKeyFromSecretKey = (secretKey) => {
                    let pk = new Uint8Array(SodiumNative.crypto_sign_PUBLICKEYBYTES);
                    SodiumNative.crypto_sign_ed25519_sk_to_pk(pk, secretKey);
                    return pk;
                };
                sodiumLib.hash = (message) => {
                    let out = Buffer.alloc(SodiumNative.crypto_hash_sha512_BYTES);
                    SodiumNative.crypto_hash_sha512(out, message);
                    return out;
                };
            } catch (err) {
                console.error("Error in loading sodium-native: fallback on tweetnacl");
                return loadSodium('');
            }
            break;
        default: // tweetNaCl
            NaCl = require("tweetnacl/nacl-fast");
            sodiumLib.sigVerify = NaCl.sign.open;
            sodiumLib.detachedVerify = NaCl.sign.detached.verify;
            sodiumLib.secretbox = NaCl.secretbox;
            sodiumLib.secretboxOpen = (secretBox, nonce, secretKey) => Buffer.from(NaCl.secretbox.open(secretBox, nonce, secretKey));
            sodiumLib.publicKeyFromSecretKey = (secretKey) => {
                return NaCl.sign?.keyPair?.fromSecretKey(secretKey)?.publicKey;
            };
            sodiumLib.hash = (msg) => Buffer.from(NaCl.hash(msg));
            break;
    }
    return sodiumLib;
};

module.exports = cryptoLib => {
    const exports = loadSodium(cryptoLib);
    exports.decodeBase64 =  msg => Buffer.from(msg, 'base64');
    exports.encodeBase64 = msg => Buffer.from(msg).toString('base64');
    exports.decodeUTF8 = msg => Buffer.from(msg, 'utf8');
    exports.encodeUTF8 = msg => Buffer.from(msg).toString('utf8');
    return exports;
};
