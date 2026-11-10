# wa-bridge: a time-limited browser-to-WhatsApp bridge

A small Node.js server that gives you a web page for one WhatsApp chat. You link
your own WhatsApp as a linked device (QR scan or phone-number code), open the page
from any browser, and messages you send on the page go out from your WhatsApp into
that one chat; replies come back to the page.

Time-limited by design: a setup window to link (default 2 hours), then an access
window (default 24 hours), then the bridge application closes itself. Both
windows are configurable at launch (see Expiry model below). The server machine
only terminates if you also configure the AWS backstops described below - app
expiry and machine termination are separate mechanisms.

Provenance, stated plainly: this project's original build was deployed for a
24-hour session, and linking WhatsApp plus exchanging messages through the page
were live-verified in it. The app-expiry watcher and both termination backstops
were configured for that session but had not fired yet when this was written -
their end-of-window behavior is covered by the mock-mode tests, not by
observation. Since then, this repo gained a redesigned UI, configurable timing,
a Secure-on-HTTPS session cookie, the launch/cleanup helper scripts and their
PowerShell variants, and small hardening fixes. Those revisions pass the
mock-mode test suite and shell/syntax checks but have NOT been live-deployed
from this repo form - the first real run you launch is the first live test of
the current package.

## How it works

```
browser  --HTTPS-->  Cloudflare quick tunnel  -->  Node server (127.0.0.1:3000)
                                                        |
                                                  Baileys (WhatsApp Web protocol)
                                                        |
                                              your WhatsApp account,
                                              one allowed chat only
```

- `server.js` - HTTP server, login gate, message API, expiry state machine.
- `live.js` - WhatsApp adapter using [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys).
  Accepts messages from the allowed chat only, in both JID and LID addressing forms;
  everything else is dropped before storage.
- `public/index.html` - the single-page UI (login, QR/pairing code, chat).
- The page polls every 3s while visible, 20s when hidden, so a 24h run stays cheap.

## Security model

- The page is password-gated (timing-safe compare, Origin check on POSTs,
  HttpOnly SameSite=Strict session cookie, Secure when served over HTTPS; the
  local loopback demo stays usable without TLS).
- Login is limited to 5 attempts per 5 minutes per source IP. Behind the tunnel
  every request arrives from loopback, so in practice the limit is 5 attempts
  per 5 minutes for the whole bridge - stricter, not weaker.
- The session token is a hash of the bridge password and the boot timestamp,
  fixed for the life of one run (no rotation). Its strength rests on the
  password's: use a generated one from a password manager.
- The Node server binds to localhost only. The only public path in is the tunnel,
  and the tunnel terminates at the password gate. No inbound ports are open on the
  server itself.
- The bridge password never appears in the page URL, in logs, or in this repo.
  On AWS it is delivered through SSM Parameter Store (SecureString) and written to
  `.env` with mode 600.
- Only one chat is ever read or written. The scope is enforced server-side in the
  adapter, not in the UI.
- Scope boundary, stated plainly: that one-chat filter lives in this app's code.
  The linked-device credentials on the server can do anything a WhatsApp linked
  device can do, which is the whole account. WhatsApp does not enforce the
  one-chat limit; this code chooses it. Protect the machine and its `data/auth/`
  directory accordingly.
- WhatsApp session keys live under `data/auth/` on the server and are deleted with
  the instance. Nothing about your account is in this repo.
- This repo contains no credentials, no session data, no account IDs and no
  phone numbers. Anyone can copy the code and run it in their own AWS account
  with their own WhatsApp; nothing here grants access to yours. Your running
  bridge stays behind its password, and your AWS account stays behind your IAM.
- The rendered user-data file is the one private artifact: it embeds your chat
  JID and pairing phone in plaintext. It is generated per run, never committed,
  and readable by anyone holding `ec2:DescribeInstanceAttribute` on that
  instance - keep your IAM scoped and delete rendered copies when done.

## Expiry model

`data/state.json` persists `createdAt` and `activatedAt` across restarts:

- Setup window: you have `SETUP_HOURS` (default 2h, allowed 0.25-12) from first
  boot to link. Miss it and the bridge serves "setup expired" and stops offering
  codes.
- Access window: linking sets `activatedAt`; `SESSION_HOURS` (default 24h,
  allowed 1-168) later a watcher shuts the WhatsApp session down (fail closed)
  and the page shows closed.
- Timing is chosen at launch (render time), not from the page: there is no
  public control that can extend the bridge. Out-of-range values are rejected
  by the render script and clamped by the server.
