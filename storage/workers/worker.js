// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later
const Util = require("../common-util.js");

const Env = {};

const init = (conf, _cb) => {
    const cb = Util.once(Util.mkAsync(_cb));
    if (!conf) {
        return void cb('E_INVALID_CONFIG');
    };
};
