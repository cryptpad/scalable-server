// SPDX-FileCopyrightText: 2026 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as HttpServer from './index.js';

process.on('message', (message: Message) => {
    HttpServer.start(message);
});


export const start = HttpServer.start;