- These application windows do not stop the machine or its billing by
  themselves. An unpaired bridge at setup-expiry is just a closed app on a
  running instance. Machine cleanup is independently configured: a systemd
  one-shot powers off at boot + SETUP_HOURS + SESSION_HOURS + 1h (launch with
  shutdown behavior = terminate), and an EventBridge one-time schedule calls
  TerminateInstances at the same horizon as the external backstop. Neither
  depends on any console session staying alive.
- Longer sessions cost proportionally more: the instance, its public IPv4 and
  its disk bill until termination. Check current prices before raising
  SESSION_HOURS.

## Run it locally (tests, no WhatsApp)

```
npm install
npm test
```

The mock adapter needs no credentials and exercises login, the scope filter,
send/receive, expiry, and shutdown. `node server.js` with `MODE=mock` gives you a
clickable demo at http://127.0.0.1:3000 (password `test-password`).

## Deploy on AWS (the setup this project ran)

1. Render the user-data script:

   ```
   cd deploy
   ALLOWED_JID='14155551234@s.whatsapp.net' \
   PAIRING_PHONE='14155559876' \
   SETUP_HOURS=2 SESSION_HOURS=24 \
   ./build-userdata.sh > /tmp/userdata-final.sh
   ```

   `ALLOWED_JID` is the destination chat (its number + `@s.whatsapp.net`).
   `PAIRING_PHONE` is your own number, digits only; omit it to offer QR only.
   `SETUP_HOURS` and `SESSION_HOURS` are optional (defaults 2 and 24); the
   script prints the effective timing, the failsafe horizon and a cost note.

2. Store the bridge password: Systems Manager > Parameter Store > create
   `/wa-bridge/bridge-password` as a SecureString. The instance reads it at boot
   with a retry loop, so you can create it right after launch. Use a generated
   password from a password manager; never paste it into user-data or logs.

3. Launch one EC2 instance, US East (N. Virginia):
   - AMI: Amazon Linux 2023 (x86_64). Type: t3.micro.
   - Key pair: none. Security group: no inbound rules at all (the tunnel is
     outbound-only). Storage: 8 GB gp3, delete on termination.
   - Shutdown behavior: Terminate. CPU credit specification: Standard.
   - IAM instance profile: a role with (a) the managed AmazonSSMManagedInstanceCore
     policy, which covers Run Command and SSM agent traffic, and (b) an inline
     policy allowing `ssm:GetParameter` on the password parameter's ARN only,
     `arn:aws:ssm:<region>:<account-id>:parameter/wa-bridge/bridge-password`.
     The managed core policy alone is not enough to read the parameter. If you
     encrypt the parameter with a customer-managed KMS key instead of the default
     `aws/ssm` key, also allow `kms:Decrypt` on that key. There is no SSH.
   - Advanced details > User data: paste the rendered script.

4. Watch EC2 > Instance > Actions > Monitor and troubleshoot > Get system log for
   `WA-BRIDGE-URL: https://....trycloudflare.com`. That is your bridge URL.
   The password is never printed there; only the URL is.

5. External backstop: EventBridge Scheduler > create a one-time schedule at
   boot + SETUP_HOURS + SESSION_HOURS + 1h after launch, target Amazon EC2 >
   TerminateInstances with payload `{"InstanceIds":["i-..."]}`, execution role
   allowed to terminate that instance only. The on-instance systemd poweroff is
   the second backstop.

6. Open the URL, sign in with the bridge password, and link within the setup
   window (2 hours by default).

`deploy/launch.sh` automates steps 3-5 with the AWS CLI (roles, no-inbound
security group, launch, EventBridge backstop placed from the rendered file's
config marker, URL recovery from the console output), and `deploy/cleanup.sh`
ends a run (terminate, delete the schedule, verify volumes). Review both before
first use; they encode the manual run this project executed but have not been
re-run against a live account from this repo.

### Windows / PowerShell

`deploy/build-userdata.ps1`, `deploy/launch.ps1` and `deploy/cleanup.ps1` are
the same three steps for Windows (PowerShell 5.1+, AWS CLI v2, the tar.exe that
ships with Windows 10 1803+):

```
cd deploy
.\build-userdata.ps1 -AllowedJid '14155551234@s.whatsapp.net' -PairingPhone '14155559876' -OutFile "$env:TEMP\userdata-final.sh"
.\launch.ps1 "$env:TEMP\userdata-final.sh"
.\cleanup.ps1 i-0123456789abcdef0
```

