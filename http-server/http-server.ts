import * as HttpServer from './index.js';

process.on('message', (message: Message) => {
    HttpServer.start(message);
});


export const start = HttpServer.start;
