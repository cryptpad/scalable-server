//const infra = require('../../config/infra.json');
const Crypto = require('node:crypto');
const Path = require('node:path');

const WebSocket = require("ws");
const Netflux = require("netflux-websocket");
const Nacl = require('tweetnacl/nacl-fast');

const Rpc = require('./rpc');
const { jumpConsistentHash } = require('../../common/consistent-hash.js');
const Util = require('../../common/common-util');
const Core = require('../../common/core');

const config = require('../../config/config.json');
const infra = require('../../config/infra.json');

const hk = '0123456789abcdef';

const mainCfg = config?.public?.main;
const getWsURL = () => {
    const wsUrl = new URL('ws://localhost:3000/cryptpad_websocket');
    if (mainCfg.origin) {
        let url = new URL(mainCfg.origin);
        wsUrl.hostname = url.hostname;
        wsUrl.port = url.port;
        wsUrl.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    }
    return wsUrl.href;
};

const getOrigin = () => {
    let url = new URL(mainCfg.origin);
    return url.origin;
};

const connectUser = index => {
    const f = () => {
        return new WebSocket(getWsURL(index));
    };
    return Netflux.connect('', f);
};

const getRandomKeys = () => {
    const kp = Nacl.sign.keyPair();
    const edPublic = Util.encodeBase64(kp.publicKey);
    const edPrivate = Util.encodeBase64(kp.secretKey);
    return {
        publicKey: kp.publicKey,
        secretKey: kp.secretKey,
        edPublic, edPrivate
    };
};

const getRandomMsg = () => {
    const rdm = Crypto.randomBytes(48).toString('hex');
    return `test-${rdm}`;
};

const createAnonRpc = (args) => {
    const { network } = args;
    network.historyKeeper = hk;
    return new Promise((resolve, reject) => {
        Rpc.createAnonymous(network, (e, rpc) => {
            if (e) { return reject(e); }
            resolve({rpc, network});
        });
    });
};

const createUserRpc = (args) => {
    const { network, keys } = args;
    network.historyKeeper = hk;
    return new Promise((resolve, reject) => {
        let t = setTimeout(() => {
            reject('USER_RPC_TIMEOUT');
        }, 5000);
        const {edPrivate, edPublic} = keys;
        Rpc.create(network, edPrivate, edPublic, (e, rpc) => {
            clearTimeout(t);
            if (e) { return reject(e); }
            resolve({network, rpc});
        });
    });
};

const getChannelPath = channel => {
    // We need a 8 byte key
    const nb = infra.storage.length;
    let key = Buffer.from(channel.slice(0, 8));
    let index = jumpConsistentHash(key, nb);
    const p = Core.getPaths({ index });
    const file = `${channel}.ndjson`;
    return Path.join(p.filePath, channel.slice(0,2), file);
};
const getBlobPath = channel => {
    // We need a 8 byte key
    const nb = infra.storage.length;
    let key = Buffer.from(channel.slice(0, 8));
    let index = jumpConsistentHash(key, nb);
    const p = Core.getPaths({ index });
    const file = `${channel}.ndjson`;
    return Path.join(p.blobPath, channel.slice(0,2), file);
};
const getPinPath = publicKey => {
    // We need a 8 byte key
    const nb = infra.storage.length;
    let safeKey = Util.escapeKeyCharacters(publicKey);
    let key = Buffer.from(safeKey.slice(0, 8));
    let index = jumpConsistentHash(key, nb);
    const p = Core.getPaths({ index });
    const file = `${safeKey}.ndjson`;
    return Path.join(p.pinPath, safeKey.slice(0,2), file);
};
const getBlockPath = publicKey => {
    // We need a 8 byte key
    const nb = infra.storage.length;
    let safeKey = Util.escapeKeyCharacters(publicKey);
    let key = Buffer.from(safeKey.slice(0, 8));
    let index = jumpConsistentHash(key, nb);
    const p = Core.getPaths({ index });
    const file = `${safeKey}`;
    return Path.join(p.blockPath, safeKey.slice(0,2), file);
};

const hashChannelList = (list) => {
    return Util.encodeBase64(Nacl.hash(Util
        .decodeUTF8(JSON.stringify(list))));
};

module.exports = {
    getWsURL, connectUser, getOrigin,
    createAnonRpc, createUserRpc,
    hashChannelList,
    getRandomKeys, getRandomMsg,
    getChannelPath, getBlobPath, getPinPath, getBlockPath
};
