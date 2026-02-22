
1. Last user updated on hover. Can get from meta data endpoint
2. Broadcast user cursor events to connection shard as well, to prevent ghost users.
3. Url changes to include centre coordinate, and zoom level. Can add share button to post it online.
4. Migrate existing user to email once singed up (migrating existing anon user into that account.)
5. Deployment hardening: configure `IDENTITY_SIGNING_SECRET` via runtime secret (do not rely on dev fallback secret).
6. Add rate limiting for new identity issuance/user creation to reduce abuse and reconnect storms.
7. Implement spawn-near-activity API flow (`GET /api/hello` selecting recent edits + jittered camera spawn).
