// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors
const Util = require("./common-util.js");
const OTP = require("otpauth");
const nThen = require("nthen");
const Core = require("../common/core");

const MFA = require("./storage/mfa");
const Sessions = require("./storage/sessions");
const BlockStore = require("./storage/block");
const Block = require("./commands/block");
const Users = require("./commands/users");
const Invitation = require("./commands/invitation");


const isString = s => typeof(s) === 'string';

// basic definition of what we'll accept as an OTP code
// exactly six numerical digits
const isValidOTP = otp => {
    return isString(otp) &&
        // in the future this could be updated to support 8 digits
        otp.length === 6 &&
        // \D is non-digit characters, so this tests that it is exclusively numeric
        !/\D/.test(otp);
};

// basic definition of what we'll accept as a recovery key
// 24 bytes encoded as b64 ==> 32 characters
const isValidRecoveryKey = otp => {
    return isString(otp) &&
        // in the future this could be updated to support 8 digits
        otp.length === 32 &&
        // \D is non-digit characters, so this tests that it is exclusively numeric
        /[A-Za-z0-9+\/]{32}/.test(otp);
};

// we'll only allow users to set up multi-factor auth
// for keypairs they control which already have blocks
// this check doesn't confirm that their id is valid base64
// any attempt relying on this should fail when we can't decode
// the id they provided.
const isValidBlockId = Core.isValidBlockId;

// Create a session with a token for the given public key
const makeSession = (Env, publicKey, oldKey, ssoSession, cb) => {
    const EXPIRATION = (Env.otpSessionExpiration || 7 * 24) * 3600 * 1000;

    const sessionId = ssoSession || Sessions.randomId();
    let SSOUtils = Env.plugins && Env.plugins.SSO && Env.plugins.SSO.utils;

    // For password change, we need to get the sso session associated to the old block key
    // In other cases (login and totp_setup), the sso session is associated to the current block
    oldKey = oldKey || publicKey; // use the current block if no old key

    let isUpdate = false;
    nThen(function (w) {
        if (!ssoSession || !SSOUtils) { return; }
        // If we have an session token, confirm this is an sso account
        // XXX plugins
        // XXX plugins be careful oldKey amy be in other storage
        SSOUtils.readBlock(Env, oldKey, w((err) => {
            if (err === 'ENOENT') { return; } // No sso block, no need to update the session
            if (err) {
                w.abort();
                return void cb('TOTP_VALIDATE_READ_SSO');
            }
            // We have an existing session for an SSO account: update the existing session
            isUpdate = true;
        }));
    }).nThen(function (w) {
        // store the token
        let sessionData = {
            mfa: {
                type: 'otp',
                exp: (+new Date()) + EXPIRATION
            }
        };
        const then = w((err) => {
            if (err) {
                Env.Log.error("TOTP_VALIDATE_SESSION_WRITE", {
                    error: Util.serializeError(err),
                    publicKey: publicKey,
                    sessionId: sessionId,
                });
                w.abort();
                return void cb("SESSION_WRITE_ERROR");
            }
            // else continue
        });
        if (isUpdate) {
            Sessions.update(Env, publicKey, oldKey, sessionId, JSON.stringify(sessionData), then);
        } else {
            Sessions.write(Env, publicKey, sessionId, JSON.stringify(sessionData), then);
        }
    }).nThen(function () {
        cb(void 0, {
            bearer: sessionId,
        });
    });
};

// Read the MFA settings for the given public key
const readMFA = (Env, publicKey, cb) => {
    // check that there is an MFA configuration for the given account
    MFA.read(Env, publicKey, (err, content) => {
        if (err) {
            Env.Log.error('TOTP_VALIDATE_MFA_READ', {
                error: err,
                publicKey: publicKey,
            });
            return void cb('NO_MFA_CONFIGURED');
        }

        const parsed = Util.tryParse(content);
        if (!parsed) { return void cb("INVALID_CONFIGURATION"); }
        cb(undefined, parsed);
    });
};

// Check if an OTP code is valid against the provided secret
const checkCode = (Env, secret, code, publicKey, _cb) => {
    const cb = Util.mkAsync(_cb);

    let totp = new OTP.TOTP({
        secret
    });

    let validated = totp.validate({
        token: code,
        window: 1
    });

    if (![-1,0,1].includes(validated)) {
        Env.Log.error("TOTP_VALIDATE_BAD_OTP", {
            code,
        });
        return void cb("INVALID_OTP");
    }

    // call back to indicate that their request was well-formed and valid
    cb();
};


const MFAManager = {};

