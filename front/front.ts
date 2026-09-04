// SPDX-FileCopyrightText: 2026 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Front from './index.js';

process.on('message', (message: Message) => {
    Front.start(message);
});


export const start = Front.start;
