const Constants = {};

Constants.CHECKPOINT_PATTERN = /^cp\|(([A-Za-z0-9+/=]+)\|)?/;

Constants.STANDARD_CHANNEL_LENGTH = 32;
Constants.ADMIN_CHANNEL_LENGTH = 33;
Constants.EPHEMERAL_CHANNEL_LENGTH = 34;
Constants.BLOB_ID_LENGTH = 48;

Constants.publicKeyLength = 32;

Constants.hkId = "0123456789abcdef";

Constants.TEMPORARY_CHANNEL_LIFETIME = 30 * 1000;

Constants.paths = {
    base: './data/',
    channel: 'channel/',
    archive: 'archive/'
};

module.exports = Constants;
