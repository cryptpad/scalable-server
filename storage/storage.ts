// SPDX-FileCopyrightText: 2026 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Storage from './index.js';

process.on('message', (message: Message) => {
    Storage.start(message);
});

export const start = Storage.start;
