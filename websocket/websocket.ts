import * as WebSocket from './index.js';

process.on('message', (message: Message) => {
    let { server, infra } = message?.config;
    WebSocket.start({
        myId: message?.name,
        index: message?.index,
        server,
        infra
    });
});
