# Security Policy

## Supported Versions

Version 1.0.0 is a release candidate until every signed platform lane passes and the owner publishes it. Before publication, security fixes target the development branch. After publication, the latest 1.x release receives security fixes; superseded versions receive only fixes explicitly listed in their release notes.

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private security advisory feature for this repository and include:

- affected version or commit;
- reproduction steps or a minimal proof of concept;
- expected impact;
- relevant logs with secrets removed;
- suggested mitigation, if known.

Receipt will be acknowledged as soon as practical. A remediation and disclosure timeline will be provided after validation. Do not access data that is not yours, disrupt third-party systems or publish details before coordinated disclosure.

## Scope

The security boundary includes the OpenCode plugin, native control plane, local IPC, project state, update and packaging logic, role isolation, command execution policy, evidence handling and supply chain.
