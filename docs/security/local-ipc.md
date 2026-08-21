# Local IPC Security

Cycle for OpenCode does not expose TCP or HTTP listeners. The plugin and `workflowd` communicate through a Windows named pipe or a Unix domain socket.

## Transport boundary

- Windows rejects remote named-pipe clients and uses an endpoint identifier derived from a random credential.
- Linux creates the runtime directory with mode `0700`, creates the socket with mode `0600`, rejects non-socket and symlink endpoints, and compares the peer UID with the daemon UID.
- Stale Unix sockets are removed only after the existing endpoint refuses a connection and its physical type is confirmed.
- Every connection must additionally complete the authenticated challenge before application messages are accepted.

## Authentication

The first-run credential contains 256 bits from the operating-system random source. It is never included in endpoint names, logs, errors, history, exports, prompts, or model context. Endpoint names use only a one-way digest prefix.

Authentication uses HMAC-SHA-256 over a domain separator, a 256-bit server nonce, and an absolute millisecond expiry that round-trips exactly through JavaScript. Verification is constant-time. A challenge is accepted once; replay state is bounded and expired entries are removed before admission.

Unix fallback credential files are created atomically with mode `0600`, inside a `0700` directory, and are rejected if they are symlinks, non-regular files, malformed, or later become group/world accessible. Windows credentials inherit the access control list of the per-user application-data directory; release qualification verifies that a second local user cannot read the file or connect to the named pipe.

## Framing

Messages are length-prefixed JSON with an 8 MiB hard limit. Headers are parsed before payload allocation. Zero-length, oversized, malformed, unknown-version, and unknown-field messages poison the decoder, after which the connection is closed. Fragmented and concatenated frames are supported without cross-delivery.

The security boundary protects against other operating-system users and accidental local process discovery. A malicious process already running as the same user is inside the documented machine-owner trust boundary and may access the user's files or OpenCode session.
