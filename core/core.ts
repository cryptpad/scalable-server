// SPDX-FileCopyrightText: 2026 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Core from './index.js';

process.on('message', (message: Message) => {
    Core.start(message);
});

export const start = Core.start;
