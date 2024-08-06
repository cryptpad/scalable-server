// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const NaCl = require("tweetnacl/nacl-fast");

module.exports = {
    decodeBase64: msg => Buffer.from(msg, 'base64'),
    sigVerify: NaCl.sign.open, // (message, key) -> bool
};
