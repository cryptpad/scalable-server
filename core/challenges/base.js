// SPDX-FileCopyrightText: 2023 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const Commands = module.exports;
const Util = require("../../common/common-util");
const Core = require("../../common/core");

const isValidBlockId = Core.isValidBlockId;

// Read the MFA settings for the given public key
const checkMFA = (Env, publicKey, cb) => {
    const safeKey = Util.escapeKeyCharacters(publicKey);
    const storageId = Env.getStorageId(safeKey);
    Env.interface.sendQuery(storageId, 'HTTP_MFA_CHECK', {
        publicKey
    }, res => {
        cb(res.error || undefined);
    });
};

// Write a login block IFF
// 1. You can sign for the block's public key
// 2. the block is not protected by MFA
// Note: the internal WRITE_LOGIN_BLOCK will check is you're allowed to create this block
const writeBlock = Commands.WRITE_BLOCK = (Env, body, cb) => {
    const { publicKey, content } = body;

    // they must provide a valid block public key
    if (!isValidBlockId(publicKey)) { return void cb("INVALID_KEY"); }
    if (publicKey !== content.publicKey) { return void cb("INVALID_KEY"); }

    // check MFA
    checkMFA(Env, publicKey, cb);
};

writeBlock.complete = function (Env, body, cb) {
    const { publicKey, content, session } = body;

    const safeKey = Util.escapeKeyCharacters(publicKey);
    const sId = Env.getStorageId(safeKey);
    Env.interface.sendQuery(sId, 'HTTP_WRITE_BLOCK', content, res => {
        const err = res?.error;
        if (err) { return void cb(err); }

        if (!session) { return void cb(); }

        const proof = Util.tryParse(content.registrationProof);
        const oldKey = proof && proof[0];

        Env.interface.sendQuery(sId, 'HTTP_UPDATE_SESSION', {
            publicKey, oldKey, session
        }, res => {
            cb(res.error, res.data);
        });
    });

};

// Make sure the block is not protected by MFA but don't
// do anything else
const check = Commands.MFA_CHECK = (Env, body, cb) => {
    const { publicKey } = body;
    if (!isValidBlockId(publicKey)) { return void cb("INVALID_KEY"); }
    checkMFA(Env, publicKey, cb);
};
check.complete = (Env, body, cb) => { cb(); };

// Remove a login block IFF
// 1. You can sign for the block's public key
// 2. the block is not protected by MFA
const removeBlock = Commands.REMOVE_BLOCK = (Env, body, cb) => {
    const { publicKey } = body;

    // they must provide a valid block public key
    if (!isValidBlockId(publicKey)) { return void cb("INVALID_KEY"); }

    // check MFA
    checkMFA(Env, publicKey, cb);
};

removeBlock.complete = (Env, body, cb) => {
    const { publicKey, edPublic, reason } = body;

    const safeKey = Util.escapeKeyCharacters(publicKey);
    const sId = Env.getStorageId(safeKey);
    Env.interface.sendQuery(sId, 'HTTP_REMOVE_BLOCK', {
        publicKey, reason, edPublic
    }, res => {
        cb(res.error, res.data);
    });
};


// Test command that does nothing
// XXX TO REMOVE
const testCommand = Commands.TEST = function (Env, body, cb) {
    const { publicKey } = body;

    // they must provide a valid public key
    if (publicKey && typeof(publicKey) === "string"
        && publicKey.length === 44) {
        return cb();
    }

    cb("INVALID_KEY");
};

testCommand.complete = function (Env, body, cb) {
    //const { publicKey } = body;

    return void cb(void 0, {
        success: 1
    });
};

// Get an upload cookie
// Get a cookie allowing you to upload to the blobstage of your user
const uploadCookie = Commands.UPLOAD_COOKIE = function (Env, body, cb) {
    const { publicKey } = body;

    // they must provide a valid public key
    if (publicKey && typeof(publicKey) === "string"
        && publicKey.length === 44) {
        return cb();
    }

    cb("INVALID_KEY");
};

uploadCookie.complete = function (Env, body, cb) {
    const { id, publicKey } = body;

    const safeKey = Util.escapeKeyCharacters(publicKey);
    const storageId = Env.getStorageId(id);
    Env.interface.sendQuery(storageId, 'HTTP_UPLOAD_COOKIE', {
        safeKey, id
    }, res => {
        cb(res.error, {
            cookie: res.data
        });
    });
};
