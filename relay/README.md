# Sleepy Pet Message Relay

Sleepy Pet can send pet messages two ways:

- Default: `https://ntfy.sh`, a public HTTP pub/sub relay that works without setup.
- Private: this no-dependency relay, which exposes the same `/messages` API the app already understands.

## Run Locally

```bash
node relay/free-relay.js
```

Then set the app's Messages -> Relay URL to:

```text
http://localhost:8787
```

For another computer on the same network, use the host machine's LAN IP instead of `localhost`.

## API

Send:

```http
POST /messages
content-type: application/json

{
  "id": "msg-example",
  "to": "FRIEND-CODE",
  "text": "sleep soon?",
  "from": {
    "id": "YOUR-CODE",
    "catName": "Mochi",
    "appearance": {
      "selectedRibbon": "Blue",
      "selectedSkin": null
    }
  }
}
```

Receive:

```http
GET /messages?to=FRIEND-CODE
```

The relay keeps messages in memory for up to 24 hours. For a private internet deployment, run this on any free Node host and point the app's Relay URL at that host.
