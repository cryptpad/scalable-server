// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// Implementation of https://arxiv.org/pdf/1406.2294
// Inspired from: https://github.com/autonomys/jump-consistent-hash/tree/master
// Not used due to security issue

module.exports = {
    jumpConsistentHash: function(key, num_buckets) {
        let keyBigInt = key.readBigUInt64LE();
        let b = -1n;
        let j = 0n;
        while (j < num_buckets) {
            b = j;
            keyBigInt = (keyBigInt * 2862933555777941757n + 1n) % (1n << 64n);
            j = BigInt(Math.floor((Number(b) + 1) * Number(1n << 31n) / Number((keyBigInt >> 33n) + 1n)))
        }
        return b;
    }
}
