const ServerCommand = require('./http-command');
const Nacl = require('tweetnacl/nacl-fast');
const Util = require('../../common/common-util');
const { getOrigin } = require('./utils');

const { infra } = require('../../common/load-config');
const origin = infra?.public?.origin;
ServerCommand.setCustomize({
    ApiConfig: {
        httpUnsafeOrigin: origin
    }
});

const Block = {};

Block.join = Util.uint8ArrayJoin;

// (UTF8 content, keys object) => Uint8Array block
Block.encrypt = (version, content, keys) => {
    const u8 = Util.decodeUTF8(content);
    const nonce = Nacl.randomBytes(Nacl.secretbox.nonceLength);
    return Block.join([
        [0],
        nonce,
        Nacl.secretbox(u8, nonce, keys.symmetric)
    ]);
};

// (uint8Array block) => payload object
Block.decrypt = (u8_content, keys) => {
    // version is currently ignored since there is only one
    let nonce = u8_content.subarray(1,1 + Nacl.secretbox.nonceLength);
    let box = u8_content.subarray(1 + Nacl.secretbox.nonceLength);

    let plaintext = Nacl.secretbox.open(box, nonce, keys.symmetric);
    try {
        return JSON.parse(Util.encodeUTF8(plaintext));
    } catch (e) {
        console.error(e);
        return;
    }
};

// (Uint8Array block) => signature
Block.sign = (ciphertext, keys) => {
    return Nacl.sign.detached(Nacl.hash(ciphertext), keys.sign.secretKey);
};


Block.serialize = (content, keys) => {
    // encrypt the content
    let ciphertext = Block.encrypt(0, content, keys);

    // generate a detached signature
    let sig = Block.sign(ciphertext, keys);

    // serialize {publickey, sig, ciphertext}
    return {
        publicKey: Util.encodeBase64(keys.sign.publicKey),
        signature: Util.encodeBase64(sig),
        ciphertext: Util.encodeBase64(ciphertext),
    };
};

Block.proveAncestor = (O /* oldBlockKeys, N, newBlockKeys */) => {
    let u8_pub = Util.find(O, ['sign', 'publicKey']);
    let u8_secret = Util.find(O, ['sign', 'secretKey']);
    try {
    // sign your old publicKey with your old privateKey
        let u8_sig = Nacl.sign.detached(u8_pub, u8_secret);
    // return an array with the sig and the pubkey
        return JSON.stringify([u8_pub, u8_sig].map(Util.encodeBase64));
    } catch (err) {
        return void console.error(err);
    }
};


Block.writeLoginBlock = (data, cb) => {
    const { content, blockKeys, oldBlockKeys, auth, pw, session, token, userData } = data;

    const command = 'WRITE_BLOCK';
    if (auth && auth.type) { command = `${auth.type.toUpperCase()}_` + command; }

    let block = Block.serialize(JSON.stringify(content), blockKeys);
    block.auth = auth && auth.data;
    block.hasPassword = pw;
    block.registrationProof = oldBlockKeys && Block.proveAncestor(oldBlockKeys);
    if (token) { block.inviteToken = token; }
    if (userData) { block.userData = userData; }

    ServerCommand(blockKeys.sign, {
        command: command,
        content: block,
        session: session // sso session
    }, cb);
};

Block.removeLoginBlock = (data, cb) => {
    const { reason, blockKeys, auth, edPublic } = data;

    const command = 'REMOVE_BLOCK';
    if (auth && auth.type) { command = `${auth.type.toUpperCase()}_` + command; }

    ServerCommand(blockKeys.sign, {
        command: command,
        auth: auth && auth.data,
        edPublic: edPublic,
        reason: reason
    }, cb);
};

const urlSafeB64 = (u8) => {
    return Util.encodeBase64(u8).replace(/\//g, '-');
};

Block.getBlockUrl = (keys) => {
    const publicKey = urlSafeB64(keys.sign.publicKey);
    return getOrigin() + '/block/' + publicKey.slice(0, 2) + '/' +  publicKey;
};

module.exports = Block;
