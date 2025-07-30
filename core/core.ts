import * as Core from './index.js';

process.on('message', (message: Message) => {
	let { server, infra } = message?.config;
	Core.start({
		myId: message?.name,
		index: message?.index,
		server,
		infra
	});
});
