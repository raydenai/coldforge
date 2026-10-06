# Provider contract checkpoint

Verified against official public documentation on October 5, 2026. These are integration contracts, not proof that the owner's accounts are configured or that messages/calls have been delivered.

## Winnr SMTP and replies

The [generic CSV documentation](https://winnr.app/help/export-integrations/generic-csv.html) specifies a Default export containing sender identity, SMTP/IMAP hosts and ports, usernames, passwords and footer. SMTP uses implicit TLS on 465; IMAP uses 993. Hosts belong to each mailbox and must not be assumed identical. The documented mailbox username is its full email address. These facts resolve the previous unknown export-format gate.

The [credential export guide](https://winnr.app/help/mailboxes/export-credentials.html) says exports are free, contain plaintext passwords, and return a download link that expires after 15 minutes. The API limits exports to one per five seconds. Application code must keep the CSV/download URL server-side, encrypt retained credentials and return only nonsecret connection status.

The [OpenAPI contract](https://app.winnr.app/openapi.yaml), previously downloaded and hashed in the launch audit, defines POST `/v1/export` with format `default`, optional domain filters and `get_all`; the response contains `data.download_url`, count and expiry. The URL points to presigned S3 storage and is nullable for an empty export. Downloads must use a separate client without the Winnr Authorization header and reject redirects/unapproved hosts.

Use SMTP for campaign messages requiring custom unsubscribe headers. REST sending remains available for its narrower documented message schema. Both transports require the same durable send reservation and unknown-outcome rules. The [webhook guide](https://winnr.app/help/api-mcp/webhooks.html) documents signed receipt events and Message-ID mapping for reply correlation.

## CloseBot and GHL

[CloseBot's custom blank channel guide](https://docs.closebot.com/en/articles/16358483-custom-blank-source-channel-webhook) documents a webhook source for receiving messages and delivering responses through a connected messaging API. This provides an alternative to making CRM integration a prerequisite for every conversation. The exact account/channel setup remains unverified.

[CloseBot API authentication](https://docs.closebot.com/en/articles/12068330-using-the-closebot-api) uses account-specific API keys and points to the [developer reference](https://developers.closebot.com/). CRM-specific source creation may still require OAuth. Do not invent a conversational API endpoint from the generic webhook description.

[GHL conversation providers](https://marketplace.gohighlevel.com/docs/2023-02-21/marketplace-modules/ConversationProviders/) distinguish default email providers from additional custom channels; workflow support differs. The application must choose and test the exact channel mode. [Provider delivery webhooks](https://marketplace.gohighlevel.com/docs/2021-07-28/webhook/ProviderOutboundMessage/index.html) use `X-GHL-Signature` with Ed25519 over the raw body. Validate before parsing or dispatching and dedupe the external message identity.

## Retell

[Create Phone Call](https://docs.retellai.com/api-references/create-phone-call) documents POST `/v2/create-phone-call`, Bearer authentication, from/to numbers and an idempotency key. Call creation is a separate external effect requiring a durable eligible job and a provider receipt. Verify incoming callbacks following [Retell's webhook signature documentation](https://docs.retellai.com/features/secure-webhook).

No CloseBot, GHL or Retell account connection, purchase, message, call or booking was attempted in this checkpoint. Their credentials, configured source/location/calendar/agent and controlled test audience remain launch inputs.

## Reply correlation and validation follow-up

The [Winnr webhook guide](https://winnr.app/help/api-mcp/webhooks.html), updated September 24, describes at-least-once delivery, original/provider Message-ID mapping and received-event body retrieval through the inbox API. The cached OpenAPI still labels received/bounce/complaint events as rolling out and has fewer received-event fields than the guide. Implement against validated optional fields; prove actual account delivery before declaring ingestion live. Warm-up traffic is excluded from the documented received stream.

[ZeroBounce single-address validation](https://zerobounce.net/docs/email-validation-api-quickstart/v2-validate-emails) documents HTTPS `/v2/validate`, including POST form parameters `api_key`, `email` and `timeout`. Only a validated receipt for the exact submitted address can become a provider-verified result. Invalid, risky and unknown remain distinct; import syntax or DNS alone never establishes mailbox deliverability. An imported external validation report may carry its own explicit provenance. No ZeroBounce account/credits or live validation call has been verified.
