// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors

const Nacl = require('tweetnacl/nacl-fast');
const ServerCommand = require('./http-command');

const config = require('../../config/config.json');

const origin = config?.public?.main?.origin;
ServerCommand.setCustomize({
    ApiConfig: {
        httpUnsafeOrigin: origin
    }
});

const keys = Nacl.sign.keyPair();

const checkCommand = () => {
    return new Promise((resolve, reject) => {
        ServerCommand(keys, {
            command: 'TEST'
        }, (err, data) => {
            if (err) { return void reject(err); }
            if (data?.success !== 1) {
                return void reject('INVALID_RESULT');
            }
            resolve();
        });

    });
};

checkCommand()
.then(() => {
    console.log('SUCCESS');
    process.exit(1);
}).catch(e => {
    console.log('FAILED', e);
    process.exit(0);
});

