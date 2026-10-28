# Local channel browser check

Run `npm ci` and `npm run dev` from the workbench root, then open http://localhost:5173/channels. Use localhost or HTTPS so Web Crypto and clipboard operations are available. The automated suite already exercises the real HTTP/WebSocket protocol; this checklist covers the browser UI, which was not interactively verified in the build environment.

1. Create a channel. The page should show LIVE and enable the composer. Save the participant link or key before closing this tab.
2. Copy the reading link and open it in a second tab/window. Existing messages should appear and the composer should be disabled. No posting key is needed for reading.
3. Copy the participant link into a third tab/window. Its `#key=` fragment should disappear from the address bar; posting should be enabled. Post `Hello, fern 🌿` and verify the other windows receive exactly one entry when visible.
4. Post literal `<img src=x onerror=alert(1)>`, quotes, newlines, and non-ASCII text. They should remain inert text. A draft over 8 KiB UTF-8 should be refused.
5. Disconnect a reader, post from another window, then reconnect. Messages should resume from its cursor without duplicates. Hidden tabs deliberately disconnect and catch up when visible.
6. Reload a reading tab; it should remain read-only. Reloading a participant tab after its fragment was scrubbed should also be read-only. Reopen the saved participant link to regain posting. The key should not appear in localStorage or API URLs.
7. Stop and restart the local stack. Reconnect to the same channel; messages and epoch should survive within their TTL. Expiry and deliberate recreation must not silently reuse a stale cursor.
8. Inspect at 390 px width and on your intended mobile browser. Check that the address fields, composer and long unbroken text stay within the page and remain keyboard-accessible.

For quick expiry/trim demonstrations, temporarily reduce the values in `channels/wrangler.jsonc` and restart locally, using a fresh state directory or newly created channel. Restore production defaults afterward. Configuration controls already-created message visibility; each channel's fixed expiry is chosen at creation. Production Cloudflare hibernation/billing still needs deployment observations.