MFAManager.checkMFA = (Env, args, cb) => {
    const { publicKey } = args;
    // Success if we can't get the MFA settings
    MFA.read(Env, publicKey, (err, content) => {
        if (err) {
            if (err.code !== "ENOENT") {
                Env.Log.error('TOTP_VALIDATE_MFA_READ', {
                    error: err,
                    publicKey: publicKey,
                });
            }
            return void cb();
        }

        var parsed = Util.tryParse(content);
        if (!parsed) { return void cb(); }

        cb("NOT_ALLOWED");
    });
};

MFAManager.updateSession = (Env, args, cb) => {
    const { publicKey, oldKey, session } = args;
    Sessions.update(Env, publicKey, oldKey, session, "", cb);
};

// TOTP challenges

// This command allows clients to configure TOTP as a second factor protecting
// their login block IFF they:
// 1. provide a sufficiently strong TOTP secret
// 2. are able to produce a valid OTP code for that secret (indicating that their clock is sufficiently close to ours)
// 3. such a login block actually exists
// 4. are able to sign an arbitrary message for the login block's public key
// 5. have not already configured TOTP protection for this account
// (changing to a new secret can be done by disabling and re-enabling TOTP 2FA)
MFAManager.setupCheck = (Env, body, cb) => {
    const { publicKey, secret, code, contact } = body;

    // the client MUST provide an OTP code of the expected format
    // this doesn't check if it matches the secret and time, just that it's well-formed
    if (!isValidOTP(code)) { return void cb("E_INVALID"); }

    // if they provide an (optional) point of contact as a recovery mechanism then it should be a string.
    // the intent is to allow to specify some side channel for those who inevitably lock themselves out
    // we should be able to use that to validate their identity.
    // I don't want to assume email, but limiting its length to 254 (the maximum email length) seems fair.
    if (contact && (!isString(contact) || contact.length > 254)) { return void cb("INVALID_CONTACT"); }

    // Check that the provided public key is the expected format for a block
    if (!isValidBlockId(publicKey)) {
        return void cb("INVALID_KEY");
    }

    // Reject attempts to setup TOTP if a record of their preferences already exists
    MFA.read(Env, publicKey, (err) => {
        // There **should be** an error here, because anything else
        // means that a record already exists
        // This may need to be adjusted as other methods of MFA are added
        if (!err) { return void cb("EEXISTS"); }

        // if no MFA settings exist then we expect ENOENT
        // anything else indicates a problem and should result in rejection
        if (err.code !== 'ENOENT') { return void cb(err); }
        try {
            // allow for 30s of clock drift in either direction
            // returns an object ({ delta: 0 }) indicating the amount of clock drift
            // if successful, otherwise `null`
            return void checkCode(Env, secret, code, publicKey, cb);
        } catch (err2) {
            Env.Log.error('TOTP_SETUP_VERIFICATION_ERROR', {
                error: err2,
            });
            return void cb("INTERNAL_ERROR");
        }
    });
};

MFAManager.setupComplete = (Env, body, cb) => {
    // the OTP code should have already been validated
    const { publicKey, secret, contact, session } = body;

    // the device from which they configure MFA settings
    // is assumed to be safe, so we'll respond with a JWT token
    // the remainder of the setup is successfully completed.
    // Otherwise they would have to reauthenticate.
    // The session id is used as a reference to this particular session.
    nThen(function (w) {
        // confirm that the block exists
        BlockStore.check(Env, publicKey, w((err) => {
            if (err) {
                Env.Log.error("TOTP_SETUP_NO_BLOCK", {
                    publicKey,
                });
                w.abort();
                return void cb("NO_BLOCK");
            }
            // otherwise the block exists, continue
        }));
    }).nThen(function (w) {
        // store the data you'll need in the future
        const data = {
            method: 'TOTP', // specify this so it's easier to add other methods later?
            secret: secret, // the 160 bit, base32-encoded secret that is used for OTP validation
            creation: new Date(), // the moment at which the MFA was configured
        };

        if (isString(contact)) {
            // 'contact' is an arbitary (and optional) string for manual recovery from 2FA auth fails
            // it should already be validated
            data.contact = contact;
        }

        // We attempt to store a record of the above preferences
        // if it fails then we abort and inform the client of an error.
        MFA.write(Env, publicKey, JSON.stringify(data), w((err) => {
            if (err) {
                w.abort();
                Env.Log.error("TOTP_SETUP_STORAGE_FAILURE", {
                    publicKey: publicKey,
                    error: err,
                });
                return void cb('STORAGE_FAILURE');
            }
            // otherwise continue
        }));
    }).nThen(function () {
        // we have already stored the MFA data, which will cause access to the resource to be restricted to the provided TOTP secret.
        // we attempt to create a session as a matter of convenience - so if it fails
        // that just means they'll be forced to authenticate
        makeSession(Env, publicKey, null, session, cb);
    });
};

