// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
module.exports = {
    infra: {
        ws: [{
            address: 'localhost',
            port: 3010
        }],
        core: [{
            address: 'localhost',
            port: 3011
        }, {
            address: 'localhost',
            port: 3012
        }],
        storage: [{
            address: 'localhost',
            port: 3014
        }]
    }
};
