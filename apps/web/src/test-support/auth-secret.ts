/**
 * Throwaway secrets for tests, shaped like `openssl rand -base64 32`. The app
 * refuses an AUTH_SECRET that is only long (`authSecretWeakness`), so a test
 * cannot use TEST_AUTH_SECRET. They guard nothing: generated once, committed.
 */
export const TEST_AUTH_SECRET = "SkeLsnD8BWCMimqAHCLI9w1uh97cWScpmSL9bBNUAY0=";
export const TEST_AUTH_SECRET_OTHER = "W0ycEXcCkeUwJIek+mvUzkAv4h3TnqrCV/D/7ayh4Yg=";
