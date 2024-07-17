// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
module.exports = {
    infra: {
        ws: [{
            url: 'localhost:3010'
        }],
        core: [{
            url: 'localhost:3011'
        }, {
            url: 'localhost:3012'
        }],
        storage: [{
            url: 'localhost:3014'
        }]
    }
};
