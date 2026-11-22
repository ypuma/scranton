# Build explicitly, only after checking the base is local:
# docker build --pull=false -t scranton-tools:24-r2 sandbox
FROM node:24-bookworm-slim
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends git bash ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 scranton \
 && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash scranton \
 && mkdir -p /workspace \
 && chown scranton:scranton /workspace
# Keep release pins in sync with tools-lock.json (test/packaging/dockerfile-pins.test.js).
# Classic builders do not supply TARGETARCH; dpkg reports the base image architecture.
RUN set -eu; \
 RG_VERSION='15.2.0'; \
 FD_VERSION='10.5.2'; \
 case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
   amd64) \
     RG_URL='https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz'; \
     RG_SHA256='33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c'; \
     RG_BINARY='ripgrep-15.2.0-x86_64-unknown-linux-musl/rg'; \
     FD_URL='https://github.com/sharkdp/fd/releases/download/v10.5.2/fd-v10.5.2-x86_64-unknown-linux-musl.tar.gz'; \
     FD_SHA256='7e2d07fa2b8807642aaec67b7e2972a9fbe4db26fcb340a7372392db42b26694'; \
     FD_BINARY='fd-v10.5.2-x86_64-unknown-linux-musl/fd'; \
     ;; \
   arm64) \
     RG_URL='https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-aarch64-unknown-linux-musl.tar.gz'; \
     RG_SHA256='800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915'; \
     RG_BINARY='ripgrep-15.2.0-aarch64-unknown-linux-musl/rg'; \
     FD_URL='https://github.com/sharkdp/fd/releases/download/v10.5.2/fd-v10.5.2-aarch64-unknown-linux-musl.tar.gz'; \
     FD_SHA256='63ea52cb31586e6d98efa2f06d73d542f16c7d0c4af0f07b579aaf9714cf907a'; \
     FD_BINARY='fd-v10.5.2-aarch64-unknown-linux-musl/fd'; \
     ;; \
   *) echo 'unsupported architecture for pinned search tools' >&2; exit 1 ;; \
 esac; \
 node --input-type=module -e 'import { writeFile } from "node:fs/promises"; const args = process.argv.slice(1); for (let i = 0; i < args.length; i += 2) { const response = await fetch(args[i]); if (!response.ok) throw new Error(`Download failed: ${response.status}`); await writeFile(args[i + 1], Buffer.from(await response.arrayBuffer())); }' "$RG_URL" /tmp/rg.tar.gz "$FD_URL" /tmp/fd.tar.gz; \
 printf '%s  %s\n' "$RG_SHA256" '/tmp/rg.tar.gz' | sha256sum -c -; \
 printf '%s  %s\n' "$FD_SHA256" '/tmp/fd.tar.gz' | sha256sum -c -; \
 mkdir -p /tmp/search-tools; \
 tar -xzf /tmp/rg.tar.gz -C /tmp/search-tools "$RG_BINARY"; \
 tar -xzf /tmp/fd.tar.gz -C /tmp/search-tools "$FD_BINARY"; \
 install -m 0755 "/tmp/search-tools/$RG_BINARY" /usr/local/bin/rg; \
 install -m 0755 "/tmp/search-tools/$FD_BINARY" /usr/local/bin/fd; \
 test "$(rg --version | head -n 1)" = "ripgrep $RG_VERSION"; \
 test "$(fd --version)" = "fd $FD_VERSION"; \
 rm -rf /tmp/search-tools /tmp/rg.tar.gz /tmp/fd.tar.gz
ENV HOME=/tmp
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/bin/sleep", "infinity"]
# Tool processes only. No inference SDK, credentials or host profile.
# Base and apt dependencies retain the existing recipe's version policy (not digest-pinned).
