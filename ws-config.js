// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
module.exports = {
    infra: {
        ws: [{
            host: 'localhost',
            port: 3010
        }],
        core: [{
            host: 'localhost',
            port: 3011
        // }, {
        //     host: 'localhost',
        //     port: 3012
        }],
        storage: [{
            host: 'localhost',
            port: 3014
        }]
    }
};
