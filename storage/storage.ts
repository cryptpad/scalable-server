import * as Storage from './index.js';

process.on('message', (message: Message) => {
    let { server, infra } = message?.config;
    Storage.start({
        myId: message?.name,
        index: message?.index,
        server,
        infra
    });
});