// This command is somewhat simpler than TOTP_SETUP
// Issue a client a JWT which will allow them to access a login block IFF:
// 1. That login block exists
// 2. That login block is protected by TOTP 2FA
// 3. They can produce a valid OTP for that block's TOTP secret
// 4. They can sign for the block's public key
MFAManager.validateCheck = (Env, body, cb) => {
    const { publicKey, code } = body;

    // they must provide a valid OTP code
    if (!isValidOTP(code)) { return void cb('E_INVALID'); }

    // they must provide a valid block public key
    if (!isValidBlockId(publicKey)) { return void cb("INVALID_KEY"); }

    let secret;
    nThen(function (w) {
        // check that there is an MFA configuration for the given account
        readMFA(Env, publicKey, w((err, content) => {
            if (err) {
                w.abort();
                return void cb(err);
            }
            secret = content.secret;
        }));
    }).nThen(function () {
        checkCode(Env, secret, code, publicKey, cb);
    });
};

MFAManager.validateComplete = (Env, body, cb) => {
/*
if they are here then they:

1. have a valid block configured with TOTP-based 2FA
2. were able to provide a valid TOTP for that block's secret
3. were able to sign their messages for the block's public key

So, we should:

1. instanciate a session for them by generating and storing a token for their public key
2. send them the token

*/
    const { publicKey, session } = body;
    makeSession(Env, publicKey, null, session, cb);
};

// Same as TOTP_VALIDATE but without making a session at the end
MFAManager.statusCheck = (Env, body, cb) => {
    const { publicKey, auth } = body;
    const code = auth;
    if (!isValidOTP(code)) { return void cb('E_INVALID'); }
    if (!isValidBlockId(publicKey)) { return void cb("INVALID_KEY"); }
    let secret;
    nThen(function (w) {
        readMFA(Env, publicKey, w((err, content) => {
            if (err) {
                w.abort();
                return void cb(err);
            }
            secret = content.secret;
        }));
    }).nThen(function () {
        checkCode(Env, secret, code, publicKey, cb);
    });
};

// Revoke a client TOTP secret which will allow them to disable TOTP for a login block IFF:
// 1. That login block exists
// 2. That login block is protected by TOTP 2FA
// 3. They can produce a valid OTP for that block's TOTP secret
// 4. They can sign for the block's public key
MFAManager.revokeCheck = (Env, body, cb) => {
    const { publicKey, code, recoveryKey } = body;

    // they must provide a valid OTP code
    if (!isValidOTP(code) && !isValidRecoveryKey(recoveryKey)) { return void cb('E_INVALID'); }

    // they must provide a valid block public key
    if (!isValidBlockId(publicKey)) { return void cb("INVALID_KEY"); }

    let secret, recoveryStored;
    nThen(function (w) {
        // check that there is an MFA configuration for the given account
        readMFA(Env, publicKey, w((err, content) => {
            if (err) {
                w.abort();
                return void cb(err);
            }
            secret = content.secret;
            recoveryStored = content.contact;
        }));
    }).nThen(function (w) {
        if (!recoveryKey) { return; }
        w.abort();
        if (!/^secret:/.test(recoveryStored)) {
            return void cb("E_NO_RECOVERY_KEY");
        }
        recoveryStored = recoveryStored.slice(7);
        if (recoveryKey !== recoveryStored) {
            return void cb("E_WRONG_RECOVERY_KEY");
        }
        cb();
    }).nThen(function () {
        checkCode(Env, secret, code, publicKey, cb);
    });
};

MFAManager.revokeComplete = (Env, body, cb) => {
/*
if they are here then they:

1. have a valid block configured with TOTP-based 2FA
2. were able to provide a valid TOTP for that block's secret
3. were able to sign their messages for the block's public key

So, we should:

1. Revoke the TOTP authentication for their block
2. Remove all existing sessions
*/
    const { publicKey } = body;
    MFA.revoke(Env, publicKey, cb);
};

