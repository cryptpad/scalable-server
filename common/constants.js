const Constants = {}

Constants.CHECKPOINT_PATTERN = /^cp\|(([A-Za-z0-9+\/=]+)\|)?/;

Constants.STANDARD_CHANNEL_LENGTH = 32;
Constants.ADMIN_CHANNEL_LENGTH = 33;
Constants.EPHEMERAL_CHANNEL_LENGTH = 34;
Constants.hkId = "0123456789abcdef";

module.exports = Constants;
