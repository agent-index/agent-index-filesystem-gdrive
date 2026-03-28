# agent-index-filesystem-gdrive

Google Drive adapter for the agent-index remote filesystem. Connects the `aifs_*` MCP tool interface to Google Drive and Shared Drives via the Google APIs.

## Overview

This adapter implements the `BackendAdapter` interface from `@agent-index/filesystem` against the Google Drive API. It handles path-to-ID resolution (Drive is ID-based, not path-based), shared drive support, recursive directory creation, and OAuth2 authentication with refresh token persistence.

Members never interact with this package directly. The pre-built bundle is included in the bootstrap zip during org setup and runs as a background MCP server process inside Cowork.

## Features

- Personal Drive and Shared Drive support (`supportsAllDrives`)
- Path-to-ID resolution with caching for performance
- OAuth2 per-member authentication with automatic token refresh
- Recursive parent directory creation on write
- All 9 `aifs_*` tools supported

## Connection Config

Set by the org admin during `create-org`:

| Field | Required | Description |
|---|---|---|
| `drive_id` | No | Google Shared Drive ID. Omit for personal Drive. |
| `root_folder_id` | No | Folder ID to use as filesystem root. Omit for Drive root. |
| `client_id` | Yes | OAuth 2.0 client ID from the org's Google Cloud project. |
| `client_secret` | Yes | OAuth 2.0 client secret from the org's Google Cloud project. |

## Development

```bash
npm install              # Install dependencies
npm run build            # Bundle, checksum, and stamp adapter.json
npm run build:bundle     # esbuild only (no metadata stamp)
npm test                 # Run tests
```

The `npm run build` command produces `dist/server.bundle.js` (a self-contained single-file MCP server) and updates `adapter.json` with the build timestamp and checksum. Commit both files together.

## Repository Structure

```
├── adapter.json            # Adapter metadata, connection schema, build info
├── package.json            # Source dependencies and build scripts
├── scripts/
│   └── build.js            # Build pipeline (bundle + checksum + stamp)
├── src/
│   ├── index.js            # Entry point
│   └── adapters/
│       └── gdrive.js       # BackendAdapter implementation
└── dist/
    └── server.bundle.js    # Pre-built bundle (committed to repo)
```

## License

Proprietary — Copyright (c) 2026 Agent Index Inc. All rights reserved. See [LICENSE](LICENSE) for details.
