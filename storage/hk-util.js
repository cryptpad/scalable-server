// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
var HK = module.exports;

const STANDARD_CHANNEL_LENGTH = HK.STANDARD_CHANNEL_LENGTH = 32;
const ADMIN_CHANNEL_LENGTH = HK.ADMIN_CHANNEL_LENGTH = 33;

/*  getHash
    * this function slices off the leading portion of a message which is
      most likely unique
    * these "hashes" are used to identify particular messages in a channel's history
    * clients store "hashes" either in memory or in their drive to query for new messages:
      * when reconnecting to a pad
      * when connecting to chat or a mailbox
    * thus, we can't change this function without invalidating client data which:
      * is encrypted clientside
      * can't be easily migrated
    * don't break it!
*/
const getHash = HK.getHash = function (msg, Log) {
    if (typeof(msg) !== 'string') {
        if (Log) {
            Log.warn('HK_GET_HASH', 'getHash() called on ' + typeof(msg) + ': ' + msg);
        }
        return '';
    }
    return msg.slice(0,64);
};

/*  sliceCpIndex
    returns a list of all checkpoints which might be relevant for a client connecting to a session

    * if there are two or fewer checkpoints, return everything you have
    * if there are more than two
      * return at least two
      * plus any more which were received within the last 100 messages

    This is important because the additional history is what prevents
    clients from forking on checkpoints and dropping forked history.

*/
const sliceCpIndex = HK.sliceCpIndex = function (cpIndex, line) {
    // Remove "old" checkpoints (cp sent before 100 messages ago)
    const minLine = Math.max(0, (line - 100));
    let start = cpIndex.slice(0, -2);
    const end = cpIndex.slice(-2);
    start = start.filter(function (obj) {
        return obj.line > minLine;
    });
    return start.concat(end);
};

const isMetadataMessage = HK.isMetadataMessage = function (parsed) {
    return Boolean(parsed && parsed.channel);
};

const decodeBase64 = function(string) {
    let buff = Buffer.from(string, 'base64');
    return buff.toString();
}

// validateKeyStrings supplied by clients must decode to 32-byte Uint8Arrays
const isValidValidateKeyString = HK.isValidValidateKeyString = function(key) {
    try {
        return typeof (key) === 'string' &&
            decodeBase64(key).length === Env.publicKeyLength;
    } catch (e) {
        return false;
    }
};

// TODO: check
HK.getNetfluxSession = function (Env, netfluxId) {
    return Env.netfluxUsers[netfluxId];
};
