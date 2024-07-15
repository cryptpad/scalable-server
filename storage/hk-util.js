var HK = module.exports;

const STANDARD_CHANNEL_LENGTH = HK.STANDARD_CHANNEL_LENGTH = 32;
const ADMIN_CHANNEL_LENGTH = HK.ADMIN_CHANNEL_LENGTH = 33;

/*  getHash
    * this function slices off the leading portion of a message which is
      most likely unique
    * these "hashes" are used to identify particular messages in a channel's history
    * clients store "hashes" either in memory or in their drive to query for new messages:
      * when reconnecting to a pad
      * when connecting to chat or a mailbox
    * thus, we can't change this function without invalidating client data which:
      * is encrypted clientside
      * can't be easily migrated
    * don't break it!
*/
const getHash = HK.getHash = function (msg, Log) {
    if (typeof(msg) !== 'string') {
        if (Log) {
            Log.warn('HK_GET_HASH', 'getHash() called on ' + typeof(msg) + ': ' + msg);
        }
        return '';
    }
    return msg.slice(0,64);
};

const isMetadataMessage = HK.isMetadataMessage = function (parsed) {
    return Boolean(parsed && parsed.channel);
};
