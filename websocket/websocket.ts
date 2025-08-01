import * as WebSocket from './index.js';

process.on('message', (message: Message) => {
    WebSocket.start(message);
});


export const start = WebSocket.start;
