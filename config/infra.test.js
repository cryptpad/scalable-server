// SPDX-FileCopyrightText: 2026 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Infra for tests: 2-4-3 nodes topology on ports 40xx

module.exports = {
    "public": {
        origin: "http://localhost:4000",
        sandboxOrigin: "http://localhost:4001",
        httpHost: "localhost",
        httpPort: 4000,
        httpSafePort: 4001,
        externalWebsocketURL: undefined,
        fileHost: undefined,
        httpServerId: 'test',
    },
    "front": [
        {
            host: "localhost",
            port: 4010, // Public http and websocket port
            serverId: 'test'
        },
        {
            host: "localhost",
            port: 4011,
            serverId: 'test'
        }
    ],
    "core": [
        {
            host: "localhost",
            port: 4020,
            serverId: 'test'
        },
        {
            host: "localhost",
            port: 4021,
            serverId: 'test'
        },
        {
            host: "localhost",
            port: 4023,
            serverId: 'test'
        },
        {
            host: "localhost",
            port: 4024,
            serverId: 'test'
        }
    ],
    "storage": [
        {
            host: "localhost",
            port: 4030,
            wsPort: 4040,
            serverId: 'test'
        },
        {
            host: "localhost",
            port: 4031,
            wsPort: 4041,
            serverId: 'test'
        },
        {
            host: "localhost",
            port: 4032,
            wsPort: 4042,
            serverId: 'test'
        }
    ]
};
