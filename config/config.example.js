module.exports = {
    /*  CryptPad will launch a child process for every core available
     *  in order to perform CPU-intensive tasks in parallel.
     *  Some host environments may have a very large number of cores available
     *  or you may want to limit how much computing power CryptPad can take.
     *  If so, set 'maxWorkers' to a positive integer.
     */
    maxWorkers: false,

    /* =====================
     *       Sessions
     * ===================== */

    /*  Accounts can be protected with an OTP (One Time Password) system
     *  to add a second authentication layer. Such accounts use a session
     *  with a given lifetime after which they are logged out and need
     *  to be re-authenticated. You can configure the lifetime of these
     *  sessions here.
     *
     *  defaults to 7 days
     */
    otpSessionExpiration: 7*24, // hours

    /*  Registered users can be forced to protect their account
     *  with a Multi-factor Authentication (MFA) tool like a TOTP
     *  authenticator application.
     *
     *  defaults to false
     */
    enforceMFA: false,

    /* =====================
     *         Admin
     * ===================== */

    /*
     *  CryptPad contains an administration panel. Its access is restricted to specific
     *  users using the following list and the management interface on the instance.
     *  To give access to the admin panel to a user account, just add their public signing
     *  key, which can be found on the settings page for registered users. Access can be
     *  revoked directly from the interface, unless you added the key below.
     *  Entries should be strings separated by a comma.
     *  adminKeys: [
     *      "[cryptpad-user1@my.awesome.website/YZgXQxKR0Rcb6r6CmxHPdAGLVludrAF2lEnkbx1vVOo=]",
     *      "[cryptpad-user2@my.awesome.website/jA-9c5iNuG7SyxzGCjwJXVnk5NPfAOO8fQuQ0dC83RE=]",
     *  ]
     *
     */
    adminKeys: [
        "[decrees-test-admin@test.local/9MESY9hRN6s7T8M94+vxhS69Z9Hu+uQaXtlKFuxxFY0=]"
    ],

    /* =====================
     *          Log
     * ===================== */

    /* CryptPad supports logging events directly to the disk in a 'logs' directory
     * Set its location here, or set it to false (or nothing) if you'd rather not log
     */
    logPath: './data/logs',

    /*  CryptPad can log activity to stdout
     *  This may be useful for debugging
     */
    logToStdout: false,

    /* CryptPad can be configured to log more or less
     * the various settings are listed below by order of importance
     *
     * silly, verbose, debug, feedback, info, warn, error
     *
     * Choose the least important level of logging you wish to see.
     * For example, a 'silly' logLevel will display everything,
     * while 'info' will display 'info', 'warn', and 'error' logs
     *
     * This will affect both logging to the console and the disk.
     */
    logLevel: 'info',

    /*  clients can use the /settings/ app to opt out of usage feedback
     *  which informs the server of things like how much each app is being
     *  used, and whether certain clientside features are supported by
     *  the client's browser. The intent is to provide feedback to the admin
     *  such that the service can be improved. Enable this with `true`
     *  and ignore feedback with `false` or by commenting the attribute
     *
     *  You will need to set your logLevel to include 'feedback'. Set this
     *  to false if you'd like to exclude feedback from your logs.
     */
    logFeedback: false,

    /*  CryptPad supports verbose logging
     *  (false by default)
     */
    verbose: false,

};
