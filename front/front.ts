import * as Front from './index.js';

process.on('message', (message: Message) => {
    Front.start(message);
});


export const start = Front.start;
