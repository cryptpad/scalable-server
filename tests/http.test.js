// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors

const Nacl = require('tweetnacl/nacl-fast');
const ServerCommand = require('./common/http-command');

const config = require('../config/config.json');

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
    console.log('HTTP: success');
    if (require.main === module) { process.exit(0); }
    global?.onTestEnd?.(true);
}).catch(e => {
    console.log('HTTP: failure');
    console.log(e);
    if (require.main === module) { process.exit(1); }
    global?.onTestEnd?.(false);
});

