const Store = require("./storage/file");

// TODO: fill from getMetadataRaw
let Env = {};

Store.create({
	filePath: './data/channel',
	archivePath: './data/archive',
	volumeId: 'channel'
}, function() {});
