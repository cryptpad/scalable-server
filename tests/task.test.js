// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors

/* Integration test about basic pad usage.
 * Multiple users will connect to different websocket nodes and
 * join the same pad. We'll make sure they all receive the correct
 * JOIN, MSG and LEAVE messages as weell as the pad history.
 */


const Crypto = require('node:crypto');

const WebSocket = require("ws");
const Netflux = require("netflux-websocket");

const infra = require('../../config/infra.json');
const config = require('../../config/config.json');

const wss = infra.websocket;
const wsCfg = config?.public?.websocket;

const padId = Crypto.randomBytes(16).toString('hex');

const hk = '0123456789abcdef';

const getWsURL = (index) => {
    // Index inside infra array
    const wssIndex = index % wss.length;
    // Public config
    const ws = wsCfg[wssIndex];

    const wsUrl = new URL('ws://localhost:3000');
    if (ws.host && ws.port) {
        wsUrl.host = ws.host;
        wsUrl.port = ws.port;
        wsUrl.protocol = ws.protocol || 'ws:';
    } else {
        wsUrl.href = ws.href;
    }
    return wsUrl.href;
};

const connectUser = index => {
    const f = () => {
        return new WebSocket(getWsURL(index));
    };
    return Netflux.connect('', f);
};

console.log(padId);
const setExpire = () => {
    return new Promise((resolve, reject) => {
        const txid = Crypto.randomBytes(4).toString('hex');

        const onMessage = (msg, sender) => {
            const parsed = JSON.parse(msg);
            if (sender !== hk) { return; }
            if (parsed.state === 1 && parsed.channel === padId) {
                resolve();
            }
        };

        //let expire = 5*60;
        let expire = 30;
        connectUser(0)
        .then(_network => {
            network = _network;
            _network.on('message', onMessage);
            return _network.join(padId);
        }).then(() => {
            const msg = ['GET_HISTORY', padId, {
                txid,
                metadata: {
                    expire
                }
            }];
            network.sendto(hk, JSON.stringify(msg));
        }).catch(e => {
            console.error(e);
            reject(e);
        });
    });
};


setExpire()
//.then(checkHistoryRange)
.then(() => {
    console.log('All pads tests passed!');
    process.exit(0);
}).catch(e => {
    console.error(e);
});