// Write a login block using an existing OTP block IFF
// 1. You can sign for the block's public key
// 2. You have a proof for the old block
// 3. The old block is OTP protected
// 4. The OTP code is valid
// Note: this is used when users change their password
MFAManager.writeCheck = (Env, body, cb) => {
    const { publicKey, content } = body;
    const code = content.auth;
    const registrationProof = content.registrationProof;

    // they must provide a valid block public key
    if (!isValidBlockId(publicKey)) { return void cb("INVALID_KEY"); }
    if (publicKey !== content.publicKey) { return void cb("INVALID_KEY"); }
    if (!isValidOTP(code)) { return void cb('E_INVALID'); }
    if (!registrationProof) { return void cb('MISSING_ANCESTOR'); }

    let secret;
    let oldKey;
    nThen(function (w) {
        Block.validateAncestorProof(Env, registrationProof, w((err, provenKey) => {
            if (err || !provenKey) {
                w.abort();
                return void cb('INVALID_ANCESTOR');
            }
            oldKey = provenKey;
        }));
    }).nThen(function (w) {
        // check that there is an MFA configuration for the ancestor account
        readMFA(Env, oldKey, w((err, content) => {
            if (err) {
                w.abort();
                return void cb(err);
            }
            secret = content.secret;
        }));
    }).nThen(function () {
        // check that the OTP code is valid
        checkCode(Env, secret, code, oldKey, cb);
    });
};

MFAManager.writeComplete = (Env, body, cb) => {
    const { publicKey, content, session } = body;
    let oldKey;
    nThen(function (w) {
        // Write new block
        Block.writeLoginBlock(Env, content, w((err) => {
            if (err) {
                w.abort();
                return void cb("BLOCK_WRITE_ERROR");
            }
        }));
    }).nThen(function (w) {
        // Copy MFA settings
        const proof = Util.tryParse(content.registrationProof);
        oldKey = proof && proof[0];
        if (!oldKey) {
            w.abort();
            return void cb('INVALID_ANCESTOR');
        }
        MFA.copy(Env, oldKey, publicKey, w());
    }).nThen(function () {
        // Create a session for the current user
        makeSession(Env, publicKey, oldKey, session, cb);
    });
};

// Remove a login block IFF
// 1. You can sign for the block's public key
MFAManager.removeCheck = (Env, body, cb) => {
    const { publicKey, auth } = body;
    const code = auth;

    // they must provide a valid block public key
    if (!isValidBlockId(publicKey)) { return void cb("INVALID_KEY"); }
    if (!isValidOTP(code)) { return void cb('E_INVALID'); }

    let secret;
    nThen(function (w) {
        // check that there is an MFA configuration for this block
        readMFA(Env, publicKey, w((err, content) => {
            if (err) {
                w.abort();
                return void cb(err);
            }
            secret = content.secret;
        }));
    }).nThen(function () {
        // check that the OTP code is valid
        checkCode(Env, secret, code, publicKey, cb);
    });
};
MFAManager.removeComplete = (Env, body, cb) => {
    const { publicKey, edPublic, reason } = body;
    nThen(function (w) {
        // Remove the block
        Block.removeLoginBlock(Env, {
            publicKey, reason, edPublic
        }, w((err) => {
            if (err) {
                w.abort();
                return void cb(err);
            }
        }));
    }).nThen(() => {
        // Delete the MFA settings and sessions
        MFA.revoke(Env, publicKey, cb);
    });
};

MFAManager.getMFA = (Env, args, cb) => {
    MFA.read(Env, args.blockId, cb, true);
};
MFAManager.sessionsCmd = (Env, args, cb) => {
    const { blockId, session, cmd } = args;
    if (cmd === 'READ') {
        return void Sessions.read(Env, blockId, session, cb, true);
    }
    if (cmd === 'DELETE') {
        return void Sessions.delete(Env, blockId, session, cb, true);
    }
};

MFAManager.userRegistryCmd = (Env, args, cb) => {
    const { edPublic, data, cmd } = args;
    if (cmd === 'DELETE') {
        return void Users.delete(Env, edPublic, cb, true);
    }
    if (cmd === 'ADD') {
        const { content, adminKey } = data;
        return void Users.add(Env, edPublic, content, adminKey, cb, true);
    }
    if (cmd === 'CHECK_UPDATE') {
        const { content, newBlock } = data;
        return void Users.checkUpdate(Env, content, newBlock, cb, true);
    }
    cb('EINVAL');
};
MFAManager.invitationCmd = (Env, args, cb) => {
    const { inviteToken, data, cmd } = args;
    if (cmd === 'CHECK') {
        return void Invitation.check(Env, inviteToken, cb, true);
    }
    if (cmd === 'USE') {
        const { blockId, userData } = data;
        return void Invitation.use(Env, inviteToken, blockId, userData, cb, true);
    }
    cb('EINVAL');
};

module.exports = MFAManager;