The bash scripts target Linux and macOS; on Windows use the PowerShell
versions. The PowerShell scripts were syntax-reviewed but not executed against
a live account from this repo; the bash versions encode the run this project
executed.

## Run it again whenever you need it

The bridge is disposable by design: every run is a fresh instance with fresh
state and a fresh WhatsApp link. There is nothing to stop and start - the
instance shuts down terminated, so a new run is a new launch, and the old one
never comes back. Each run gives you a fresh setup
window, a new linking code for your number, and a new tunnel URL.

The loop, once the one-time IAM and SSM setup from the deploy steps exists:

```
deploy/launch.sh /tmp/userdata-final.sh     # ~5 min, prints the new URL
# open URL, sign in, link with the phone-number code
deploy/cleanup.sh i-...                     # when you're done, or let the
                                            # failsafes fire on their own
```

The SSM password parameter is reused across runs, so the bridge password stays
the one you generated the first time. WhatsApp linking does not carry over:
each run links fresh from the page, by phone-number code or QR. Your phone
keeps old linked-device entries until you remove them under Linked devices.

## Linking WhatsApp

On the bridge page, either:

- Scan the QR with WhatsApp > Linked devices > Link a device, or
- Tap "Link with phone number instead" in WhatsApp's Linked devices flow and enter
  the code shown under the QR. Codes rotate every couple of minutes; always use
  the one currently on the page. This path requires `PAIRING_PHONE` to be set to
  your own number at render time; there is no way to enter an arbitrary number.

Linking starts the access window (24 hours by default). The page header shows
the exact expiry.

## The Cloudflare tunnel

The user-data installs `cloudflared` and runs a
[quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/):
an outbound-only connection that gives the localhost server a temporary public
HTTPS URL, with no Cloudflare account, no token, and no open inbound ports.

Known limitation: a quick tunnel URL is ephemeral. If the tunnel process or the
machine restarts, the URL changes and the old one dies. The tunnel service
restarts automatically and its script prints each new URL to the EC2 system log
the same way as the first one, so Get system log is the recovery path; that
reprint path is built in but was not exercised during the deployment this
project ran, and a changed URL still means re-sharing the link. For anything longer-lived, use a
named tunnel on your own Cloudflare account instead.

## Limitations and risks

- Baileys is an unofficial WhatsApp Web client library. Linking your account to
  unofficial software can violate WhatsApp's Terms of Service and risks account
  restrictions. You accept that risk by linking.
- The bridge relays one chat only. It is not a general WhatsApp export or API.
- Messages are stored in plaintext JSON on the instance for the session's life
  and are destroyed with it.
- WhatsApp rate limits and protocol changes can break linking or delivery without
  warning.

## Cost notes (us-east-1 list prices, checked November 2026)

- t3.micro on-demand: $0.0104/h -
  https://aws.amazon.com/ec2/instance-types/t3/
- Public IPv4 address: $0.005/h, since February 2024 -
  https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights/
- 8 GB gp3 storage: a few cents per day.
- SSM Parameter Store standard tier: no additional charge -
  https://aws.amazon.com/systems-manager/pricing/
- KMS requests with the default aws/ssm key and EventBridge Scheduler
  invocations fall inside their published free tiers at this one-off volume -
  https://aws.amazon.com/kms/pricing/ and
  https://aws.amazon.com/eventbridge/pricing/. The Cloudflare quick tunnel is
  free (see The Cloudflare tunnel above).

With the default timing (2h setup + 24h session + 1h failsafe buffer) the
instance is scheduled to terminate about 27 hours after launch: roughly $0.45
if the backstops fire on time. Termination is scheduled, not guaranteed - if
the failsafes fail, billing continues until the instance is terminated.
Prices change and free-tier or credit coverage varies by account: check
current prices before running, especially with a longer SESSION_HOURS.

## Repo layout

```
server.js                 HTTP server, auth, expiry state machine
live.js                   WhatsApp adapter (Baileys), scope filter
public/index.html         single-page UI
test/run-tests.js         mock-mode test suite
deploy/user-data.template.sh   EC2 bootstrap template (placeholders)
deploy/build-userdata.sh/.ps1  renders the template with your JID/phone/timing + payload
deploy/launch.sh/.ps1          one-command launch + termination backstop
deploy/cleanup.sh/.ps1         terminate, delete backstop, verify volumes
.env.example              every setting, documented
```
