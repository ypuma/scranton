# Build explicitly: docker build -t scranton-sandbox:1.5.2-r1 sandbox
# bridge permits cloud-model access; none disables networking. No egress filtering is claimed.
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git bash ripgrep fd-find ca-certificates \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global --ignore-scripts @earendil-works/pi-coding-agent@1.5.2 \
 && groupadd --gid 10001 pi \
 && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash pi \
 && mkdir -p /workspace /session /scranton \
 && chown pi:pi /workspace /session /scranton
ENV HOME=/home/pi
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/pi"]
# The launcher mounts only a private checkout, one session, and exact managed files.
# .git is masked read-only: host Git metadata/commands are unavailable inside the container.
# Linux uses the invoking non-root UID/GID (10001 on Windows/root hosts).
# Root-owned Linux bind directories must allow UID 10001 writes; do not weaken --user.
