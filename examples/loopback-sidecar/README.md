# Loopback Sidecar Example

This example shows how a trusted local extension can declare a loopback sidecar
dependency in its manifest metadata.

It is not a working feature extension. It documents the intended shape for
extensions such as Desktop Companion, where WebUI loads local JS/CSS assets and
the desktop or native behavior runs in a separate localhost process.

The manifest contract and consent-gated proxy are shipped. This historical
Desktop Companion shape is explicitly `legacy` because its externally maintained
runtime still uses direct loopback. New `token-v1` sidecars use the proxy and must
follow [`docs/SIDECAR_CONTRACT.md`](../../docs/SIDECAR_CONTRACT.md).

