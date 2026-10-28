# Pinned blob-store client

`blob-store/src/proof.ts` and `blob-store/examples/client.ts` are byte-for-byte copies from the source-only Cloudflare blob-store v0.5.0 artifact used in this project. Their relative import layout is preserved. They implement `blob-store-upload-v1` and `hash_length` addresses, including the single-use challenge flow.

No CDN package or automatic protocol update is used. When the service protocol changes, update these files together and rerun the workbench's store integration test. The server itself remains a separate project.

The full v0.5 store is included under `store/` for local execution and later deployment. Its server sources and protocol client are unchanged. The workbench root dependencies supply Miniflare for local runs; the store retains its own deployment package and lockfile.
