# Found & Home

A responsive community lost and found board. Visitors can search public posts; members can create accounts, post lost or found items, and manage their own posts.

## Run locally

Requires Node.js 22.5 or newer. No package installation is needed.

```sh
npm start
```

Open <http://localhost:3000>. Set the `PORT` environment variable to use a different port. Posts and accounts are stored in `data/lost-and-found.sqlite`.

## First-version behavior

- Anyone with the site link can browse, search, and see the contact email shown on a post.
- Anyone can create an email-and-password account; the first version does not verify organizational membership or email ownership.
- Signed-in members can create, edit, resolve, reopen, and delete their own posts.
- Lost and found posts can be filtered by type, category, text, and location.
- Passwords are stored as scrypt hashes, and session tokens are stored as hashes in SQLite.

For a public deployment, place the app behind HTTPS and a reverse proxy, and add organization membership verification and operational controls such as backups and rate limits before relying on it for a large community.
