# Security policy

## Reporting a vulnerability

Please report security issues privately, through
[GitHub's private vulnerability reporting](https://github.com/ilanKushnir/readport/security/advisories/new),
rather than as a public issue.

Include what you did, what happened, and what you expected. A proof of concept
helps but is not required — a clear description of the flaw is enough to start.

You will get an acknowledgement within a few days. ReadPort is maintained by
one person in their spare time, so a fix may take longer than that; you will be
told where it stands rather than left waiting. When a fix ships you will be
credited in the release notes unless you would rather not be.

## Supported versions

The latest release. ReadPort is pre-1.0 and there are no maintenance branches:
security fixes land on `main` and go out in the next tagged image.

## What ReadPort assumes about its deployment

ReadPort holds a personal library, its readers' accounts, and their reading
positions. It is built to be safe when exposed to the internet behind a reverse
proxy, and these are the assumptions it makes. A deployment that breaks one of
them is not covered by the guarantees below.

- **`RP_SESSION_SECRET` is secret and stable.** Sessions are signed with it.
  Losing it signs everyone out; leaking it lets someone forge a session.
- **Proxy trust is off unless you turn it on.** `X-Forwarded-For` is ignored
  until `RP_TRUST_PROXY` names the proxies you actually run, so a client
  hitting the port directly cannot forge a client address.
- **Header SSO is bound to a peer address.** With `RP_PROXY_AUTH_HEADER` set,
  the header is trusted only from the addresses in `RP_PROXY_AUTH_SOURCES`.
  Without that pin, anyone who can reach the port can claim to be anyone.
- **Library folders are read-only** and are mounted that way in the stock
  Compose file. The alignment folder is the one exception, and it holds only
  files ReadPort itself wrote.
- **There is no open registration.** The first account is created once, with a
  one-time token printed in the server log; after that an admin adds people or
  sends invite links.

## What is in scope

Anything that lets one account read or change another's library, progress,
notes or shelves; anything that escapes the configured library folders;
anything that turns an admin session into code execution on the host;
authentication or session-fixation flaws; and cache poisoning or cross-account
leakage in the service worker or the offline packages.

## What is not

Findings that require an attacker to already hold an admin session or shell on
the host; missing rate limits on endpoints that are not authentication;
denial of service by asking a self-hosted server to do expensive work it was
configured to do; and anything about the third-party alignment model beyond how
ReadPort downloads and verifies it.
