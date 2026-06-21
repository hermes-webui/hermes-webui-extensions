# Loopback Sidecar Example

This example shows how a trusted local extension can declare a loopback sidecar
dependency in its manifest metadata.

It is not a working feature extension. It documents the intended shape for
extensions such as Desktop Companion, where WebUI loads local JS/CSS assets and
the desktop or native behavior runs in a separate localhost process.

The `sidecar` metadata is descriptive until the main Hermes WebUI repository
defines and ships the corresponding manifest contract.

