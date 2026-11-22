# Build explicitly, only after checking the base is local:
# docker build --pull=false -t scranton-tools:24-r1 sandbox
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git bash ripgrep fd-find ca-certificates \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 scranton \
 && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash scranton \
 && mkdir -p /workspace \
 && chown scranton:scranton /workspace
ENV HOME=/tmp
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/bin/sleep", "infinity"]
# Tool processes only. No inference SDK, credentials or host profile.
# Base and apt dependencies retain the existing recipe's version policy (not digest-pinned).
