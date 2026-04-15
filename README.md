# agent-index-filesystem-gdrive

Google Drive adapter for the agent-index remote filesystem. Implements the `aifs_*` tool interface for Google Drive and Shared Drives via the Google APIs.

## Overview

This adapter implements the `BackendAdapter` interface from `@agent-index/filesystem` against the Google Drive API. It handles path-to-ID resolution (Drive is ID-based, not path-based), shared drive support, recursive directory creation, and OAuth2 authentication with refresh token persistence.

Members do not interact with this package directly. The adapter handles backend operations when the `aifs_*` tools are called in exec mode.

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
npm run build            # Build and verify adapter implementation
npm test                 # Run tests
```

The build process verifies that the adapter correctly implements the `BackendAdapter` interface and is compatible with the exec-mode `aifs_*` tools.

## Repository Structure

```
├── adapter.json            # Adapter metadata and connection schema
├── package.json            # Source dependencies and build scripts
├── scripts/
│   └── build.js            # Build and validation
├── src/
│   ├── index.js            # Entry point
│   └── adapters/
│       └── gdrive.js       # BackendAdapter implementation
└── dist/
    └── adapter.js          # Compiled adapter
```

## License

Proprietary — Copyright (c) 2026 Agent Index Inc. All rights reserved. See [LICENSE](LICENSE) for details.
