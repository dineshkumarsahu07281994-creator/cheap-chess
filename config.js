// Optional settings for CheapChess.

// TURN relay for players whose networks block direct connections (strict NATs, many mobile
// carriers, offices). Without one, those players can't be paired with each other.
// Free option: sign up at https://www.metered.ca/tools/openrelay/ (20 GB/month free), create
// a TURN credential, and paste the credentials URL from the dashboard here, e.g.
//   'https://<your-app>.metered.live/api/v1/turn/credentials?apiKey=<key>'
// The key is visible to anyone who opens the site, so anyone could spend your free quota.
window.CHEAPCHESS_TURN_CREDENTIALS_URL = '';
